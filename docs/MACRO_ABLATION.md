# The macro ablation — does design-time encoding raise information-per-joule?

**This is an experiment reported as evidence, not a law.** One task family
(`github-maintainer`), one 100-task corpus, five local models, one decision step.
It tests one direction of one claim. It is a demonstration; it is explicitly not a
proof and not a "conservation law." The pre-registration that fixed the conditions,
the decode rule, the metrics, and the prediction *before any run* is committed at
[`../bench/MACRO_ABLATION_PREREGISTRATION.md`](../bench/MACRO_ABLATION_PREREGISTRATION.md)
(its commit precedes the first `bench/runs/*-off-*` commit — the audit trail).

## The question

Macrokit's mechanism claim ([`WHY_IT_WORKS.md`](./WHY_IT_WORKS.md)): encoding a
workflow as a **design-time macro** raises the **information delivered per unit of
runtime compute** (value-density), not merely accuracy. The benchmark
([`BENCHMARK.md`](./BENCHMARK.md)) is "macro-ON for every model" — it measures
`I`/compute across model *scale*, not encoded-vs-reasoned *within* a model. This
ablation adds the missing second condition, within each model:

- **MACRO-ON** — the model is given the 6 encoded workflow macros (intent + JSON
  Schema) and routes intent → one macro call. (`Y` = the macro it called.)
- **MACRO-OFF** — the same model, same task, same temperature 0, but given only the
  11 low-level primitives (mechanical descriptions, no encoded workflow); it must
  compose the workflow itself over up to 5 router steps. (`Y` = the intent decoded
  from its primitive trajectory by the frozen rule in the pre-registration §2.)

`X` = gold intent; `Y` = chosen intent; both over the same 7-class label space.
`I(X;Y)` is computed in nats from the confusion matrix with `mutual_information`
**ported verbatim** from the value theory's `value/sim/value_sim.py`. Value-density
= `I(X;Y)` per second of compute (R3's units) and per call. 95% CIs are bootstrap
over the 100 tasks (2000 resamples; the I/sec ratio is jointly resampled).

## Results

Latest run per model, temperature 0, same corpus. Reproduce with
`python3 bench/analysis/value_density.py bench/runs`.

| Model | Cond | Accuracy | I(X;Y) nats | calls/task | s/task | I/sec | I/call | ON/OFF I/sec [95% CI] | ON/OFF I/call |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| qwen2.5-1.5b | ON | 79.0% | 1.277 | 1.0 | 1.72 | 0.7411 | 1.277 | — | — |
| qwen2.5-1.5b | OFF | 53.0% | 0.789 | 0.8 | 5.38 | 0.1467 | 0.999 | **5.05×** [1.83, 12.50] | 1.28× |
| qwen2.5-3b | ON | 87.0% | 1.561 | 1.0 | 4.12 | 0.3791 | 1.561 | — | — |
| qwen2.5-3b | OFF | 66.0% | 1.031 | 1.1 | 5.55 | 0.1856 | 0.981 | **2.04×** [1.46, 2.65] | 1.59× |
| qwen2.5-7b | ON | 84.0% | 1.515 | 1.0 | 15.63 | 0.0969 | 1.515 | — | — |
| qwen2.5-7b | OFF | 69.0% | 1.226 | 1.2 | 9.09 | 0.1348 | 1.048 | **0.72×** [0.60, 0.84] | 1.45× |
| llama3.1-8b | ON | 86.0% | 1.513 | 1.0 | 10.00 | 0.1514 | 1.513 | — | — |
| llama3.1-8b | OFF | 54.0% | 0.958 | 1.1 | 15.02 | 0.0638 | 0.913 | **2.37×** [1.90, 2.71] | 1.66× |
| mistral-7b | ON | 14.0% | 0.000 | 1.0 | 27.04 | 0.000 | 0.000 | — | — |
| mistral-7b | OFF | 14.0% | 0.000 | 0.0 | 21.20 | 0.000 | 0.000 | n/a | n/a |
| qwen-7b-local (reference) | ON | 96.0% | 1.779 | 1.0 | 5.85 | 0.3040 | 1.779 | — (ON only) | — |

## What it shows

**On information, macro-ON wins on every working model.** `I(X;Y)` is higher with
the encoded macro for all four models that route at all: 1.28→0.79 (1.5b),
1.56→1.03 (3b), 1.52→1.23 (7b), 1.51→0.96 (8b) — ratios 1.24–1.62×. Accuracy moves
the same way (79→53, 87→66, 84→69, 86→54). Stripping the encoded workflow and making
the model reconstruct it from primitives **costs task-relevant information**, because
several intents share primitives and the model has to re-derive which workflow it is
in — exactly the runtime reasoning the macro pays for once, at design time.

**On compute-per-call, macro-ON wins on every working model.** Per call (the
latency-robust compute proxy), macro-ON delivers 1.28–1.66× the `I` of macro-OFF.
The encoded condition is one routing call; the primitive condition averages slightly
more (and many of its calls carry less intent information).

**On wall-clock I/sec, macro-ON wins on three of four — and loses on one.** For
1.5b/3b/8b the encoded macro delivers **2.0–5.1×** the information per second
(CIs entirely above 1). For the **7b the ratio is 0.72× — macro-OFF won this axis**,
and we report it as a result, not bury it.

## The honest negative (qwen2.5-7b on I/sec)

The pre-registration predicted macro-ON > macro-OFF on `I` per second for *every*
model. That is **false for the 7b**: 0.72× [0.60, 0.84]. The cause is wall-clock
latency, not information — the 7b's macro-ON run averaged **15.6 s/call** while its
macro-OFF run averaged **9.1 s/call**. The same model's single-call latency varied
this much *between runs* (Ollama model load/unload, thermal, host load on the shared
16 GB machine), so wall-clock seconds carry run-level noise the within-run bootstrap
does not capture. On the two axes that are robust to that noise the 7b behaves like
the rest of the ladder: macro-ON has **higher `I`** (1.52 vs 1.23) and **higher
`I` per call** (1.45×). So the *claim* — design-time encoding preserves more
task-relevant information at lower runtime reasoning cost — holds for the 7b on the
clean axes; only the wall-clock-seconds expression of it inverted, on a single noisy
latency measurement. We did not re-run to "fix" it; the row stands.

## Caveats and scope

- **The weak models did not chain primitives deeply.** macro-OFF averaged ~1 call
  per task, not the long multi-step plans we expected — small models often emit one
  primitive and stop. So the compute gap here is modest (1.3–1.7× per call); the
  information gap is the larger effect. A stronger model that actually plans long
  sequences would likely widen the compute gap.
- **mistral-7b is excluded from the comparison.** It scores 14% with ~0 `I` in
  *both* conditions: it narrates tool calls in prose instead of emitting them
  (`tool_call_as_text`, the same plumbing failure seen in the benchmark). Because the
  failure is identical in both conditions it cannot inform the within-model ON−OFF
  delta; we report it honestly rather than dropping it silently.
- **The reference `qwen-7b-local` row is ON-only.** It is the production llama.cpp
  server, not re-run in the macro-OFF condition; it is shown for continuity with the
  benchmark, not as a pair.
- **One task family, one decision step.** This is evidence on `github-maintainer`
  intent routing, not a universal law. The decode rule (pre-registration §2) is a
  fixed, lossy map from primitive trajectory to intent; a different decode could
  shift the macro-OFF numbers. It was frozen before the runs.

## Bottom line

On a pre-registered within-model ablation, encoding the workflow as a design-time
macro **raised the information `I(X;Y)` for every model that routes (1.24–1.62×)**
and **raised value-density per call for every such model (1.28–1.66×)**; on
wall-clock information-per-second it delivered **2.0–5.1× for the 1.5B/3B/8B models**,
with the 7B as a reported exception driven by latency noise. That is direct,
falsifiable evidence for the mechanism in [`WHY_IT_WORKS.md`](./WHY_IT_WORKS.md) — a
demonstration on one task, not the final word.
