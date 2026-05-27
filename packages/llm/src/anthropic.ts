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

export interface AnthropicAdapterOptions {
  /** API base URL. Override for proxies or compatible endpoints. */
  baseUrl?: string;
  /** Model name, e.g. "claude-sonnet-4-20250514". */
  model: string;
  /** Anthropic API key. */
  apiKey: string;
  /** anthropic-version header value. Default "2023-06-01". */
  apiVersion?: string;
  /** Custom fetch for tests. */
  fetch?: typeof fetch;
  /** Hard cap on tokens per response. Anthropic REQUIRES this — default 4096. */
  defaultMaxTokens?: number;
}

/**
 * Anthropic Messages API adapter. Maps Macrokit's normalized message +
 * tool-call shape to and from Anthropic's native format, which differs
 * from OpenAI in three notable ways:
 *
 *   1. The system prompt is a top-level string, not a message with
 *      role:"system".
 *   2. Tool calls and tool results are represented as content blocks of
 *      type "tool_use" / "tool_result" inside the assistant / user
 *      messages, not as separate role:"tool" messages.
 *   3. Tools are described as { name, description, input_schema } —
 *      OpenAI wraps everything in { type:"function", function:{ ... } }.
 *
 * Authentication uses x-api-key + anthropic-version headers, not Bearer.
 *
 * Tested without an API key via a stub fetch. With a real key the same
 * adapter drops into Runtime.chat() exactly like the OpenAI-compatible
 * one — same LLMAdapter contract.
 */
export class AnthropicAdapter implements LLMAdapter {
  readonly provider = "anthropic";
  readonly defaultModel: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultMaxTokens: number;

  constructor(opts: AnthropicAdapterOptions) {
    this.baseUrl = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
    this.defaultModel = opts.model;
    this.apiKey = opts.apiKey;
    this.apiVersion = opts.apiVersion ?? "2023-06-01";
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 4096;
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    const { system, messages } = splitSystem(opts.messages);
    const body: Record<string, unknown> = {
      model: opts.model ?? this.defaultModel,
      messages: messages.map(toAnthropicMessage),
      max_tokens: opts.maxTokens ?? this.defaultMaxTokens,
    };
    if (system) body.system = system;
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map(toAnthropicTool);
      if (opts.toolChoice) body.tool_choice = toAnthropicToolChoice(opts.toolChoice);
    }
    if (opts.temperature !== undefined) body.temperature = opts.temperature;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": this.apiVersion,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (cause) {
      throw new LLMAdapterError(
        `Network error calling Anthropic at ${this.baseUrl}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        { provider: this.provider, cause },
      );
    }

    if (!response.ok) {
      const errorBody = await safeReadText(response);
      throw new LLMAdapterError(
        `Anthropic returned ${response.status} ${response.statusText}: ${errorBody}`,
        { provider: this.provider, status: response.status },
      );
    }

    let payload: AnthropicResponse;
    try {
      payload = (await response.json()) as AnthropicResponse;
    } catch (cause) {
      throw new LLMAdapterError("Anthropic returned non-JSON response", {
        provider: this.provider,
        cause,
      });
    }
    return fromAnthropicResponse(payload);
  }
}

// ---------------------------------------------------------------------------
// Provider <-> normalized shape mappers
// ---------------------------------------------------------------------------

interface AnthropicTextBlock {
  type: "text";
  text: string;
}
interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicResponse {
  id?: string;
  type?: string;
  role?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Anthropic's API takes system as a top-level field, not a message. Pull
 * any system messages out of the array and concatenate them.
 */
function splitSystem(messages: ChatMessage[]): { system: string | undefined; messages: ChatMessage[] } {
  const systemParts: string[] = [];
  const rest: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      if (m.content) systemParts.push(m.content);
    } else {
      rest.push(m);
    }
  }
  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: rest,
  };
}

function toAnthropicMessage(m: ChatMessage): AnthropicMessage {
  // role:"tool" turns become user messages containing tool_result blocks.
  if (m.role === "tool") {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: m.toolCallId ?? "",
          content: m.content,
        },
      ],
    };
  }

  if (m.role === "assistant") {
    const blocks: AnthropicContentBlock[] = [];
    if (m.content && m.content.length > 0) {
      blocks.push({ type: "text", text: m.content });
    }
    for (const tc of m.toolCalls ?? []) {
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: tc.args,
      });
    }
    // Anthropic requires content to be non-empty.
    if (blocks.length === 0) blocks.push({ type: "text", text: "" });
    return { role: "assistant", content: blocks };
  }

  // user
  return { role: "user", content: m.content };
}

function toAnthropicTool(t: ToolSpec): AnthropicTool {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  };
}

function toAnthropicToolChoice(
  choice: NonNullable<CompleteOptions["toolChoice"]>,
): unknown {
  if (choice === "auto") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  if (choice === "none") return { type: "none" } as unknown;
  if (typeof choice === "object" && "name" in choice) {
    return { type: "tool", name: choice.name };
  }
  return { type: "auto" };
}

function fromAnthropicResponse(payload: AnthropicResponse): CompleteResult {
  const blocks = payload.content ?? [];
  let text = "";
  const toolCalls: NormalizedToolCall[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        args: block.input ?? {},
      });
    }
  }
  return {
    text,
    toolCalls,
    finishReason: normalizeFinishReason(payload.stop_reason ?? null),
    raw: payload,
  };
}

function normalizeFinishReason(reason: string | null): FinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case null:
    case undefined:
      return "unknown";
    default:
      return "unknown";
  }
}

async function safeReadText(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return "<unreadable body>";
  }
}
