# Macrokit launch benchmark

**Headline:** Off-the-shelf **local** models clear the bar on a pre-registered 100-task intent-routing benchmark (the [`github-maintainer`](../examples/github-maintainer/) reference implementation). The Qwen 2.5 line scales cleanly on a 16 GB MacBook — 1.5B / 3B / 7B at **74 / 79 / 82%** — and Llama 3.1 8B lands at **82.5%**, all via `ollama pull` at temperature 0. The same 7B served as the production reference (llama.cpp, Q4_K_M) reaches **94.5%** with zero structural failures. Full multi-model table below; raw runs for every row in [`bench/runs/`](../bench/runs/).

The harness is shipped, the corpus is committed, the runs are public — **including the failed first run, and a model that flunks**. If you have API keys for any cloud model, run the same harness yourself; instructions below. **We intentionally did not buy or use any frontier API to produce this benchmark.** That choice is the point of this document.

## Results — weak and local models on the same 100-task corpus

Every row is the **same** pre-registered 100-task corpus, scored at **temperature 0** (greedy, per [`methodology.md`](../bench/methodology.md)). No frontier models (see §1 below). Raw `.jsonl` + `.summary.json` for every row are committed in [`bench/runs/`](../bench/runs/) — reproducible with `pnpm exec tsx src/cli.ts run --model <id>`.

| Model | Params | Tasks | Score | Bail-outs | Mean latency |
|---|---|---:|---:|---:|---:|
| Qwen 2.5 1.5B Instruct (Ollama) | 1.5B | 100 | 74.0% | 0 | 1.7 s |
| Qwen 2.5 3B Instruct (Ollama) | 3B | 100 | 79.3% | 0 | 4.1 s |
| Qwen 2.5 7B Instruct (Ollama) | 7B | 100 | 82.3% | 0 | 15.6 s |
| Llama 3.1 8B Instruct (Ollama) | 8B | 100 | 82.5% | 5 | 10.0 s |
| **Qwen 2.5 7B Q4_K_M (llama.cpp, production reference)** | 7B | 100 | **94.5%** | 0 | 5.9 s |
| Mistral 7B Instruct v0.3 (Ollama) | 7B | 100 | 14.0% | 24 | 27.0 s |

**What this shows.** The Qwen 2.5 family scales cleanly on-device — 1.5B → 3B → 7B at 74 → 79 → 82% — and Llama 3.1 8B reaches 82.5%, all on a 16 GB MacBook with no cloud and no key. The same 7B served and tuned as the production reference (llama.cpp, Q4_K_M) reaches 94.5%; most of the gap between an off-the-shelf `ollama pull` and the reference row is serving, quantization, and sampling config — not raw model capability.

**The honest negative.** Mistral 7B v0.3 scored 14% — and the bail-out detector fired on **24** tasks with code `tool_call_as_text`. Mistral narrated the call in prose (*"the `triage_pull_request` macro will be called with…"*) or emitted it inside a fenced code block, instead of producing a structured tool call. That is exactly the structural failure the bail-out detector exists to catch — the harness flags it instead of scoring a hallucinated success. Not every weak model clears the bar on every SDK contract; we publish the row that flunks rather than dropping it. (Mistral may improve with a tool-calling-tuned build or a chat template tweak; the off-the-shelf `mistral:7b` tag as shipped does not.)

*Sampling note:* the harness sends `temperature: 0` explicitly (it previously fell back to the provider default, e.g. Ollama's 0.8 — noisy for routing and not what methodology specifies). The numbers above are the corrected, methodology-compliant runs.

## Why no frontier models in our published numbers

Three reasons, in priority order:

1. **Macrokit is for users who cannot or do not want to access frontier APIs.** Running cloud comparisons ourselves would implicitly concede that frontier is the standard and on-device is a discount from it. That's the framing the SDK exists to dissolve. The on-device result *is* the headline, not a footnote.

2. **Benchmark credibility comes from reproducibility, not vendor money.** A number we produced by paying for cloud inference is inherently less trustworthy than a harness anyone can rerun. We ship the harness, the corpus, the model SHA, and the raw outputs. You don't have to trust our numbers — you can replay them, or run new models we don't have access to.

3. **Frontier comparisons gatekept behind API spend recreate the exact problem Macrokit exists to dissolve.** Many of Macrokit's intended users are in markets where frontier APIs are slow, expensive, or blocked. A benchmark that requires those APIs to interpret its results re-imports that constraint into the SDK's own discourse. We refuse.

If you want a cloud row in this table, here's how: run the harness, post your numbers. Pull requests adding rows to `bench/runs/community/` are how that ecosystem grows. See [Submit your own results](#submit-your-own-results) below.

## What the benchmark measures

Six maintainer-agent macros (`triage_pull_request`, `triage_issue`, `generate_release_notes`, `close_stale_issues`, `suggest_reviewers`, `capture_workflow_log`) plus a "no_macro" bucket and an "ambiguous_multi_intent" bucket. 100 hand-crafted tasks total.

For each task, we score two binary signals: **tool_match** (did the model call the correct macro?) and **args_match** (were the arguments structurally correct?). Each is worth 1 point; max 200. Half-credit is awarded on ambiguous tasks where the model picks a documented alternative.

This benchmark **does not** measure:

- Handler correctness — those are deterministic Macrokit macros, identical across all models.
- General LLM capability — there are saturated leaderboards for that.
- Output quality or downstream effects — only the routing decision is scored.
- Latency or cost — reported but not part of the headline.

Full methodology, scoring rubric, pre-registration commit, and reproducibility notes: see [`bench/methodology.md`](../bench/methodology.md).

## The two-run story

The first benchmark run scored **53.5%**. We found a fixable SDK config issue, fixed it, and the same model on the same corpus scored **94.5%**. Both runs are committed.

### Run 1 (config-level miss)

- Score: **53.5%** (107.0 / 200)
- Bail-outs: 0 / 100
- Mean latency: 3.82 s
- Commit: [run-1 outputs](../bench/runs/) immediately after pre-registration commit [`ff843b1`](https://github.com/macrokit/core/commit/ff843b1)

Inspecting the raw outputs, every miss was the same failure mode: **tool selection was correct, argument naming was not.** The model called `triage_pull_request` correctly but supplied `{"repo": "owner/name", "pr_number": 1234}` instead of `{"owner": "owner", "repo": "name", "number": 1234}`. The schema's argument names were not making it into the tool spec the model saw.

Root cause was in `@macrokit/runtime`'s tool-spec rendering: zod schemas weren't being converted to JSON Schema, so the LLM saw the macro's intent description but not its parameter names. It was guessing reasonable names that didn't match.

### Run 2 (fix shipped)

- Score: **94.5%** (189.0 / 200)
- Bail-outs: 0 / 100
- Mean latency: 5.85 s
- Commit: [`6424cc7`](https://github.com/macrokit/core/commit/6424cc7) — `@macrokit/authoring` now auto-converts zod schemas to JSON Schema at `defineMacro()` time.

The model's capability was never the bottleneck. The SDK's communication of arg names was. This is on us; finding it before launch is exactly what a pre-registered benchmark + raw-output publishing is *for*.

> **Provenance erratum (2026-06-10).** The 94.5% reproduces deterministically from the committed raw
> artifacts (the scorer is fixed; `gold` never enters prompts) and the fix it depends on is real — but two
> provenance caveats apply to the "verify the git log" claim, surfaced by external review:
> - **The run-2 artifact mis-records its commit.** The run-2 `summary.json` header carries
>   `harnessCommit: d3e38e14` — the **pre-fix** Run-1 commit. The zod→JSON-Schema fix landed ~12 minutes
>   later in [`6424cc7`](https://github.com/macrokit/core/commit/6424cc7). Run 2 was executed with the fix
>   in the working tree but tagged with a commit that does not contain it, so checking out the recorded
>   commit reproduces 53.5%, not 94.5%. The prose above attributes the fix to `6424cc7` correctly; the
>   artifact *header* is what's stale.
> - **The history was rewritten after publication.** The repo history was rewritten with `git filter-repo`
>   on 2026-05-31 (a Sacred-Rule-#1 scrub) — after the v2 preprint was deposited. Commit hashes/timestamps
>   are therefore reconstructed; the v2 PDF cites pre-rewrite hashes that no longer resolve. The relative
>   orderings (prereg → run 1 → fix → run 2) still hold in the current history, but the audit trail is
>   reconstructed, not original. A corrected v3 will re-cite current hashes and disclose the rewrite.
>
> The number stands; the provenance metadata did not, and we say so plainly — which is what a pre-registered,
> raw-output-published benchmark is *for*.

### Per-bucket and per-difficulty breakdown (run 2)

| Bucket | Run 1 | Run 2 |
|---|---|---|
| `triage_pull_request` | 50.0% | **100.0%** |
| `triage_issue` | 53.3% | **100.0%** |
| `generate_release_notes` | 50.0% | **100.0%** |
| `capture_workflow_log` | 50.0% | **100.0%** |
| `close_stale_issues` | 50.0% | 87.5% |
| `suggest_reviewers` | 41.7% | 83.3% |
| `no_macro` | 90.9% | 90.9% |
| `ambiguous_multi_intent` | 46.7% | 93.3% |

| Difficulty | Run 1 | Run 2 |
|---|---|---|
| `easy_direct` | 56.0% | 96.0% |
| `medium_paraphrase` | 56.3% | 97.9% |
| `hard_implicit` | 50.0% | **100.0%** |
| `hard_distractor` | 51.6% | 87.1% |

## The seven misses on run 2

The harness recorded 7 tasks where the model did not score `full`. Honest categorization:

| # | Task | Verdict | Read |
|---|---|---|---|
| 1 | `ST002` | tool_only | Prompt: *"close stale issues in macrokit/core older than 120 days."* Gold expected `apply: true`. Model defaulted to `apply: false`. **Cautious-on-destructive-action.** Scoring is strictly fair. |
| 2 | `ST004` | tool_only | *"clean up old issues in nodejs/node that nobody's touched for 90+ days."* Same pattern as ST002. |
| 3 | `ST012` | tool_only | *"close stale in some-org/some-repo, threshold 60 days, max 5 comments."* Same pattern. |
| 4 | `SR010` | miss | *"triage PR 5 in macrokit/core and also tell me who should review it."* Genuinely multi-intent. The task notes (committed pre-registration) state: *"canonical answer is the reviewer suggestion (the more specific ask). triage_pull_request is an acceptable alternative — but we only register one expected here per scoring rules."* **Scoring artifact: this task should have carried a `alternative` field for half-credit per the methodology, and the corpus author neglected to add it.** Under the scorer's actual half-credit semantics, +1.5 points (0.5 `tool_score` + full `args_score`; the model's args match the alternative's). |
| 5 | `SR011` | miss | *"label PR 7 in macrokit/website and pick reviewers."* Same scoring artifact as SR010. |
| 6 | `NM010` | miss | *"give me a release notes template I can adapt."* Gold is `no_macro` (template request, not an actual generate). Model called `generate_release_notes` with placeholder owner/repo. **Fair miss.** |
| 7 | `AM012` | miss | *"go through the issue list in microsoft/vscode and label everything that's a bug."* Gold is `no_macro` (no batch-label macro exists). Model called `triage_issue` on issue 1. **Fair miss.** |

**On the scoring artifacts (#4, #5):** the discipline of pre-registration is that we don't edit the corpus after running. We could have, after the fact, added `alternative` fields to those two tasks and re-run; we chose not to. The honest published number is **94.5%**. The score if half-credit had been triggered on those two tasks is **96.0%** (192.0 / 200) — verified by running `scoreTask` on the artifact rows with the missing `alternative` field present: a `half` verdict awards 0.5 `tool_score` plus full `args_score` when the args match the alternative's, i.e. +1.5 per task. (An earlier revision of this note said 95.0%, assuming +0.5 per task; methodology.md said 95.5%, assuming +1.0 — both under-counted the scorer's behavior. All three docs now state 96.0%; see PREPRINT.md §10.) The difference is documented here, not buried.

**On the cautious-mutation pattern (#1, #2, #3):** when a maintainer says *"close the stale issues"*, the user-facing answer is to actually do it; the model interpreted that as a list-and-confirm. This is a defensible model behavior on destructive operations, but it's not what the corpus author intended. Adopters who want `apply: true` to be the default behavior for their `close_*` macros can shift it in their own schema; the reference implementation defaults to dry-run for safety.

## What this tells us, what it does not

**It tells us:** with the SDK doing its job, a 7B local model handles narrow-workflow intent routing reliably enough for production. 94.5% with zero structural failures is not a "model is barely usable" result; it is a "model is largely indistinguishable from a careful human router" result, on tasks that matter for a real domain.

**It does not tell us:** how Macrokit performs on workflows outside the maintainer-agent macro library. The pitch is that any narrow workflow can be encoded; this benchmark exercises six. If you ship a vertical with twenty domain macros and twenty utility macros, you should run the harness against your own corpus before quoting numbers. We do not generalize from six macros to all workflows.

**It also does not tell us:** how Macrokit compares to frontier-API agents. We deliberately did not run that comparison. The framing is in §1 of this document; the harness is open.

## Run the benchmark yourself

The harness lives in [`bench/`](../bench/). Each adapter in `@macrokit/llm` plugs into it via the `LLMAdapter` contract — same code path as production usage.

### Against a local Ollama model

```sh
cd core/bench
ollama serve &  # in another terminal
ollama pull qwen2.5:7b-instruct
pnpm exec tsx src/cli.ts run --model ollama-default
```

### Against any OpenAI-compatible provider

```sh
export MACROKIT_BENCH_LOCAL_URL="https://your-endpoint.example.com/v1"
# (or use one of the pre-wired models; see `pnpm exec tsx src/cli.ts list-models`)

# DeepSeek:
DEEPSEEK_API_KEY=sk-... pnpm exec tsx src/cli.ts run --model deepseek-chat

# Alibaba DashScope (Qwen Plus):
DASHSCOPE_API_KEY=sk-... pnpm exec tsx src/cli.ts run --model qwen-plus

# Zhipu (GLM-4):
ZHIPU_API_KEY=... pnpm exec tsx src/cli.ts run --model glm-4-flash
```

### Against Anthropic

```sh
ANTHROPIC_API_KEY=sk-ant-... pnpm exec tsx src/cli.ts run --model claude-sonnet-4
```

The `AnthropicAdapter` in `@macrokit/llm` handles the API's tool_use blocks and system-prompt lifting transparently.

### Output

Two files land in `bench/runs/`:
- `<model-id>-<timestamp>.jsonl` — one line per task with raw model output
- `<model-id>-<timestamp>.summary.json` — aggregate scores and breakdowns

A run against the local 7B takes ~10 minutes on a 16 GB M1.

## Submit your own results

If you ran the harness against a model or hardware we don't have access to, we'd like to publish your numbers alongside ours. PR your raw outputs to [`bench/runs/community/`](../bench/runs/) with:

1. The full `.jsonl` and `.summary.json` files (don't redact anything).
2. A short `README.md` in the same directory documenting your model, hardware, hyperparameters, and any harness modifications.
3. The git commit your harness was at when you ran it (so reviewers can verify what code produced the numbers).

We will accept submissions for any model — including cloud frontier models, which is how cloud numbers will show up in this repository if they show up at all.

## Versioning of the benchmark itself

Corpus and harness are versioned alongside the SDK. When we add macros, we add tasks. When we change the runtime's routing prompt, we mark a new benchmark version and republish all rows. Currently:

- **Benchmark v1.0** — frozen at the pre-registration commit ([`ff843b1`](https://github.com/macrokit/core/commit/ff843b1)). All current numbers are v1.0.

Future runs against newer SDK versions, against new macros, or with corpus changes will be tagged v1.1, v2.0, etc. Old runs stay published; they document where the SDK was at the time.
