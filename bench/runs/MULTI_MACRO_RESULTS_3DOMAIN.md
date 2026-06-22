# Results — multi-macro routing at 17 macros / 3 domains (scaling test)

**Model:** `qwen2.5:7b-instruct` (Ollama, local, greedy `temperature=0`)
**Prompt set:** `prompts-3domain.json` v2.0.0 (51 prompts), frozen in prereg
commit `ab415f8`, which **precedes** this artifact.
**Run:** `multi-macro-prompts-3domain-qwen2.5_7b-instruct-2026-06-22T05-25-29-801Z.*`
**Reproduce:** `pnpm --filter @macrokit/bench run:multi-macro`

The question: does routing **hold as the library grows**? We added the third
reference vertical (`hr-recruiting`, 6 macros) to reach **17 macros across 3
domains** in one registry, and probed specifically for **HR people/candidate
language bleeding into the github or paper macros**.

## Headline — routing got *stronger*, not weaker, at 1.5× the macros

| Metric | Baseline (11 macros / 2 domains, `a1c45c0`) | **This run (17 macros / 3 domains)** |
|---|---|---|
| Macros / domains | 11 / 2 | **17 / 3** |
| Routing accuracy (positives) | 27/28 = 96.4% | **45/45 = 100.0%** |
| &nbsp;&nbsp;clear-intent | 24/24 | **39/39** |
| &nbsp;&nbsp;ambiguous (accept-set) | 3/4 | **6/6** |
| No-route accuracy (negatives) | 6/6 = 100% | **6/6 = 100.0%** |
| Hallucinated-tool-call rate | 0.0% | **0.0%** |
| Arg-extraction — per-key | 98.1% | **98.6% (71/72)** |
| Arg-extraction — exact-args | 95.8% | **97.4% (38/39)** |
| Confusion matrix | fully diagonal | **fully diagonal** |

**The diagonal held.** All 39 clear prompts routed to exactly their gold macro —
zero off-diagonal cells, zero no-route on positives across all three domains
(full matrix in `*.confusion.txt`). Adding 6 HR macros did not cause a single
github or paper prompt to mis-route, and no HR prompt leaked into github/paper.

## The bleed probes — the whole point — all resisted

Three clear prompts were engineered to reuse a verb owned by another domain but
with a candidate/requisition referent, to see if lexical overlap pulls routing
across domains. None did:

| Probe prompt | Tempting wrong macro | Routed to | ✓ |
|---|---|---|---|
| `hx1` "**Triage** candidate CAND-2001 for the backend role." | `triage_issue` / `triage_paper` | `screen_resume` | ✓ |
| `hx2` "**Find the references** for candidate CAND-2003…" | `bibliography_lookup` | `check_references_dryrun` | ✓ |
| `hx3` "**Compare** the candidates for REQ-1001…ranks highest" | `compare_papers` | `rank_candidates` | ✓ |

qwen2.5:7b keyed on the *referent* (a candidate / requisition ID, the word
"candidate") over the *verb*. People/candidate language did **not** bleed.

Notably, the one baseline routing miss — `a04` "Pull together the literature on
graph neural networks so I can compare the top ones" — routed correctly this run
(`bibliography_lookup`, in its accept set), even with 6 more macros competing.

## The one residual arg miss (unchanged from baseline)

Same single arg-extraction miss as the 11-macro run: `c07` (`close_stale_issues`,
"…inactive for over 180 days") routed correctly and extracted the value `180`,
but bound it to an invented key `max` instead of the schema's `minDaysOpen`. The
residual error is still in *argument field-name mapping*, not classification —
the schema field name is less guessable than the model's prior. (This run the
model also populated the unscored `excludeLabels` default sensibly.) Consistent
with the 2-A finding: routing is solved; the marginal risk lives in arg schemas.

## Interpretation

The library **stays routable as it scales** — at least through 17 macros / 3
domains on a 7B local model, routing did not degrade; it was perfect on every
clear and ambiguous prompt and resisted deliberate cross-domain lexical traps.
This is the green light for packaging the three verticals as the seed library
(2-C): there is no evidence yet of a per-macro-count ceiling where intents start
colliding, and the established mitigations (sharper `intent` strings, a
retrieval pre-filter) remain in reserve if a future, larger or more lexically
overlapping library ever pushes off-diagonal cells to appear.
