# Results — multi-macro routing stress test

**Model:** `qwen2.5:7b-instruct` (Ollama, local, greedy `temperature=0`)
**Prompt set:** v1.0.0 (34 prompts, frozen in the prereg commit `f490e1f`, which
**precedes** this artifact)
**Run:** `multi-macro-qwen2.5_7b-instruct-2026-06-22T02-54-31-710Z.*`
**Reproduce:** `pnpm --filter @macrokit/bench run:multi-macro`

This is the validation the single-macro job vertical could not give: with **one**
macro, routing is trivially "yes/no". Here the same weak local model must pick
the right macro out of **11 across two unrelated domains** and extract its args.

## Headline

| Metric | Result |
|---|---|
| **Routing accuracy (positives, clear ∪ ambiguous)** | **27/28 = 96.4%** |
| &nbsp;&nbsp;clear-intent | 24/24 = 100% |
| &nbsp;&nbsp;ambiguous (accept-set) | 3/4 = 75% |
| **No-route accuracy (negatives)** | **6/6 = 100%** |
| &nbsp;&nbsp;hallucinated-tool-call rate | 0.0% |
| **Arg-extraction — per-key** | 51/52 = 98.1% |
| **Arg-extraction — exact-args** | 23/24 = 95.8% |

The confusion matrix is **fully diagonal on the 24 clear prompts** — zero
cross-macro confusion. qwen2.5:7b cleanly separates all 11 macros across both
domains; it never picked a github macro for a paper prompt or vice-versa, and
never fired a tool on a negative control.

(Full matrix: `*.confusion.txt`. Per-prompt raw: `*.jsonl`. Aggregates:
`*.summary.json`.)

## The interesting failures (the point of the exercise)

Routing is essentially solved at 7B for this macro set. The signal is in the
**three** non-perfect cells — all in *argument extraction* and *genuine
ambiguity*, not in macro classification:

1. **`a04-lit-or-compare` — the one routing miss.** Prompt: *"Pull together the
   literature on graph neural networks so I can compare the top ones."* Accept
   set was `{bibliography_lookup, compare_papers}`; the model chose
   `find_related_papers` — and **fabricated a `paperId`**
   (`10.1371/journal.pone.0205798`) that appears nowhere in the prompt. A
   topic-only query was forced into an ID-shaped macro. This is the most
   instructive failure: when no macro is a clean fit, the weak model
   hallucinates an argument rather than no-routing. → sharper `intent` strings
   distinguishing "search by topic" vs "recommend from an ID", or a retrieval
   pre-filter, would help.

2. **`c07-stale-a` — wrong arg *name*.** Routed correctly to
   `close_stale_issues` and extracted the value `180` correctly, but bound it to
   an invented key `maxDaysInactive` instead of the schema's `minDaysOpen`. The
   schema name was less guessable than the model's prior. → the one per-key miss;
   argues for schema field names that match the obvious natural-language phrasing.

3. **Safety-flag over-trigger (not scored, but worth flagging).** On *both*
   `close_stale_issues` prompts the model set `apply: true`, whereas the schema
   default is `false` (dry-run). Neither prompt said "actually close" vs
   "dry-run". Routing accuracy hides this: a weak model will happily default a
   destructive flag to on. → consequential boolean flags should be gated by the
   dispatcher / require explicit confirmation, not left to arg extraction.

## Honest framing

The headline is strong and real: **96.4% routing / 100% no-route / 98.1% args**
at 7B, fully-diagonal confusion. But the honest finding is *where the residual
risk lives* — not in "which macro" (solved) but in **argument extraction under
ambiguity** (hallucinated IDs, invented field names, defaulted destructive
flags). That is exactly the surface the Macrokit dispatcher's schema validation
+ capability membrane is designed to backstop, and it motivates the Phase-3
value-density question (does a sharper macro `intent` / retrieval pre-filter buy
more than a bigger model?). A single 7B pass already clears the routing bar for
11 macros; the next marginal gains are in arg-validation, not classification.
