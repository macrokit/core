# Independent value — does the information quantity predict a task outcome it isn't defined from?

> ## ✅ CORRECTED RE-RUN (2026-06-19) — the withdrawn lift is replaced with the measured one
> A first version of this experiment (the `*-iv-*` runs) was **withdrawn**: an external review found a
> harness asymmetry in which **macro-OFF** ran with empty tool surfaces + hardcoded **stub** primitives
> while **macro-ON** got the real per-item fixture. The two arms did not have matched information access,
> so macro-OFF's value floor (0.11–0.17) was a **structural artifact** and the reported **5–10× ON/OFF
> lift was predetermined by the harness, not measured**.
>
> That defect is fixed (commit `5af609a`: `buildFixturedPrimitiveRegistry` — macro-OFF primitives now
> return the **same per-item fixture data** macro-ON gets) and the experiment was **re-run from a fresh
> pre-registration** ([`INDEPENDENT_VALUE_RERUN_PREREGISTRATION.md`](../bench/INDEPENDENT_VALUE_RERUN_PREREGISTRATION.md),
> committed `b507345` before any corrected run; artifacts are `bench/runs/*-iv2-*`, kept separate from the
> withdrawn `*-iv-*` record).
>
> **The corrected result, reported below, is smaller and we say so plainly:** with a fair baseline,
> macro-OFF reaches `V` ≈ 0.39–0.44 (not 0.11–0.17), and the macro-ON advantage is **~2.1–2.8× per call,
> not 5–10×** — the withdrawn lift was roughly **double** the real one. The core claim survives (macro-ON
> still beats a *fair* macro-OFF on every routing model, all CIs above 1); the magnitude does not. The
> sections below are the corrected (`-iv2-`) numbers. This result is pending independent adversarial
> re-verification; the raw confusion matrices, per-item `V` vectors, and bootstrap seeds are dumped to
> [`bench/runs/iv2_analysis.json`](../bench/runs/iv2_analysis.json) to make that easy.

**This is an experiment reported as evidence, not a law.** One task family
(`github-maintainer`), one ~18-item fixtured corpus, five local models, discrete
outcomes. It is a demonstration; it is explicitly not a proof and not a
"conservation law." The corrected re-run is pre-registered at
[`../bench/INDEPENDENT_VALUE_RERUN_PREREGISTRATION.md`](../bench/INDEPENDENT_VALUE_RERUN_PREREGISTRATION.md)
(commit `b507345`, which precedes the first `bench/runs/*-iv2-*` artifact — the audit
trail); it supersedes the original
[`INDEPENDENT_VALUE_PREREGISTRATION.md`](../bench/INDEPENDENT_VALUE_PREREGISTRATION.md). The
rerun prereg states the honest prior up front: with a fair baseline the lift **may shrink
or vanish, and that is a fine, publishable outcome.** It shrank; we report it.

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

## Results (corrected re-run, `*-iv2-*`)

Five local models, temperature 0, both arms fed the same per-item fixture.
Reproduce with `python3 bench/analysis/independent_value2.py bench/runs`
(reads only `*-iv2-*`; writes the full audit dump with `--json`).

### Prediction 1 — router `I(X;Y)` vs the independent outcome `V` (macro-ON)

The macro-ON arm was **not** changed by the fix (the asymmetry was only in
macro-OFF), so these numbers match the withdrawn run, as expected.

| Model | router `I(X;Y)` nats | mean `V` |
|---|---:|---:|
| qwen2.5-1.5b | 1.147 | 0.778 |
| qwen2.5-3b | 1.301 | 0.833 |
| qwen2.5-7b | 1.301 | 0.889 |
| llama3.1-8b | 1.301 | 0.833 |
| mistral-7b | ~0.000 | 0.111 |

**Pearson r = 0.997, bootstrap-over-models 95% CI [0.791, 1.000]** (n = 5, seed
1102). Among the four routing models (mistral dropped, `I` below the 0.05 floor),
**r = 0.816**. The information the router carries about the gold intent predicts a
task outcome that is not read from the routing matrix; the correlation is not solely
a mistral artifact, though the full-sample r is partly driven by mistral's
low-`I`/low-`V` corner (see honest analysis).

### Prediction 2 — macro-ON vs macro-OFF independent value-per-call (the corrected test)

This is the prediction the fix actually changes. macro-OFF now runs against
fixture-backed primitives that return the **same per-item data** macro-ON gets, so
the comparison is fair. Per-call is the latency-robust compute proxy; per-second is
shown alongside but macro-OFF is much slower (multi-step), so per-second flatters
macro-ON and we lead with per-call. Paired bootstrap over items, ratio jointly
resampled (seed 7, 2000×).

| Model | `V` ON | `V` OFF | router `I` OFF | ON/OFF `V`/call [95% CI] | ON/OFF `V`/sec [95% CI] |
|---|---:|---:|---:|---:|---:|
| qwen2.5-1.5b | 0.778 | 0.389 | 0.931 | **2.14×** [1.39, 4.64] | 3.27× [1.63, 8.57] |
| qwen2.5-3b | 0.833 | 0.444 | 0.960 | **2.76×** [1.50, 5.78] | 6.15× [3.60, 13.29] |
| qwen2.5-7b | 0.889 | 0.389 | 1.037 | **2.43×** [1.60, 5.28] | 4.29× [2.60, 9.79] |
| llama3.1-8b | 0.833 | 0.389 | 1.009 | **2.39×** [1.45, 5.20] | 8.04× [5.27, 17.07] |
| mistral-7b | 0.111 | 0.167 | ~0.000 | n/a | 0.84× [0.00, 1.49] |

For every model that routes, macro-ON delivers **~2.1–2.8× the independent value per
call** of a *fair* macro-OFF, with all four CIs entirely above 1. This is roughly
**half** the withdrawn run's 5–10×: that inflation was the harness defect. The lower
bound of the worst CI is 1.39× — the macro-ON advantage is real and survives a fair
baseline, but it is a ~2× effect, not an order of magnitude.

## What it shows

**The macro advantage survives a fair baseline, at about half the withdrawn size.**
Once macro-OFF can see the same per-item data, weak models compose a substantial
fraction of the workflow value from raw primitives on their own — macro-OFF reaches
`V` ≈ 0.39–0.44, against macro-ON's 0.78–0.89. The encoded macro still roughly
*doubles* per-call value, but it does not 5–10× it; the design-time encoding is a
strong convenience-and-reliability win on this corpus, not a capability chasm.

**Routing is not the differentiator — executing the encoded logic is (still true,
softer).** In the corrected macro-OFF the models route correctly about as often as
in macro-ON (decoded router `I` ≈ 0.93–1.04 vs 1.15–1.30), yet `V` is roughly half.
Reading the per-item dump: a model routes a PR-triage item right, fetches the PR, and
still produces the wrong classification or omits the gold label about half the time.
So the gap the macro closes is in *reliably reproducing the encoded logic*, not in
picking the workflow — the original reading, but now a 0.39→0.83 gap, not the
artifactual 0.11→0.83 one.

**Prediction 1 holds and is unchanged.** Router `I(X;Y)` predicts the independent
`V` (r = 0.997 / 0.816 among routers). Because the macro-ON arm was untouched, this
half of the result is exactly as before — and exactly as circumscribed (next section).

## Honest analysis — what this does and does NOT escape

- **The withdrawn headline was inflated ~2×, and we are not defending it.** The
  pre-registered prior allowed for the lift to shrink or vanish; it shrank from
  5–10× to ~2.4×. The corrected number is the one to cite. The `*-iv-*` runs stay in
  the repo as the record of the confounded attempt.
- **Reduces, does not eliminate, circularity.** `V` is scored externally (end-state
  vs hand gold), so it is not the routing matrix. But in **macro-ON** the end-state
  is still *downstream of* routing, so router `I` and `V` share routing as a common
  driver and a positive correlation is *expected* — external validity, not proof of
  independence. The cleaner decouple is the now-fair macro-OFF arm, where routing is
  right yet `V` is lower; that gap (Prediction 2) is the load-bearing signal, and it
  is a ~2× effect.
- **Prediction 1's strength leans partly on mistral.** mistral barely perceives the
  task (`I ≈ 0`, `V = 0.11`) and anchors the low corner. Removing it, r drops from
  0.997 to 0.816 — still clearly positive, but the among-routers spread is small:
  three of the four routing models have **identical** `I = 1.301` on this 18-item
  corpus (near-saturated routing, a small-n artifact). A larger, harder corpus would
  spread `I` among the routers and is the obvious next step.
- **Still one task family, discrete outcomes, small n.** 18 items, 3 macros, 5
  models, a handful of discrete `V` levels. A demonstration on `github-maintainer`,
  not a universal law. Fixtures, gold, scoring rule, and both predictions frozen
  pre-run.
- **mistral is a reported negative, not a dropped one.** It fails in both conditions
  (it narrates tool calls as prose — the same `tool_call_as_text` plumbing failure
  seen in the benchmark and ablation), so it cannot inform the within-model ON/OFF
  ratio (Prediction 2, n/a). It is *kept* in Prediction 1, where its low-`I`/low-`V`
  point is a real observation.
- **macro-OFF is much slower, so per-second flatters macro-ON.** macro-OFF runs up to
  five router steps; its wall-clock `V`/sec ratios (3–8×) are inflated by that, which
  is why we lead with `V`/call (~2.4×). Reported, not hidden.

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

On a pre-registered, harness-corrected re-run, the routing information `I(X;Y)`
**predicts an independently-scored task outcome** (r = 0.997 [0.791, 1.000] over five
models; r = 0.816 with the non-routing model removed), and turning the macro on
**raises independent value-per-call ~2.1–2.8×** within every model that routes (all
CIs above 1, worst lower bound 1.39×). That ~2.4× is **about half** the 5–10× a
confounded first run reported; the inflation was a harness asymmetry (macro-OFF was
starved of the per-item data), and the corrected number is the one to cite. The macro
advantage is real and survives a fair baseline — a roughly 2× value-per-call win — but
it is not an order-of-magnitude capability chasm. A design-time by-product — the VOI
pruner, which is unaffected by the asymmetry (it runs the deterministic handler with
no model in the loop) — used the same independent signal to find and propose cutting
one zero-value primitive call in each of three macros (value-density +50–100%). A
demonstration on one task family, not the final word — and a worked example of
publishing the corrected number when the first one doesn't survive review. Mechanism
context in [`WHY_IT_WORKS.md`](./WHY_IT_WORKS.md).
