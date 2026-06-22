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
# → writes bench/runs/multi-macro-<model>-<stamp>.{jsonl,summary.json,confusion.txt}
pnpm --filter @macrokit/bench test                     # offline harness test (no Ollama)
```
