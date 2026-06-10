import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { AnthropicAdapter, OllamaAdapter, OpenAICompatibleAdapter } from "@macrokit/llm";
import type { LLMAdapter } from "@macrokit/runtime";
import { loadAllTasks } from "./load-tasks.js";
import { runBenchmark } from "./runner.js";
import { loadOutcomeTasks, runOutcome } from "./outcome-runner.js";
import type { RunHeader } from "./types.js";

/**
 * Usage:
 *   pnpm run -- run --model qwen-7b-local
 *   pnpm run -- run --model deepseek-chat
 *   pnpm run -- list-models
 */

interface ModelConfig {
  id: string;
  display: string;
  build: () => LLMAdapter;
  notes?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(here, "..");

const MODELS: Record<string, ModelConfig> = {
  "qwen-7b-local": {
    id: "qwen-7b-local",
    display: "Qwen 2.5 7B Instruct Q4_K_M (llama-server on an M1 MacBook)",
    notes:
      "Production on-device model of the private reference deployment. SHA256 " +
      "65b8fcd92af6b4fefa935c625d1ac27ea29dcb6ee14589c55a8f115ceaaa1423. " +
      "Local llama.cpp host (build b9354, loopback).",
    build: () =>
      new OpenAICompatibleAdapter({
        baseUrl: process.env.MACROKIT_BENCH_LOCAL_URL ?? "http://127.0.0.1:18080/v1",
        model: "local-7b-reference",
        apiKey: "local",
        provider: "llama-server",
      }),
  },
  "ollama-default": {
    id: "ollama-default",
    display: "Ollama (whatever model is loaded)",
    build: () =>
      new OllamaAdapter({
        model: process.env.LLM_MODEL ?? "qwen2.5:7b-instruct",
      }),
  },

  // --- Additional WEAK / LOCAL models (Ollama). No frontier rows (see
  //     docs/BENCHMARK.md §1). Each is a small, locally-runnable model; the
  //     point is the spread of weak models clearing the bar, not a frontier
  //     comparison. Run on a host with Ollama serving these tags. ---
  "qwen2.5-1.5b-ollama": {
    id: "qwen2.5-1.5b-ollama",
    display: "Qwen 2.5 1.5B Instruct (Ollama)",
    notes: "Local via Ollama. `ollama pull qwen2.5:1.5b-instruct`.",
    build: () => new OllamaAdapter({ model: "qwen2.5:1.5b-instruct" }),
  },
  "qwen2.5-3b-ollama": {
    id: "qwen2.5-3b-ollama",
    display: "Qwen 2.5 3B Instruct (Ollama)",
    notes: "Local via Ollama. `ollama pull qwen2.5:3b-instruct`.",
    build: () => new OllamaAdapter({ model: "qwen2.5:3b-instruct" }),
  },
  "qwen2.5-7b-ollama": {
    id: "qwen2.5-7b-ollama",
    display: "Qwen 2.5 7B Instruct (Ollama)",
    notes:
      "Local via Ollama. `ollama pull qwen2.5:7b-instruct`. Same model family as " +
      "the reference qwen-7b-local row, served through Ollama instead of llama.cpp.",
    build: () => new OllamaAdapter({ model: "qwen2.5:7b-instruct" }),
  },
  "llama3.1-8b-ollama": {
    id: "llama3.1-8b-ollama",
    display: "Llama 3.1 8B Instruct (Ollama)",
    notes: "Local via Ollama. `ollama pull llama3.1:8b`.",
    build: () => new OllamaAdapter({ model: "llama3.1:8b" }),
  },
  "mistral-7b-ollama": {
    id: "mistral-7b-ollama",
    display: "Mistral 7B Instruct v0.3 (Ollama)",
    notes: "Local via Ollama. `ollama pull mistral:7b`.",
    build: () => new OllamaAdapter({ model: "mistral:7b" }),
  },
  "claude-sonnet-4": {
    id: "claude-sonnet-4",
    display: "Claude Sonnet 4 (Anthropic API)",
    notes: "Requires ANTHROPIC_API_KEY.",
    build: () =>
      new AnthropicAdapter({
        model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514",
        apiKey: process.env.ANTHROPIC_API_KEY ?? "",
      }),
  },
  "qwen-plus": {
    id: "qwen-plus",
    display: "Qwen Plus (Alibaba DashScope)",
    notes: "Requires DASHSCOPE_API_KEY.",
    build: () =>
      new OpenAICompatibleAdapter({
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen-plus",
        apiKey: process.env.DASHSCOPE_API_KEY ?? "",
        provider: "dashscope",
      }),
  },
  "deepseek-chat": {
    id: "deepseek-chat",
    display: "DeepSeek Chat",
    notes: "Requires DEEPSEEK_API_KEY.",
    build: () =>
      new OpenAICompatibleAdapter({
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        apiKey: process.env.DEEPSEEK_API_KEY ?? "",
        provider: "deepseek",
      }),
  },
  "glm-4-flash": {
    id: "glm-4-flash",
    display: "GLM-4 Flash (Zhipu)",
    notes: "Requires ZHIPU_API_KEY.",
    build: () =>
      new OpenAICompatibleAdapter({
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        model: "glm-4-flash",
        apiKey: process.env.ZHIPU_API_KEY ?? "",
        provider: "zhipu",
      }),
  },
};

async function main(argv: string[]): Promise<number> {
  const cmd = argv[2];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === "list-models") {
    for (const m of Object.values(MODELS)) {
      process.stdout.write(`${m.id.padEnd(20)} ${m.display}\n`);
    }
    return 0;
  }
  if (cmd === "run") {
    return await runOne(argv.slice(3));
  }
  if (cmd === "run-outcome") {
    return await runOutcomeCmd(argv.slice(3));
  }
  process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
  return 2;
}

async function runOutcomeCmd(args: string[]): Promise<number> {
  const modelId = flag(args, "--model");
  if (!modelId) {
    process.stderr.write("--model <id> required.\n");
    return 2;
  }
  const cfg = MODELS[modelId];
  if (!cfg) {
    process.stderr.write(`unknown model "${modelId}". Try \`list-models\`.\n`);
    return 2;
  }
  const conditionFlag = flag(args, "--condition") ?? "macro_on";
  if (conditionFlag !== "macro_on" && conditionFlag !== "macro_off") {
    process.stderr.write(`--condition must be macro_on or macro_off.\n`);
    return 2;
  }
  const condition = conditionFlag as "macro_on" | "macro_off";
  const suffix = condition === "macro_off" ? "-iv-off" : "-iv";

  const tasks = loadOutcomeTasks(resolve(BENCH_ROOT, "outcome-tasks", "outcome-corpus.jsonl"));
  process.stdout.write(`Loaded ${tasks.length} outcome tasks.\n`);
  const adapter = cfg.build();
  const header: RunHeader = {
    modelId: `${cfg.id}${suffix}`,
    modelDisplay: `${cfg.display} — INDEPENDENT-VALUE (${condition})`,
    llmProvider: adapter.provider,
    startedAt: new Date().toISOString(),
    harnessCommit: gitHead(BENCH_ROOT) ?? undefined,
    corpusCommit: gitHead(BENCH_ROOT) ?? undefined,
    notes: `${cfg.notes ? cfg.notes + " " : ""}[independent_value: ${condition}]`,
  };
  process.stdout.write(`\nModel: ${header.modelDisplay}\nStarted: ${header.startedAt}\n\n`);

  const { meanValue } = await runOutcome({
    adapter, header, tasks, condition, outDir: resolve(BENCH_ROOT, "runs"),
    onProgress: (i, n, r) => {
      const pad = String(i).padStart(2, " ");
      process.stdout.write(`[${pad}/${n}] ${r.taskId} gold=${r.goldIntent.padEnd(20)} routed=${String(r.routedIntent).padEnd(20)} V=${r.value.toFixed(2)} ${(r.latencyMs/1000).toFixed(2)}s\n`);
    },
  });
  process.stdout.write(`\n${"=".repeat(50)}\n${header.modelDisplay}\nmean independent value V = ${meanValue.toFixed(4)}\n`);
  return 0;
}

async function runOne(args: string[]): Promise<number> {
  const modelId = flag(args, "--model");
  if (!modelId) {
    process.stderr.write("--model <id> required. Try `list-models` to see options.\n");
    return 2;
  }
  const cfg = MODELS[modelId];
  if (!cfg) {
    process.stderr.write(`unknown model "${modelId}". Try \`list-models\`.\n`);
    return 2;
  }

  // --condition macro_on (default) | macro_off (the ablation; see
  // MACRO_ABLATION_PREREGISTRATION.md). macro_off artifacts get a "-off" id
  // suffix so they sit beside the macro-ON runs without colliding.
  const conditionFlag = flag(args, "--condition") ?? "macro_on";
  if (conditionFlag !== "macro_on" && conditionFlag !== "macro_off") {
    process.stderr.write(`--condition must be macro_on or macro_off (got "${conditionFlag}").\n`);
    return 2;
  }
  const condition = conditionFlag as "macro_on" | "macro_off";
  const isOff = condition === "macro_off";

  process.stdout.write(`Loading tasks from bench/tasks/...\n`);
  const tasks = loadAllTasks(resolve(BENCH_ROOT, "tasks"));
  process.stdout.write(`Loaded ${tasks.length} tasks.\n`);

  const adapter = cfg.build();
  const header: RunHeader = {
    modelId: isOff ? `${cfg.id}-off` : cfg.id,
    modelDisplay: isOff ? `${cfg.display} — MACRO-OFF (primitives)` : cfg.display,
    llmProvider: adapter.provider,
    startedAt: new Date().toISOString(),
    harnessCommit: gitHead(BENCH_ROOT) ?? undefined,
    corpusCommit: gitHead(BENCH_ROOT) ?? undefined,
    notes: `${cfg.notes ? cfg.notes + " " : ""}[condition: ${condition}]`,
  };
  process.stdout.write(`\nModel: ${header.modelDisplay}\nCondition: ${condition}\nStarted: ${header.startedAt}\n\n`);

  const summary = await runBenchmark({
    adapter,
    header,
    tasks,
    condition,
    outDir: resolve(BENCH_ROOT, "runs"),
    onProgress: (i, n, r) => {
      const mark =
        r.verdict === "full" ? "✓" : r.verdict === "tool_only" ? "T" : r.verdict === "half" ? "½" : "·";
      const pad = String(i).padStart(3, " ");
      process.stdout.write(
        `[${pad}/${n}] ${mark} ${r.taskId} ${r.bucket.padEnd(28)} ${r.actualTool ?? "(text)"}` +
          ` ${(r.latencyMs / 1000).toFixed(2)}s\n`,
      );
    },
  });

  process.stdout.write(
    `\n${"=".repeat(60)}\n` +
      `${cfg.display}\n` +
      `Score:    ${summary.totalScore.toFixed(1)} / ${summary.maxScore} (${summary.percent.toFixed(1)}%)\n` +
      `Bail-outs: ${summary.bailOutCount} / ${summary.taskCount}\n` +
      `Mean lat: ${(summary.meanLatencyMs / 1000).toFixed(2)}s\n\n` +
      `By bucket:\n`,
  );
  for (const [k, v] of Object.entries(summary.bucketBreakdown)) {
    process.stdout.write(`  ${k.padEnd(28)} ${v.total.toFixed(1)} / ${v.max} (${v.percent.toFixed(1)}%)\n`);
  }
  process.stdout.write(`\nBy difficulty:\n`);
  for (const [k, v] of Object.entries(summary.difficultyBreakdown)) {
    process.stdout.write(`  ${k.padEnd(28)} ${v.total.toFixed(1)} / ${v.max} (${v.percent.toFixed(1)}%)\n`);
  }
  return 0;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

function gitHead(cwd: string): string | null {
  try {
    return execSync("git rev-parse HEAD", { cwd, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const HELP = `macrokit/bench — launch benchmark runner

Usage:
  pnpm run -- list-models
  pnpm run -- run --model <id> [--condition macro_on|macro_off]

  --condition macro_off runs the macro ablation: the model sees the low-level
  primitives instead of the encoded macros and must compose the workflow itself
  (see bench/MACRO_ABLATION_PREREGISTRATION.md). Artifacts get a "-off" suffix.

Models: see \`list-models\`. The on-device model "qwen-7b-local" needs
a running llama-server (see methodology.md §2 + bench/README.md).

Output:
  bench/runs/<model-id>-<timestamp>.jsonl     per-task raw outputs
  bench/runs/<model-id>-<timestamp>.summary.json
`;

main(process.argv).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`bench failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  },
);
