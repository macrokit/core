import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

/**
 * The distillation gate. THE_PATTERN.md §5.
 *
 *   "Every session that touches a workflow without an existing macro must
 *    encode that workflow as a macro before ending."
 *
 * This module reads session logs and finds violations: user turns in which
 * the model composed three-or-more separate macro dispatches in a row. That
 * sequence is a candidate for being a single composite macro the adopter
 * should encode before merging.
 *
 * Pure functions for the analysis — easy to test. The CLI wraps these.
 */

export interface SessionLogEntry {
  ts: string;
  type: "user" | "assistant" | "tool_call" | "tool_result" | "system";
  [key: string]: unknown;
}

export interface UserTurn {
  startedAtIndex: number;
  endedAtIndex: number;
  userText: string;
  toolCalls: Array<{ name: string; argsHash: string }>;
}

export interface GateViolation {
  /** Which file the session log lives in. */
  sessionPath: string;
  /** 1-based index of the violating user turn within the session. */
  turnIndex: number;
  /** What the user asked. */
  userText: string;
  /** Macros called, in order, with arg hashes for de-duping in suggestions. */
  toolCalls: ReadonlyArray<{ name: string; argsHash: string }>;
  /** Suggested macro name + stub code. */
  suggestion: {
    name: string;
    stub: string;
  };
}

export interface GateOptions {
  /** Trigger when a user turn dispatches >= this many distinct macros. Default 3. */
  threshold?: number;
  /**
   * Optional category lookup: if provided, called per macro name and may
   * return "utility" to mark a macro as a generic primitive. Sequences
   * containing only domain macros are weighted higher in suggestions.
   */
  categoryOf?: (name: string) => "domain" | "utility" | undefined;
  /**
   * Optional "is this name an already-encoded macro?" predicate. When provided
   * (the CLI builds it from the project's registered macros), ONLY un-encoded
   * calls — raw primitives, i.e. a workflow done *without* a macro — count
   * toward the gate. This is the documented distillation-gate semantics
   * (THE_PATTERN.md §5): flag the un-encoded workflow so it gets encoded; do
   * NOT flag a turn that merely chained existing macros. Without it, the gate
   * falls back to counting all distinct calls (legacy behavior).
   */
  isEncoded?: (name: string) => boolean;
}

const DEFAULT_THRESHOLD = 3;

export function analyzeSession(
  sessionPath: string,
  entries: ReadonlyArray<SessionLogEntry>,
  opts: GateOptions = {},
): GateViolation[] {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const turns = extractUserTurns(entries);
  const violations: GateViolation[] = [];

  turns.forEach((turn, i) => {
    // Count distinct macros (de-duped by name+args). A loop of one macro is
    // a different concern (repeated_tool_call bail-out), not a distillation
    // gate concern.
    const isEncoded = opts.isEncoded;
    const distinct = new Set<string>();
    for (const tc of turn.toolCalls) {
      // When we can tell encoded macros from raw primitives, only RAW (un-encoded)
      // calls count — a turn that chained existing macros is not an un-encoded
      // workflow and must not be flagged. Without the predicate, count all
      // distinct calls (legacy behavior).
      if (isEncoded && isEncoded(tc.name)) continue;
      distinct.add(`${tc.name}|${tc.argsHash}`);
    }
    if (distinct.size >= threshold) {
      violations.push({
        sessionPath,
        turnIndex: i + 1,
        userText: turn.userText,
        toolCalls: turn.toolCalls,
        suggestion: buildSuggestion(turn, opts),
      });
    }
  });
  return violations;
}

export function extractUserTurns(
  entries: ReadonlyArray<SessionLogEntry>,
): UserTurn[] {
  const turns: UserTurn[] = [];
  let current: UserTurn | null = null;

  for (let idx = 0; idx < entries.length; idx++) {
    const e = entries[idx]!;
    if (e.type === "user") {
      if (current !== null) {
        current.endedAtIndex = idx - 1;
        turns.push(current);
      }
      current = {
        startedAtIndex: idx,
        endedAtIndex: idx,
        userText: typeof e.text === "string" ? e.text : "",
        toolCalls: [],
      };
      continue;
    }
    if (current !== null && e.type === "tool_call" && typeof e.tool === "string") {
      current.toolCalls.push({
        name: e.tool,
        argsHash: stableHash(e.args),
      });
    }
    if (current !== null && e.type === "assistant") {
      current.endedAtIndex = idx;
      turns.push(current);
      current = null;
    }
  }

  if (current !== null) {
    (current as UserTurn).endedAtIndex = entries.length - 1;
    turns.push(current);
  }
  return turns;
}

function buildSuggestion(
  turn: UserTurn,
  opts: GateOptions,
): { name: string; stub: string } {
  const categoryOf = opts.categoryOf ?? (() => undefined);
  const names = [...new Set(turn.toolCalls.map((t) => t.name))];
  const domainNames = names.filter((n) => categoryOf(n) !== "utility");
  const subjects = domainNames.length > 0 ? domainNames : names;

  // Derive a candidate name from the macros + user text: take the first
  // verb-noun fragment we can find. Fall back to "composite_" + joined names.
  const fromText = derivePhrase(turn.userText);
  const name = fromText ?? `composite_${subjects.slice(0, 3).join("_")}`;
  const stub = renderStub(name, turn);
  return { name, stub };
}

function derivePhrase(text: string): string | undefined {
  // Very simple: pick first two lowercase words from the user text and join
  // with underscores. Good enough as a *suggestion* — adopter will rename.
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
  if (tokens.length === 0) return undefined;
  return tokens.slice(0, 2).join("_").slice(0, 40);
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "you", "can",
  "please", "would", "should", "could", "have", "has", "had", "into", "onto",
]);

function renderStub(name: string, turn: UserTurn): string {
  const macroList = turn.toolCalls.map((t) => `    //   - ${t.name}`).join("\n");
  return [
    "import { defineMacro } from \"@macrokit/authoring\";",
    "import { z } from \"zod\";",
    "",
    "export const " + name + " = defineMacro({",
    `  name: "${name}",`,
    `  intent: ${JSON.stringify(turn.userText.slice(0, 100) || "TODO: describe the workflow")},`,
    "  schema: z.object({",
    "    // TODO: extract the arguments this workflow needs from the user request",
    "  }),",
    "  handler: async (args, ctx) => {",
    "    // This workflow currently happens as several router-driven calls:",
    macroList,
    "    // Encode the sequence here so the router dispatches it as ONE macro.",
    "    return {};",
    "  },",
    "});",
  ].join("\n");
}

function stableHash(args: unknown): string {
  return stableStringify(args).slice(0, 80);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map(
        (k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}

// ---------------------------------------------------------------------------
// File-walking entry points used by the CLI
// ---------------------------------------------------------------------------

export function loadSessionLog(path: string): SessionLogEntry[] {
  const text = readFileSync(path, "utf8");
  const out: SessionLogEntry[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as SessionLogEntry;
      out.push(obj);
    } catch {
      // skip malformed lines silently — session logs are append-only and may
      // have a partial last line if the process died mid-write.
    }
  }
  return out;
}

export function findSessionLogs(root: string): string[] {
  const out: string[] = [];
  walk(root, out);
  return out.sort();
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let s;
    try {
      s = statSync(p);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      walk(p, out);
    } else if (s.isFile() && extname(name) === ".jsonl") {
      out.push(p);
    }
  }
}
