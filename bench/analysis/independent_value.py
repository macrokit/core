#!/usr/bin/env python3
"""Independent-value analysis (see INDEPENDENT_VALUE_PREREGISTRATION.md).

Reads the `*-iv-*` run artifacts and computes, per model x condition:
  - router I(X;Y) [nats] from the routing confusion matrix (gold_intent vs
    routedIntent), via mutual_information ported verbatim from value_sim.py,
  - mean independent value V (externally-scored end-state),
  - compute (mean s/item, calls/item) and value-density V/sec, V/call.

Then:
  CLAIM 1 (non-circular): Pearson r between router I(X;Y) and mean V across
    models (macro-ON), with a bootstrap-over-models 95% CI.
  CLAIM 2 (non-Kelly): per-model macro-ON vs macro-OFF V-per-joule, bootstrap
    95% CI over items, ratio jointly resampled.

Usage: python3 bench/analysis/independent_value.py [runs_dir] [--json out.json]
"""
from __future__ import annotations
import json, sys, glob, os
import numpy as np

def _clip(p): return np.clip(p, 1e-300, None)
def mutual_information(joint):  # ported verbatim from value/sim/value_sim.py
    P = _clip(joint); P = P / P.sum()
    px = P.sum(axis=1, keepdims=True); py = P.sum(axis=0, keepdims=True)
    return float((P * np.log(P / (px * py))).sum())

CLASSES = ["triage_pull_request","triage_issue","generate_release_notes","close_stale_issues",
           "suggest_reviewers","capture_workflow_log","no_macro"]
KNOWN = set(CLASSES)
def lab(t):
    if t is None or t=="" : return "no_macro"
    return t if t in KNOWN else "no_macro"

def load(path):
    head=None; rows=[]
    for line in open(path):
        line=line.strip()
        if not line: continue
        o=json.loads(line)
        if o.get("type")=="header": head=o
        elif o.get("type")=="task":
            rows.append((lab(o["goldIntent"]), lab(o.get("routedIntent")),
                         float(o["value"]), float(o["latencyMs"]), int(o.get("calls",1))))
    return head, rows

def confusion(rows, idxs=None):
    # Build the matrix over ONLY the labels observed in these rows (gold ∪
    # routed). The IV corpus exercises a subset of the 7-class space, and a
    # zero-marginal class would underflow px*py to 0.0 → I=inf. Restricting to
    # the realized label space changes nothing about the MI value (a 0-marginal
    # class contributes 0·log0 = 0) and is the correct space for this corpus.
    src=rows if idxs is None else [rows[i] for i in idxs]
    seen=[]
    for x,y,_,_,_ in src:
        for c in (x,y):
            if c not in seen: seen.append(c)
    seen.sort()
    idx={c:i for i,c in enumerate(seen)}; k=max(1,len(seen))
    C=np.zeros((k,k))
    for x,y,_,_,_ in src: C[idx[x],idx[y]]+=1
    return C

def metrics(rows, idxs=None):
    src = rows if idxs is None else [rows[i] for i in idxs]
    n=len(src)
    I=mutual_information(confusion(rows,idxs))
    V=float(np.mean([r[2] for r in src])) if n else 0.0
    s=float(np.mean([r[3] for r in src])/1000.0) if n else 0.0
    calls=float(np.mean([r[4] for r in src])) if n else 0.0
    return {"I":I,"V":V,"s":s,"calls":calls,
            "V_per_s": V/s if s>0 else 0.0, "V_per_call": V/calls if calls>0 else 0.0, "n":n}

def latest(runs_dir):
    best={}
    for p in glob.glob(os.path.join(runs_dir,"*-iv*.jsonl")):
        h,_=load(p)
        if not h: continue
        mid=h["modelId"]
        if mid not in best or p>best[mid]: best[mid]=p
    return best

def boot_ratio(on,off,key="V_per_s",B=2000,seed=7):
    rng=np.random.default_rng(seed); n=min(len(on),len(off)); rs=[]
    for _ in range(B):
        idx=rng.integers(0,n,n).tolist()
        a=metrics(on,idx)[key]; b=metrics(off,idx)[key]
        if b>0: rs.append(a/b)
    return ([float(np.percentile(rs,2.5)),float(np.percentile(rs,97.5))] if rs else [float('nan')]*2)

def main():
    np.seterr(all="ignore")
    argv=sys.argv[1:]; json_out=None
    if "--json" in argv:
        i=argv.index("--json"); json_out=argv[i+1] if i+1<len(argv) else None; argv=argv[:i]+argv[i+2:]
    args=[a for a in argv if not a.startswith("--")]
    runs_dir=args[0] if args else os.path.join(os.path.dirname(__file__),"..","runs")
    best=latest(runs_dir); runs={m:load(p) for m,p in best.items()}

    # pair base model id (strip -iv / -iv-off)
    def base(mid): return mid.replace("-iv-off","").replace("-iv","")
    bases=sorted({base(m) for m in runs})
    out={"models":[], "claim1":{}, "claim2":[]}
    on_I=[]; on_V=[]; names=[]
    for b in bases:
        on_id=b+"-iv"; off_id=b+"-iv-off"
        if on_id not in runs: continue
        on=metrics(runs[on_id][1]); rec={"model":b,"on":on}
        names.append(b); on_I.append(on["I"]); on_V.append(on["V"])
        if off_id in runs:
            off=metrics(runs[off_id][1]); rec["off"]=off
            rec["V_per_s_ratio_on_over_off"]= on["V_per_s"]/off["V_per_s"] if off["V_per_s"]>0 else None
            rec["V_per_s_ratio_ci"]=boot_ratio(runs[on_id][1],runs[off_id][1],"V_per_s")
            rec["V_per_call_ratio_on_over_off"]= on["V_per_call"]/off["V_per_call"] if off["V_per_call"]>0 else None
            rec["V_per_call_ratio_ci"]=boot_ratio(runs[on_id][1],runs[off_id][1],"V_per_call")
            out["claim2"].append(rec)
        out["models"].append(rec)

    # CLAIM 1: Pearson r between router I and mean V across models (macro-ON)
    on_I=np.array(on_I); on_V=np.array(on_V)
    if len(on_I)>=3 and on_I.std()>0 and on_V.std()>0:
        r=float(np.corrcoef(on_I,on_V)[0,1])
        rng=np.random.default_rng(11); rs=[]
        m=len(on_I)
        for _ in range(5000):
            idx=rng.integers(0,m,m)
            xi,yi=on_I[idx],on_V[idx]
            if xi.std()>0 and yi.std()>0: rs.append(np.corrcoef(xi,yi)[0,1])
        out["claim1"]={"pearson_r":r,"ci":[float(np.percentile(rs,2.5)),float(np.percentile(rs,97.5))],
                       "n_models":m,"models":names,"I":on_I.tolist(),"V":on_V.tolist()}

    # tables
    print("\n### Per model (macro-ON):")
    print("| Model | router I(X;Y) | mean V | s/item | V/sec | V/call |")
    print("|---|---:|---:|---:|---:|---:|")
    for rec in out["models"]:
        o=rec["on"]; print(f"| {rec['model']} | {o['I']:.3f} | {o['V']:.3f} | {o['s']:.2f} | {o['V_per_s']:.4f} | {o['V_per_call']:.4f} |")
    print("\n### Claim 2 — macro-ON vs macro-OFF independent value-per-joule:")
    print("Per-call is the latency-robust compute proxy (see MACRO_ABLATION.md); per-second carries shared-host wall-clock noise.")
    print("| Model | V ON | V OFF | ON/OFF V/call [95% CI] | ON/OFF V/sec [95% CI] |")
    print("|---|---:|---:|---:|---:|")
    for rec in out["claim2"]:
        on,off=rec["on"],rec["off"]
        rc=rec["V_per_call_ratio_on_over_off"]; cic=rec["V_per_call_ratio_ci"]
        rsc=f"{rc:.2f}× [{cic[0]:.2f},{cic[1]:.2f}]" if rc else "n/a"
        r=rec["V_per_s_ratio_on_over_off"]; ci=rec["V_per_s_ratio_ci"]
        rs=f"{r:.2f}× [{ci[0]:.2f},{ci[1]:.2f}]" if r else "n/a"
        print(f"| {rec['model']} | {on['V']:.3f} | {off['V']:.3f} | {rsc} | {rs} |")
    if out["claim1"]:
        c=out["claim1"]; print(f"\n### Claim 1 — router I(X;Y) vs independent V across {c['n_models']} models:")
        print(f"Pearson r = {c['pearson_r']:.3f}  (bootstrap-over-models 95% CI [{c['ci'][0]:.3f}, {c['ci'][1]:.3f}])")

    if json_out:
        json.dump(out, open(json_out,"w"), indent=2)

if __name__=="__main__": main()
