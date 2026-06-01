# Why the pattern works: value per joule

> *Optional reading.* The [Macrokit pattern](./THE_PATTERN.md) is justified empirically — weak, cheap models
> match frontier capability on narrow, repetitive workflows once the multi-step reasoning is moved to
> design-time. This page gives the *formal* account of **why** that works, drawn from the preprint
> [*A Mathematical Theory of Value*](https://doi.org/10.5281/zenodo.20487042) (Qian, 2026). You do not need any
> of this to use Macrokit; it is here for readers who want the underlying reason.

## The one quantity: value per joule

Treat a workflow agent as something that converts a scarce resource (compute, time, tokens) into
goal-progress. Call the rate at which it does so its **value-throughput**. The theory's central result is a
limit:

> **An agent cannot create value faster than it can perceive the task.** Formally, the rate of value creation
> is bounded by the mutual information between the world-state `X` (the correct action) and the agent's
> perception `Y` (the action it takes): `ΔG ≤ I(X;Y)`.

For a *narrow, repetitive* workflow, raw throughput is the wrong yardstick — what matters is throughput **per
unit of scarce resource**:

```
value per joule  =  I(X;Y) / compute
```

This single ratio is what the Macrokit pattern optimizes.

## Why a macro wins

A strong model at runtime spends a great deal of compute re-deriving the same multi-step reasoning on every
call — high `I(X;Y)`, but at high cost, so **low value per joule**.

A macro moves that reasoning to **design-time**: a strong model encodes the workflow once. At runtime the weak
model no longer has to *reason* — it only has to *perceive intent* and dispatch. That collapses the runtime
compute while preserving the task-relevant information, so the macro **raises `I(X;Y)` per joule**. The
expensive deliberation is paid once, at design-time; every runtime call then runs at high value-density.

This is the formal content of the [North Star](./THE_PATTERN.md): the macro is **learned automaticity**
(System 1 — a cheap, high-value-per-joule reflex), and the strong model is **deliberation** (System 2 —
expensive, reserved for novelty). The theory says precisely *why* carrying ~95% of the load on the reflex is
efficient: the reflex maximizes value per joule.

## The evidence

The preprint tests this directly. Across a ladder of local models of increasing capability, it measures
`I(X;Y)` and compute per call on a fixed decision task, and finds that **the cheapest model delivers the most
`I(X;Y)` per second of compute** — the value-per-joule point, on real models. (See the preprint's "real
agents" section, result R3.) It also finds that `I(X;Y)` tracks a model's *realized capability*, not its
parameter count — which is the formal reason a small, well-targeted runtime model can match a much larger one
on a narrow task.

## Honest scope

This is a *per-agent* account, and the experiments are a **demonstration, not a universal law** — one task,
a handful of models. The preprint is explicit about this and names the larger experiment that would settle it;
see its limitations section. We cite the theory here because it gives a clean, testable reason for a pattern
Macrokit already validates empirically — not because Macrokit depends on the theory being the final word.

## Further reading

- Qian, C. (2026). *A Mathematical Theory of Value.* Zenodo. [10.5281/zenodo.20487042](https://doi.org/10.5281/zenodo.20487042)
- [THE_PATTERN.md](./THE_PATTERN.md) — the Macrokit pattern and the North Star it comes from.
