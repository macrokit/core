/**
 * CLI for the multi-macro routing stress test.
 *
 *   pnpm --filter @macrokit/bench run:multi-macro
 *
 * Needs Ollama serving qwen2.5:7b-instruct at http://localhost:11434.
 * Writes the raw per-prompt artifact + summary + confusion matrix to bench/runs/.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OllamaAdapter } from "@macrokit/llm";
import {
  aggregate,
  renderConfusion,
  runMultiMacro,
  type PromptFile,
  type PromptResult,
  type Summary,
} from "./multi-macro.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const MODEL = process.env.MULTI_MACRO_MODEL ?? "qwen2.5:7b-instruct";

function loadPrompts(): PromptFile {
  const raw = readFileSync(join(ROOT, "multi-macro", "prompts.json"), "utf8");
  return JSON.parse(raw) as PromptFile;
}

async function main(): Promise<void> {
  const { prompts, version } = loadPrompts();
  const adapter = new OllamaAdapter({ model: MODEL });
  const startedAt = new Date().toISOString();
  console.error(
    `multi-macro routing · model=${MODEL} · ${prompts.length} prompts · promptset v${version}`,
  );

  const results = await runMultiMacro(adapter, prompts, {
    model: MODEL,
    onProgress: (i, n, r) => {
      const mark = r.routingCorrect ? "✓" : "✗";
      console.error(
        `  [${String(i).padStart(2)}/${n}] ${mark} ${r.id.padEnd(28)} ` +
          `exp=${r.expect.join("|") || "(none)"} got=${r.actual ?? "(no-route)"}`,
      );
    },
  });

  const summary = aggregate(results);
  const stamp = startedAt.replace(/[:.]/g, "-");
  const outDir = join(ROOT, "runs");
  mkdirSync(outDir, { recursive: true });
  const base = join(outDir, `multi-macro-${MODEL.replace(/[:/]/g, "_")}-${stamp}`);

  // Raw artifact: header + one line per prompt result.
  const jsonl = [
    JSON.stringify({ type: "header", model: MODEL, promptSetVersion: version, startedAt }),
    ...results.map((r: PromptResult) => JSON.stringify({ type: "result", ...r })),
  ].join("\n");
  writeFileSync(`${base}.jsonl`, jsonl + "\n");
  writeFileSync(
    `${base}.summary.json`,
    JSON.stringify({ model: MODEL, promptSetVersion: version, startedAt, ...summary }, null, 2) + "\n",
  );
  writeFileSync(`${base}.confusion.txt`, renderConfusion(summary) + "\n");

  printReport(summary, MODEL);
  console.error(`\nartifacts → ${base}.{jsonl,summary.json,confusion.txt}`);
}

function pct(x: number): string {
  return (x * 100).toFixed(1) + "%";
}

function printReport(s: Summary, model: string): void {
  const L = console.error;
  L("\n========== multi-macro routing — " + model + " ==========");
  L(`routing accuracy (positives): ${pct(s.routingAccuracyPositives)}  ` +
    `(clear ${s.byCategory.clear.routedCorrect}/${s.byCategory.clear.n}, ` +
    `ambiguous ${s.byCategory.ambiguous.routedCorrect}/${s.byCategory.ambiguous.n})`);
  L(`no-route accuracy (negatives): ${pct(s.noRouteAccuracy)}  ` +
    `(${s.byCategory.negative.routedCorrect}/${s.byCategory.negative.n}; ` +
    `hallucinated-tool-call rate ${pct(s.hallucinatedToolCallRate)})`);
  L(`arg-extraction: per-key ${pct(s.argKeyAccuracy)} · exact-args ${pct(s.argsExactRate)}`);
  L("\nper-macro routing (clear):");
  for (const [m, v] of Object.entries(s.perMacroRouting)) {
    const ak = s.perMacroArgKey[m];
    const argStr = ak ? ` · args ${ak.correct}/${ak.keys}` : "";
    L(`  ${m.padEnd(24)} ${v.correct}/${v.n}${argStr}`);
  }
  L("\nconfusion matrix (rows=gold, cols=actual):");
  L(renderConfusion(s));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
