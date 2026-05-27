# How a 7B model on a laptop got to 94.5% on a maintainer-agent benchmark

*Or: the load-bearing claim of Macrokit is not "weak models match frontier models." It's "you don't need to find out."*

A few weeks ago I ran a 100-task benchmark against a private Macrokit deployment we've had in production since early 2026. The deployment is a vertical app whose users have no practical access to frontier APIs — Chinese-market sellers on 16 GB MacBooks, doing operations work that has to keep working when the network does not. The whole architecture is structured around the constraint that the LLM in the inner loop is small, local, and not very smart.

The benchmark was pre-registered. The model was Qwen 2.5 7B Instruct Q4_K_M, running on llama.cpp at 4.4 GB on disk, on a 16 GB M1 MacBook. The corpus was 100 hand-crafted natural-language requests against a six-macro maintainer agent we built specifically for the benchmark (issue triage, PR triage, release notes, stale-issue cleanup, reviewer suggestion, and one browser-driven log-capture macro). The macros are a real reference implementation, not a toy — see [`examples/github-maintainer/`](../examples/github-maintainer/).

**The first run scored 53.5%.** That's not the headline, but it should be: I want to talk about it before I talk about the second run.

## The 53.5%

The model was correctly picking the macro to call almost every time. It was using the wrong argument names. Where the macro's schema said `{ owner, repo, number }`, the model was producing `{ repo_owner, repo_name, pr_number }` or `{ repo: "owner/name", number }`. Plausible, reasonable, wrong.

Inspecting the raw runs, the root cause was in our SDK, not in the model. The `IntentRouter`'s tool-spec rendering was falling back to a permissive `{ type: "object" }` JSON Schema when it couldn't introspect the macro's argument schema. zod schemas don't carry a JSON Schema field by default, so the LLM was seeing the macro's intent description but never the actual argument names. It was guessing reasonable variants.

This is a config-level miss. It is an embarrassing one. The point of running pre-registered benchmarks before launching is to find embarrassing ones.

Twelve lines of TypeScript later — adding `zod-to-json-schema` to `@macrokit/authoring` and attaching the converted JSON Schema to each macro's `schema.jsonSchema` field — and we re-ran the same model on the same corpus.

## The 94.5%

| Bucket | Run 1 (default config) | Run 2 (with the fix) |
|---|---|---|
| `triage_pull_request` | 50.0% | **100.0%** |
| `triage_issue` | 53.3% | **100.0%** |
| `generate_release_notes` | 50.0% | **100.0%** |
| `capture_workflow_log` | 50.0% | **100.0%** |
| `close_stale_issues` | 50.0% | 87.5% |
| `suggest_reviewers` | 41.7% | 83.3% |
| `no_macro` | 90.9% | 90.9% |
| `ambiguous_multi_intent` | 46.7% | 93.3% |

189 of 200 points. 7 misses out of 100 tasks. Zero structural failures — the SDK's bail-out detector, which catches the small set of failure modes weak models hit when they're out of their depth (tool calls emitted as text, calls to nonexistent tools, loops), did not fire on a single task across both runs.

Two of the seven misses turned out to be scoring artifacts I caught after the fact and disclosed in the [methodology doc](BENCHMARK.md): tasks I'd flagged as ambiguous in pre-registration but forgot to attach `alternative` fields to, which the scorer needs to award the half-credit the methodology specifies. Under proper half-credit handling the number is 95.0%; I report both, the headline stays 94.5%. Pre-registration discipline means you don't edit the corpus after running.

## What I am *not* saying

I'm not saying weak local models match frontier models. I haven't run frontier models on this benchmark, and the published table doesn't have a frontier row. That's deliberate.

There were two ways to ship this. One was to pay for inference on Claude, GPT-4o, Qwen Plus, GLM-4, DeepSeek; produce a five-row table; publish a "weak models match frontier" headline. The other was to publish the local row, ship the harness, and put the cost of comparing on whoever wants the comparison.

I took the second path. Three reasons, in priority order:

**(1) The constraint is the product.** Macrokit's intended users — operators in regulated verticals, Chinese-market deployers, air-gapped enterprise — cannot use frontier APIs. If I run cloud comparisons to validate Macrokit, I'm implicitly conceding that the cloud row is the standard and the local row is a managed regression from it. That's the framing the SDK exists to dissolve. The on-device number isn't a discount; it's the headline.

**(2) Benchmarks paid for by the vendor are inherently less trustworthy than benchmarks anyone can run.** I can publish numbers I bought; you have to trust them. I can publish a harness; you can run it. The harness is the artifact. The model SHA is in the methodology, the runs are in the repo, the scoring code is reviewable. If you have keys, the same `pnpm exec tsx src/cli.ts run --model <id>` produces a number you can publish alongside mine. The community will do the cloud comparisons, and they'll do them better than I would, because they have skin in their own model choices and I have skin in mine.

**(3) Gating credibility behind API spend re-imports the exact constraint Macrokit is built to break.** If the only way to evaluate an SDK whose pitch is "you don't need frontier APIs" is to acquire frontier APIs, the SDK has not actually changed anything about the discourse around it. The benchmark methodology is open precisely because the cost of comparing should not be a cost.

Run the harness on whatever you have. PR your numbers to [`bench/runs/community/`](../bench/runs/). I'll merge.

## How the SDK works, briefly

Macrokit's pattern is one observation:

> The hard part for weak models is multi-step reasoning. The easy part is routing.

If you can encode each workflow your application performs as a deterministic, parameterized sequence of tool calls — a *macro* — and then expose those macros to the runtime LLM as named functions, the LLM's runtime job collapses from "plan the workflow and execute it" to "classify the user's intent against the macro list and call the matching one with the right arguments." Multi-step reasoning happens once, at design-time, with a strong model in the loop. At runtime, even a 7B is sufficient.

The pattern essay walks through this at length: [`docs/THE_PATTERN.md`](THE_PATTERN.md). The runtime, the LLM adapters, the browser service, the authoring kit, the reference-data layer, and the CLI are six TypeScript packages: [`packages/`](../packages/). One reference implementation is in [`examples/github-maintainer/`](../examples/github-maintainer/) — that's where the benchmark corpus is derived from.

The piece that's actually new — the part I want anyone reading this to internalize even if they never use Macrokit — is the **distillation gate**. After a session that touches a workflow, the runtime writes a session log. The `macrokit gate` CLI command reads that log and flags any session that performed three-or-more raw tool calls in a row for a workflow without a macro. It suggests a name, a schema, and a stub handler.

The cultural shift this enforces is the whole point. Most agent-framework adoptions accumulate tools that grow organically and don't compound. The gate makes the rule mechanical: every session that touched an un-macro'd workflow encodes one before ending. A year in, the macro library is what your team knows, written down.

## Try it

```sh
git clone git@github.com:macrokit/core.git
cd core
pnpm install
pnpm -r build

# minimal hello world (Ollama):
cd examples/github-maintainer
ollama serve &
ollama pull qwen2.5:7b-instruct
pnpm start "triage PR 5 in macrokit/core"
```

Or run the benchmark against whatever model you have:

```sh
cd bench
pnpm exec tsx src/cli.ts list-models
ANTHROPIC_API_KEY=sk-ant-... pnpm exec tsx src/cli.ts run --model claude-sonnet-4
# or DEEPSEEK_API_KEY, DASHSCOPE_API_KEY, ZHIPU_API_KEY, or just Ollama
```

Apache 2.0. No telemetry. No phone-home. Built for users who can't or won't depend on cloud APIs.

[macrokit.dev](https://macrokit.dev) · [github.com/macrokit](https://github.com/macrokit) · [@macrokitdev](https://x.com/macrokitdev) on X · [Preprint (Zenodo)](https://zenodo.org/records/20412772)

— *Cheng Qian, founder, [Deakee](https://deakee.com). Macrokit is the vertical-agnostic extraction of an architecture proven in production by an unrelated operations tool we run privately.*
