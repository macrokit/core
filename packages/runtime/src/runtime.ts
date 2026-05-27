import { Dispatcher } from "./dispatcher.js";
import { MacroRegistry } from "./registry.js";
import { SessionLog } from "./session-log.js";
import type { ToolCall, ToolResult } from "./types.js";

export interface RuntimeOptions {
  registry: MacroRegistry;
  /** Path under which session logs are written, or undefined for in-memory. */
  sessionLogPath?: string;
  /** Tool surfaces injected into every macro context (HTTP, DB, browser, …). */
  toolSurfaces?: Record<string, unknown>;
}

/**
 * Runtime is the small composition object adopters interact with. In the
 * skeleton (Day 1) it exposes only `dispatch()` — direct tool-call invocation.
 * `chat()` (the full LLM-driven loop) lands when @macrokit/llm is wired in
 * on Day 2.
 */
export class Runtime {
  readonly registry: MacroRegistry;
  readonly log: SessionLog;
  private readonly dispatcher: Dispatcher;

  constructor(opts: RuntimeOptions) {
    this.registry = opts.registry;
    this.log = new SessionLog({ path: opts.sessionLogPath });
    this.dispatcher = new Dispatcher({
      registry: this.registry,
      log: this.log,
      toolSurfaces: opts.toolSurfaces,
    });
  }

  /** Dispatch a single tool call (router output) against the registry. */
  dispatch(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    return this.dispatcher.dispatch(call, signal);
  }
}
