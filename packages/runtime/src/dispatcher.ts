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

    const tools = this.scopeTools(macro.name, macro.capabilities);

    try {
      const value = await macro.handler(args, {
        log: this.log,
        tools,
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
      const error: MacroError =
        cause instanceof CapabilityViolation
          ? {
              code: "capability_violation",
              step: "capability_check",
              message: cause.message,
              hint:
                "Add the surface to the macro's capabilities array, " +
                "or remove the access.",
            }
          : {
              code: "handler_threw",
              message:
                cause instanceof Error
                  ? cause.message
                  : `Handler failed: ${String(cause)}`,
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

  /**
   * Produce the `ctx.tools` value handed to a macro, enforcing its declared
   * capability manifest (D-017).
   *
   * - `capabilities === undefined` → legacy-permissive: return the raw
   *   surfaces, but log a one-line advisory. Only declared macros are
   *   enforced, so the existing seed macros / bench harness keep working.
   * - declared (incl. `[]`) → return a Proxy that yields a surface only for a
   *   declared key and throws a `CapabilityViolation` on any undeclared key.
   *   Enumeration traps are scoped too so the surface can't leak via
   *   `has`/`ownKeys`/`getOwnPropertyDescriptor`/`Object.keys`.
   */
  private scopeTools(
    macroName: string,
    capabilities: string[] | undefined,
  ): Record<string, unknown> {
    if (capabilities === undefined) {
      this.log.append({
        type: "system",
        message: `macro "${macroName}" declares no capabilities — running unrestricted`,
      });
      return this.toolSurfaces;
    }

    const allowed = new Set(capabilities);
    const surfaces = this.toolSurfaces;

    const isAllowed = (prop: PropertyKey): boolean =>
      typeof prop === "string" && allowed.has(prop);
    const isSurface = (prop: PropertyKey): boolean =>
      typeof prop === "string" && Object.prototype.hasOwnProperty.call(surfaces, prop);

    // MEMBRANE: proxy a fresh, extensible `{}` target and close over the real
    // surfaces. Proxying the surfaces object directly makes the enumeration
    // traps violate the Proxy invariants when `toolSurfaces` is frozen
    // (non-configurable own props cannot be hidden by `ownKeys`), which throws
    // a confusing error AND leaks the hidden surface name. A benign target has
    // no own props, so the scoped traps below are invariant-safe regardless of
    // whether the caller froze their surfaces.
    return new Proxy({} as Record<string, unknown>, {
      get(_t, prop): unknown {
        if (isSurface(prop) && !isAllowed(prop)) {
          throw new CapabilityViolation(
            `macro "${macroName}" accessed undeclared capability "${String(prop)}"`,
          );
        }
        // Return the real surface for a declared key; everything else (unknown
        // string keys, symbols like Symbol.toStringTag) is inert undefined.
        return isAllowed(prop) ? surfaces[prop as string] : undefined;
      },
      has(_t, prop): boolean {
        return isAllowed(prop) && isSurface(prop);
      },
      ownKeys(): ArrayLike<string | symbol> {
        return Reflect.ownKeys(surfaces).filter((k) => isAllowed(k));
      },
      getOwnPropertyDescriptor(_t, prop): PropertyDescriptor | undefined {
        if (!isAllowed(prop) || !isSurface(prop)) return undefined;
        // `configurable: true` is REQUIRED: the key is absent from the `{}`
        // target, and a Proxy may only report an absent-on-target key as
        // existing when its descriptor is configurable.
        return {
          value: surfaces[prop as string],
          writable: false,
          enumerable: true,
          configurable: true,
        };
      },
    });
  }
}

/**
 * Thrown by the capability-scoped Proxy when a macro reaches for a tool
 * surface it did not declare. Caught in `dispatch` and normalized into a
 * `capability_violation` MacroError + session-log entry.
 */
class CapabilityViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityViolation";
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
