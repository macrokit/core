import type { MacroError, ToolCall, ToolResult } from "./types.js";
import type { MacroRegistry } from "./registry.js";
import type { SessionLog } from "./session-log.js";

export interface DispatcherOptions {
  registry: MacroRegistry;
  log: SessionLog;
  /**
   * Tool surfaces injected into every macro's MacroContext.tools.
   * Adopters wire in HTTP clients, DB handles, browser services, etc., here.
   */
  toolSurfaces?: Record<string, unknown>;
}

/**
 * Dispatcher = "given a ToolCall the router produced, run the macro,
 * capture failures as structured context, append to the session log."
 *
 * Three failure shapes are normalized:
 *   - macro_not_found       → router asked for a nonexistent macro
 *   - schema_validation_failed → args did not pass macro.schema.parse
 *   - handler_threw         → handler raised an exception
 * Each gets a stable `code` so weak models can route on the code, not the
 * prose. See docs/THE_PATTERN.md §3 (failure-context contract).
 */
export class Dispatcher {
  private readonly registry: MacroRegistry;
  private readonly log: SessionLog;
  private readonly toolSurfaces: Record<string, unknown>;

  constructor(opts: DispatcherOptions) {
    this.registry = opts.registry;
    this.log = opts.log;
    this.toolSurfaces = opts.toolSurfaces ?? {};
  }

  async dispatch(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const abortSignal = signal ?? new AbortController().signal;
    const macro = this.registry.lookup(call.tool);

    if (!macro) {
      const error: MacroError = {
        code: "macro_not_found",
        message: `No macro registered with name "${call.tool}".`,
        hint:
          "Check that the router prompt advertises this macro name, " +
          "and that the registry has it registered.",
      };
      this.log.append({ type: "tool_result", callId: call.callId, error });
      return { ok: false, error, callId: call.callId };
    }

    let args: unknown;
    try {
      args = macro.schema.parse(call.args);
    } catch (cause) {
      const error: MacroError = {
        code: "schema_validation_failed",
        message: `Arguments did not match schema for macro "${call.tool}".`,
        step: "schema",
        hint:
          "Re-emit the tool call with arguments that match the published " +
          "schema. Do not retry the same arguments.",
        cause: serializeCause(cause),
      };
      this.log.append({ type: "tool_result", callId: call.callId, error });
      return { ok: false, error, callId: call.callId };
    }

    this.log.append({
      type: "tool_call",
      tool: call.tool,
      args,
      callId: call.callId,
    });

    try {
      const value = await macro.handler(args, {
        log: this.log,
        tools: this.toolSurfaces,
        signal: abortSignal,
      });
      this.log.append({
        type: "tool_result",
        tool: call.tool,
        callId: call.callId,
        ok: true,
      });
      return { ok: true, value, callId: call.callId };
    } catch (cause) {
      const error: MacroError = {
        code: "handler_threw",
        message:
          cause instanceof Error ? cause.message : `Handler failed: ${String(cause)}`,
        step: "handler",
        cause: serializeCause(cause),
      };
      this.log.append({
        type: "tool_result",
        tool: call.tool,
        callId: call.callId,
        error,
      });
      return { ok: false, error, callId: call.callId };
    }
  }
}

function serializeCause(cause: unknown): unknown {
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message,
      ...(cause.stack ? { stack: cause.stack } : {}),
    };
  }
  return cause;
}
