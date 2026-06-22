# Pre-registration — multi-macro routing stress test

**Status:** frozen before any qwen run. The git commit that introduces this file
+ `multi-macro/prompts.json` **precedes** the results artifact commit
(`bench/runs/multi-macro-*`). This is the audit trail: the prompts and the
expected routing are fixed *before* we look at any model output.

## Question

The single-macro job vertical hit 7/7 routing — but with **one** macro, routing
is trivial ("is this an apply request, yes/no"). The real test of intent
classification is **disambiguation among many macros**. Can a weak local model
(qwen2.5:7b-instruct, via Ollama) pick the *right* macro out of **11** spanning
**two unrelated domains**, and extract the right arguments?

## Setup (frozen)

- **Model:** `qwen2.5:7b-instruct` served by Ollama at `http://localhost:11434`,
  via `@macrokit/llm` `OllamaAdapter`. Greedy decoding (`temperature: 0`).
- **Router:** `@macrokit/runtime` `IntentRouter`, `maxIterations: 1`, fresh
  router + empty history per prompt (no cross-prompt leakage). No fallback
  adapter (a weak-only measurement — bail-outs that halt count as no-route).
- **Registry:** ONE registry holding **all 11** public reference macros:
  - github-maintainer (6): `triage_pull_request`, `triage_issue`,
    `generate_release_notes`, `close_stale_issues`, `suggest_reviewers`,
    `capture_workflow_log`.
  - paper-triage (5): `triage_paper`, `compare_papers`, `find_related_papers`,
    `bibliography_lookup`, `check_open_access`.
- **Routing-only / stubbed dispatch.** Each macro's real `intent` + `schema` are
  used verbatim (those are what routing keys on), but the handler is replaced by
  a no-op that echoes the parsed args. NO live GitHub / Semantic Scholar /
  OpenAlex / browser calls. We measure **classification + argument extraction**,
  not handler fills. The model still sees the real tool schemas, so the routing
  decision is genuine.

## Prompt set (frozen — see `multi-macro/prompts.json`)

34 prompts in three categories. Both domains live in the same registry, so every
prompt is implicitly a cross-domain disambiguation (the model must pick the right
*domain* macro, then the right macro within it).

- **Clear-intent (24):** 2–3 natural phrasings per macro, with varied verbs /
  synonyms. Each has exactly one gold macro + expected args.
- **Ambiguous (4):** prompts that plausibly fit two macros. Each records the set
  of acceptable macros (`expect` has ≥2 entries); routing is correct if the model
  picks any one of them. Args not scored (intent is the point).
- **Negative controls (6):** prompts with NO matching macro (weather, coding,
  trivia, booking). Correct behaviour = **no tool call** (no-route). A dispatched
  macro here is a hallucinated-tool-call error.

`prompts.json` entry shape:
```
{ "id", "category": "clear|ambiguous|negative",
  "domain": "github|paper|none",
  "prompt": "<user text>",
  "expect": ["macro_name", ...],   // [] for negatives; ≥2 for ambiguous
  "args": { ... } }                // expected args for clear positives only
```

## Metrics (frozen scoring — implemented in `src/multi-macro.ts`)

Let `actual` = the macro the router dispatched (`dispatched[0].call.name`), or
`null` if the router emitted no tool call (incl. a halting bail-out).

1. **Routing accuracy** (positives = clear ∪ ambiguous): correct iff
   `actual ∈ expect`. Reported overall and per gold macro (clear only, where gold
   is unique).
2. **No-route accuracy** (negatives): correct iff `actual === null`. The
   complement is the **hallucinated-tool-call rate**.
3. **Argument-extraction accuracy** (clear positives with non-empty `args`):
   per-key normalized comparison; report mean per-key accuracy overall + per
   macro, and the all-keys-correct (exact-args) rate. Normalization (frozen):
   - `owner`, `repo`, `base`, `head`: trim + lowercase string equality.
   - `number`, `runId`, `minDaysOpen`: numeric equality (`Number()`).
   - `paperId`: trim, strip a leading `arxiv:` (case-insensitive), then equality.
   - `paperIds`: order-insensitive set equality under the `paperId` rule.
   - `query`: not value-scored (free text); counted correct iff a non-empty
     string was extracted.
   Args are only scored on prompts where routing was correct (you can't grade the
   args of the wrong macro).
4. **Confusion matrix:** rows = gold macro (clear positives), columns = actual
   (macro name or `(no-route)`). This exposes *which* macros get confused with
   which — the interesting failure structure.

## Honest-framing commitment

This is where routing gets HARD (11 macros vs 1). A sub-perfect qwen result is a
**valid, publishable finding**, not a failure to hide: it informs model choice
(does a bigger local model clear the bar?) and whether routing needs help
(sharper `intent` strings, a retrieval pre-filter). We report the real number and
the real confusion matrix, whatever they are.

## Reproduce

```sh
cd core
pnpm --filter @macrokit/bench run:multi-macro          # needs Ollama + qwen2.5:7b-instruct
# → writes bench/runs/multi-macro-<tag>-<model>-<stamp>.{jsonl,summary.json,confusion.txt}
pnpm --filter @macrokit/bench test                     # offline harness test (no Ollama)
```

---

# Addendum v2 — scale to 17 macros / 3 domains (HR added)

**Status:** frozen before the v2 run. This addendum + `multi-macro/prompts-3domain.json`
are committed in the same prereg commit, which **precedes** the v2 results
artifact (`bench/runs/multi-macro-prompts-3domain-*`).

## Question (scaling)

The baseline above validated routing at **11 macros / 2 domains** (a fully
diagonal confusion matrix, 96.4% positives). Does routing **hold as the library
grows**? We add the third reference vertical — `hr-recruiting` (6 macros) — for
**17 macros across 3 domains**, and ask specifically: **does HR's
people/candidate language bleed into the github or paper macros** (or vice
versa)? The worry is lexical overlap — "triage", "compare", "find references",
"review" — that a person could read as either a candidate action or an
issue/paper action.

## What changed vs. the baseline (everything else identical)

- **Registry:** now all **17** macros in ONE registry — github-maintainer (6) +
  paper-triage (5) + hr-recruiting (6). Same stubbed-handler, routing-only setup.
- **Prompt set:** `prompts-3domain.json` (v2.0.0) = the **original 34 prompts
  verbatim** (now competing against 6 extra HR distractor macros — this is the
  pure "did adding HR break the existing routing" test) **+ 17 new HR prompts**:
  - **12 HR clear-intent** — 2 per HR macro, varied phrasings.
  - **3 cross-domain lexical-collision** (clear, single gold = HR): prompts that
    deliberately reuse a verb owned by another domain but with a candidate/req
    referent, so the right answer is the HR macro:
    `hx1` "**Triage** candidate CAND-2001…" → `screen_resume` (not triage_*);
    `hx2` "**Find the references** for candidate…" → `check_references_dryrun`
    (not bibliography_lookup); `hx3` "**Compare** the candidates…ranks highest"
    → `rank_candidates` (not compare_papers). These are the bleed probes.
  - **2 HR ambiguous** (accept-set): `ha1` req-vs-rank, `ha2` rank-vs-outreach.
  - Total **51 prompts**: 39 clear / 6 ambiguous / 6 negative.
- **Scoring + confusion matrix:** unchanged (same frozen rules). HR arg-scoring
  uses the reliably-extractable ID keys (`requisitionId`, `candidateId`, `top`);
  free-form `interviewers`/`proposedSlots` are not value-scored.

## Reported comparison

The v2 results doc reports the 17-macro numbers **side-by-side with the 11-macro
baseline** (commit `a1c45c0`): routing accuracy, no-route accuracy, arg
extraction, and — the headline for the scaling question — **whether the
confusion matrix stayed diagonal or grew off-diagonal cross-domain cells**,
especially any HR↔github/paper bleed. A drop here is a valid, publishable
finding (it would say the library needs retrieval pre-filtering or sharper
intents past ~N macros); holding the diagonal says the library stays routable as
it scales.

```sh
pnpm --filter @macrokit/bench run:multi-macro                      # v2: 17 macros, prompts-3domain.json (default)
MULTI_MACRO_PROMPTS=prompts.json pnpm --filter @macrokit/bench run:multi-macro   # baseline prompt set, now vs 17 macros
```
