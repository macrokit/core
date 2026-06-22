import { MacroRegistry, Runtime } from "@macrokit/runtime";
import { OllamaAdapter, OpenAICompatibleAdapter } from "@macrokit/llm";
import { InMemoryAtsClient } from "./primitives/ats-client.js";
import { SAMPLE_DATASET } from "./fixtures/dataset.js";
import {
  checkReferencesDryRun,
  draftCandidateOutreach,
  parseRequisition,
  rankCandidates,
  scheduleInterview,
  screenResume,
} from "./macros/index.js";

/**
 * Reference implementation entry point. Wires the registry, a fixtured ATS/HRIS
 * surface into ctx.tools (under the `ats` capability key), an LLM adapter, and a
 * Runtime — then dispatches one recruiter request.
 *
 * Structurally parallel to examples/github-maintainer/src/main.ts and
 * examples/paper-triage/src/main.ts. The three examples share the same shape so
 * an adopter can compare them side-by-side and see what stays constant vs. what
 * changes with the vertical. Here the surface is an in-memory fixtured ATS
 * seeded with SYNTHETIC data (no live calls, no real PII).
 *
 * Note the safety posture: the consequential macros (outreach, scheduling,
 * references) default to dry-run, so a bare request previews the action rather
 * than committing it. The user must say "send" / "actually book" for the
 * mutation to fire.
 */
async function main(): Promise<void> {
  const userMessage = process.argv.slice(2).join(" ").trim();
  if (!userMessage) {
    process.stderr.write(USAGE);
    process.exit(2);
  }

  const llm = process.env.OPENAI_BASE_URL
    ? new OpenAICompatibleAdapter({
        baseUrl: process.env.OPENAI_BASE_URL,
        model: process.env.LLM_MODEL ?? "gpt-4o-mini",
        apiKey: process.env.OPENAI_API_KEY ?? "",
      })
    : new OllamaAdapter({ model: process.env.LLM_MODEL ?? "qwen2.5:7b-instruct" });

  // Fixtured, in-process ATS surface. An adopter swaps this for a thin client
  // over their real Greenhouse / Lever / Workday / custom HRIS.
  const ats = new InMemoryAtsClient(SAMPLE_DATASET);

  const registry = new MacroRegistry()
    .register(parseRequisition)
    .register(screenResume)
    .register(rankCandidates)
    .register(draftCandidateOutreach)
    .register(scheduleInterview)
    .register(checkReferencesDryRun);

  const runtime = new Runtime({
    registry,
    llm,
    toolSurfaces: { ats },
    sessionLogPath: `.macrokit/sessions/${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
  });

  const result = await runtime.chat(userMessage);

  process.stdout.write(`\n${result.text}\n`);
  for (const d of result.dispatched) {
    if (d.result.ok) {
      process.stdout.write(
        `\nDispatched ${d.call.name}:\n${JSON.stringify(d.result.value, null, 2)}\n`,
      );
    } else {
      process.stderr.write(`\n${d.call.name} failed: ${d.result.error.message}\n`);
    }
  }
  if (result.bailOuts.length > 0) {
    process.stderr.write(
      `\nbail-outs this turn:\n${result.bailOuts.map((b) => `  - ${b.code}: ${b.message}`).join("\n")}\n`,
    );
  }
}

const USAGE = `usage: tsx src/main.ts <natural-language request>

Examples:
  tsx src/main.ts "parse requisition REQ-1001"
  tsx src/main.ts "screen candidate CAND-2001 for REQ-1001"
  tsx src/main.ts "rank the candidates for REQ-1001, top 3"
  tsx src/main.ts "draft outreach to CAND-2002 for REQ-1001"          # dry-run by default
  tsx src/main.ts "schedule an interview for CAND-2003 with Dana and Wei"  # dry-run by default
  tsx src/main.ts "prepare reference checks for CAND-2001"            # dry-run by default

All data is synthetic (see src/fixtures/dataset.ts). Consequential macros
(outreach / scheduling / references) default to dry-run; add "and send it" to commit.

Environment:
  LLM_MODEL        model name (default qwen2.5:7b-instruct)
  OPENAI_BASE_URL  set to use an OpenAI-compatible provider instead of Ollama
  OPENAI_API_KEY   API key for the above
`;

main().catch((err: unknown) => {
  process.stderr.write(
    `\nhr-recruiting: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
