import { MacroRegistry, Runtime } from "@macrokit/runtime";
import { OllamaAdapter, OpenAICompatibleAdapter } from "@macrokit/llm";
import { triagePullRequest } from "./macros.js";

/**
 * Dogfood entry point. Wires Macrokit's public APIs only — runtime,
 * adapter, registry, dispatcher. If anything I do here reaches past
 * those, the abstraction is wrong and the SDK needs work.
 */
async function main(): Promise<void> {
  const userMessage = process.argv.slice(2).join(" ").trim();
  if (!userMessage) {
    process.stderr.write(
      "usage: tsx src/main.ts <natural-language request>\n" +
        "  e.g. \"triage PR 123 in microsoft/vscode\"\n",
    );
    process.exit(2);
  }

  const llm = process.env.OPENAI_BASE_URL
    ? new OpenAICompatibleAdapter({
        baseUrl: process.env.OPENAI_BASE_URL,
        model: process.env.LLM_MODEL ?? "gpt-4o-mini",
        apiKey: process.env.OPENAI_API_KEY ?? "",
      })
    : new OllamaAdapter({
        model: process.env.LLM_MODEL ?? "qwen2.5:7b-instruct",
      });

  const runtime = new Runtime({
    registry: new MacroRegistry().register(triagePullRequest),
    llm,
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
}

main().catch((err: unknown) => {
  process.stderr.write(
    `\npr-triager: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
