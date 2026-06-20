/**
 * Minimal schema interface. Compatible with zod, valibot, arktype, or any
 * library whose schemas expose a `parse(input) -> T` method that throws on
 * invalid input. Keeping the surface this small means @macrokit/runtime has
 * no hard schema-library dependency.
 */
export interface Schema<T> {
  parse(input: unknown): T;
}

/**
 * A macro is the unit of distilled knowledge. See docs/THE_PATTERN.md §3.
 */
export interface Macro<TInput = unknown, TOutput = unknown> {
  /** Stable identifier. Used by the router as the tool name. */
  name: string;
  /** Natural-language description matched against user intent at routing time. */
  intent: string;
  /** Argument schema. The dispatcher calls .parse() before invoking the handler. */
  schema: Schema<TInput>;
  /** Deterministic handler. The encoded workflow. */
  handler: (args: TInput, ctx: MacroContext) => Promise<TOutput>;
  /**
   * Declared capability manifest (D-017): the tool-surface keys this macro
   * may access from `ctx.tools` (e.g. `["github"]`). Granularity is
   * surface-level — method-level scoping is a future refinement.
   *
   * Enforcement is by the dispatcher:
   *   - `undefined` → legacy-permissive: full tool access, with a one-line
   *     advisory logged. Lets adoption be incremental (the seed macros and
   *     bench harness keep working untouched).
   *   - declared (including `[]`) → access to any undeclared key throws a
   *     `capability_violation` MacroError at runtime; `[]` denies everything.
   */
  capabilities?: string[];
}

export interface MacroContext {
  /** Append-only session log handle. */
  log: SessionLogLike;
  /** Tool surfaces the adopter wires in at runtime-construction time. */
  tools: Record<string, unknown>;
  /** Abort signal for long-running handlers. */
  signal: AbortSignal;
}

/** A tool-call the router emits, normalized across LLM providers. */
export interface ToolCall {
  tool: string;
  args: unknown;
  /** Provider-specific identifier used to pair tool_result back. */
  callId?: string;
}

export type ToolResult<T = unknown> =
  | { ok: true; value: T; callId?: string }
  | { ok: false; error: MacroError; callId?: string };

/**
 * Structured failure context. Handlers throw or return errors that the
 * dispatcher normalizes into this shape; the weak model sees this and routes
 * to a recovery macro by pattern-matching the shape, not by reasoning about
 * the prose.
 */
export interface MacroError {
  /** Machine-readable error code. */
  code: string;
  /** Human-readable message. */
  message: string;
  /** Which step in the handler failed, if known. */
  step?: string;
  /** Suggestion for downstream recovery — e.g. another macro name. */
  hint?: string;
  /** Original error chain, redacted for serialization. */
  cause?: unknown;
}

/**
 * Forward-declared shape for SessionLog so types.ts has no import cycles.
 * The concrete implementation lives in session-log.ts.
 */
export interface SessionLogLike {
  append(entry: SessionLogEntryInput): void;
  readonly entries: ReadonlyArray<SessionLogEntry>;
}

export type SessionLogEntryType =
  | "system"
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result";

export interface SessionLogEntry {
  ts: string;
  type: SessionLogEntryType;
  [key: string]: unknown;
}

export type SessionLogEntryInput = Omit<SessionLogEntry, "ts"> & {
  ts?: string;
};
