import { Dispatcher } from "./dispatcher.js";
import type { LLMAdapter, ChatMessage } from "./llm-types.js";
import { MacroRegistry } from "./registry.js";
import { IntentRouter, type ChatResult } from "./router.js";
import { SessionLog } from "./session-log.js";
import type { ToolCall, ToolResult } from "./types.js";

export interface RuntimeOptions {
  registry: MacroRegistry;
  /** Path under which session logs are written, or undefined for in-memory. */
  sessionLogPath?: string;
  /** Tool surfaces injected into every macro context (HTTP, DB, browser, …). */
  toolSurfaces?: Record<string, unknown>;
  /** LLM adapter the IntentRouter drives. Omit if you only need dispatch(). */
  llm?: LLMAdapter;
  /** Optional fallback adapter for bail-out escalation. */
  fallbackLlm?: LLMAdapter;
  /** Hard cap on tool-call iterations per chat() call. Default 8. */
  maxIterations?: number;
  /** Extra system prompt text appended to the default routing instructions. */
  systemPromptExtra?: string;
}

/**
 * Runtime is the composition object adopters interact with. Exposes:
 *   - dispatch()  → direct tool-call invocation (router output goes here)
 *   - chat()      → end-to-end LLM loop (router + dispatch). Requires an llm.
 */
export class Runtime {
  readonly registry: MacroRegistry;
  readonly log: SessionLog;
  private readonly dispatcher: Dispatcher;
  private readonly router?: IntentRouter;

  constructor(opts: RuntimeOptions) {
    this.registry = opts.registry;
    this.log = new SessionLog({ path: opts.sessionLogPath });
    this.dispatcher = new Dispatcher({
      registry: this.registry,
      log: this.log,
      toolSurfaces: opts.toolSurfaces,
    });
    if (opts.llm) {
      this.router = new IntentRouter({
        registry: this.registry,
        adapter: opts.llm,
        dispatcher: this.dispatcher,
        log: this.log,
        ...(opts.fallbackLlm ? { fallbackAdapter: opts.fallbackLlm } : {}),
        ...(opts.maxIterations !== undefined ? { maxIterations: opts.maxIterations } : {}),
        ...(opts.systemPromptExtra !== undefined ? { systemPromptExtra: opts.systemPromptExtra } : {}),
      });
    }
  }

  /** Dispatch a single tool call (router output) against the registry. */
  dispatch(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    return this.dispatcher.dispatch(call, signal);
  }

  /**
   * Run one chat turn through the LLM router. Requires an llm to be passed
   * at construction time.
   */
  async chat(
    userMessage: string,
    options?: {
      history?: ChatMessage[];
      signal?: AbortSignal;
      model?: string;
      temperature?: number;
      maxTokens?: number;
    },
  ): Promise<ChatResult> {
    if (!this.router) {
      throw new Error(
        "Runtime.chat() requires an llm adapter. Pass `llm` to the Runtime constructor.",
      );
    }
    return this.router.chat(userMessage, options);
  }
}
