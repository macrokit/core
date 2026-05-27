import { MacroRegistry, Runtime } from "@macrokit/runtime";
import { OllamaAdapter, OpenAICompatibleAdapter } from "@macrokit/llm";
import { GitHubClient } from "./github-client.js";
import {
  closeStaleIssues,
  generateReleaseNotes,
  suggestReviewersMacro,
  triageIssue,
  triagePullRequest,
} from "./macros/index.js";

/**
 * Reference implementation entry point. Wires the registry, the LLM
 * adapter, and a shared GitHub client into a Runtime, then routes one
 * user turn through it. All five API-driven maintainer macros are
 * registered.
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

  // One shared GitHub client across all macros so token + base URL are
  // configured in one place. Macros pull it from ctx.tools.github.
  const github = new GitHubClient({
    ...(process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {}),
  });

  const registry = new MacroRegistry()
    .register(triagePullRequest)
    .register(triageIssue)
    .register(generateReleaseNotes)
    .register(closeStaleIssues)
    .register(suggestReviewersMacro);

  const runtime = new Runtime({
    registry,
    llm,
    toolSurfaces: { github },
    sessionLogPath: `.macrokit/sessions/${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.jsonl`,
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
      `\nbail-outs this turn:\n${result.bailOuts
        .map((b) => `  - ${b.code}: ${b.message}`)
        .join("\n")}\n`,
    );
  }
}

const USAGE = `usage: tsx src/main.ts <natural-language request>

Examples:
  tsx src/main.ts "triage PR 5 in macrokit/core"
  tsx src/main.ts "triage issue 12 in some/repo"
  tsx src/main.ts "generate release notes for macrokit/core from v0.0.1 to main"
  tsx src/main.ts "close stale issues in some/repo older than 120 days, dry-run"
  tsx src/main.ts "suggest reviewers for PR 5 in macrokit/core"

Environment:
  GITHUB_TOKEN          PAT for higher rate limits + mutations
  LLM_MODEL             model name (default qwen2.5:7b-instruct)
  OPENAI_BASE_URL       set to use an OpenAI-compatible provider instead of Ollama
  OPENAI_API_KEY        API key for the above
`;

main().catch((err: unknown) => {
  process.stderr.write(
    `\ngithub-maintainer: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
