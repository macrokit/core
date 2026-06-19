#!/usr/bin/env python3
"""Independent-value analysis — CORRECTED RE-RUN (see
INDEPENDENT_VALUE_RERUN_PREREGISTRATION.md, committed b507345 BEFORE any run).

This reads ONLY the `*-iv2-*` artifacts (the corrected re-run, where macro-OFF
gets the same per-item fixture data as macro-ON via the fixture-backed primitive
registry). It deliberately does NOT touch the withdrawn `*-iv-*` runs, which
stay in the repo as the record of the confounded first attempt.

Per model x condition: router I(X;Y) in nats (mutual_information ported VERBATIM
from value/sim/value_sim.py), mean independent V, compute (s/item, calls/item),
value-density V/sec and V/call.

  PREDICTION 1 (non-circular): Pearson r between router I(X;Y) and mean V across
    models (macro-ON), bootstrap-over-models 95% CI, plus among-routers r with the
    non-routing model removed.
  PREDICTION 2 (causal encoding): per-model macro-ON vs macro-OFF V/call, paired
    bootstrap 95% CI over items, ratio jointly resampled. Magnitude NOT predicted.

For adversarial re-verification it also writes (with --json) the raw routing
confusion matrices, the per-item V vectors for both conditions, and the bootstrap
seeds — so every number re-derives offline.

Usage: python3 bench/analysis/independent_value2.py [runs_dir] [--json out.json]
"""
from __future__ import annotations
import json, sys, glob, os
import numpy as np

# --- seeds, fixed and reported -------------------------------------------------
SEED_CLAIM1 = 1102          # bootstrap-over-models (Prediction 1)
B_CLAIM1 = 5000
SEED_CLAIM2 = 7             # paired bootstrap over items (Prediction 2)
B_CLAIM2 = 2000
ROUTER_I_FLOOR = 0.05       # a model with macro-ON I below this "does not route" (Prediction 1 among-routers)

def _clip(p): return np.clip(p, 1e-300, None)
def mutual_information(joint):  # ported verbatim from value/sim/value_sim.py
    P = _clip(joint); P = P / P.sum()
    px = P.sum(axis=1, keepdims=True); py = P.sum(axis=0, keepdims=True)
    return float((P * np.log(P / (px * py))).sum())

CLASSES = ["triage_pull_request","triage_issue","generate_release_notes","close_stale_issues",
           "suggest_reviewers","capture_workflow_log","no_macro"]
KNOWN = set(CLASSES)
def lab(t):
    if t is None or t == "": return "no_macro"
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
                         float(o["value"]), float(o["latencyMs"]), int(o.get("calls",1)), o["taskId"]))
    return head, rows

def confusion_labeled(rows, idxs=None):
    """Confusion matrix over the labels observed in these rows (gold ∪ routed).
    Restricting to the realized label space avoids a zero-marginal class
    underflowing px*py to 0 (→ I=inf); it does not change the MI value."""
    src = rows if idxs is None else [rows[i] for i in idxs]
    seen=[]
    for x,y,_,_,_,_ in src:
        for c in (x,y):
            if c not in seen: seen.append(c)
    seen.sort()
    idx={c:i for i,c in enumerate(seen)}; k=max(1,len(seen))
    C=np.zeros((k,k))
    for x,y,_,_,_,_ in src: C[idx[x],idx[y]]+=1
    return C, seen

def metrics(rows, idxs=None):
    src = rows if idxs is None else [rows[i] for i in idxs]
    n=len(src)
    C,_=confusion_labeled(rows, idxs)
    I=mutual_information(C)
    V=float(np.mean([r[2] for r in src])) if n else 0.0
    s=float(np.mean([r[3] for r in src])/1000.0) if n else 0.0
    calls=float(np.mean([r[4] for r in src])) if n else 0.0
    return {"I":I,"V":V,"s":s,"calls":calls,
            "V_per_s": V/s if s>0 else 0.0, "V_per_call": V/calls if calls>0 else 0.0, "n":n}

def latest(runs_dir):
    """ONLY *-iv2-* artifacts. Latest timestamp per modelId."""
    best={}
    for p in glob.glob(os.path.join(runs_dir,"*-iv2-*.jsonl")):
        h,_=load(p)
        if not h: continue
        mid=h["modelId"]
        if mid not in best or p>best[mid]: best[mid]=p
    return best

def boot_ratio(on, off, key="V_per_call", B=B_CLAIM2, seed=SEED_CLAIM2):
    """Paired bootstrap over item indices (same idx resamples both conditions),
    ratio jointly resampled."""
    rng=np.random.default_rng(seed); n=min(len(on),len(off)); rs=[]
    for _ in range(B):
        idx=rng.integers(0,n,n).tolist()
        a=metrics(on,idx)[key]; b=metrics(off,idx)[key]
        if b>0: rs.append(a/b)
    return ([float(np.percentile(rs,2.5)),float(np.percentile(rs,97.5))] if rs else [float('nan')]*2)

def base(mid):  # strip the -iv2 / -iv2-off suffix
    return mid.replace("-iv2-off","").replace("-iv2","")

def main():
    np.seterr(all="ignore")
    argv=sys.argv[1:]; json_out=None
    if "--json" in argv:
        i=argv.index("--json"); json_out=argv[i+1] if i+1<len(argv) else None; argv=argv[:i]+argv[i+2:]
    args=[a for a in argv if not a.startswith("--")]
    runs_dir=args[0] if args else os.path.join(os.path.dirname(__file__),"..","runs")
    best=latest(runs_dir); runs={m:load(p) for m,p in best.items()}
    if not runs:
        print(f"No *-iv2-* artifacts in {runs_dir}. Run the re-run first."); return

    bases=sorted({base(m) for m in runs})
    out={"experiment":"independent_value_rerun","seeds":{"claim1":SEED_CLAIM1,"claim2":SEED_CLAIM2,
         "B_claim1":B_CLAIM1,"B_claim2":B_CLAIM2,"router_I_floor":ROUTER_I_FLOOR},
         "sources":{base(m):os.path.basename(p) for m,p in best.items()},
         "models":[], "claim1":{}, "claim2":[], "audit":{}}
    on_I=[]; on_V=[]; names=[]
    for b in bases:
        on_id=b+"-iv2"; off_id=b+"-iv2-off"
        if on_id not in runs: continue
        on_rows=runs[on_id][1]
        on=metrics(on_rows); rec={"model":b,"on":on}
        names.append(b); on_I.append(on["I"]); on_V.append(on["V"])
        # audit dump: confusion + per-item V
        Con,Clabels=confusion_labeled(on_rows)
        aud={"on":{"confusion_labels":Clabels,"confusion":Con.astype(int).tolist(),
                   "V_per_item":[r[2] for r in on_rows],"task_ids":[r[5] for r in on_rows],
                   "routed":[r[1] for r in on_rows],"gold":[r[0] for r in on_rows]}}
        if off_id in runs:
            off_rows=runs[off_id][1]
            off=metrics(off_rows); rec["off"]=off
            rec["V_per_call_ratio_on_over_off"]= on["V_per_call"]/off["V_per_call"] if off["V_per_call"]>0 else None
            rec["V_per_call_ratio_ci"]=boot_ratio(on_rows,off_rows,"V_per_call")
            rec["V_per_s_ratio_on_over_off"]= on["V_per_s"]/off["V_per_s"] if off["V_per_s"]>0 else None
            rec["V_per_s_ratio_ci"]=boot_ratio(on_rows,off_rows,"V_per_s")
            Coff,Coffl=confusion_labeled(off_rows)
            aud["off"]={"confusion_labels":Coffl,"confusion":Coff.astype(int).tolist(),
                        "V_per_item":[r[2] for r in off_rows],"task_ids":[r[5] for r in off_rows],
                        "routed":[r[1] for r in off_rows],"gold":[r[0] for r in off_rows]}
            out["claim2"].append(rec)
        out["audit"][b]=aud
        out["models"].append(rec)

    # PREDICTION 1
    aI=np.array(on_I); aV=np.array(on_V)
    if len(aI)>=3 and aI.std()>0 and aV.std()>0:
        r=float(np.corrcoef(aI,aV)[0,1])
        rng=np.random.default_rng(SEED_CLAIM1); rs=[]; m=len(aI)
        for _ in range(B_CLAIM1):
            idx=rng.integers(0,m,m); xi,yi=aI[idx],aV[idx]
            if xi.std()>0 and yi.std()>0: rs.append(np.corrcoef(xi,yi)[0,1])
        c1={"pearson_r":r,"ci":[float(np.percentile(rs,2.5)),float(np.percentile(rs,97.5))],
            "n_models":m,"models":names,"I":aI.tolist(),"V":aV.tolist()}
        # among-routers: drop models with macro-ON I below the floor (non-routing)
        keep=[i for i in range(m) if aI[i]>=ROUTER_I_FLOOR]
        dropped=[names[i] for i in range(m) if i not in keep]
        if len(keep)>=3 and aI[keep].std()>0 and aV[keep].std()>0:
            c1["among_routers_r"]=float(np.corrcoef(aI[keep],aV[keep])[0,1])
        else:
            c1["among_routers_r"]=None
        c1["among_routers_n"]=len(keep); c1["dropped_non_routing"]=dropped
        out["claim1"]=c1

    # ---- tables ----
    print("\n### Per model (macro-ON):")
    print("| Model | router I(X;Y) | mean V | s/item | calls/item | V/sec | V/call |")
    print("|---|---:|---:|---:|---:|---:|---:|")
    for rec in out["models"]:
        o=rec["on"]; print(f"| {rec['model']} | {o['I']:.3f} | {o['V']:.3f} | {o['s']:.2f} | {o['calls']:.2f} | {o['V_per_s']:.4f} | {o['V_per_call']:.4f} |")
    print("\n### Per model (macro-OFF, corrected — fixture-backed primitives):")
    print("| Model | router I(X;Y) | mean V | s/item | calls/item | V/sec | V/call |")
    print("|---|---:|---:|---:|---:|---:|---:|")
    for rec in out["claim2"]:
        o=rec["off"]; print(f"| {rec['model']} | {o['I']:.3f} | {o['V']:.3f} | {o['s']:.2f} | {o['calls']:.2f} | {o['V_per_s']:.4f} | {o['V_per_call']:.4f} |")
    print("\n### Prediction 2 — macro-ON vs macro-OFF independent value-per-call (paired bootstrap over items):")
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
        c=out["claim1"]
        print(f"\n### Prediction 1 — router I(X;Y) vs independent V across {c['n_models']} models:")
        print(f"Pearson r = {c['pearson_r']:.3f}  (bootstrap-over-models 95% CI [{c['ci'][0]:.3f}, {c['ci'][1]:.3f}], seed {SEED_CLAIM1})")
        ar=c.get("among_routers_r")
        print(f"Among routers (n={c['among_routers_n']}, dropped {c['dropped_non_routing'] or 'none'}): r = " + (f"{ar:.3f}" if ar is not None else "n/a (I or V near-constant)"))

    if json_out:
        json.dump(out, open(json_out,"w"), indent=2)
        print(f"\nwrote {json_out}")

if __name__=="__main__": main()
