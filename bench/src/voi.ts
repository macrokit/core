/**
 * VOI pruner — design-time ingredient value-of-information measurement.
 *
 * For a macro, measures the MARGINAL contribution of each "ingredient" (a
 * primitive call, a populated schema/fixture field, or a supplied annotation)
 * to the INDEPENDENT task value V — the same hand-authored end-state score used
 * in the independent-value experiment (INDEPENDENT_VALUE_PREREGISTRATION.md),
 * NOT the routing confusion matrix. That keeps it non-circular: an ingredient's
 * VOI is its leave-one-out drop in an externally-scored outcome.
 *
 * It is a DESIGN-TIME tool: it executes the macro's *deterministic handler*
 * against the fixtured corpus with correct routing forced, so the only thing
 * that varies is the ingredient. No model in the loop — the measurement is the
 * macro's own encoded-logic ceiling, which is exactly what a macro author wants
 * to prune. Output: per-ingredient per-item V arrays → bench/runs/voi-<macro>.json,
 * consumed by bench/analysis/voi_pruner.py for ΔV + bootstrap CIs + prune flags.
 *
 * Proposes; never deletes. A human reads the ranked table and approves.
 *
 * Usage: pnpm exec tsx src/voi.ts [macro ...]   (default: all three)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionLog } from "@macrokit/runtime";
import {
  suggestReviewersMacro, triageIssue, triagePullRequest,
} from "@macrokit-example/github-maintainer/src/macros/index.js";
import { FixtureGitHubClient, scoreOutcomeOn, type OutcomeFixture, type OutcomeTask } from "./fixture-client.js";

const here = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(here, "..");

function loadCorpus(): OutcomeTask[] {
  const p = resolve(BENCH_ROOT, "outcome-tasks", "outcome-corpus.jsonl");
  return readFileSync(p, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as OutcomeTask);
}

/** Deep clone so each ablation gets a fresh, independent fixture. */
function clone(fx: OutcomeFixture): OutcomeFixture {
  return JSON.parse(JSON.stringify(fx)) as OutcomeFixture;
}

type Ablation = (fx: OutcomeFixture) => OutcomeFixture;

interface Ingredient {
  id: string;
  /** primitive = a tool call (costs 1 call); field/annotation = derived from an already-fetched payload (costs 0). */
  kind: "primitive" | "field" | "annotation";
  /** Number of primitive tool-calls this ingredient represents — what pruning it saves. */
  cost: number;
  /** Returns a fixture with this ingredient removed. */
  ablate: Ablation;
}

interface MacroSpec {
  name: string;
  goldIntent: string;
  /** Primitive tool-calls the handler makes with the full fixture — the value-density denominator. */
  baselineCalls: number;
  /** Build handler args from a corpus item. The fixture client ignores owner/repo/number, so values are nominal. */
  args: (t: OutcomeTask) => Record<string, unknown>;
  run: (args: Record<string, unknown>, fx: OutcomeFixture) => Promise<unknown>;
  ingredients: Ingredient[];
}

const ctx = (fx: OutcomeFixture) => ({ log: new SessionLog(), tools: { github: new FixtureGitHubClient(fx) }, signal: new AbortController().signal });

const MACROS: Record<string, MacroSpec> = {
  triage_pull_request: {
    name: "triage_pull_request",
    goldIntent: "triage_pull_request",
    baselineCalls: 2, // getPullRequest + getPullRequestFiles
    args: (t) => ({ owner: "x", repo: "x", number: t.fixture.pr?.number ?? 1, apply: false }),
    run: (a, fx) => triagePullRequest.handler(a as never, ctx(fx)),
    ingredients: [
      { id: "primitive:getPullRequestFiles", kind: "primitive", cost: 1, ablate: (fx) => ({ ...clone(fx), files: [] }) },
      { id: "field:pr.title", kind: "field", cost: 0, ablate: (fx) => { const c = clone(fx); if (c.pr) c.pr.title = ""; return c; } },
      { id: "field:pr.body", kind: "field", cost: 0, ablate: (fx) => { const c = clone(fx); if (c.pr) c.pr.body = null; return c; } },
      { id: "field:pr.draft", kind: "field", cost: 0, ablate: (fx) => { const c = clone(fx); if (c.pr) c.pr.draft = false; return c; } },
      { id: "field:pr.existing_labels", kind: "field", cost: 0, ablate: (fx) => { const c = clone(fx); if (c.pr) c.pr.labels = []; return c; } },
    ],
  },
  triage_issue: {
    name: "triage_issue",
    goldIntent: "triage_issue",
    baselineCalls: 2, // getIssue + listOpenIssues
    args: (t) => ({ owner: "x", repo: "x", number: t.fixture.issue?.number ?? 1, apply: false }),
    run: (a, fx) => triageIssue.handler(a as never, ctx(fx)),
    ingredients: [
      { id: "primitive:listOpenIssues", kind: "primitive", cost: 1, ablate: (fx) => ({ ...clone(fx), openIssues: [] }) },
      { id: "field:issue.title", kind: "field", cost: 0, ablate: (fx) => { const c = clone(fx); if (c.issue) c.issue.title = ""; return c; } },
      { id: "field:issue.body", kind: "field", cost: 0, ablate: (fx) => { const c = clone(fx); if (c.issue) c.issue.body = null; return c; } },
      { id: "field:issue.existing_labels", kind: "field", cost: 0, ablate: (fx) => { const c = clone(fx); if (c.issue) c.issue.labels = []; return c; } },
      { id: "field:issue.comments_count", kind: "field", cost: 0, ablate: (fx) => { const c = clone(fx); if (c.issue) c.issue.comments = 99; return c; } },
    ],
  },
  suggest_reviewers: {
    name: "suggest_reviewers",
    goldIntent: "suggest_reviewers",
    baselineCalls: 3, // getPullRequest + getPullRequestFiles + getCodeowners
    args: () => ({ owner: "x", repo: "x", number: 1, max: 3 }),
    run: (a, fx) => suggestReviewersMacro.handler(a as never, ctx(fx)),
    ingredients: [
      { id: "primitive:getCodeowners", kind: "primitive", cost: 1, ablate: (fx) => ({ ...clone(fx), codeowners: [] }) },
      { id: "primitive:getPullRequestFiles", kind: "primitive", cost: 1, ablate: (fx) => ({ ...clone(fx), files: [] }) },
      // getPullRequest is fetched ONLY to exclude the PR author from the reviewer
      // set. Ablating it = don't fetch the PR, exclude nobody. Cost 1 call.
      { id: "primitive:getPullRequest(author-exclude)", kind: "primitive", cost: 1, ablate: (fx) => { const c = clone(fx); if (c.pr) c.pr.user = { login: "__ablated_no_exclude__" }; return c; } },
    ],
  },
};

async function score(spec: MacroSpec, t: OutcomeTask, fx: OutcomeFixture): Promise<number> {
  try {
    const out = await spec.run(spec.args(t), fx);
    return scoreOutcomeOn(t, spec.goldIntent, out);
  } catch {
    return 0; // an ablation that breaks the handler scores V=0 (its contribution was load-bearing)
  }
}

async function runMacro(spec: MacroSpec, corpus: OutcomeTask[]) {
  const items = corpus.filter((t) => t.gold_intent === spec.goldIntent);
  const baseline: number[] = [];
  for (const t of items) baseline.push(await score(spec, t, t.fixture));

  const ingredients: Array<{ id: string; kind: string; cost: number; ablated: number[]; delta: number[] }> = [];
  for (const ing of spec.ingredients) {
    const ablated: number[] = [];
    const delta: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const v = await score(spec, items[i]!, ing.ablate(items[i]!.fixture));
      ablated.push(v);
      delta.push(baseline[i]! - v);
    }
    ingredients.push({ id: ing.id, kind: ing.kind, cost: ing.cost, ablated, delta });
  }
  return { macro: spec.name, goldIntent: spec.goldIntent, baselineCalls: spec.baselineCalls, n: items.length, itemIds: items.map((t) => t.id), baseline, ingredients };
}

async function main() {
  const corpus = loadCorpus();
  const which = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const names = which.length ? which : Object.keys(MACROS);
  const outDir = resolve(BENCH_ROOT, "runs");
  mkdirSync(outDir, { recursive: true });
  for (const name of names) {
    const spec = MACROS[name];
    if (!spec) { process.stderr.write(`unknown macro "${name}". Known: ${Object.keys(MACROS).join(", ")}\n`); continue; }
    const result = await runMacro(spec, corpus);
    const out = join(outDir, `voi-${name}.json`);
    writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
    const meanBase = result.baseline.reduce((s, v) => s + v, 0) / (result.baseline.length || 1);
    process.stdout.write(`\n${name}: n=${result.n}, baseline V=${meanBase.toFixed(3)}, baselineCalls=${result.baselineCalls}\n`);
    for (const ing of result.ingredients) {
      const mean = ing.delta.reduce((s, v) => s + v, 0) / (ing.delta.length || 1);
      process.stdout.write(`  ΔV=${mean.toFixed(3)}  ${ing.kind.padEnd(9)} cost=${ing.cost}  ${ing.id}\n`);
    }
    process.stdout.write(`  → wrote ${out}\n`);
  }
  process.stdout.write(`\nRun \`python3 analysis/voi_pruner.py\` for ranked ΔV + 95% CIs + prune candidates.\n`);
}

main().catch((e) => { process.stderr.write(`voi failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`); process.exit(1); });
