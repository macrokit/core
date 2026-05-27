import { MacroRegistry, Runtime } from "@macrokit/runtime";
import { OllamaAdapter, OpenAICompatibleAdapter } from "@macrokit/llm";
import type { BrowserService } from "@macrokit/browser";
import { GitHubClient } from "./github-client.js";
import {
  captureWorkflowLog,
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
    .register(suggestReviewersMacro)
    .register(captureWorkflowLog);

  // Optional Playwright-backed BrowserService for capture_workflow_log.
  // Dynamic import keeps Playwright + chromium off the install path for
  // adopters who only use the API-driven macros.
  let browser: BrowserService | undefined;
  if (process.env.MACROKIT_BROWSER === "playwright") {
    browser = await wirePlaywrightBrowser();
  }

  const runtime = new Runtime({
    registry,
    llm,
    toolSurfaces: browser ? { github, browser } : { github },
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

async function wirePlaywrightBrowser(): Promise<BrowserService> {
  // Dynamic imports so Playwright is only loaded when actually requested.
  const [{ PlaywrightBrowserService }, { chromium }] = await Promise.all([
    import("@macrokit/browser"),
    import("playwright-core"),
  ]);
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  return new PlaywrightBrowserService({ page, browser, context });
}

const USAGE = `usage: tsx src/main.ts <natural-language request>

Examples:
  tsx src/main.ts "triage PR 5 in macrokit/core"
  tsx src/main.ts "triage issue 12 in some/repo"
  tsx src/main.ts "generate release notes for macrokit/core from v0.0.1 to main"
  tsx src/main.ts "close stale issues in some/repo older than 120 days, dry-run"
  tsx src/main.ts "suggest reviewers for PR 5 in macrokit/core"
  MACROKIT_BROWSER=playwright tsx src/main.ts \\
    "capture the workflow log for run 9876543210 in macrokit/core"

Environment:
  GITHUB_TOKEN          PAT for higher rate limits + mutations
  LLM_MODEL             model name (default qwen2.5:7b-instruct)
  OPENAI_BASE_URL       set to use an OpenAI-compatible provider instead of Ollama
  OPENAI_API_KEY        API key for the above
  MACROKIT_BROWSER      "playwright" enables capture_workflow_log via a
                        headless chromium (requires \`npx playwright install
                        chromium\` to have been run once)
`;

main().catch((err: unknown) => {
  process.stderr.write(
    `\ngithub-maintainer: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
