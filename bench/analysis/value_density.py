#!/usr/bin/env python3
"""Macro ablation analysis — I(X;Y), compute, and value-density per (model x condition).

Reads the committed run artifacts in bench/runs/ (macro-ON = the encoded macros;
macro-OFF = the `*-off-*` primitive-composition runs), builds the 7-class
confusion matrix C[x,y] for each, and computes:

  - accuracy   : fraction with Y == X (diagonal mass of C)
  - I(X;Y)     : mutual information in nats, via mutual_information() ported
                 VERBATIM from value/sim/value_sim.py (not reinvented)
  - mean_lat_s : mean wall-clock seconds per task (macro-OFF = total multi-step)
  - density    : I(X;Y) per second of compute  (R3 units)

with bootstrap 95% CIs over the 100 tasks (joint resampling so the ON/OFF
density ratio CI is coherent). Every number re-derives offline from the runs.

Usage:  python3 bench/analysis/value_density.py [runs_dir] [--json out.json]
"""
from __future__ import annotations
import json, sys, glob, os, math
from collections import defaultdict

try:
    import numpy as np
except Exception:  # pragma: no cover
    sys.stderr.write("numpy required: pip install numpy\n"); raise

# --- ported VERBATIM from value/sim/value_sim.py (with its _clip) ---
def _clip(p):
    return np.clip(p, 1e-300, None)

def mutual_information(joint):
    """I(X;Y) from a joint matrix P[x,y]  (nats)."""
    P = _clip(joint); P = P / P.sum()
    px = P.sum(axis=1, keepdims=True)
    py = P.sum(axis=0, keepdims=True)
    return float((P * np.log(P / (px * py))).sum())
# --------------------------------------------------------------------

CLASSES = [
    "triage_pull_request", "triage_issue", "generate_release_notes",
    "close_stale_issues", "suggest_reviewers", "capture_workflow_log", "no_macro",
]
IDX = {c: i for i, c in enumerate(CLASSES)}
K = len(CLASSES)

def label(tool):
    """Map an expected/actual tool to a class (null/None/unknown -> no_macro)."""
    if tool is None or tool == "":
        return "no_macro"
    return tool if tool in IDX else "no_macro"

def load_run(path):
    """Return (header, [ (x_label, y_label, latency_ms, n_calls), ... ]).

    n_calls = primitive calls the model made this task: macro-OFF = trajectory
    length; macro-ON = 1 (single routing call). A latency-robust compute proxy.
    """
    header, rows = None, []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            o = json.loads(line)
            if o.get("type") == "header":
                header = o
            elif o.get("type") == "task":
                x = label((o.get("expected") or {}).get("tool"))
                y = label(o.get("actualTool"))
                traj = o.get("trajectory")
                ncalls = len(traj) if isinstance(traj, list) else 1
                rows.append((x, y, float(o.get("latencyMs", 0.0)), ncalls))
    return header, rows

def confusion(rows, idxs=None):
    C = np.zeros((K, K))
    src = rows if idxs is None else [rows[i] for i in idxs]
    for x, y, _, _ in src:
        C[IDX[x], IDX[y]] += 1
    return C

def metrics(rows, idxs=None):
    src = rows if idxs is None else [rows[i] for i in idxs]
    C = confusion(rows, idxs)
    n = len(src)
    acc = float(np.trace(C) / n) if n else 0.0
    I = mutual_information(C)
    mean_lat_s = float(np.mean([r[2] for r in src]) / 1000.0) if n else 0.0
    mean_calls = float(np.mean([r[3] for r in src])) if n else 0.0
    density = I / mean_lat_s if mean_lat_s > 0 else 0.0
    density_per_call = I / mean_calls if mean_calls > 0 else 0.0
    return {"accuracy": acc, "I_nats": I, "mean_lat_s": mean_lat_s,
            "mean_calls": mean_calls, "density": density,
            "density_per_call": density_per_call, "n": n}

def latest_per_model(runs_dir):
    """modelId -> newest .jsonl path (so old/confounded runs are ignored)."""
    best = {}
    for p in glob.glob(os.path.join(runs_dir, "*.jsonl")):
        h, _ = load_run(p)
        if not h:
            continue
        mid = h["modelId"]
        if mid not in best or p > best[mid]:
            best[mid] = p
    return best

def boot_ci(rows, B=2000, seed=12345):
    rng = np.random.default_rng(seed)
    n = len(rows)
    Is, Ds, Ls = [], [], []
    for _ in range(B):
        idxs = rng.integers(0, n, n).tolist()
        m = metrics(rows, idxs)
        Is.append(m["I_nats"]); Ds.append(m["density"]); Ls.append(m["mean_lat_s"])
    def ci(a):
        return [float(np.percentile(a, 2.5)), float(np.percentile(a, 97.5))]
    return {"I_nats": ci(Is), "density": ci(Ds), "mean_lat_s": ci(Ls)}

def ratio_ci(on_rows, off_rows, B=2000, seed=999):
    """Joint bootstrap of density(ON)/density(OFF) with shared task indices."""
    rng = np.random.default_rng(seed)
    n = min(len(on_rows), len(off_rows))
    rs = []
    for _ in range(B):
        idxs = rng.integers(0, n, n).tolist()
        don = metrics(on_rows, idxs)["density"]
        doff = metrics(off_rows, idxs)["density"]
        if doff > 0:
            rs.append(don / doff)
    return {"ratio_mean": float(np.mean(rs)) if rs else float("nan"),
            "ratio_ci": [float(np.percentile(rs, 2.5)), float(np.percentile(rs, 97.5))] if rs else [float("nan")]*2}

def main():
    np.seterr(all="ignore")  # benign underflow in MI when a class is absent from a margin
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    runs_dir = args[0] if args else os.path.join(os.path.dirname(__file__), "..", "runs")
    json_out = None
    if "--json" in sys.argv:
        json_out = sys.argv[sys.argv.index("--json") + 1]

    best = latest_per_model(runs_dir)
    runs = {mid: load_run(p) for mid, p in best.items()}

    # pair macro-ON (mid) with macro-OFF (mid + "-off")
    pairs = []
    for mid in sorted(runs):
        if mid.endswith("-off"):
            continue
        off = mid + "-off"
        if off in runs:
            pairs.append((mid, off))

    out = {"classes": CLASSES, "models": [], "unpaired": []}
    for on_id, off_id in pairs:
        on_h, on_rows = runs[on_id]
        off_h, off_rows = runs[off_id]
        on_m, off_m = metrics(on_rows), metrics(off_rows)
        rc = ratio_ci(on_rows, off_rows)
        rec = {
            "model": on_id,
            "display": on_h.get("modelDisplay"),
            "on": {**on_m, "ci": boot_ci(on_rows)},
            "off": {**off_m, "ci": boot_ci(off_rows)},
            "density_ratio_on_over_off": (on_m["density"] / off_m["density"]) if off_m["density"] > 0 else None,
            "density_per_call_ratio_on_over_off": (on_m["density_per_call"] / off_m["density_per_call"]) if off_m["density_per_call"] > 0 else None,
            "I_ratio_on_over_off": (on_m["I_nats"] / off_m["I_nats"]) if off_m["I_nats"] > 0 else None,
            **rc,
        }
        out["models"].append(rec)
    for mid in sorted(runs):
        if not mid.endswith("-off") and (mid + "-off") not in runs:
            h, rows = runs[mid]
            out["unpaired"].append({"model": mid, "display": h.get("modelDisplay"), **metrics(rows)})

    # print a markdown table
    print("\n| Model | Cond | Acc | I(X;Y) nats | calls/task | s/task | I/sec | I/call | ON/OFF I/sec | ON/OFF I/call |")
    print("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|")
    for r in out["models"]:
        on, off = r["on"], r["off"]
        print(f"| {r['model']} | ON | {on['accuracy']*100:.1f}% | {on['I_nats']:.3f} | {on['mean_calls']:.1f} | {on['mean_lat_s']:.2f} | {on['density']:.4f} | {on['density_per_call']:.4f} | — | — |")
        rsec = r["density_ratio_on_over_off"]; rcall = r["density_per_call_ratio_on_over_off"]
        rci = r.get("ratio_ci", [float('nan')]*2)
        sec_s = f"{rsec:.2f}× [{rci[0]:.2f},{rci[1]:.2f}]" if rsec else "n/a"
        call_s = f"{rcall:.2f}×" if rcall else "n/a"
        print(f"| {r['model']} | OFF | {off['accuracy']*100:.1f}% | {off['I_nats']:.3f} | {off['mean_calls']:.1f} | {off['mean_lat_s']:.2f} | {off['density']:.4f} | {off['density_per_call']:.4f} | {sec_s} | {call_s} |")
    for u in out["unpaired"]:
        print(f"| {u['model']} (ON only) | ON | {u['accuracy']*100:.1f}% | {u['I_nats']:.3f} | {u['mean_calls']:.1f} | {u['mean_lat_s']:.2f} | {u['density']:.4f} | {u['density_per_call']:.4f} | — | — |")

    if json_out:
        with open(json_out, "w") as f:
            json.dump(out, f, indent=2)
        print(f"\nwrote {json_out}")

if __name__ == "__main__":
    main()
