import { detectBailOut, type BailOutFire } from "./bail-out-detector.js";
import type { Dispatcher } from "./dispatcher.js";
import type {
  ChatMessage,
  CompleteOptions,
  LLMAdapter,
  NormalizedToolCall,
  ToolSpec,
} from "./llm-types.js";
import type { MacroRegistry } from "./registry.js";
import type { SessionLog } from "./session-log.js";
import type { Macro, ToolResult } from "./types.js";

export interface IntentRouterOptions {
  registry: MacroRegistry;
  adapter: LLMAdapter;
  dispatcher: Dispatcher;
  log: SessionLog;

  /**
   * Optional fallback adapter the router escalates to when the bail-out
   * detector fires (e.g. a frontier API used as the strong fallback when
   * the local model is out of its depth).
   */
  fallbackAdapter?: LLMAdapter;

  /** Hard cap on tool-call iterations per chat() call. Default 8. */
  maxIterations?: number;

  /** Extra system prompt text appended to the default routing instructions. */
  systemPromptExtra?: string;

  /** Conversation history carried across chat() calls. */
  history?: ChatMessage[];

  /** Forwarded to the adapter. */
  temperature?: number;
  maxTokens?: number;
  model?: string;
}

export interface ChatResult {
  /** The final assistant text returned to the caller. */
  text: string;
  /** Tool calls dispatched during this turn, in order. */
  dispatched: Array<{ call: NormalizedToolCall; result: ToolResult }>;
  /** Bail-out events that fired during this turn (escalations, repairs). */
  bailOuts: BailOutFire[];
  /** Updated conversation history (caller may persist and pass back next turn). */
  history: ChatMessage[];
  /** Whether the loop exhausted maxIterations without producing a final answer. */
  exhausted: boolean;
}

/**
 * IntentRouter — the runtime loop described in docs/THE_PATTERN.md §4 and
 * docs/ARCHITECTURE.md §3.
 *
 * Single-turn semantics: chat(userMessage) runs the model, dispatches any
 * tool calls deterministically, optionally escalates to a fallback adapter
 * when the bail-out detector fires, and returns the final assistant text
 * plus a record of everything that happened.
 */
export class IntentRouter {
  private readonly registry: MacroRegistry;
  private readonly adapter: LLMAdapter;
  private readonly fallback?: LLMAdapter;
  private readonly dispatcher: Dispatcher;
  private readonly log: SessionLog;
  private readonly maxIterations: number;
  private readonly systemPromptExtra?: string;

  constructor(opts: IntentRouterOptions) {
    this.registry = opts.registry;
    this.adapter = opts.adapter;
    this.fallback = opts.fallbackAdapter;
    this.dispatcher = opts.dispatcher;
    this.log = opts.log;
    this.maxIterations = opts.maxIterations ?? 8;
    this.systemPromptExtra = opts.systemPromptExtra;
  }

  async chat(
    userMessage: string,
    options: {
      history?: ChatMessage[];
      signal?: AbortSignal;
      model?: string;
      temperature?: number;
      maxTokens?: number;
    } = {},
  ): Promise<ChatResult> {
    const history: ChatMessage[] = [...(options.history ?? [])];
    const dispatched: ChatResult["dispatched"] = [];
    const bailOuts: BailOutFire[] = [];
    const recentToolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

    const macros = this.registry.list();
    const tools = macros.map(macroToToolSpec);
    const systemMessage = this.buildSystemMessage(macros);

    history.push({ role: "user", content: userMessage });
    this.log.append({ type: "user", text: userMessage });

    let iteration = 0;
    while (iteration < this.maxIterations) {
      iteration += 1;

      const completeOpts: CompleteOptions = {
        messages: [{ role: "system", content: systemMessage }, ...history],
        tools,
        signal: options.signal,
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      };

      let result = await this.adapter.complete(completeOpts);

      // Bail-out detection + optional fallback escalation.
      const detection = detectBailOut(result, {
        tools,
        recentToolCalls,
        userMessage,
      });
      if (detection.fired) {
        bailOuts.push(detection);
        this.log.append({
          type: "system",
          subtype: "bail_out",
          code: detection.code,
          message: detection.message,
          hint: detection.hint,
        });

        if (this.fallback) {
          result = await this.fallback.complete(completeOpts);
          this.log.append({
            type: "system",
            subtype: "escalated",
            to: this.fallback.provider,
          });
        }
        // If no fallback, we use the original result and continue. The
        // upstream caller can read bailOuts and decide what to do next turn.
      }

      // If the model emitted tool calls, dispatch them.
      if (result.toolCalls.length > 0) {
        // Append the assistant turn so the next iteration has the call in history.
        history.push({
          role: "assistant",
          content: result.text,
          toolCalls: result.toolCalls,
        });

        for (const call of result.toolCalls) {
          const dispatchResult = await this.dispatcher.dispatch(
            { tool: call.name, args: call.args, callId: call.id },
            options.signal,
          );
          dispatched.push({ call, result: dispatchResult });
          recentToolCalls.unshift({ name: call.name, args: call.args });

          history.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: JSON.stringify(
              dispatchResult.ok
                ? { ok: true, value: dispatchResult.value }
                : { ok: false, error: dispatchResult.error },
            ),
          });
        }
        // Continue loop: model gets a chance to respond to the tool results.
        continue;
      }

      // No tool calls — this is the model's final answer.
      history.push({ role: "assistant", content: result.text });
      this.log.append({ type: "assistant", text: result.text });
      return { text: result.text, dispatched, bailOuts, history, exhausted: false };
    }

    // Loop exhausted; return whatever we have.
    this.log.append({
      type: "system",
      subtype: "max_iterations_exhausted",
      maxIterations: this.maxIterations,
    });
    return { text: "", dispatched, bailOuts, history, exhausted: true };
  }

  private buildSystemMessage(macros: ReadonlyArray<Macro>): string {
    const base = [
      "You are an intent router. Your job is to map the user's request to one of",
      "the registered macros below and call it with the right arguments. Do NOT",
      "plan multi-step workflows yourself — each macro is already a complete",
      "encoded workflow.",
      "",
      "Rules:",
      "1. If the user's request matches a macro, call that macro. One tool call",
      "   per turn unless multiple are clearly independent.",
      "2. If no macro matches, answer in plain text — do NOT invent a tool name.",
      "3. Never emit a tool call as JSON in your message content. Use the",
      "   structured tool_calls field your provider exposes.",
      "4. When a tool returns, summarize the result for the user in one or two",
      "   short sentences. Do not re-call the same tool with the same arguments.",
      "",
      `Available macros (${macros.length}):`,
      ...macros.map((m) => `  - ${m.name}: ${m.intent}`),
    ].join("\n");
    return this.systemPromptExtra ? `${base}\n\n${this.systemPromptExtra}` : base;
  }
}

function macroToToolSpec(m: Macro): ToolSpec {
  const params = extractJsonSchema(m.schema);
  return {
    name: m.name,
    description: m.intent,
    parameters: params,
  };
}

/**
 * Best-effort extraction of JSON Schema from a Schema<T>. Supports:
 *   - zod schemas (via `_def` + `toJSONSchema()` if available, fallback to passthrough)
 *   - schemas that already carry a `jsonSchema` property
 *   - schemas that expose `.toJsonSchema()` method
 * Otherwise returns a permissive empty object — the model will see only the
 * macro's `intent` description and may still produce valid arguments.
 */
function extractJsonSchema(schema: unknown): Record<string, unknown> {
  const s = schema as Record<string, unknown> | null | undefined;
  if (s == null) return { type: "object", properties: {} };

  if (typeof s.jsonSchema === "object" && s.jsonSchema !== null) {
    return s.jsonSchema as Record<string, unknown>;
  }
  if (typeof s.toJsonSchema === "function") {
    try {
      const json = (s.toJsonSchema as () => unknown)();
      if (json && typeof json === "object") return json as Record<string, unknown>;
    } catch {
      // fall through
    }
  }
  return { type: "object", properties: {}, additionalProperties: true };
}
