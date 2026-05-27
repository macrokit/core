import type { Task, Verdict } from "./types.js";

export interface ScoreInput {
  actualTool: string | null;
  actualArgs?: Record<string, unknown>;
}

export interface Score {
  verdict: Verdict;
  toolScore: number;
  argsScore: number;
}

/**
 * Score one task. Rules:
 *   - expected.tool === null:
 *       miss if actualTool is non-null; full (2pts) if also null.
 *   - expected.tool === "X":
 *       miss if actualTool !== "X" AND not the documented alternative.
 *       half (1pt) if actualTool is the documented alternative (args evaluated against alternative.args).
 *       tool_only (1pt) if tool matches but args don't.
 *       full (2pts) if both match.
 *
 * args_match requires every expected key to be present with the expected
 * value (== comparison). Extra args in actualArgs are ignored (providers
 * may include defaults). Numbers and booleans compared by value; strings
 * trimmed; nested objects/arrays compared by JSON.stringify.
 */
export function scoreTask(task: Task, input: ScoreInput): Score {
  const expectedTool = task.expected.tool;
  const expectedArgs = task.expected.args;
  const actualTool = input.actualTool;
  const actualArgs = input.actualArgs;

  // Case 1: no_macro
  if (expectedTool === null) {
    if (actualTool === null) {
      return { verdict: "full", toolScore: 1, argsScore: 1 };
    }
    return { verdict: "miss", toolScore: 0, argsScore: 0 };
  }

  // Case 2: free-text returned where a tool was expected
  if (actualTool === null) {
    return { verdict: "miss", toolScore: 0, argsScore: 0 };
  }

  // Case 3: exact-match the expected tool
  if (actualTool === expectedTool) {
    const argsOk = argsMatch(expectedArgs, actualArgs);
    return argsOk
      ? { verdict: "full", toolScore: 1, argsScore: 1 }
      : { verdict: "tool_only", toolScore: 1, argsScore: 0 };
  }

  // Case 4: documented alternative on an ambiguous task — half-credit
  if (task.alternative && actualTool === task.alternative.tool) {
    const altArgs = task.alternative.args;
    const argsOk = argsMatch(altArgs, actualArgs);
    return argsOk
      ? { verdict: "half", toolScore: 0.5, argsScore: 1 }
      : { verdict: "half", toolScore: 0.5, argsScore: 0 };
  }

  return { verdict: "miss", toolScore: 0, argsScore: 0 };
}

function argsMatch(
  expected: Record<string, unknown> | undefined,
  actual: Record<string, unknown> | undefined,
): boolean {
  if (!expected || Object.keys(expected).length === 0) return true;
  if (!actual) return false;
  for (const key of Object.keys(expected)) {
    if (!(key in actual)) return false;
    if (!valueEquals(expected[key], actual[key])) return false;
  }
  return true;
}

function valueEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  // Coerce stringy numbers — model might return "1234" instead of 1234.
  if (typeof a === "number" && typeof b === "string") {
    const n = Number(b);
    if (Number.isFinite(n) && n === a) return true;
  }
  if (typeof a === "string" && typeof b === "number") {
    const n = Number(a);
    if (Number.isFinite(n) && n === b) return true;
  }
  if (typeof a === "string" && typeof b === "string") {
    return a.trim() === b.trim();
  }
  // Booleans by value
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  // Fallback: structural via JSON
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
