import { describe, it, expect } from "vitest";
import { AnthropicAdapter } from "../src/anthropic.js";
import type { ToolSpec } from "../src/types.js";

function fakeFetch(
  rec: { lastUrl?: string; lastInit?: RequestInit; lastBody?: any },
  response: unknown,
  init: { status?: number } = {},
): typeof fetch {
  return (async (input: RequestInfo | URL, requestInit?: RequestInit) => {
    rec.lastUrl = typeof input === "string" ? input : input.toString();
    rec.lastInit = requestInit;
    rec.lastBody = requestInit?.body ? JSON.parse(requestInit.body as string) : undefined;
    return new Response(JSON.stringify(response), {
      status: init.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

const TOOL: ToolSpec = {
  name: "triage_pull_request",
  description: "triage a PR",
  parameters: {
    type: "object",
    properties: { owner: { type: "string" }, repo: { type: "string" }, number: { type: "integer" } },
    required: ["owner", "repo", "number"],
  },
};

describe("AnthropicAdapter", () => {
  it("POSTs to /v1/messages with x-api-key + anthropic-version headers", async () => {
    const rec: any = {};
    const adapter = new AnthropicAdapter({
      model: "claude-sonnet-4-20250514",
      apiKey: "sk-ant-test",
      fetch: fakeFetch(rec, {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
      }),
    });
    await adapter.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(rec.lastUrl).toBe("https://api.anthropic.com/v1/messages");
    const headers = rec.lastInit.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("lifts system messages to a top-level `system` field", async () => {
    const rec: any = {};
    const adapter = new AnthropicAdapter({
      model: "x",
      apiKey: "k",
      fetch: fakeFetch(rec, { content: [{ type: "text", text: "" }], stop_reason: "end_turn" }),
    });
    await adapter.complete({
      messages: [
        { role: "system", content: "You are a router." },
        { role: "user", content: "hi" },
      ],
    });
    expect(rec.lastBody.system).toBe("You are a router.");
    expect(rec.lastBody.messages).toHaveLength(1);
    expect(rec.lastBody.messages[0].role).toBe("user");
  });

  it("requires max_tokens (Anthropic constraint) and applies default", async () => {
    const rec: any = {};
    const adapter = new AnthropicAdapter({
      model: "x",
      apiKey: "k",
      fetch: fakeFetch(rec, { content: [{ type: "text", text: "" }], stop_reason: "end_turn" }),
    });
    await adapter.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(typeof rec.lastBody.max_tokens).toBe("number");
    expect(rec.lastBody.max_tokens).toBe(4096);
  });

  it("renders tools as { name, description, input_schema } (no function wrapping)", async () => {
    const rec: any = {};
    const adapter = new AnthropicAdapter({
      model: "x",
      apiKey: "k",
      fetch: fakeFetch(rec, { content: [{ type: "text", text: "" }], stop_reason: "end_turn" }),
    });
    await adapter.complete({ messages: [{ role: "user", content: "hi" }], tools: [TOOL] });
    expect(rec.lastBody.tools).toEqual([
      {
        name: "triage_pull_request",
        description: "triage a PR",
        input_schema: TOOL.parameters,
      },
    ]);
  });

  it("normalizes tool_use blocks into NormalizedToolCall objects", async () => {
    const adapter = new AnthropicAdapter({
      model: "x",
      apiKey: "k",
      fetch: fakeFetch({}, {
        id: "msg_2",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_abc",
            name: "triage_pull_request",
            input: { owner: "macrokit", repo: "core", number: 5 },
          },
        ],
        stop_reason: "tool_use",
      }),
    });
    const result = await adapter.complete({
      messages: [{ role: "user", content: "triage PR 5 in macrokit/core" }],
      tools: [TOOL],
    });
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      { id: "toolu_abc", name: "triage_pull_request", args: { owner: "macrokit", repo: "core", number: 5 } },
    ]);
    expect(result.text).toBe("");
  });

  it("converts assistant tool_calls back into tool_use blocks on the way in", async () => {
    const rec: any = {};
    const adapter = new AnthropicAdapter({
      model: "x",
      apiKey: "k",
      fetch: fakeFetch(rec, { content: [{ type: "text", text: "" }], stop_reason: "end_turn" }),
    });
    await adapter.complete({
      messages: [
        { role: "user", content: "triage PR 5 in macrokit/core" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "toolu_1", name: "triage_pull_request", args: { owner: "macrokit", repo: "core", number: 5 } },
          ],
        },
        { role: "tool", content: '{"classification":"bug"}', toolCallId: "toolu_1" },
      ],
    });
    expect(rec.lastBody.messages[1].role).toBe("assistant");
    const assistantBlocks = rec.lastBody.messages[1].content;
    expect(assistantBlocks).toEqual([
      {
        type: "tool_use",
        id: "toolu_1",
        name: "triage_pull_request",
        input: { owner: "macrokit", repo: "core", number: 5 },
      },
    ]);
    expect(rec.lastBody.messages[2].role).toBe("user"); // tool turn becomes user
    expect(rec.lastBody.messages[2].content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: '{"classification":"bug"}',
    });
  });

  it("maps stop_reason values to FinishReason correctly", async () => {
    const cases: Array<[string, "stop" | "tool_calls" | "length" | "unknown"]> = [
      ["end_turn", "stop"],
      ["stop_sequence", "stop"],
      ["tool_use", "tool_calls"],
      ["max_tokens", "length"],
      ["weird_one", "unknown"],
    ];
    for (const [reason, expected] of cases) {
      const adapter = new AnthropicAdapter({
        model: "x",
        apiKey: "k",
        fetch: fakeFetch({}, { content: [{ type: "text", text: "" }], stop_reason: reason }),
      });
      const r = await adapter.complete({ messages: [{ role: "user", content: "x" }] });
      expect(r.finishReason, `stop_reason=${reason}`).toBe(expected);
    }
  });

  it("throws LLMAdapterError on non-2xx with body included", async () => {
    const adapter = new AnthropicAdapter({
      model: "x",
      apiKey: "bad-key",
      fetch: fakeFetch({}, { error: { type: "authentication_error", message: "invalid key" } }, { status: 401 }),
    });
    await expect(
      adapter.complete({ messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow(/401.*invalid key/);
  });

  it("translates toolChoice values to Anthropic's format", async () => {
    const rec: any = {};
    const adapter = new AnthropicAdapter({
      model: "x",
      apiKey: "k",
      fetch: fakeFetch(rec, { content: [{ type: "text", text: "" }], stop_reason: "end_turn" }),
    });
    await adapter.complete({ messages: [{ role: "user", content: "x" }], tools: [TOOL], toolChoice: "required" });
    expect(rec.lastBody.tool_choice).toEqual({ type: "any" });
    await adapter.complete({ messages: [{ role: "user", content: "x" }], tools: [TOOL], toolChoice: { name: "triage_pull_request" } });
    expect(rec.lastBody.tool_choice).toEqual({ type: "tool", name: "triage_pull_request" });
  });
});
