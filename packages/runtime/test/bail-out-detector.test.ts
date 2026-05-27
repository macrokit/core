import { describe, it, expect } from "vitest";
import { detectBailOut } from "../src/bail-out-detector.js";
import type { CompleteResult, ToolSpec } from "../src/index.js";

const TOOLS: ToolSpec[] = [
  { name: "echo", description: "", parameters: {} },
  { name: "triage", description: "", parameters: {} },
];

function res(over: Partial<CompleteResult> = {}): CompleteResult {
  return { text: "", toolCalls: [], finishReason: "stop", ...over };
}

describe("detectBailOut", () => {
  it("passes a clean tool call", () => {
    const r = detectBailOut(
      res({ toolCalls: [{ id: "1", name: "echo", args: { text: "hi" } }] }),
      { tools: TOOLS },
    );
    expect(r.fired).toBe(false);
  });

  it("fires explicit_escalation when the user asks for the strong model", () => {
    const r = detectBailOut(res({ text: "ok" }), {
      tools: TOOLS,
      userMessage: "this is hard, can you use Claude for this one?",
    });
    expect(r.fired).toBe(true);
    if (r.fired) expect(r.code).toBe("explicit_escalation");
  });

  it("fires tool_call_as_text when content is JSON-shaped tool call", () => {
    const r = detectBailOut(
      res({ text: '{"tool": "echo", "args": {"text":"hi"}}' }),
      { tools: TOOLS },
    );
    expect(r.fired).toBe(true);
    if (r.fired) expect(r.code).toBe("tool_call_as_text");
  });

  it("fires tool_call_as_text on `tool_call: name(args)` style", () => {
    const r = detectBailOut(res({ text: "tool_call: echo(text='hi')" }), { tools: TOOLS });
    expect(r.fired).toBe(true);
    if (r.fired) expect(r.code).toBe("tool_call_as_text");
  });

  it("fires unknown_tool when the model invents a tool name", () => {
    const r = detectBailOut(
      res({ toolCalls: [{ id: "1", name: "delete_universe", args: {} }] }),
      { tools: TOOLS },
    );
    expect(r.fired).toBe(true);
    if (r.fired) expect(r.code).toBe("unknown_tool");
  });

  it("fires repeated_tool_call on identical back-to-back calls", () => {
    const r = detectBailOut(
      res({ toolCalls: [{ id: "2", name: "echo", args: { text: "hi" } }] }),
      { tools: TOOLS, recentToolCalls: [{ name: "echo", args: { text: "hi" } }] },
    );
    expect(r.fired).toBe(true);
    if (r.fired) expect(r.code).toBe("repeated_tool_call");
  });

  it("does not fire repeated_tool_call when args differ", () => {
    const r = detectBailOut(
      res({ toolCalls: [{ id: "2", name: "echo", args: { text: "bye" } }] }),
      { tools: TOOLS, recentToolCalls: [{ name: "echo", args: { text: "hi" } }] },
    );
    expect(r.fired).toBe(false);
  });

  it("fires no_tool_when_required when the caller required one", () => {
    const r = detectBailOut(res({ text: "I think you should..." }), {
      tools: TOOLS,
      requireToolCall: true,
    });
    expect(r.fired).toBe(true);
    if (r.fired) expect(r.code).toBe("no_tool_when_required");
  });

  it("passes when no tool call is required and the model returned prose", () => {
    const r = detectBailOut(res({ text: "Hello! How can I help you today?" }), { tools: TOOLS });
    expect(r.fired).toBe(false);
  });
});
