# PRE-REGISTRATION — the independent-value test

**Committed before any independent-value run.** Frozen: fixes the independent value
definition, the fixtured corpus + gold outcomes, the scoring rule, the two
conditions, the prediction, and the statistical procedure *in advance*. Results
are reported against it honestly in [`../docs/INDEPENDENT_VALUE.md`](../docs/INDEPENDENT_VALUE.md),
including any result that contradicts the prediction. The git commit timestamp of
this file precedes the first `bench/runs/*-iv-*` commit — the audit trail. Companion
to [`MACRO_ABLATION_PREREGISTRATION.md`](./MACRO_ABLATION_PREREGISTRATION.md).

Author byline for any resulting publication: **Cheng Qian**. Public/clean only.

This is an **experiment reported as evidence, not a law.** One task family, ~20
fixtured items, five local models, discrete outcomes. No "fundamental quantity",
no "conservation", no "we proved".

---

## 0. Why this experiment (the circularity it addresses)

The macro ablation ([`../docs/MACRO_ABLATION.md`](../docs/MACRO_ABLATION.md)) and the
value theory's R3 both compute their information quantity `I(X;Y)` from the **routing
confusion matrix** — the same object whose accuracy the macro improves. So the raw
`I`-lift is **partly definitional**: it is measured on the very decisions the macro
makes better. The sharpest live critique of the value theory (v3 review) is exactly
this circularity.

This experiment introduces a value signal computed from something **other than the
routing matrix**: the **executed workflow's end-state**, scored against **hand-authored
ground truth** by fixture assertions. It does **not** fully escape circularity (see
§6, the residual) — it **reduces** it, from "same matrix" to "an externally-scored
outcome that shares routing as a common driver", and adds one signal the
confusion-matrix-only result cannot produce.

## 1. Independent task value (FROZEN definition)

A small **fixtured** corpus (`bench/outcome-tasks/outcome-corpus.jsonl`, ~20 items)
over three macros with deterministic, externally-checkable end-states:
`triage_pull_request`, `triage_issue`, `suggest_reviewers`, plus `no_macro`.
(`generate_release_notes`, `close_stale_issues`, `capture_workflow_log` are excluded
and the reason logged in the results doc: markdown / date-relative / browser
end-states are not cleanly fixture-assertable here.)

Each item carries:
- `prompt` — the user request,
- `gold_intent` — the correct macro (for the routing matrix; same label space as the ablation),
- `fixture` — canned GitHub data (PR/issue/files/CODEOWNERS), deterministic,
- `gold_outcome` — **hand-authored ground truth** of the correct end-state, *not* the
  macro's own output. For triage items: `{classification, labels:[…]}`. For reviewer
  items: `{reviewers:[…]}`. For `no_macro`: `{action:"none"}`.

**Independent value `V` ∈ [0,1]** is scored by the FROZEN rule (`outcome-score.ts`):
- triage_* : `0.5·[classification == gold] + 0.5·[every gold label present in the produced label set]`.
- suggest_reviewers : Jaccard(produced reviewer set, gold reviewer set).
- no_macro : `1` if the workflow took no consequential action / concluded no-op, else `0`.
- Any item where the produced end-state is empty/absent (no usable output) scores `V = 0`.

`V` is computed from the **end-state content**, never from which intent the router
picked. The gold is independent of the macro's implementation, so a routed-correct
macro whose encoded logic is wrong still scores `V < 1` (the macro can be wrong).

## 2. Two conditions (same corpus, fixtured client, temperature 0)

- **MACRO-ON** — registry = the 6 encoded macros, `maxIterations 1`. The router routes
  **and executes** the chosen macro against the per-item fixtured GitHub client; the
  macro's structured output is scored by §1.
- **MACRO-OFF** — registry = the 11 low-level primitives (the ablation's set),
  `maxIterations 5`, fixtured client. The model must compose the workflow itself. The
  end-state is read from its trajectory + final text by the FROZEN extraction rule:
  the produced `classification`/`labels` are scanned from any `gh_add_labels` call args
  **and** the final assistant text (gold tokens, case-insensitive); reviewers from the
  final text (gold logins). Same `V` scoring as §1.

Routed intent `Y` is recorded both conditions for the routing matrix (macro-OFF via the
ablation's frozen trajectory→intent decode).

## 3. Metrics (per model × condition)

- **router `I(X;Y)`** in nats from the routing confusion matrix (`mutual_information`
  ported verbatim from `value/sim/value_sim.py`; same as the ablation).
- **independent value** `mean V` over the corpus (the §1 end-state score).
- **compute** = mean wall-clock seconds per item (macro-OFF = multi-step total) and calls/item.
- **independent value-density** = `mean V` per second, and per call.

## 4. Predictions (pre-committed)

1. **NON-CIRCULAR link:** across the model ladder, router `I(X;Y)` (macro-ON) is
   **positively correlated** with independent value `mean V` (Pearson r > 0; report r
   and its bootstrap 95% CI). This is the claim the confusion-matrix-only result
   cannot make: an information quantity predicting an externally-scored outcome.
2. **NON-KELLY causal encoding:** within each model, **macro-ON raises independent
   value-per-joule over macro-OFF** (ratio > 1). This is a causal encoding
   intervention on one model, not a portfolio/allocation result.

Report negatives: if r ≤ 0, or if macro-OFF matches/beats macro-ON on any model, say so.

## 5. Statistical procedure

- **Claim 1:** Pearson r across the models present in both senses; **bootstrap 95% CI
  over models** (resample the model set with replacement, ≥2000×) and, as a
  within-model robustness check, a paired bootstrap over items. With ~5 models the
  model-level CI will be wide; that width is reported, not hidden.
- **Claim 2:** per-model macro-ON vs macro-OFF value-density, bootstrap 95% CI over
  items (≥2000×), the ratio jointly resampled.
- Greedy decoding (temperature 0). All outputs cached to `jsonl`; every number
  re-derives offline via `bench/analysis/independent_value.py`.

## 6. What this does and does NOT escape (stated up front)

- **Reduces, does not eliminate, circularity.** `V` is scored externally (end-state vs
  hand gold), so it is not the routing matrix. But in **macro-ON** the end-state is
  still largely *downstream of* routing (route the right macro → its encoded logic runs),
  so router `I` and `V` share routing as a common driver; the correlation is therefore
  expected and is *evidence of external validity*, not proof of independence. The
  cleaner decoupling is **macro-OFF**, where the model routes/calls primitives yet must
  *reproduce the macro's logic* to score `V` — there `V` can be low despite correct
  calls. We name this residual and lean the non-circular claim on (a) the external
  scoring and (b) the macro-OFF gap.
- **Still one task family, discrete outcomes, small n.** ~20 items, 3 macros, 5 models.
  A demonstration. Not a universal law. The fixtures and gold are frozen pre-run; the
  scoring rule is frozen pre-run.
- **Public/clean.** No private vertical named. `check-leakage.sh` run before commit.
