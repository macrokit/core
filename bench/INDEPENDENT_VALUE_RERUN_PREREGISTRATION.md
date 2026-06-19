# PRE-REGISTRATION — independent-value test, CORRECTED RE-RUN

**Committed before any corrected run.** This frozen document supersedes the first
attempt's pre-registration (`INDEPENDENT_VALUE_PREREGISTRATION.md`) for the purpose
of the re-run. The git commit timestamp of *this file* must precede the first
`bench/runs/*-iv2-*` artifact. Results are reported honestly against it in
`../docs/INDEPENDENT_VALUE.md`, **including a result that overturns the original
headline.**

## 0. Why a re-run — the harness asymmetry being corrected
The first run was withdrawn (see the erratum at the top of `../docs/INDEPENDENT_VALUE.md`).
External review found that in `outcome-runner.ts` the **macro-OFF** condition ran with
empty tool surfaces + hardcoded **stub** primitives (`{title:"stub", owners:["@octocat"]}`),
while **macro-ON** received the real **per-item fixture**. The two conditions did **not**
have matched information access, so the macro-OFF value floor (0.11–0.17) was a
**structural artifact** — the model was starved of the per-item data the gold requires —
and the reported 5–10× ON/OFF lift was predetermined by the harness, not measured.

**The fix (committed before this prereg, `5af609a`):** `buildFixturedPrimitiveRegistry(fx, sink)`
in `ablation-primitives.ts` — macro-OFF primitives now return the **same per-item
`OutcomeFixture` data** macro-ON gets (`gh_get_pull` → `fx.pr`, `gh_get_codeowners` →
`fx.codeowners`, etc.; `gh_add_labels` records to `sink.labels` so the end-state is
observable). `outcome-runner.ts` wires it into the macro-OFF path. Both conditions now
have **matched information access**.

## 1. The honest prior (stated up front)
With the fix, macro-OFF can now actually *see* the data and attempt the workflow.
**It is entirely possible — and a fine, publishable outcome — that the ON/OFF lift
shrinks substantially or disappears.** If a fixture-fed weak model can compose the
workflow from primitives nearly as well as routing to the encoded macro, then the
original "design-time encoding raises value" claim is weaker than the confounded run
suggested, and we will say so plainly. We are re-running to find the *real* number,
whatever it is. No outcome is "wrong."

## 2. Conditions (FROZEN — same corpus, fixtured client both sides, temperature 0)
- **MACRO-ON:** the 6 encoded macros; one routing call; the macro executes against the
  per-item `FixtureGitHubClient`; `V` scores the produced end-state.
- **MACRO-OFF (corrected):** the **fixture-backed** low-level primitives
  (`buildFixturedPrimitiveRegistry`), up to 5 router steps; the model composes the
  workflow itself from primitives that return the **same per-item data**; `V` scores the
  end-state read from its `sink.labels` + decoded trajectory by the FROZEN rule.
- `X` = gold intent; `Y` = chosen/decoded intent (routing confusion matrix). `V` = the
  FROZEN end-state score (`fixture-client.ts`, unchanged) — read from end-state content,
  never from which intent routed.

## 3. Metrics (per model × condition) — unchanged from the original
Router `I(X;Y)` in nats (`mutual_information`, ported verbatim from `value_sim.py`);
mean independent `V`; compute (s/item, calls/item); value-density `V`/sec and `V`/call.

## 4. Predictions (pre-committed)
1. **Non-circular:** router `I(X;Y)` is positively correlated with independent `V` across
   models (Pearson r; report r + bootstrap-over-models 95% CI, *and* the among-routers r
   with the non-routing model removed).
2. **Causal encoding (the real test now):** macro-ON ≥ macro-OFF on independent
   value-per-call within each routing model. **We do NOT predict the magnitude** — the
   corrected macro-OFF may close most of the gap. Report the per-model ratio + 95% CI; an
   inversion or a ratio near 1 is a valid, reported result.

## 5. Statistical procedure (unchanged)
Bootstrap 95% CIs: Claim 1 = bootstrap over models (≥1000 resamples, 2.5/97.5 pct), plus
the among-routers value; Claim 2 = per-model paired bootstrap over items, ratio jointly
resampled. Mistral kept in Claim 1 if it again fails to route (`tool_call_as_text`); n/a
in Claim 2.

## 6. What this does and does NOT escape (unchanged caveats)
Still one task family (`github-maintainer`), ~18-item fixtured corpus, discrete outcomes,
5 local models. A demonstration, not a law. macro-ON's end-state is still downstream of
routing (shared driver with `I`); the cleaner decouple is the macro-OFF arm — but **only
now that macro-OFF has the data**, so a macro-OFF that *still* underperforms is the
meaningful signal, and a macro-OFF that *matches* is the honest null.

## 7. Audit
Run artifacts land as `bench/runs/*-iv2-*` (distinct from the withdrawn `*-iv-*`). This
file's commit precedes the first such artifact. The withdrawn `*-iv-*` runs stay in the
repo as the record of the confounded attempt; the erratum stands until this re-run is
analyzed and independently re-verified.
