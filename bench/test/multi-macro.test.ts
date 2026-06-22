/**
 * Offline harness test for the multi-macro routing experiment — no Ollama, no
 * network. A scripted adapter returns canned tool calls so we can prove the
 * registry, router wiring, frozen scoring, and confusion matrix are correct.
 * The real qwen2.5:7b run is a separate manual artifact (see the prereg).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CompleteOptions,
  CompleteResult,
  LLMAdapter,
} from "@macrokit/runtime";
import {
  ALL_MACRO_NAMES,
  aggregate,
  buildMultiMacroRegistry,
  renderConfusion,
  runMultiMacro,
  scorePrompt,
  type Prompt,
  type PromptFile,
} from "../src/multi-macro.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPTS = JSON.parse(
  readFileSync(join(HERE, "..", "multi-macro", "prompts.json"), "utf8"),
) as PromptFile;

/** Adapter that replays a prompt→toolcall script. null = no tool call. */
function scriptedAdapter(
  script: Record<string, { name: string; args: Record<string, unknown> } | null>,
): LLMAdapter {
  return {
    provider: "scripted",
    defaultModel: "scripted",
    async complete(opts: CompleteOptions): Promise<CompleteResult> {
      const user = [...opts.messages].reverse().find((m) => m.role === "user");
      const planned = script[user?.content ?? ""];
      if (!planned) {
        return { text: "I can't help with that.", toolCalls: [], finishReason: "stop" };
      }
      return {
        text: "",
        toolCalls: [{ id: "call_1", name: planned.name, args: planned.args }],
        finishReason: "tool_calls",
      };
    },
  };
}

describe("multi-macro registry", () => {
  it("registers all 11 reference macros with stubbed (offline) handlers", async () => {
    const reg = buildMultiMacroRegistry();
    expect(reg.list().map((m) => m.name).sort()).toEqual([...ALL_MACRO_NAMES].sort());
    expect(ALL_MACRO_NAMES).toHaveLength(11);
    // The stub handler echoes args and never touches the network/ctx.tools.
    const macro = reg.lookup("triage_paper")!;
    const echoed = await macro.handler({ paperId: "x" }, {} as never);
    expect(echoed).toEqual({ paperId: "x" });
  });
});

describe("frozen scoring", () => {
  const clear: Prompt = {
    id: "t", category: "clear", domain: "github",
    prompt: "p", expect: ["triage_issue"],
    args: { owner: "A", repo: "B", number: 5 },
  };

  it("clear: correct macro + normalized args (case-insensitive owner/repo, numeric)", () => {
    const s = scorePrompt(clear, "triage_issue", { owner: "a", repo: "b", number: "5" });
    expect(s.routingCorrect).toBe(true);
    expect(s.argsScored).toBe(true);
    expect(s.argsExact).toBe(true);
  });

  it("clear: wrong macro → routing fail, args NOT scored", () => {
    const s = scorePrompt(clear, "triage_pull_request", { owner: "a", repo: "b", number: 5 });
    expect(s.routingCorrect).toBe(false);
    expect(s.argsScored).toBe(false);
  });

  it("clear: right macro, one wrong arg key → exact=false, partial keys", () => {
    const s = scorePrompt(clear, "triage_issue", { owner: "a", repo: "WRONG", number: 5 });
    expect(s.routingCorrect).toBe(true);
    expect(s.argsExact).toBe(false);
    expect(s.argKeys.filter((k) => k.correct)).toHaveLength(2);
  });

  it("paperId: arxiv: prefix is stripped before comparison", () => {
    const p: Prompt = { id: "x", category: "clear", domain: "paper", prompt: "p",
      expect: ["triage_paper"], args: { paperId: "2401.12345" } };
    expect(scorePrompt(p, "triage_paper", { paperId: "arXiv:2401.12345" }).argsExact).toBe(true);
  });

  it("paperIds: order-insensitive set equality", () => {
    const p: Prompt = { id: "x", category: "clear", domain: "paper", prompt: "p",
      expect: ["compare_papers"], args: { paperIds: ["A", "B"] } };
    expect(scorePrompt(p, "compare_papers", { paperIds: ["b", "a"] }).argsExact).toBe(true);
    expect(scorePrompt(p, "compare_papers", { paperIds: ["a"] }).argsExact).toBe(false);
  });

  it("ambiguous: any accepted macro is correct; args not scored", () => {
    const p: Prompt = { id: "a", category: "ambiguous", domain: "github", prompt: "p",
      expect: ["triage_pull_request", "suggest_reviewers"], args: {} };
    expect(scorePrompt(p, "suggest_reviewers", {}).routingCorrect).toBe(true);
    expect(scorePrompt(p, "triage_issue", {}).routingCorrect).toBe(false);
  });

  it("negative: no-route is correct, a dispatched macro is a hallucination", () => {
    const p: Prompt = { id: "n", category: "negative", domain: "none", prompt: "p",
      expect: [], args: {} };
    expect(scorePrompt(p, null, undefined).routingCorrect).toBe(true);
    expect(scorePrompt(p, "triage_issue", {}).routingCorrect).toBe(false);
  });
});

describe("runMultiMacro end-to-end (scripted, offline)", () => {
  it("routes via the LLM, scores, and builds a confusion matrix", async () => {
    const subset: Prompt[] = [
      { id: "p1", category: "clear", domain: "github", prompt: "triage pr",
        expect: ["triage_pull_request"], args: { owner: "o", repo: "r", number: 1 } },
      { id: "p2", category: "clear", domain: "paper", prompt: "triage paper",
        expect: ["triage_paper"], args: { paperId: "2401.00001" } },
      { id: "p3", category: "negative", domain: "none", prompt: "weather", expect: [], args: {} },
      { id: "p4", category: "clear", domain: "github", prompt: "confuse",
        expect: ["triage_issue"], args: { owner: "o", repo: "r", number: 2 } },
    ];
    const adapter = scriptedAdapter({
      "triage pr": { name: "triage_pull_request", args: { owner: "o", repo: "r", number: 1 } },
      "triage paper": { name: "triage_paper", args: { paperId: "arXiv:2401.00001" } },
      "weather": null,
      // p4: model picks the WRONG macro — proves the confusion matrix records it.
      "confuse": { name: "triage_pull_request", args: { owner: "o", repo: "r", number: 2 } },
    });

    const results = await runMultiMacro(adapter, subset);
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId.p1!.routingCorrect).toBe(true);
    expect(byId.p1!.argsExact).toBe(true);
    expect(byId.p2!.actual).toBe("triage_paper");
    expect(byId.p2!.argsExact).toBe(true); // arxiv: prefix normalized
    expect(byId.p3!.actual).toBeNull();
    expect(byId.p3!.routingCorrect).toBe(true);
    expect(byId.p4!.routingCorrect).toBe(false);
    expect(byId.p4!.actual).toBe("triage_pull_request");

    const s = aggregate(results);
    expect(s.routingAccuracyPositives).toBeCloseTo(2 / 3); // p1,p2 right, p4 wrong
    expect(s.noRouteAccuracy).toBe(1);
    expect(s.argKeyAccuracy).toBe(1); // only p1,p2 args scored, all correct
    // Confusion: gold triage_issue was answered as triage_pull_request.
    expect(s.confusion["triage_issue"]!["triage_pull_request"]).toBe(1);
    expect(renderConfusion(s)).toContain("gold \\ actual");
  });
});

describe("frozen prompt set", () => {
  it("is well-formed: 34 prompts, valid macros, category invariants", () => {
    const macros = new Set(ALL_MACRO_NAMES);
    expect(PROMPTS.prompts).toHaveLength(34);
    for (const p of PROMPTS.prompts) {
      for (const m of p.expect) expect(macros.has(m)).toBe(true);
      if (p.category === "negative") expect(p.expect).toHaveLength(0);
      if (p.category === "clear") expect(p.expect).toHaveLength(1);
      if (p.category === "ambiguous") expect(p.expect.length).toBeGreaterThanOrEqual(2);
    }
    const n = (c: string) => PROMPTS.prompts.filter((p) => p.category === c).length;
    expect([n("clear"), n("ambiguous"), n("negative")]).toEqual([24, 4, 6]);
  });
});
