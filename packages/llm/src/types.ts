/**
 * Macrokit's LLM types are deliberately a small, provider-agnostic subset.
 * Each concrete adapter (OpenAI-compatible, Ollama, …) maps the provider's
 * native message + tool-call shape to these types on the way in and out.
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  /** Free-form text content. May be empty when the message is a tool_calls turn. */
  content: string;
  /** Set on `assistant` turns that emitted one or more tool calls. */
  toolCalls?: NormalizedToolCall[];
  /** Set on `tool` turns to pair the result back to the assistant call. */
  toolCallId?: string;
  /** Optional human-readable name (e.g. the tool name on tool turns). */
  name?: string;
}

export interface NormalizedToolCall {
  /** Provider-issued call id, used to pair results back. */
  id: string;
  /** Macro name. */
  name: string;
  /** Parsed JSON arguments. Adapters parse the raw provider payload. */
  args: Record<string, unknown>;
}

/**
 * A tool specification, in JSON Schema 7 dialect for `parameters`. The shape
 * matches OpenAI's tool-call schema, which the other supported providers
 * have adopted compatibly.
 */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CompleteOptions {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Force a specific tool ("required", a tool name) or none ("none"). */
  toolChoice?: "auto" | "required" | "none" | { name: string };
  signal?: AbortSignal;
}

export type FinishReason =
  | "stop"
  | "tool_calls"
  | "length"
  | "content_filter"
  | "error"
  | "unknown";

export interface CompleteResult {
  /** Assistant text. Often empty when toolCalls are present. */
  text: string;
  toolCalls: NormalizedToolCall[];
  finishReason: FinishReason;
  /** Provider-native response, for adapters or debuggers that need it. */
  raw?: unknown;
}

export interface LLMAdapter {
  readonly provider: string;
  readonly defaultModel: string;
  complete(opts: CompleteOptions): Promise<CompleteResult>;
}

/** Thrown when an adapter cannot reach or parse the provider. */
export class LLMAdapterError extends Error {
  constructor(
    message: string,
    readonly options: {
      provider: string;
      status?: number;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "LLMAdapterError";
  }
}
