# Macrokit launch benchmark — methodology

**Status:** Pre-registered 2026-05-27.
**Task corpus committed at:** `bench/tasks/*.jsonl` — frozen before any model was run.
**Harness committed at:** `bench/src/*.ts` — frozen before any model was run.
**Runs committed at:** `bench/runs/<model-id>-<timestamp>.jsonl` — appended after each run.

Pre-registration matters. If we choose the corpus after seeing the results, we can flatter any model we like. The corpus and the scoring rules are committed to a public-on-launch repo *before* a single model is invoked. The git log is the audit trail.

## 1. The question

> *Across a span of LLM capability (frontier API down to a 7B on-device model), how well does intent routing alone — the Macrokit pattern — recover frontier behavior on narrow workflows?*

Specifically: holding the macro library fixed (the six maintainer-agent macros from `examples/github-maintainer/`), how many of N natural-language user requests does each model route to the correct macro with the correct arguments?

We are **not** measuring:

- The macros' own correctness — those are deterministic functions, identical across all models.
- General LLM capability — there are saturated leaderboards for that.
- Latency, cost, throughput — relevant but separate; reported as secondary columns, not the headline.

We **are** measuring: *given the pattern, does the routing step work at all on weak models?* That is the load-bearing claim of the launch pitch.

## 2. Models

| Slot | Model | Provider | Type | Status |
|---|---|---|---|---|
| Frontier ceiling | `claude-sonnet-4` | Anthropic | Cloud API | pending API key |
| Cloud (mid-size) | `qwen-plus` | Alibaba DashScope | Cloud API | pending API key |
| Cloud (cheap) | `deepseek-chat` | DeepSeek | Cloud API | pending API key |
| Cloud (cheap) | `glm-4-flash` | Zhipu | Cloud API | pending API key |
| **On-device floor** | **`Qwen 2.5 7B Instruct Q4_K_M`** | **llama-server, M1 MacBook (16 GB)** | **Local** | **runnable now** |

The on-device row is the **production model** of the private reference deployment. Exact quant: bartowski's GGUF, SHA256 `65b8fcd92af6b4fefa935c625d1ac27ea29dcb6ee14589c55a8f115ceaaa1423`, 4.4 GB. llama.cpp build `b9354`.

Production hyperparameters held constant across runs:

| Param | Value |
|---|---|
| `temperature` | `0.0` (greedy — matches production) |
| `max_tokens` | `512` |
| `top_p` | `1.0` |
| `-np` | `1` (single inference slot) |
| `-c` | `8192` (context window) |
| `--cache-type-k`, `--cache-type-v` | `q8_0` |

For cloud models: `temperature: 0` where the provider supports it; otherwise the lowest documented setting. No special prompt engineering — every model sees the exact same system prompt (macro registry) and user prompt.

## 3. Tasks

100 tasks split across the six maintainer-agent macros plus a "no-macro" bucket. Distribution chosen to mirror realistic maintainer workflows:

| Bucket | Tasks | Notes |
|---|---|---|
| `triage_pull_request` | 15 | core daily task |
| `triage_issue` | 15 | with duplicate-detection variants |
| `generate_release_notes` | 12 | needs base/head extraction |
| `close_stale_issues` | 12 | parameter-heavy (criteria) |
| `suggest_reviewers` | 12 | |
| `capture_workflow_log` | 8 | the browser-driven one |
| `no_macro` | 11 | model should reply in free text, not call a tool |
| `ambiguous_multi_intent` | 15 | request could plausibly hit two macros — gold answer pins one based on the most common maintainer reading |

Each task is tagged with a difficulty band:

- `easy_direct` — phrasing is close to the macro's intent string.
- `medium_paraphrase` — synonyms and casual phrasing.
- `hard_implicit` — intent is implied, not stated (e.g. *"clean up old stuff in repo X"* → `close_stale_issues`).
- `hard_distractor` — sentence contains tokens that look like a different macro's vocabulary.

Distribution per bucket is documented in `tasks/README.md` alongside the JSONL files.

## 4. Task format

One JSON object per line (JSONL). Schema:

```json
{
  "id": "T015",
  "bucket": "triage_pull_request",
  "difficulty": "medium_paraphrase",
  "prompt": "could you take a look at pull request 1234 over in microsoft/vscode and tell me what kind of change it is",
  "expected": {
    "tool": "triage_pull_request",
    "args": { "owner": "microsoft", "repo": "vscode", "number": 1234 }
  },
  "notes": "PR number expressed as 'pull request 1234'; expect the model to parse without an explicit '#'."
}
```

For `no_macro` tasks, `expected.tool` is `null` and `expected.args` is omitted.

For `ambiguous_multi_intent` tasks, `expected.tool` records the single canonical answer; `notes` records the alternative the model might pick. Half-credit may be assigned (see scoring) if the model picks the documented alternative.

## 5. Scoring

Two binary signals per task:

| Signal | Meaning | Points |
|---|---|---|
| `tool_match` | Model emitted exactly the expected tool name (or no tool call when expected was `null`). | 1 |
| `args_match` | Every expected arg key is present with the expected value (extra args ignored — providers vary on whether they include defaults). | 1 |

`args_match` is auto-zero when `tool_match` is zero (you can't get args credit for the wrong tool).

**Score per task:** 0, 1 (tool only), or 2 (tool + args).
**Score per bucket:** sum of task scores.
**Headline score per model:** sum across all tasks, divided by `2 × |tasks|`, expressed as percentage.

Two derived metrics, reported but not headline:

- **Bail-out rate:** % of tasks where the Macrokit bail-out detector fired (model emitted tool call as text, called an unknown tool, looped, etc.). Lower is better. The detector's classification is logged per task.
- **Mean latency per request:** wall-clock seconds from `complete()` call to result.

The raw model output (full assistant message + tool_calls JSON) is logged per task to `bench/runs/<model-id>-<timestamp>.jsonl`. **Every scored run is published — including failed ones.** (Stated as "every run" in earlier revisions; a set of discarded exploratory Ollama runs at the wrong sampling temperature — 0.8, against the pre-registered temperature 0 — was never scored and never committed, so the claim is now scoped to what was always true of the scored runs.) Anyone wanting to audit can replay the harness against the same corpus.

## 6. Half-credit policy on ambiguous tasks

For tasks tagged `ambiguous_multi_intent`:

- Picking the canonical answer: full credit per the scoring above.
- Picking the documented alternative: `tool_match = 0.5` (and `args_match` evaluated against the alternative's expected args from `notes.alternative_args`).
- Picking any other tool: zero.

Documented before running. Not adjustable after.

## 7. The harness

`bench/src/cli.ts run --model <id>` — load all task files, instantiate the appropriate adapter and a `Runtime` with the six maintainer macros registered, dispatch each prompt, capture the raw model output AND any bail-out signal, write per-task results to a JSONL run file, write an aggregate summary to stdout and to `bench/runs/<id>-<timestamp>.summary.json`.

The harness reads `MACROKIT_BENCH_MODEL_*` environment variables for adapter configuration (base URL, key, model name). Adapters are constructed via the same `@macrokit/llm` package adopters use — no benchmark-only code paths.

## 8. What this benchmark cannot tell you

- It does not tell you how each model behaves on workflows *outside* the maintainer-agent macro library. Macrokit's pitch is that any workflow can be encoded; this benchmark exercises six.
- It does not measure the macros' own correctness, output quality, or downstream effects (issues actually closed, PRs actually labeled). Those are deterministic; the variation we measure is purely the routing step.
- It does not control for prompt-engineering effort on the cloud models. We use the same system prompt for every model. A frontier model with bespoke prompting would do better on every cell.
- It does not measure data-residency or compliance properties. Those are architectural claims, not benchmark questions.

If you'd want to see one of those questions answered too, the harness is open — fork and extend.

## 9. Reproducibility

| Asset | Where |
|---|---|
| Task corpus | `bench/tasks/*.jsonl` — committed before any run, frozen. |
| Harness source | `bench/src/*.ts` — committed before any run, frozen. |
| Macro library | `examples/github-maintainer/` — committed before any run. |
| Local model GGUF SHA256 | Documented in §2 above. |
| Cloud model versions | Recorded per-run in the JSONL run header. |
| Raw outputs | `bench/runs/*.jsonl` — committed after each run, all of them. |
| Score summaries | `bench/runs/*.summary.json` — committed after each run. |

Pre-registration commit (this file plus tasks + harness, BEFORE any model is run): captured in the git log of [github.com/macrokit/core](https://github.com/macrokit/core) — see the commit immediately preceding the first commit under `bench/runs/`.

## 10. Post-run audit log

After each run, we walk the non-full tasks and check whether each loss was a fair model miss or a scorer / corpus artifact. Findings are documented here **without retroactively changing published scores** — pre-registered numbers are immutable.

When the audit finds a corpus design gap (e.g. an ambiguous task that should have allowed half-credit but didn't have an `alternative` field), the gap is documented here and the corpus is left as-is for the next run. Future runs apply the clarified rule from the start; old runs keep their original scores.

### Run 2 audit — `qwen-7b-local-2026-05-27T09-56-43-014Z` (94.5%, 189/200)

Seven tasks scored below full (3 × `tool_only` losing 1 point each + 4 × `miss` losing 2 points each = 11 points missing).

**Genuine model misses (5):**

| Task | Bucket | Verdict | Finding |
|---|---|---|---|
| ST002 | `close_stale_issues` | `tool_only` | Prompt was *"close stale issues in macrokit/core older than 120 days"*. Expected `apply: true`. Model omitted the `apply` arg. The model exhibits a systematic dry-run bias on `close_stale_issues` — confirmed across ST002 / ST004 / ST012. |
| ST004 | `close_stale_issues` | `tool_only` | Same pattern: *"clean up old issues … 90+ days"*. Expected `apply: true`. Model omitted. |
| ST012 | `close_stale_issues` | `tool_only` | Same pattern; model explicitly set `apply: false`. |
| NM010 | `no_macro` | `miss` | *"give me a release notes template I can adapt"* — model called `generate_release_notes` with hallucinated `owner/repo/base/head`. Should have answered in free text. Scorer fair. |
| AM012 | `ambiguous_multi_intent` | `miss` | *"go through the issue list in microsoft/vscode and label everything that's a bug"* — batch action, no specific number. Model called `triage_issue` with `number: 1`, hallucinating a target. Should have asked for clarification or declined. Scorer fair. |

**Corpus design gaps (2) — rubric clarification, no retroactive rescoring:**

| Task | Verdict | Corpus issue | If half-credit had applied |
|---|---|---|---|
| SR010 | `miss` | Notes field reads *"triage_pull_request is an acceptable alternative — but we only register one expected here per scoring rules."* The corpus author identified an acceptable second answer but did **not** add an `alternative` field, so the scorer (correctly) scored as zero. The model picked the acceptable alternative. | `half` (1.5 of 2: 0.5 tool + 1.0 args — the model's args match the alternative's) |
| SR011 | `miss` | Identical pattern (*"label PR 7 in macrokit/website and pick reviewers"*); notes flag triage_pull_request as acceptable alternative; no `alternative` field. Model picked the alternative. | `half` (1.5 of 2: same scorer semantics) |

**Rubric clarification — applies to runs 3+, NOT retroactively to runs 1 or 2.**

> Half-credit applies on any task — regardless of bucket — whose `notes` field explicitly identifies an acceptable alternative tool. The `alternative` field SHOULD be populated for any such task; if it is absent but the notes describe an alternative, the corpus author SHOULD add the field in a separate corpus-amendment commit before the next run. Run 2 scores are not adjusted.

For transparency: if SR010 and SR011 had received half-credit at run time, the run 2 headline would have been **192/200 = 96.0%** instead of 189/200 = 94.5%. (Earlier revisions of this note said 95.5%, assuming `half` is worth 1 point; the scorer's actual `half` verdict awards 0.5 `tool_score` plus full `args_score` when the args match the alternative's — verified by running `scoreTask` on the artifact rows — i.e. 1.5 points each. Reconciled with PREPRINT.md §5.7/§10 and BENCHMARK.md.) We publish the lower number because the pre-registered rule was what produced it.

**Pattern that emerged:** the model's dominant failure mode on this corpus is **conservative arg omission** (defaulting to safer values like `apply: false`, omitting optional fields entirely) rather than tool mis-selection. Tool selection is solid; the remaining surface area for improvement is making the system prompt or schema rendering pin "explicit verb in prompt → explicit boolean in args" more clearly. Documented for future SDK work, not changed for this run.
