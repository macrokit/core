#!/usr/bin/env python3
"""VOI pruner analysis — rank a macro's ingredients by their marginal
contribution to INDEPENDENT task value V, with bootstrap CIs, and flag the
~0-VOI ones as PRUNE CANDIDATES.

Reads the design-time ablation artifacts produced by `src/voi.ts`
(bench/runs/voi-<macro>.json), each carrying, per ingredient, the per-item
leave-one-out delta in V (baseline V minus ablated V). V is the externally
scored end-state (INDEPENDENT_VALUE_PREREGISTRATION.md §1), NOT the routing
confusion matrix — so an ingredient's VOI is non-circular by construction.

For each ingredient: mean ΔV (marginal value) + a bootstrap 95% CI over items.
FROZEN flag rule: an ingredient is a PRUNE CANDIDATE when its bootstrap 95% CI
upper bound <= EPS (0.05) — i.e. no measurable positive contribution to the
independent outcome on this corpus. For primitive ingredients (a real tool
call), pruning also raises value-density: V per primitive call, reported
before/after removing the flagged primitives.

This PROPOSES. It never deletes. A human reads the table and approves.

Usage: python3 bench/analysis/voi_pruner.py [runs_dir] [--json out.json]
"""
from __future__ import annotations
import json, sys, glob, os
import numpy as np

EPS = 0.05          # CI-upper-bound threshold for "no measurable contribution"
B = 2000            # bootstrap resamples
SEED = 4242

def boot_mean_ci(xs, b=B, seed=SEED):
    xs = np.asarray(xs, dtype=float)
    n = len(xs)
    if n == 0:
        return 0.0, [float("nan"), float("nan")]
    if np.allclose(xs, xs[0]):           # degenerate (e.g. all-zero deltas): CI is the point
        return float(xs[0]), [float(xs[0]), float(xs[0])]
    rng = np.random.default_rng(seed)
    means = [float(xs[rng.integers(0, n, n)].mean()) for _ in range(b)]
    return float(xs.mean()), [float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))]

def analyze(path):
    d = json.load(open(path))
    base = np.asarray(d["baseline"], dtype=float)
    base_mean = float(base.mean()) if len(base) else 0.0
    calls = int(d["baselineCalls"])
    rows = []
    for ing in d["ingredients"]:
        mean, ci = boot_mean_ci(ing["delta"])
        prune = ci[1] <= EPS
        rows.append({"id": ing["id"], "kind": ing["kind"], "cost": int(ing["cost"]),
                     "dV": mean, "ci": ci, "prune": prune})
    rows.sort(key=lambda r: r["dV"], reverse=True)
    # value-density before/after pruning the flagged PRIMITIVE ingredients.
    pruned_calls = sum(r["cost"] for r in rows if r["prune"] and r["kind"] == "primitive")
    after_calls = max(1, calls - pruned_calls)
    dens_before = base_mean / calls if calls else 0.0
    dens_after = base_mean / after_calls
    return {"macro": d["macro"], "n": d["n"], "base_mean": base_mean,
            "calls_before": calls, "calls_after": after_calls,
            "density_before": dens_before, "density_after": dens_after,
            "density_gain_pct": (dens_after / dens_before - 1.0) * 100 if dens_before > 0 else 0.0,
            "pruned_calls": pruned_calls, "rows": rows}

def main():
    np.seterr(all="ignore")
    argv = sys.argv[1:]
    json_out = None
    if "--json" in argv:
        i = argv.index("--json")
        json_out = argv[i + 1] if i + 1 < len(argv) else None
        argv = argv[:i] + argv[i + 2:]
    args = [a for a in argv if not a.startswith("--")]
    runs_dir = args[0] if args else os.path.join(os.path.dirname(__file__), "..", "runs")
    paths = sorted(glob.glob(os.path.join(runs_dir, "voi-*.json")))
    if not paths:
        print(f"no voi-*.json artifacts in {runs_dir}. Run `pnpm exec tsx src/voi.ts` first.")
        return
    out = []
    for p in paths:
        a = analyze(p)
        out.append(a)
        print(f"\n### {a['macro']}  (n={a['n']}, baseline V={a['base_mean']:.3f})")
        print("| Ingredient | kind | calls | marginal ΔV [95% CI] | verdict |")
        print("|---|---|---:|---:|---|")
        for r in a["rows"]:
            ci = f"[{r['ci'][0]:.3f}, {r['ci'][1]:.3f}]"
            verdict = "**PRUNE CANDIDATE**" if r["prune"] else "keep"
            print(f"| `{r['id']}` | {r['kind']} | {r['cost']} | {r['dV']:.3f} {ci} | {verdict} |")
        if a["pruned_calls"] > 0:
            print(f"\nPrune saves {a['pruned_calls']} primitive call(s) per run with no measured V loss. "
                  f"Value-density (V per primitive call): "
                  f"{a['density_before']:.3f} → {a['density_after']:.3f} "
                  f"(**+{a['density_gain_pct']:.0f}%**, {a['calls_before']}→{a['calls_after']} calls).")
        else:
            print("\nNo prunable primitive ingredients — every tool call carries measurable independent value. "
                  "(A real result: nothing to cut here.)")

    if json_out:
        json.dump(out, open(json_out, "w"), indent=2)

if __name__ == "__main__":
    main()
