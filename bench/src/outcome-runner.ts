import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IntentRouter, MacroRegistry, Dispatcher, SessionLog, type LLMAdapter } from "@macrokit/runtime";
import {
  captureWorkflowLog, closeStaleIssues, generateReleaseNotes,
  suggestReviewersMacro, triageIssue, triagePullRequest,
} from "@macrokit-example/github-maintainer/src/macros/index.js";
import { buildFixturedPrimitiveRegistry, classifyTrajectory, MACRO_OFF_SYSTEM_EXTRA } from "./ablation-primitives.js";
import {
  makeFixtureClient, FixtureGitHubClient, scoreOutcomeOn, scoreOutcomeOff, type OutcomeTask,
} from "./fixture-client.js";
import type { RunHeader } from "./types.js";
import type { Condition } from "./runner.js";

function buildMacroRegistry(): MacroRegistry {
  return new MacroRegistry()
    .register(triagePullRequest).register(triageIssue).register(generateReleaseNotes)
    .register(closeStaleIssues).register(suggestReviewersMacro).register(captureWorkflowLog);
}

export function loadOutcomeTasks(path: string): OutcomeTask[] {
  return readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as OutcomeTask);
}

export interface OutcomeResult {
  taskId: string;
  goldIntent: string;
  routedIntent: string | null;
  value: number;
  latencyMs: number;
  calls: number;
  rawText: string;
}

export interface OutcomeRunOptions {
  adapter: LLMAdapter;
  header: RunHeader;
  tasks: ReadonlyArray<OutcomeTask>;
  outDir: string;
  condition: Condition;
  onProgress?: (i: number, n: number, r: OutcomeResult) => void;
}

export async function runOutcome(opts: OutcomeRunOptions): Promise<{ meanValue: number; results: OutcomeResult[] }> {
  const { adapter, header, tasks, outDir, condition, onProgress } = opts;
  mkdirSync(outDir, { recursive: true });
  const stamp = header.startedAt.replace(/[:.]/g, "-");
  const runPath = join(outDir, `${header.modelId}-${stamp}.jsonl`);
  const summaryPath = join(outDir, `${header.modelId}-${stamp}.summary.json`);
  writeFileSync(runPath, JSON.stringify({ type: "header", condition, experiment: "independent_value", ...header }) + "\n");

  const results: OutcomeResult[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    const r = await runOne(task, adapter, condition);
    results.push(r);
    appendFileSync(runPath, JSON.stringify({ type: "task", ...r }) + "\n");
    onProgress?.(i + 1, tasks.length, r);
  }
  const meanValue = results.length ? results.reduce((s, r) => s + r.value, 0) / results.length : 0;
  writeFileSync(summaryPath, JSON.stringify({
    header, condition, experiment: "independent_value", taskCount: results.length,
    meanValue, meanLatencyMs: results.length ? results.reduce((s, r) => s + r.latencyMs, 0) / results.length : 0,
    finishedAt: new Date().toISOString(),
  }, null, 2) + "\n");
  return { meanValue, results };
}

async function runOne(task: OutcomeTask, adapter: LLMAdapter, condition: Condition): Promise<OutcomeResult> {
  const log = new SessionLog();
  const fixture = new FixtureGitHubClient(task.fixture);
  const offSink: { labels: string[]; action?: string } = { labels: [] };
  // FIX 2026-06-10 (harness asymmetry erratum): macro-OFF now uses FIXTURE-BACKED
  // primitives — each returns the same per-item data macro-ON gets — so the ON/OFF
  // value comparison is fair. Previously macro-OFF got empty tool surfaces + stub
  // primitives and was structurally starved. NOT yet re-run; needs a corrected
  // pre-registration + bench-host run + independent re-verification before use.
  const registry = condition === "macro_off" ? buildFixturedPrimitiveRegistry(task.fixture, offSink) : buildMacroRegistry();
  const toolSurfaces = condition === "macro_off" ? {} : { github: fixture };
  const dispatcher = new Dispatcher({ registry, log, toolSurfaces });
  const router = new IntentRouter({
    registry, adapter, dispatcher, log,
    maxIterations: condition === "macro_off" ? 5 : 1,
    ...(condition === "macro_off" ? { systemPromptExtra: MACRO_OFF_SYSTEM_EXTRA } : {}),
  });

  const start = Date.now();
  let routedIntent: string | null = null;
  let value = 0;
  let calls = 0;
  let rawText = "";
  try {
    const res = await router.chat(task.prompt, { history: [], temperature: 0 });
    rawText = res.text;
    calls = res.dispatched.length;
    if (condition === "macro_off") {
      const names = res.dispatched.map((d) => d.call.name);
      const decoded = classifyTrajectory(names);
      routedIntent = decoded;
      value = scoreOutcomeOff(task, decoded, offSink.labels, rawText);
    } else {
      const d0 = res.dispatched[0];
      routedIntent = d0 ? d0.call.name : null;
      const output = d0 && d0.result.ok ? d0.result.value : undefined;
      value = scoreOutcomeOn(task, routedIntent, output);
    }
  } catch {
    /* errored task scores V=0, routedIntent null */
  }
  return { taskId: task.id, goldIntent: task.gold_intent, routedIntent, value, latencyMs: Date.now() - start, calls, rawText };
}
