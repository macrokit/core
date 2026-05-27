import { SessionLog, type MacroContext } from "@macrokit/runtime";
import type { AuthoredMacro, MacroFixture } from "./define-macro.js";

export interface TestMacroResult<TOutput> {
  name: string;
  passed: boolean;
  /** Actual handler output. Present even on failure. */
  actual?: TOutput;
  expected: TOutput;
  error?: string;
}

export interface TestMacroOptions<TOutput> {
  /** Override or extend the fixtures attached to the macro. */
  fixtures?: ReadonlyArray<MacroFixture<unknown, TOutput>>;
  /** Custom equality predicate. Defaults to deep structural equality. */
  equals?: (a: TOutput, b: TOutput) => boolean;
  /** Tool surfaces shared across all fixtures (per-fixture wins). */
  tools?: Record<string, unknown>;
}

/**
 * Replay a macro's fixtures against its handler. Returns one result per
 * fixture, including the actual output for debugging. Does not throw — the
 * caller decides what to do with failures (assert, log, …).
 */
export async function testMacro<TInput, TOutput>(
  macro: AuthoredMacro<TInput, TOutput>,
  opts: TestMacroOptions<TOutput> = {},
): Promise<Array<TestMacroResult<TOutput>>> {
  const fixtures = (opts.fixtures ?? macro.fixtures) as ReadonlyArray<
    MacroFixture<TInput, TOutput>
  >;
  const eq = opts.equals ?? deepEqual;
  const results: Array<TestMacroResult<TOutput>> = [];

  let i = 0;
  for (const f of fixtures) {
    i += 1;
    const name = f.name ?? `${macro.name} fixture #${i}`;
    const log = new SessionLog();
    const ctx: MacroContext = {
      log,
      tools: { ...(opts.tools ?? {}), ...(f.tools ?? {}) },
      signal: new AbortController().signal,
    };
    try {
      // macro.schema.parse normalizes inputs (defaults, coercions). Mirrors
      // what the dispatcher would do at runtime.
      const args = macro.schema.parse(f.args);
      const actual = await macro.handler(args, ctx);
      const passed = eq(actual, f.expected);
      results.push({ name, passed, actual, expected: f.expected });
    } catch (err) {
      results.push({
        name,
        passed: false,
        expected: f.expected,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
      return false;
    }
  }
  return true;
}
