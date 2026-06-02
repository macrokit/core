import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  IntentRouter,
  MacroRegistry,
  Dispatcher,
  SessionLog,
  type LLMAdapter,
} from "@macrokit/runtime";
import {
  captureWorkflowLog,
  closeStaleIssues,
  generateReleaseNotes,
  suggestReviewersMacro,
  triageIssue,
  triagePullRequest,
} from "@macrokit-example/github-maintainer/src/macros/index.js";
import { scoreTask } from "./score.js";
import {
  buildPrimitiveRegistry,
  classifyTrajectory,
  MACRO_OFF_SYSTEM_EXTRA,
} from "./ablation-primitives.js";
import type {
  RunHeader,
  RunSummary,
  Task,
  TaskResult,
} from "./types.js";

export type Condition = "macro_on" | "macro_off";

/**
 * Build a registry with the maintainer-agent macros registered. The macros'
 * handlers will not actually fire — we intercept at the router so we score
 * only the routing decision (the SDK's headline claim).
 */
function buildRegistry(): MacroRegistry {
  return new MacroRegistry()
    .register(triagePullRequest)
    .register(triageIssue)
    .register(generateReleaseNotes)
    .register(closeStaleIssues)
    .register(suggestReviewersMacro)
    .register(captureWorkflowLog);
}

export interface RunOptions {
  adapter: LLMAdapter;
  header: RunHeader;
  tasks: ReadonlyArray<Task>;
  outDir: string;
  /** macro_on (default, the encoded macros) | macro_off (low-level primitives). */
  condition?: Condition;
  onProgress?: (i: number, n: number, result: TaskResult) => void;
}

export async function runBenchmark(opts: RunOptions): Promise<RunSummary> {
  const { adapter, header, tasks, outDir, onProgress } = opts;
  const condition: Condition = opts.condition ?? "macro_on";
  mkdirSync(outDir, { recursive: true });
  const stamp = header.startedAt.replace(/[:.]/g, "-");
  const runPath = join(outDir, `${header.modelId}-${stamp}.jsonl`);
  const summaryPath = join(outDir, `${header.modelId}-${stamp}.summary.json`);

  // Write the run header as the first line so a partial run still has
  // model+config metadata attached.
  writeFileSync(runPath, JSON.stringify({ type: "header", condition, ...header }) + "\n");

  // macro-ON: the 6 encoded workflow macros, one routing call.
  // macro-OFF: the low-level primitives, multi-step composition.
  const registry = condition === "macro_off" ? buildPrimitiveRegistry() : buildRegistry();
  const maxIterations = condition === "macro_off" ? 5 : 1;
  const systemPromptExtra = condition === "macro_off" ? MACRO_OFF_SYSTEM_EXTRA : undefined;
  const log = new SessionLog();
  const dispatcher = new Dispatcher({ registry, log });

  const results: TaskResult[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    const result = await runOneTask(task, adapter, registry, dispatcher, log, {
      condition,
      maxIterations,
      systemPromptExtra,
    });
    results.push(result);
    appendFileSync(runPath, JSON.stringify({ type: "task", ...result }) + "\n");
    onProgress?.(i + 1, tasks.length, result);
  }

  const summary = aggregate(header, results);
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

async function runOneTask(
  task: Task,
  adapter: LLMAdapter,
  registry: MacroRegistry,
  dispatcher: Dispatcher,
  log: SessionLog,
  opts: { condition: Condition; maxIterations: number; systemPromptExtra?: string },
): Promise<TaskResult> {
  // Fresh router per task so history doesn't leak across prompts.
  const router = new IntentRouter({
    registry,
    adapter,
    dispatcher,
    log,
    maxIterations: opts.maxIterations,
    ...(opts.systemPromptExtra ? { systemPromptExtra: opts.systemPromptExtra } : {}),
  });

  const start = Date.now();
  let actualTool: string | null = null;
  let actualArgs: Record<string, unknown> | undefined;
  let bailOutCode: string | null = null;
  let rawText = "";
  let errorMessage: string | undefined;
  let trajectory: string[] | undefined;
  let derivedIntent: string | undefined;

  try {
    // history=[] so each task is independent; temperature 0 = greedy (methodology).
    // macro-ON: maxIterations 1, read the single routing decision off dispatched[0].
    // macro-OFF: maxIterations 5, the model composes primitives; we collect the
    //   full trajectory and decode it to an intent via the frozen rule. Handlers
    //   return stub data so the loop proceeds (the ablation scores the planning
    //   decision, not handler correctness — same as macro-ON).
    const result = await router.chat(task.prompt, { history: [], temperature: 0 });
    rawText = result.text;
    if (result.bailOuts.length > 0) {
      bailOutCode = result.bailOuts[0]!.code;
    }
    if (opts.condition === "macro_off") {
      trajectory = result.dispatched.map((d) => d.call.name);
      derivedIntent = classifyTrajectory(trajectory);
      actualTool = derivedIntent === "no_macro" ? null : derivedIntent;
      // args from the call whose op the decode keyed on (best-effort, not scored
      // in the ablation's intent-level accuracy).
      const keyed = result.dispatched.find((d) => d.call.name);
      actualArgs = keyed?.call.args;
    } else if (result.dispatched.length > 0) {
      const call = result.dispatched[0]!.call;
      actualTool = call.name;
      actualArgs = call.args;
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  const latencyMs = Date.now() - start;
  const score = scoreTask(task, { actualTool, ...(actualArgs ? { actualArgs } : {}) });

  return {
    taskId: task.id,
    bucket: task.bucket,
    difficulty: task.difficulty,
    prompt: task.prompt,
    expected: task.expected,
    actualTool,
    actualArgs,
    verdict: score.verdict,
    toolScore: score.toolScore,
    argsScore: score.argsScore,
    bailOutCode,
    latencyMs,
    rawText,
    ...(errorMessage ? { errorMessage } : {}),
    ...(trajectory ? { trajectory } : {}),
    ...(derivedIntent ? { derivedIntent } : {}),
  };
}

function aggregate(header: RunHeader, results: ReadonlyArray<TaskResult>): RunSummary {
  const buckets: RunSummary["bucketBreakdown"] = {};
  const difficulties: RunSummary["difficultyBreakdown"] = {};
  let totalScore = 0;
  const maxScore = 2 * results.length;
  const bailOutBreakdown: Record<string, number> = {};
  let bailOutCount = 0;
  let totalLatency = 0;

  for (const r of results) {
    const s = r.toolScore + r.argsScore;
    totalScore += s;
    totalLatency += r.latencyMs;
    if (r.bailOutCode) {
      bailOutCount += 1;
      bailOutBreakdown[r.bailOutCode] = (bailOutBreakdown[r.bailOutCode] ?? 0) + 1;
    }
    bump(buckets, r.bucket, s);
    bump(difficulties, r.difficulty, s);
  }
  finalize(buckets);
  finalize(difficulties);

  return {
    header,
    taskCount: results.length,
    totalScore,
    maxScore,
    percent: maxScore === 0 ? 0 : (totalScore / maxScore) * 100,
    bucketBreakdown: buckets,
    difficultyBreakdown: difficulties,
    bailOutCount,
    bailOutBreakdown,
    meanLatencyMs: results.length === 0 ? 0 : totalLatency / results.length,
    finishedAt: new Date().toISOString(),
  };
}

function bump(
  acc: Record<string, { total: number; max: number; percent: number; count: number }>,
  key: string,
  score: number,
): void {
  const e = (acc[key] ??= { total: 0, max: 0, percent: 0, count: 0 });
  e.total += score;
  e.max += 2;
  e.count += 1;
}

function finalize(
  acc: Record<string, { total: number; max: number; percent: number; count: number }>,
): void {
  for (const k of Object.keys(acc)) {
    const e = acc[k]!;
    e.percent = e.max === 0 ? 0 : (e.total / e.max) * 100;
  }
}

// silence unused-imports — referenced via dynamic registry but ESM hoist
void dirname;
