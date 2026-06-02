# PRE-REGISTRATION — the macro ablation

**Committed before any macro-OFF run.** This document fixes the conditions, the macro-OFF
contract, the trajectory→intent decode rule, the metrics, the prediction, and the statistical
procedure *in advance*. It is **frozen**: once committed it is not edited. Results are reported
against it honestly in [`../docs/MACRO_ABLATION.md`](../docs/MACRO_ABLATION.md), including any
result that contradicts the prediction. The git commit timestamp of this file, preceding the
first `bench/runs/*-off-*` commit, is the audit trail.

Author byline for any resulting publication: **Cheng Qian**. Public/clean only; no private or
proprietary domain content.

This is an **experiment reported as evidence, not a law.** One task family, one corpus, a handful
of local models. It tests one direction of one claim. It is a demonstration; it is explicitly not
a proof, and not a "conservation law."

---

## 0. The question

Macrokit's core mechanism claim ([`../docs/WHY_IT_WORKS.md`](../docs/WHY_IT_WORKS.md)): encoding a
workflow as a **design-time macro** raises the **information delivered per unit of runtime
compute** (value-density) — not merely accuracy. The existing benchmark (`docs/BENCHMARK.md`) is
"macro-ON for every model"; it measures `I`/compute across model *scale*, not encoded-vs-reasoned
*within* a model. The value theory flags exactly this gap as future work
(`value/docs/06-real-agent-test.md` §5: "a clean within-model macro ablation … is future work and
needs a second prompt condition the frozen corpus does not contain"). This is that condition.

## 1. The two conditions (same corpus, same machinery, same sampling)

Both conditions use the **same** committed 100-task `github-maintainer` corpus (`bench/tasks/`),
the **same** `IntentRouter` + tool-calling machinery, and **temperature 0** (greedy). The *only*
difference is the tool set the model is given.

- **MACRO-ON** — the existing harness. The registry holds the **6 encoded workflow macros**
  (`triage_pull_request`, `triage_issue`, `generate_release_notes`, `close_stale_issues`,
  `suggest_reviewers`, `capture_workflow_log`), each carrying an intent description + JSON Schema.
  The model routes intent → **one** macro call (`maxIterations: 1`). Runs already exist in
  `bench/runs/` (the multi-model benchmark). `Y` = the macro the model called.

- **MACRO-OFF** — the runtime-reasoning condition. The registry instead holds **low-level
  primitives** with purely mechanical descriptions (no encoded workflow shape):
  `gh_get_pull`, `gh_get_pull_files`, `gh_get_issue`, `gh_list_open_issues`, `gh_get_issue_comments`,
  `gh_compare_commits`, `gh_get_codeowners`, `gh_add_labels`, `gh_close_issue`,
  `gh_comment_on_issue`, `gh_get_actions_run_log`. The system prompt states there is **no pre-built
  workflow** and the model must compose the primitives needed to accomplish the request. The model
  may call several in sequence (`maxIterations: 5`); primitives return minimal stub data so the
  loop proceeds. `Y` = the workflow intent **decoded from the primitive trajectory** by the rule in
  §2. Same model, same task, same temperature.

**Output-mode note (confound control).** Both conditions use the Ollama tool-calling API, so any
tool-call plumbing weakness of a given model (e.g. mistral's narrate-instead-of-call failure seen
in the benchmark) applies to **both** conditions and cannot bias the *within-model* ON−OFF delta,
which is the quantity of interest. A model that emits no usable tool call is recorded honestly
(intent `no_macro`, the no-op class), never silently dropped.

## 2. Decode rule: macro-OFF trajectory → intent label (FROZEN)

`Y` for macro-OFF is a deterministic function of the **set** of primitive ops the model called
across its trajectory, applied in this priority order (first match wins):

1. `gh_get_actions_run_log` called → **capture_workflow_log**
2. `gh_compare_commits` called → **generate_release_notes**
3. `gh_get_codeowners` called → **suggest_reviewers**
4. `gh_close_issue` or `gh_comment_on_issue` called → **close_stale_issues**
5. `gh_get_pull` or `gh_get_pull_files` called → **triage_pull_request**
6. `gh_get_issue`, `gh_list_open_issues`, or `gh_get_issue_comments` called → **triage_issue**
7. no recognized primitive called (or no tool call at all) → **no_macro**

This decode is intentionally fixed and lossy: without the macro's encoded shape, several intents
share primitives (e.g. PR-triage and reviewer-suggestion both read the PR; the discriminator is
whether the model also thought to fetch CODEOWNERS). That ambiguity is part of what the experiment
measures — it is not patched away after seeing results.

## 3. Label space, X and Y

- **Classes (K = 7):** the 6 workflow macros above + `no_macro`.
- **X (gold):** `task.expected.tool`, with `null` mapped to `no_macro`. Identical across conditions.
- **Y (chosen):** macro-ON = the macro called (`null`→`no_macro`); macro-OFF = the §2 decode.
- **Confusion matrix** `C[x, y]` = #(gold intent x, chosen intent y) over the 100 tasks, 7×7.

## 4. Metrics (per model × condition)

- **Accuracy** — tool-level intent match, the diagonal mass of `C` (fraction with `Y == X`).
  (The existing 0/1/2 scorer is also reported for macro-ON; macro-OFF args are multi-step and not
  directly comparable, so the ablation's accuracy axis is intent-match, computed identically for
  both conditions.)
- **`I(X;Y)` in nats** from `C`, using the value theory's estimator **ported verbatim** from
  `value/sim/value_sim.py::mutual_information` (`P/=P.sum(); I = Σ P ln(P/(px·py))`). Not reinvented.
- **Compute per call** — mean wall-clock latency per task (already recorded by the harness). For
  macro-OFF this is the **total** latency across the multi-step trajectory (the real runtime cost
  of reasoning the workflow). Token counts are **not** captured (not cheap to plumb through the
  router); latency-seconds is the compute unit, matching R3.
- **VALUE-DENSITY** = `I(X;Y)` per **second** of compute (R3's units), and per **call/task**.

## 5. Prediction (pre-committed)

> **MACRO-ON yields higher `I(X;Y)` per second of compute than MACRO-OFF, for each model on the
> ladder.** Expected mechanism: (a) macro-ON preserves task-relevant information at least as well
> (the intent is handed to the model as a tool), and (b) macro-ON spends far less runtime compute
> (one routing call vs a multi-step reasoned sequence). The headline quantity is the **ratio**
> `density(ON) / density(OFF)`; we predict it is `> 1` across the ladder.

Secondary (not gating): macro-ON ≥ macro-OFF on raw `I(X;Y)` and on accuracy. These may be closer
than the density ratio; the density gap is where the claim lives.

## 6. Models

At minimum the set already run macro-ON: `qwen2.5-1.5b`, `qwen2.5-3b`, `qwen2.5-7b`, `llama3.1-8b`,
`mistral-7b` (all Ollama, on the 16 GB China-Mac host via the benchmark's SSH pattern). The ladder
may be extended toward the value-v2 set (`qwen2.5:0.5b`, `llama3.2:1b/3b`, `gemma2:2b`, `phi3.5`)
if those pull and fit cheaply. **Fallback:** a model that won't pull/load/adapt is excluded and
**named with the reason** in `MACRO_ABLATION.md` — never silently dropped. Analysis requires
≥3 models actually run in **both** conditions.

## 7. Statistical procedure

- Point estimates accompanied by **95% confidence intervals** where feasible: bootstrap over the
  100 tasks (≥1000 resamples), recomputing `I(X;Y)`, latency, and density on each resample;
  report the 2.5/97.5 percentiles. The density **ratio** CI is bootstrapped jointly (same resample
  indices for both conditions).
- Greedy decoding (temperature 0) for all runs. All model outputs cached to `jsonl`; every number
  re-derivable offline from the committed run artifacts via `bench/analysis/value_density.py`.

## 8. Honesty rules

- **Report negatives as results.** If macro-OFF wins on any axis for any model, it is stated
  plainly in the results doc, not buried.
- **Demonstration, not law.** No "fourth fundamental quantity" / "conservation law" framing. The
  caveat in §0 travels with every headline.
- **Public/clean.** No private vertical named anywhere. `check-leakage.sh` is run before commit.
