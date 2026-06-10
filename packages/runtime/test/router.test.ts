import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  MacroRegistry,
  Runtime,
  type ChatMessage,
  type CompleteOptions,
  type CompleteResult,
  type LLMAdapter,
  type Macro,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Macros
// ---------------------------------------------------------------------------

const echo: Macro<{ text: string; shout: boolean }, { text: string }> = {
  name: "echo",
  intent: "echo back whatever the user said, optionally shouting",
  schema: z.object({ text: z.string(), shout: z.boolean().default(false) }),
  handler: async ({ text, shout }) => ({ text: shout ? text.toUpperCase() : text }),
};

const explodes: Macro<Record<string, never>, never> = {
  name: "explodes",
  intent: "always throws",
  schema: z.object({}),
  handler: async () => {
    throw new Error("boom");
  },
};

// ---------------------------------------------------------------------------
// Programmable fake adapter
// ---------------------------------------------------------------------------

class FakeAdapter implements LLMAdapter {
  readonly provider = "fake";
  readonly defaultModel = "fake-1";
  readonly calls: CompleteOptions[] = [];
  private queue: CompleteResult[];

  constructor(queue: CompleteResult[]) {
    this.queue = [...queue];
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    this.calls.push(opts);
    const next = this.queue.shift();
    if (!next) throw new Error("FakeAdapter: queue exhausted");
    return next;
  }
}

const toolCallResult = (name: string, args: Record<string, unknown>, id = "c1"): CompleteResult => ({
  text: "",
  toolCalls: [{ id, name, args }],
  finishReason: "tool_calls",
});

const finalResult = (text: string): CompleteResult => ({
  text,
  toolCalls: [],
  finishReason: "stop",
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IntentRouter (via Runtime.chat)", () => {
  it("runs the canonical loop: route → dispatch → respond", async () => {
    const adapter = new FakeAdapter([
      toolCallResult("echo", { text: "hello", shout: true }),
      finalResult("I shouted HELLO for you."),
    ]);
    const runtime = new Runtime({
      registry: new MacroRegistry().register(echo),
      llm: adapter,
    });

    const result = await runtime.chat("please shout hello");
    expect(result.text).toBe("I shouted HELLO for you.");
    expect(result.exhausted).toBe(false);
    expect(result.dispatched).toHaveLength(1);
    expect(result.dispatched[0]?.call.name).toBe("echo");
    expect(result.dispatched[0]?.result.ok).toBe(true);
    if (result.dispatched[0]?.result.ok) {
      expect(result.dispatched[0].result.value).toEqual({ text: "HELLO" });
    }
    // adapter saw two turns: route, then continue-after-tool
    expect(adapter.calls).toHaveLength(2);
  });

  it("includes the rendered macro list in the system prompt", async () => {
    const adapter = new FakeAdapter([finalResult("hi there")]);
    const runtime = new Runtime({
      registry: new MacroRegistry().register(echo).register(explodes),
      llm: adapter,
    });
    await runtime.chat("hi");
    const systemMsg = adapter.calls[0]!.messages[0]!;
    expect(systemMsg.role).toBe("system");
    expect(systemMsg.content).toContain("echo");
    expect(systemMsg.content).toContain("explodes");
    expect(systemMsg.content).toContain("intent router");
  });

  it("returns free-form text when the model emits no tool calls", async () => {
    const adapter = new FakeAdapter([finalResult("I do not know.")]);
    const runtime = new Runtime({
      registry: new MacroRegistry().register(echo),
      llm: adapter,
    });
    const result = await runtime.chat("what's the airspeed velocity of an unladen swallow?");
    expect(result.text).toBe("I do not know.");
    expect(result.dispatched).toEqual([]);
    expect(adapter.calls).toHaveLength(1);
  });

  it("surfaces handler failures as tool messages and continues the loop", async () => {
    const adapter = new FakeAdapter([
      toolCallResult("explodes", {}),
      finalResult("The macro threw."),
    ]);
    const runtime = new Runtime({
      registry: new MacroRegistry().register(explodes),
      llm: adapter,
    });
    const result = await runtime.chat("explode for me");
    expect(result.text).toBe("The macro threw.");
    expect(result.dispatched[0]?.result.ok).toBe(false);

    // Second adapter call should see the tool result in its message history.
    const secondTurnMessages = adapter.calls[1]!.messages;
    const toolMsg = secondTurnMessages.find((m: ChatMessage) => m.role === "tool");
    expect(toolMsg?.content).toContain("handler_threw");
  });

  it("escalates to the fallback adapter when bail-out fires (per-turn)", async () => {
    // Iteration 1: weak emits a tool call as TEXT — bail-out fires →
    //              fallback re-runs the turn and returns a real tool call →
    //              echo dispatches.
    // Iteration 2: weak runs again and produces the final assistant reply.
    const weak = new FakeAdapter([
      { text: '{"tool":"echo","args":{"text":"hi"}}', toolCalls: [], finishReason: "stop" },
      finalResult("said hi."),
    ]);
    const strong = new FakeAdapter([toolCallResult("echo", { text: "hi" })]);
    const runtime = new Runtime({
      registry: new MacroRegistry().register(echo),
      llm: weak,
      fallbackLlm: strong,
    });
    const result = await runtime.chat("say hi");
    expect(result.bailOuts).toHaveLength(1);
    expect(result.bailOuts[0]?.code).toBe("tool_call_as_text");
    expect(result.text).toBe("said hi.");
    expect(result.dispatched).toHaveLength(1);
    expect(strong.calls).toHaveLength(1);
    expect(weak.calls).toHaveLength(2);
  });

  it("halts (does not ship bad output) when bail-out fires and no fallback is configured", async () => {
    // weak emits a tool call as TEXT — bail-out fires, no fallback → the turn
    // must HALT: the prose is not returned as a normal answer and nothing is
    // dispatched. (Previously this shipped the flagged output silently.)
    const weak = new FakeAdapter([
      { text: '{"tool":"echo","args":{"text":"hi"}}', toolCalls: [], finishReason: "stop" },
      finalResult("should-not-reach"),
    ]);
    const runtime = new Runtime({
      registry: new MacroRegistry().register(echo),
      llm: weak,
    });
    const result = await runtime.chat("say hi");
    expect(result.bailOuts).toHaveLength(1);
    expect(result.bailOuts[0]?.code).toBe("tool_call_as_text");
    expect(result.bailedOut).toBe(true);
    expect(result.dispatched).toHaveLength(0);
    expect(result.text).not.toBe("should-not-reach");
    expect(weak.calls).toHaveLength(1); // halted after the first bad result
  });

  it("respects maxIterations and reports exhausted=true", async () => {
    const adapter = new FakeAdapter([
      toolCallResult("echo", { text: "a" }),
      toolCallResult("echo", { text: "b" }),
      toolCallResult("echo", { text: "c" }),
    ]);
    const runtime = new Runtime({
      registry: new MacroRegistry().register(echo),
      llm: adapter,
      maxIterations: 3,
    });
    const result = await runtime.chat("loop forever");
    expect(result.exhausted).toBe(true);
    expect(result.dispatched).toHaveLength(3);
  });

  it("throws when chat() is called without an llm configured", async () => {
    const runtime = new Runtime({ registry: new MacroRegistry().register(echo) });
    await expect(runtime.chat("anything")).rejects.toThrow(/requires an llm adapter/);
  });

  it("includes both user and assistant turns in the returned history", async () => {
    const adapter = new FakeAdapter([finalResult("hello back")]);
    const runtime = new Runtime({
      registry: new MacroRegistry().register(echo),
      llm: adapter,
    });
    const result = await runtime.chat("hi");
    expect(result.history.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(result.history[1]?.content).toBe("hello back");
  });
});
