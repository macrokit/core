import { describe, it, expect } from "vitest";
import { OpenAICompatibleAdapter } from "../src/openai-compatible.js";
import { OllamaAdapter } from "../src/ollama.js";
import type { ToolSpec } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fake fetch helpers
// ---------------------------------------------------------------------------

function fakeFetch(
  recorder: { lastUrl?: string; lastInit?: RequestInit; lastBody?: unknown },
  response: unknown,
  init: { status?: number } = {},
): typeof fetch {
  return (async (input: RequestInfo | URL, requestInit?: RequestInit) => {
    recorder.lastUrl = typeof input === "string" ? input : input.toString();
    recorder.lastInit = requestInit;
    recorder.lastBody = requestInit?.body
      ? JSON.parse(requestInit.body as string)
      : undefined;
    return new Response(JSON.stringify(response), {
      status: init.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

const TRIAGE_TOOL: ToolSpec = {
  name: "triage_arxiv_paper",
  description: "summarize and classify an arXiv paper",
  parameters: {
    type: "object",
    properties: {
      paperId: { type: "string" },
    },
    required: ["paperId"],
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenAICompatibleAdapter", () => {
  it("posts to {baseUrl}/chat/completions with bearer auth", async () => {
    const rec: { lastUrl?: string; lastInit?: RequestInit } = {};
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: "https://api.example.com/v1",
      model: "test-model",
      apiKey: "sk-test",
      fetch: fakeFetch(rec, {
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }),
    });
    await adapter.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(rec.lastUrl).toBe("https://api.example.com/v1/chat/completions");
    expect((rec.lastInit?.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-test",
    );
  });

  it("trims trailing slashes from baseUrl", async () => {
    const rec: { lastUrl?: string } = {};
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: "https://api.example.com/v1///",
      model: "m",
      apiKey: "k",
      fetch: fakeFetch(rec, {
        choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }],
      }),
    });
    await adapter.complete({ messages: [] });
    expect(rec.lastUrl).toBe("https://api.example.com/v1/chat/completions");
  });

  it("translates normalized tool calls to provider shape on the way in", async () => {
    const rec: { lastBody?: any } = {};
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: "https://api.example.com/v1",
      model: "m",
      apiKey: "k",
      fetch: fakeFetch(rec, {
        choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }],
      }),
    });
    await adapter.complete({
      messages: [
        { role: "user", content: "triage 2401.123" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call_1", name: "triage_arxiv_paper", args: { paperId: "2401.123" } },
          ],
        },
        { role: "tool", content: '{"score":0.7}', toolCallId: "call_1" },
      ],
      tools: [TRIAGE_TOOL],
    });
    const body = rec.lastBody;
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "triage_arxiv_paper",
          description: "summarize and classify an arXiv paper",
          parameters: TRIAGE_TOOL.parameters,
        },
      },
    ]);
    // assistant message with tool_calls must have content=null per OpenAI spec
    expect(body.messages[1].content).toBeNull();
    expect(body.messages[1].tool_calls[0]).toEqual({
      id: "call_1",
      type: "function",
      function: {
        name: "triage_arxiv_paper",
        arguments: JSON.stringify({ paperId: "2401.123" }),
      },
    });
    // tool result message preserves the call id
    expect(body.messages[2].tool_call_id).toBe("call_1");
  });

  it("normalizes provider tool_calls back into NormalizedToolCall", async () => {
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: "https://api.example.com/v1",
      model: "m",
      apiKey: "k",
      fetch: fakeFetch(
        {},
        {
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_abc",
                    type: "function",
                    function: {
                      name: "triage_arxiv_paper",
                      arguments: '{"paperId":"2401.123"}',
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ),
    });
    const result = await adapter.complete({
      messages: [{ role: "user", content: "triage 2401.123" }],
      tools: [TRIAGE_TOOL],
    });
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      { id: "call_abc", name: "triage_arxiv_paper", args: { paperId: "2401.123" } },
    ]);
    expect(result.text).toBe("");
  });

  it("survives malformed tool-call argument JSON without crashing", async () => {
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: "https://api.example.com/v1",
      model: "m",
      apiKey: "k",
      fetch: fakeFetch(
        {},
        {
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "triage_arxiv_paper", arguments: "{malformed" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ),
    });
    const result = await adapter.complete({
      messages: [{ role: "user", content: "x" }],
      tools: [TRIAGE_TOOL],
    });
    expect(result.toolCalls[0]?.args).toEqual({ __raw: "{malformed" });
  });

  it("throws LLMAdapterError on non-2xx responses with the body in the message", async () => {
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: "https://api.example.com/v1",
      model: "m",
      apiKey: "k",
      fetch: fakeFetch({}, { error: "rate limited" }, { status: 429 }),
    });
    await expect(
      adapter.complete({ messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow(/429.*rate limited/);
  });
});

describe("OllamaAdapter", () => {
  it("targets http://localhost:11434/v1/chat/completions by default", async () => {
    const rec: { lastUrl?: string } = {};
    const adapter = new OllamaAdapter({
      model: "qwen2.5:7b-instruct",
      fetch: fakeFetch(rec, {
        choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }],
      }),
    });
    await adapter.complete({ messages: [] });
    expect(rec.lastUrl).toBe("http://localhost:11434/v1/chat/completions");
    expect(adapter.provider).toBe("ollama");
  });

  it("honors a custom baseUrl", async () => {
    const rec: { lastUrl?: string } = {};
    const adapter = new OllamaAdapter({
      baseUrl: "http://remote:11434",
      model: "qwen2.5:7b-instruct",
      fetch: fakeFetch(rec, {
        choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }],
      }),
    });
    await adapter.complete({ messages: [] });
    expect(rec.lastUrl).toBe("http://remote:11434/v1/chat/completions");
  });
});
