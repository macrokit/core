# Independent value — does the information quantity predict a task outcome it isn't defined from?

**This is an experiment reported as evidence, not a law.** One task family
(`github-maintainer`), one ~18-item fixtured corpus, five local models, discrete
outcomes. It is a demonstration; it is explicitly not a proof and not a
"conservation law." The pre-registration that fixed the independent-value
definition, the fixtures + hand-authored gold, the scoring rule, both conditions,
both predictions, and the statistical procedure *before any run* is committed at
[`../bench/INDEPENDENT_VALUE_PREREGISTRATION.md`](../bench/INDEPENDENT_VALUE_PREREGISTRATION.md)
(its commit precedes the first `bench/runs/*-iv-*` commit — the audit trail).

## Why this experiment exists — the circularity it addresses

The [macro ablation](./MACRO_ABLATION.md) and the value theory's R3 both compute
their information quantity `I(X;Y)` from the **routing confusion matrix** — the
same object whose accuracy the macro improves. So the raw `I`-lift there is
**partly definitional**: it is measured on the very decisions the macro makes
better. The sharpest live critique of the
[*Theory of Value*](https://doi.org/10.5281/zenodo.20487041) (Qian, 2026; cite the
concept DOI, which resolves to the latest version) is exactly this circularity —
`I(X;Y)` and the value quantity `ΔG` are read off the same matrix, so the
in-sample identity is partly arithmetic.

This experiment introduces a value signal computed from something **other than the
routing matrix**: the **executed workflow's end-state**, scored against
**hand-authored ground truth** by fixture assertions, *independently* of which
intent the router picked. It then asks two pre-registered questions the
confusion-matrix-only result cannot answer:

- **Claim 1 (non-circular):** does router `I(X;Y)` predict the
  *independently-scored* task value `V`?
- **Claim 2 (non-Kelly):** does turning the macro **on** raise independent value
  **per joule** within a single model — a causal encoding intervention, not a
  portfolio/allocation result?

It does **not** fully escape circularity. It *reduces* it (from "same matrix" to
"an externally-scored outcome that shares routing as a common driver") and adds a
signal the matrix-only result cannot produce. The residual is named in
[§ Honest analysis](#honest-analysis--what-this-does-and-does-not-escape).

## Independent value `V` (frozen; see pre-registration §1)

A fixtured corpus ([`bench/outcome-tasks/outcome-corpus.jsonl`](../bench/outcome-tasks/outcome-corpus.jsonl),
18 items) over three macros with externally-checkable end-states —
`triage_pull_request`, `triage_issue`, `suggest_reviewers` — plus `no_macro`.
Each item carries canned GitHub data and a **hand-authored `gold_outcome`** (the
correct classification + labels, or the correct reviewer set, or "no action"),
which is *not* the macro's own output. `V ∈ [0,1]` is scored by the frozen rule
(`bench/src/fixture-client.ts`): triage = `0.5·[classification==gold] +
0.5·[every gold label produced]`; reviewers = Jaccard(produced, gold);
`no_macro` = 1 iff no consequential action. `V` is read from the **end-state
content**, never from which intent was routed — so a correctly-routed macro whose
encoded logic is wrong still scores `V < 1`.

Two conditions, same corpus, fixtured client, temperature 0:
**MACRO-ON** (the 6 encoded macros, one routing call, the macro executes against
the fixture) and **MACRO-OFF** (only the 11 low-level primitives, up to 5 router
steps; the model must compose the workflow itself, and `V` is read from its
trajectory + final text by the frozen extraction rule).

## Results

Five local models, temperature 0. Reproduce with
`python3 bench/analysis/independent_value.py bench/runs`.

### Claim 1 — router `I(X;Y)` vs the independent outcome `V` (macro-ON)

| Model | router `I(X;Y)` nats | mean `V` |
|---|---:|---:|
| qwen2.5-1.5b | 1.147 | 0.778 |
| qwen2.5-3b | 1.301 | 0.833 |
| qwen2.5-7b | 1.301 | 0.889 |
| llama3.1-8b | 1.301 | 0.833 |
| mistral-7b | ~0.000 | 0.111 |

**Pearson r = 0.997, bootstrap-over-models 95% CI [0.791, 1.000]** (n = 5). The
information the router carries about the gold intent predicts a task outcome that
is *not* read from the routing matrix. With mistral excluded (the one model that
does not route at all), the relationship **survives**: r = 0.816 across the four
routing models — so the correlation is not solely a mistral artifact, though the
full-sample r is partly driven by mistral's low-`I`/low-`V` corner (see honest
analysis).

### Claim 2 — macro-ON vs macro-OFF independent value-per-joule

Per-call is the latency-robust compute proxy (the [ablation](./MACRO_ABLATION.md)
showed wall-clock seconds carry run-level noise on the shared host); per-second is
shown alongside and, here, agrees.

| Model | `V` ON | `V` OFF | ON/OFF `V`/call [95% CI] | ON/OFF `V`/sec [95% CI] |
|---|---:|---:|---:|---:|
| qwen2.5-1.5b | 0.778 | 0.167 | **5.00×** [2.40, 16.00] | 7.02× [2.47, 29.33] |
| qwen2.5-3b | 0.833 | 0.167 | **6.76×** [2.63, 24.55] | 13.66× [5.57, 50.74] |
| qwen2.5-7b | 0.889 | 0.111 | **10.00×** [3.75, 25.41] | 14.70× [4.91, 42.66] |
| llama3.1-8b | 0.833 | 0.111 | **8.38×** [3.29, 19.83] | 25.43× [10.87, 60.86] |
| mistral-7b | 0.111 | 0.167 | n/a | 0.83× [0.00, 1.49] |

For every model that routes, **macro-ON delivers 5.0–10.0× the independent value
per call** of macro-OFF, with all four CIs entirely above 1. Unlike the ablation's
`I`/sec axis (where the 7b inverted on a noisy latency measurement), no model
inverts here on either axis.

## What it shows

**The information quantity predicts an outcome it is not defined from.** The
macro-ON `I(X;Y)` — computed from the routing matrix — tracks `V`, scored from the
executed end-state against hand gold. That is the claim the confusion-matrix-only
result structurally cannot make.

**Routing alone does not deliver the outcome — the encoded logic does.** This is
the cleanest non-circular evidence in the experiment. In **macro-OFF** the models
still route and call primitives (their decoded intent is often correct), yet
independent `V` collapses to 0.11–0.17 — because reproducing the macro's
*encoded logic* (the right classification, the right labels, the right reviewer
set) from raw primitives is what they fail at. The value lives in the design-time
encoding, not merely in picking the right workflow. That gap is exactly what the
macro pays for once, at design time.

## Honest analysis — what this does and does NOT escape

- **Reduces, does not eliminate, circularity.** `V` is scored externally (end-state
  vs hand gold), so it is not the routing matrix. But in **macro-ON** the end-state
  is still largely *downstream of* routing — route the right macro and its
  deterministic logic runs — so router `I` and `V` share routing as a common
  driver, and a positive correlation is *expected*. It is evidence of external
  validity, not proof of independence. The cleaner decoupling is **macro-OFF**,
  where routing can be right while `V` is low; that is where the two signals come
  apart, and they do (Claim 2).
- **Claim 1's strength leans partly on mistral.** mistral barely perceives the task
  (`I ≈ 0`, `V = 0.11`) and anchors the low corner of the line. Removing it,
  r drops from 0.997 to 0.816 — still clearly positive, but the among-routers
  spread is small: three of the four routing models have **identical** `I = 1.301`
  on this 18-item corpus (near-saturated routing, a small-n artifact). A larger,
  harder corpus would spread `I` among the routers and is the obvious next step.
- **Still one task family, discrete outcomes, small n.** 18 items, 3 macros, 5
  models, four discrete `V` levels. A demonstration on `github-maintainer`, not a
  universal law. Fixtures, gold, and scoring rule were all frozen pre-run.
- **mistral is a reported negative, not a dropped one.** It fails in both
  conditions (it narrates tool calls as prose — the same `tool_call_as_text`
  plumbing failure seen in the benchmark and ablation), so it cannot inform the
  within-model ON/OFF ratio (Claim 2, n/a). It is *kept* in Claim 1, where its
  low-`I`/low-`V` point is a real observation.

## A by-product: the VOI pruner (design-time tool, same substrate)

The same independent signal answers a different, practical question: **which
ingredients of a macro actually earn their keep?** The VOI pruner
([`bench/src/voi.ts`](../bench/src/voi.ts) +
[`bench/analysis/voi_pruner.py`](../bench/analysis/voi_pruner.py)) measures the
**marginal contribution of each ingredient** — a primitive call, a populated
schema/fixture field, an annotation — to the independent value `V` by
**leave-one-out**: run the macro's *deterministic handler* against the fixtured
corpus with one ingredient ablated, and measure the drop in `V` against the same
hand-authored gold. It scores against the outcome, **never the routing matrix**,
so it is non-circular by construction; and it needs **no model in the loop** (it
measures the macro's own encoded-logic ceiling), so it is a pure design-time pass.
It **proposes**; a human approves. Reproduce with
`pnpm exec tsx bench/src/voi.ts && python3 bench/analysis/voi_pruner.py`.

Frozen flag rule: an ingredient is a **PRUNE CANDIDATE** when its bootstrap 95% CI
upper bound on marginal `ΔV` is ≤ 0.05 — no measurable positive contribution to
the independent outcome on this corpus. Result on the three measured macros:

| Macro | load-bearing (kept) | ~0-VOI primitive flagged | value-density (V per primitive call) |
|---|---|---|---|
| `triage_pull_request` | `pr.title` (ΔV 0.29) | **`getPullRequestFiles`** (ΔV 0.00) | 0.50 → 1.00 (**+100%**, 2→1 calls) |
| `triage_issue` | `issue.title` (ΔV 0.40) | **`listOpenIssues`** (ΔV 0.00) | 0.30 → 0.60 (**+100%**, 2→1 calls) |
| `suggest_reviewers` | `getCodeowners` (ΔV 1.00), `getPullRequestFiles` (ΔV 1.00) | **`getPullRequest`** (author-exclude; ΔV 0.00) | 0.33 → 0.50 (**+50%**, 3→2 calls) |

It found a genuinely low-VOI ingredient in **every** macro — and, importantly, did
**not** flag the load-bearing ones (CODEOWNERS and the changed-files list are each
worth a full point of reviewer value; the PR/issue titles drive classification).
Each flagged item is a real tool call that returns **zero independent value on this
corpus**: every triage title here carries a conventional-commit prefix or a
keyword, so the changed-files fetch never changes the classification; the
duplicate-issue scan feeds an output field the gold never scores; the PR fetch in
`suggest_reviewers` exists only to exclude an author who is never a code-owner
here. Pruning the three flagged primitives removes one network round-trip per
macro with no measured `V` loss, raising value-density **+50% to +100%**.

**Honest caveat on the pruner.** These are low-VOI *on this corpus*, not in
general: changed-files would matter for an un-prefixed PR title; the duplicate scan
matters if you score duplicate-detection; the author-exclude matters when the
author *is* a code-owner. The pruner reports value-on-the-measured-tasks and flags
candidates; the decision to cut stays with a human who knows the wider
distribution. If a macro had no prunable primitive, the tool says so — also a real
result.

## Bottom line

On a pre-registered test, the routing information `I(X;Y)` **predicts an
independently-scored task outcome** (r = 0.997 [0.791, 1.000] over five models;
r = 0.816 with the non-routing model removed), and turning the macro on **raises
independent value-per-call 5.0–10.0×** within every model that routes (CIs above
1). The robust half of the story is the per-joule, externally-scored lift; the raw
in-sample `I`-identity remains partly definitional, and we say so. A design-time
by-product — the VOI pruner — used the same independent signal to find and propose
cutting one zero-value primitive call in each of three macros (value-density
+50–100%). Direct, falsifiable evidence for the mechanism in
[`WHY_IT_WORKS.md`](./WHY_IT_WORKS.md) — a demonstration on one task family, not the
final word.
