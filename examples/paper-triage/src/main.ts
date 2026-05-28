import { MacroRegistry, Runtime } from "@macrokit/runtime";
import { OllamaAdapter, OpenAICompatibleAdapter } from "@macrokit/llm";
import { OpenAlexClient, SemanticScholarClient } from "./api-client.js";
import {
  bibliographyLookup,
  checkOpenAccess,
  comparePapers,
  findRelatedPapers,
  triagePaper,
} from "./macros/index.js";

/**
 * Reference implementation entry point. Wires the registry, a shared
 * Semantic Scholar + OpenAlex client into ctx.tools, an LLM adapter, and
 * a Runtime — then dispatches one user turn.
 *
 * Structurally parallel to examples/github-maintainer/src/main.ts. The
 * two examples share the same shape so an adopter can compare them side-
 * by-side and see what stays the same vs. what changes with the vertical.
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

  const semanticScholar = new SemanticScholarClient({
    ...(process.env.SEMANTIC_SCHOLAR_API_KEY ? { apiKey: process.env.SEMANTIC_SCHOLAR_API_KEY } : {}),
  });
  const openAlex = new OpenAlexClient({
    ...(process.env.OPENALEX_CONTACT_EMAIL ? { contactEmail: process.env.OPENALEX_CONTACT_EMAIL } : {}),
  });

  const registry = new MacroRegistry()
    .register(triagePaper)
    .register(comparePapers)
    .register(findRelatedPapers)
    .register(bibliographyLookup)
    .register(checkOpenAccess);

  const runtime = new Runtime({
    registry,
    llm,
    toolSurfaces: { semanticScholar, openAlex },
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
  tsx src/main.ts "triage paper 2401.12345"
  tsx src/main.ts "compare 2401.12345 and 1706.03762"
  tsx src/main.ts "find 5 papers related to 1706.03762 about training stability"
  tsx src/main.ts "look up 3 papers about retrieval-augmented generation"
  tsx src/main.ts "is 10.1145/3372297.3417883 open access?"

Environment:
  LLM_MODEL                model name (default qwen2.5:7b-instruct)
  OPENAI_BASE_URL          set to use an OpenAI-compatible provider instead of Ollama
  OPENAI_API_KEY           API key for the above
  SEMANTIC_SCHOLAR_API_KEY (optional) raises S2 rate limits
  OPENALEX_CONTACT_EMAIL   (optional) puts you in OpenAlex's "polite pool"
`;

main().catch((err: unknown) => {
  process.stderr.write(
    `\npaper-triage: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
