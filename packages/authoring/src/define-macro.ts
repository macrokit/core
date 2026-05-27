import type { Macro, MacroContext, Schema } from "@macrokit/runtime";

/**
 * A test fixture: a recorded (args, result) pair, optionally with the tool
 * surfaces the handler is expected to interact with. testMacro() replays
 * fixtures against the handler.
 */
export interface MacroFixture<TInput = unknown, TOutput = unknown> {
  /** Optional label shown in test output. */
  name?: string;
  args: TInput;
  /** Expected handler output. */
  expected: TOutput;
  /** Optional mock tool surfaces injected as ctx.tools. */
  tools?: Record<string, unknown>;
}

/**
 * Macro definition — the same shape as @macrokit/runtime's Macro, plus an
 * optional fixtures array for tests and an optional `category` tag used by
 * the distillation gate to distinguish utility macros (bash, fetch, …) from
 * domain macros that encode real workflows.
 */
export interface MacroDefinition<TInput, TOutput> {
  name: string;
  intent: string;
  schema: Schema<TInput>;
  handler: (args: TInput, ctx: MacroContext) => Promise<TOutput>;
  /**
   * "domain" (default): an encoded workflow.
   * "utility": a generic primitive (bash, fetch, read_file, …). The
   * distillation gate uses this tag to spot sessions composing utility
   * macros in sequence — a sign a domain macro should be encoded.
   */
  category?: "domain" | "utility";
  fixtures?: ReadonlyArray<MacroFixture<TInput, TOutput>>;
}

/**
 * A macro authored via this helper. Carries the runtime's `Macro` interface
 * plus the authoring-time metadata (category, fixtures).
 */
export interface AuthoredMacro<TInput = unknown, TOutput = unknown>
  extends Macro<TInput, TOutput> {
  category: "domain" | "utility";
  fixtures: ReadonlyArray<MacroFixture<TInput, TOutput>>;
}

/**
 * Typed factory for macros. The output is assignable to `Macro` from the
 * runtime, so the same value is what you `register()` on a MacroRegistry.
 *
 * Validates `name` matches the registry's accepted pattern eagerly so you
 * catch typos at module load, not at the first dispatch.
 */
export function defineMacro<TInput, TOutput>(
  spec: MacroDefinition<TInput, TOutput>,
): AuthoredMacro<TInput, TOutput> {
  if (!spec.name.match(/^[a-z][a-z0-9_]*$/)) {
    throw new Error(
      `defineMacro: invalid name "${spec.name}". Macro names must match ` +
        `/^[a-z][a-z0-9_]*$/ — lowercase letters, digits, and underscores; ` +
        `must start with a letter.`,
    );
  }
  if (!spec.intent || spec.intent.trim().length === 0) {
    throw new Error(
      `defineMacro: "${spec.name}" is missing an intent string. The intent ` +
        `is what the router classifies the user request against — it cannot ` +
        `be empty.`,
    );
  }
  return {
    name: spec.name,
    intent: spec.intent,
    schema: spec.schema,
    handler: spec.handler,
    category: spec.category ?? "domain",
    fixtures: spec.fixtures ?? [],
  };
}
