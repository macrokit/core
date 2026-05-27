import {
  LLMAdapterError,
  type ChatMessage,
  type CompleteOptions,
  type CompleteResult,
  type FinishReason,
  type LLMAdapter,
  type NormalizedToolCall,
  type ToolSpec,
} from "./types.js";

export interface OpenAICompatibleOptions {
  /** Base URL up to and including /v1, e.g. "https://api.openai.com/v1". */
  baseUrl: string;
  /** Model id sent in every request unless overridden by CompleteOptions.model. */
  model: string;
  /** API key. May be a placeholder (e.g. "ollama") for providers that don't require one. */
  apiKey?: string;
  /** Provider name for telemetry / error messages. Default "openai-compatible". */
  provider?: string;
  /**
   * Custom fetch implementation. Defaults to global fetch. Useful for tests
   * and for adopters routing through a custom transport.
   */
  fetch?: typeof fetch;
  /** Additional headers sent on every request. */
  headers?: Record<string, string>;
}

/**
 * OpenAI-compatible chat-completions adapter. One adapter covers OpenAI,
 * DeepSeek, Qwen, Zhipu, Kimi, Together, OpenRouter, Ollama's /v1 surface,
 * llama.cpp's HTTP server, and any other provider that speaks the OpenAI
 * chat-completions schema.
 *
 * The adapter translates Macrokit's normalized message + tool-call shape to
 * the provider on the way in, and translates the provider's response back
 * to Macrokit's normalized shape on the way out.
 */
export class OpenAICompatibleAdapter implements LLMAdapter {
  readonly provider: string;
  readonly defaultModel: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;

  constructor(opts: OpenAICompatibleOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.defaultModel = opts.model;
    this.apiKey = opts.apiKey;
    this.provider = opts.provider ?? "openai-compatible";
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.headers = opts.headers ?? {};
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    const body: Record<string, unknown> = {
      model: opts.model ?? this.defaultModel,
      messages: opts.messages.map(toProviderMessage),
    };
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map(toProviderTool);
      if (opts.toolChoice) body.tool_choice = toProviderToolChoice(opts.toolChoice);
    }
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          ...this.headers,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (cause) {
      throw new LLMAdapterError(
        `Network error calling ${this.provider} at ${this.baseUrl}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        { provider: this.provider, cause },
      );
    }

    if (!response.ok) {
      const errorBody = await safeReadText(response);
      throw new LLMAdapterError(
        `${this.provider} returned ${response.status} ${response.statusText}: ${errorBody}`,
        { provider: this.provider, status: response.status },
      );
    }

    let payload: ProviderCompletionResponse;
    try {
      payload = (await response.json()) as ProviderCompletionResponse;
    } catch (cause) {
      throw new LLMAdapterError(`${this.provider} returned non-JSON response`, {
        provider: this.provider,
        cause,
      });
    }

    return fromProviderResponse(payload);
  }
}

// ---------------------------------------------------------------------------
// Provider <-> normalized shape mappers
// ---------------------------------------------------------------------------

interface ProviderMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ProviderToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ProviderToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** OpenAI returns arguments as a JSON-encoded string. */
    arguments: string;
  };
}

interface ProviderTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ProviderCompletionResponse {
  choices: Array<{
    message: ProviderMessage;
    finish_reason: string | null;
  }>;
}

function toProviderMessage(m: ChatMessage): ProviderMessage {
  const base: ProviderMessage = {
    role: m.role,
    content: m.content,
  };
  if (m.toolCalls && m.toolCalls.length > 0) {
    base.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.args) },
    }));
    // OpenAI requires content === null when tool_calls is set.
    if (base.content === "") base.content = null;
  }
  if (m.toolCallId) base.tool_call_id = m.toolCallId;
  if (m.name) base.name = m.name;
  return base;
}

function toProviderTool(t: ToolSpec): ProviderTool {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  };
}

function toProviderToolChoice(
  choice: NonNullable<CompleteOptions["toolChoice"]>,
): unknown {
  if (typeof choice === "string") return choice;
  return { type: "function", function: { name: choice.name } };
}

function fromProviderResponse(payload: ProviderCompletionResponse): CompleteResult {
  const choice = payload.choices?.[0];
  if (!choice) {
    return { text: "", toolCalls: [], finishReason: "error", raw: payload };
  }
  const msg = choice.message ?? { role: "assistant", content: "" };
  const toolCalls: NormalizedToolCall[] = (msg.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    args: safeParseJson(tc.function.arguments),
  }));
  return {
    text: msg.content ?? "",
    toolCalls,
    finishReason: normalizeFinishReason(choice.finish_reason),
    raw: payload,
  };
}

function normalizeFinishReason(reason: string | null): FinishReason {
  switch (reason) {
    case "stop":
    case "tool_calls":
    case "length":
    case "content_filter":
      return reason;
    case null:
    case undefined:
      return "unknown";
    default:
      return "unknown";
  }
}

function safeParseJson(s: string): Record<string, unknown> {
  if (!s) return {};
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return { __raw: s };
  }
}

async function safeReadText(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return "<unreadable body>";
  }
}
