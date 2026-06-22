/**
 * Multi-macro routing stress test — harness.
 *
 * Registers ALL 11 public reference macros (github-maintainer + paper-triage)
 * into ONE registry and measures whether a weak local model can disambiguate
 * among them. Routing-only: macro handlers are stubbed (no live GitHub /
 * Semantic Scholar / OpenAlex / browser calls), so we score the classification
 * + argument-extraction decision, not handler fills.
 *
 * Scoring is the frozen pre-registration (MULTI_MACRO_ROUTING_PREREGISTRATION.md).
 */
import {
  IntentRouter,
  MacroRegistry,
  Dispatcher,
  SessionLog,
  type LLMAdapter,
  type Macro,
} from "@macrokit/runtime";
import {
  captureWorkflowLog,
  closeStaleIssues,
  generateReleaseNotes,
  suggestReviewersMacro,
  triageIssue,
  triagePullRequest,
} from "@macrokit-example/github-maintainer/src/macros/index.js";
import {
  bibliographyLookup,
  checkOpenAccess,
  comparePapers,
  findRelatedPapers,
  triagePaper,
} from "@macrokit-example/paper-triage/src/macros/index.js";

/** The 11 real macros, in a stable order. */
const REAL_MACROS: ReadonlyArray<Macro> = [
  triagePullRequest,
  triageIssue,
  generateReleaseNotes,
  closeStaleIssues,
  suggestReviewersMacro,
  captureWorkflowLog,
  triagePaper,
  comparePapers,
  findRelatedPapers,
  bibliographyLookup,
  checkOpenAccess,
] as unknown as ReadonlyArray<Macro>;

export const ALL_MACRO_NAMES: ReadonlyArray<string> = REAL_MACROS.map((m) => m.name);

/**
 * Build the routing registry. Each macro keeps its real `name` + `intent` +
 * `schema` (what routing keys on) but its handler is replaced by a no-op that
 * echoes the parsed args — no network, deterministic. We only read the routing
 * decision, never an executed result.
 */
export function buildMultiMacroRegistry(): MacroRegistry {
  const reg = new MacroRegistry();
  for (const m of REAL_MACROS) {
    reg.register({
      name: m.name,
      intent: m.intent,
      schema: m.schema,
      // Stub: do not touch ctx.tools, so capability checks never trip.
      handler: async (args: unknown) => args,
    });
  }
  return reg;
}

// ---------------------------------------------------------------------------
// Prompt set + scoring (frozen)
// ---------------------------------------------------------------------------

export type Category = "clear" | "ambiguous" | "negative";

export interface Prompt {
  id: string;
  category: Category;
  domain: "github" | "paper" | "none";
  prompt: string;
  /** Acceptable macros. [] for negatives; one for clear; ≥2 for ambiguous. */
  expect: string[];
  /** Expected args for clear positives (scored per-key). */
  args: Record<string, unknown>;
}

export interface PromptFile {
  version: string;
  prompts: Prompt[];
}

export interface PromptResult {
  id: string;
  category: Category;
  prompt: string;
  expect: string[];
  goldArgs: Record<string, unknown>;
  /** Macro the router dispatched, or null if no tool call (incl. halting bail-out). */
  actual: string | null;
  actualArgs: Record<string, unknown> | undefined;
  routingCorrect: boolean;
  /** Per-key arg outcome (clear positives only; empty otherwise). */
  argKeys: Array<{ key: string; correct: boolean }>;
  argsScored: boolean;
  argsExact: boolean;
  bailOut: string | null;
  rawText: string;
  latencyMs: number;
  error?: string;
}

const NO_ROUTE = "(no-route)";

// --- arg normalization (frozen) -------------------------------------------

function normStr(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}
function normPaperId(v: unknown): string {
  return String(v ?? "").trim().replace(/^arxiv:/i, "").toLowerCase();
}
function keyCorrect(key: string, expected: unknown, actual: unknown): boolean {
  if (actual === undefined || actual === null) return false;
  switch (key) {
    case "owner":
    case "repo":
    case "base":
    case "head":
      return normStr(expected) === normStr(actual);
    case "number":
    case "runId":
    case "minDaysOpen":
      return Number(expected) === Number(actual);
    case "paperId":
      return normPaperId(expected) === normPaperId(actual);
    case "paperIds": {
      const e = new Set((expected as unknown[]).map(normPaperId));
      const a = new Set((Array.isArray(actual) ? actual : []).map(normPaperId));
      if (e.size !== a.size) return false;
      for (const x of e) if (!a.has(x)) return false;
      return true;
    }
    case "query":
      // free text — counted correct iff a non-empty string was extracted.
      return typeof actual === "string" && actual.trim().length > 0;
    default:
      return normStr(expected) === normStr(actual);
  }
}

export function scorePrompt(
  p: Prompt,
  actual: string | null,
  actualArgs: Record<string, unknown> | undefined,
): Pick<PromptResult, "routingCorrect" | "argKeys" | "argsScored" | "argsExact"> {
  const routingCorrect =
    p.category === "negative" ? actual === null : actual !== null && p.expect.includes(actual);

  // Args are scored only on clear positives that routed correctly and declare args.
  const argKeys: Array<{ key: string; correct: boolean }> = [];
  let argsScored = false;
  if (p.category === "clear" && routingCorrect && Object.keys(p.args).length > 0) {
    argsScored = true;
    for (const [key, expected] of Object.entries(p.args)) {
      argKeys.push({ key, correct: keyCorrect(key, expected, actualArgs?.[key]) });
    }
  }
  const argsExact = argsScored && argKeys.every((k) => k.correct);
  return { routingCorrect, argKeys, argsScored, argsExact };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunMultiMacroOptions {
  model?: string;
  onProgress?: (i: number, n: number, r: PromptResult) => void;
}

export async function runMultiMacro(
  adapter: LLMAdapter,
  prompts: ReadonlyArray<Prompt>,
  opts: RunMultiMacroOptions = {},
): Promise<PromptResult[]> {
  const registry = buildMultiMacroRegistry();
  const log = new SessionLog();
  const dispatcher = new Dispatcher({ registry, log });
  const results: PromptResult[] = [];

  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i]!;
    // Fresh router + empty history per prompt — no cross-prompt leakage.
    const router = new IntentRouter({ registry, adapter, dispatcher, log, maxIterations: 1 });
    const start = Date.now();
    let actual: string | null = null;
    let actualArgs: Record<string, unknown> | undefined;
    let bailOut: string | null = null;
    let rawText = "";
    let error: string | undefined;
    try {
      const res = await router.chat(p.prompt, {
        history: [],
        temperature: 0,
        ...(opts.model ? { model: opts.model } : {}),
      });
      rawText = res.text;
      if (res.bailOuts.length > 0) bailOut = res.bailOuts[0]!.code;
      if (res.dispatched.length > 0) {
        actual = res.dispatched[0]!.call.name;
        actualArgs = res.dispatched[0]!.call.args;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const scored = scorePrompt(p, actual, actualArgs);
    const r: PromptResult = {
      id: p.id,
      category: p.category,
      prompt: p.prompt,
      expect: p.expect,
      goldArgs: p.args,
      actual,
      actualArgs,
      bailOut,
      rawText,
      latencyMs: Date.now() - start,
      ...scored,
      ...(error ? { error } : {}),
    };
    results.push(r);
    opts.onProgress?.(i + 1, prompts.length, r);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Aggregation + confusion matrix
// ---------------------------------------------------------------------------

export interface Summary {
  total: number;
  byCategory: Record<Category, { n: number; routedCorrect: number }>;
  routingAccuracyPositives: number;
  noRouteAccuracy: number;
  hallucinatedToolCallRate: number;
  argKeyAccuracy: number;
  argsExactRate: number;
  perMacroRouting: Record<string, { n: number; correct: number }>;
  perMacroArgKey: Record<string, { keys: number; correct: number }>;
  /** rows = gold macro (clear positives), cols = actual macro name or "(no-route)". */
  confusion: Record<string, Record<string, number>>;
}

export function aggregate(results: ReadonlyArray<PromptResult>): Summary {
  const byCategory: Summary["byCategory"] = {
    clear: { n: 0, routedCorrect: 0 },
    ambiguous: { n: 0, routedCorrect: 0 },
    negative: { n: 0, routedCorrect: 0 },
  };
  const perMacroRouting: Summary["perMacroRouting"] = {};
  const perMacroArgKey: Summary["perMacroArgKey"] = {};
  const confusion: Summary["confusion"] = {};

  let posTotal = 0;
  let posCorrect = 0;
  let negTotal = 0;
  let negCorrect = 0;
  let argKeysTotal = 0;
  let argKeysCorrect = 0;
  let argsScoredTotal = 0;
  let argsExactTotal = 0;

  for (const r of results) {
    byCategory[r.category].n += 1;
    if (r.routingCorrect) byCategory[r.category].routedCorrect += 1;

    if (r.category === "negative") {
      negTotal += 1;
      if (r.routingCorrect) negCorrect += 1;
    } else {
      posTotal += 1;
      if (r.routingCorrect) posCorrect += 1;
    }

    // Per-macro routing + confusion: only clear positives have a unique gold.
    if (r.category === "clear") {
      const gold = r.expect[0]!;
      perMacroRouting[gold] ??= { n: 0, correct: 0 };
      perMacroRouting[gold].n += 1;
      if (r.routingCorrect) perMacroRouting[gold].correct += 1;

      confusion[gold] ??= {};
      const col = r.actual ?? NO_ROUTE;
      confusion[gold][col] = (confusion[gold][col] ?? 0) + 1;

      if (r.argsScored) {
        perMacroArgKey[gold] ??= { keys: 0, correct: 0 };
        for (const k of r.argKeys) {
          perMacroArgKey[gold].keys += 1;
          if (k.correct) perMacroArgKey[gold].correct += 1;
        }
      }
    }

    if (r.argsScored) {
      argsScoredTotal += 1;
      if (r.argsExact) argsExactTotal += 1;
      for (const k of r.argKeys) {
        argKeysTotal += 1;
        if (k.correct) argKeysCorrect += 1;
      }
    }
  }

  return {
    total: results.length,
    byCategory,
    routingAccuracyPositives: posTotal ? posCorrect / posTotal : 0,
    noRouteAccuracy: negTotal ? negCorrect / negTotal : 0,
    hallucinatedToolCallRate: negTotal ? (negTotal - negCorrect) / negTotal : 0,
    argKeyAccuracy: argKeysTotal ? argKeysCorrect / argKeysTotal : 0,
    argsExactRate: argsScoredTotal ? argsExactTotal / argsScoredTotal : 0,
    perMacroRouting,
    perMacroArgKey,
    confusion,
  };
}

/** Render the confusion matrix as a fixed-width text table. */
export function renderConfusion(summary: Summary): string {
  const golds = ALL_MACRO_NAMES.filter((m) => summary.confusion[m]);
  const cols = [...ALL_MACRO_NAMES, NO_ROUTE];
  const short = (s: string) => s.replace(/_/g, " ").slice(0, 10).padEnd(10);
  const head = "gold \\ actual".padEnd(22) + cols.map((c) => short(c)).join(" ");
  const lines = [head];
  for (const g of golds) {
    const row = summary.confusion[g]!;
    const cells = cols.map((c) => String(row[c] ?? 0).padStart(10));
    lines.push(g.padEnd(22) + cells.join(" "));
  }
  return lines.join("\n");
}
