# The Macrokit Pattern: Intent Routing and Macro Distillation for Weak LLMs on Narrow Workflows

**Author:** Cheng Qian, Macrokit
**Status:** Published at Zenodo. DOI (all versions): [10.5281/zenodo.20412771](https://doi.org/10.5281/zenodo.20412771)
**Version:** v3 — carries corrections and disclosures from an external review of v2. **Read §10 (Errata & audit-trail) first** if you are auditing this paper's claims; every substantive change from v2 is listed there.
**Repository:** [github.com/macrokit/core](https://github.com/macrokit/core) (commit pinned at submission)
**License of accompanying code:** Apache 2.0

## Abstract

Most production LLM applications today face a forced choice between *frontier-API models* (capable, expensive, network-dependent) and *weak or local models* (cheap, private, fragile). The dominant response in 2024–2026 has been to push the weak side: train smaller models to reason better, scaffold the reasoning loop with agent frameworks, and accept the resulting brittleness as a cost of doing business.

We describe an alternative architecture, **intent routing plus macro distillation**, that obviates this choice for a large and useful class of workloads. The observation is that production LLM applications repeatedly execute narrow, parameterizable workflows on opaque external surfaces. The corresponding runtime problem is not multi-step reasoning — at which weak models fail — but intent classification, at which they succeed reliably. By moving each workflow's encoding to *design-time*, with a strong model supervising a developer, and confining the *runtime* LLM to routing user requests against a registry of pre-encoded macros, we produce a system in which the runtime model can be a small local LLM with no measurable capability cost on the routed workloads.

The architecture recapitulates how biological cognition manages the cost of thinking. A macro is **learned automaticity** — the analog of a System-1 reflex: fast, cheap, deterministic, acquired (not innate), and reserved for the routine. The strong design-time model is **deliberation** — System 2: slow, expensive, flexible, reserved for novelty. Efficient cognitive systems compile repeated deliberation into cheap automatic behavior and hold deliberation in reserve; Macrokit ports that division of labor to LLM systems, with the cheap path carrying the bulk of the request volume. The analogy is structural, not decorative, and §2.5 states where it breaks.

We report results from a pre-registered 100-task benchmark across six maintainer-agent macros. A 7-billion-parameter local model running on a 16-GB consumer laptop (Qwen 2.5 7B Instruct Q4_K_M, ~4.4 GB) achieves **94.5%** intent-routing accuracy with zero structural failures. We argue that the benchmark's load-bearing finding is not the headline number but the methodological one: an earlier configuration of the same SDK and same model scored 53.5%, and the gap was entirely attributable to a fixable choice about how the SDK rendered tool argument names to the model. The model's capability was not the bottleneck.

We additionally describe a cultural artifact we believe is the more important contribution: the **distillation gate**, a CLI-enforced rule that every session interacting with an un-encoded workflow must encode that workflow as a new macro before terminating. We argue this discipline is what allows a macro library to compound rather than degenerate.

We deliberately publish no cloud-API comparison rows; we discuss this methodological choice in §7.

---

## 1. Introduction

A practitioner building an LLM-driven production application in 2026 faces three constraints commonly:

- **Cost.** Per-token pricing at frontier-API rates does not amortize well against the high-volume, low-value-per-request workloads typical of operations and back-office automation.
- **Latency.** Round-tripping inference to a US-hosted endpoint, on user-side networks of varying quality, is incompatible with sub-second product expectations.
- **Data residency.** Jurisdictions with strong residency or compliance requirements (EU GDPR, Chinese PIPL, US healthcare HIPAA, financial-services data localization) forbid sending in-scope data to cloud-controlled inference endpoints.

The deployable substitute — a small local LLM — fails on multi-step reasoning, hallucinates tool names, drifts into prose where structured tool calls are required, and recovers poorly from errors. The dominant industry response has been to scaffold the weak model with agent frameworks (LangChain, AutoGen, CrewAI) that attempt to externalize reasoning via prompt-engineered planning loops. We observe that these frameworks compete on *improving runtime reasoning*, while our approach competes by *eliminating it*.

The architecture we describe has been running in continuous production since 2026-Q1 in a private operations tool serving users without practical frontier-API access. We do not present that deployment as evidence in this paper; instead, we present a pre-registered, fully public benchmark of the same architecture against a fresh six-macro maintainer-agent reference implementation, with all code, methodology, raw outputs, and audit notes committed to a public repository. The intended contribution of this paper is reproducible.

---

## 2. The pattern

### 2.1 Theorem and architecture

We posit:

> **Working hypothesis.** Any workflow a strong model can solve by reasoning step-by-step on a known surface can be encoded as a deterministic, parameterized sequence of tool calls. Once encoded, executing the workflow requires only intent classification — a one-shot routing problem that small models handle reliably.

This is not a formal claim. It is a working hypothesis we have verified in one production deployment and against the public benchmark of §5. We expect it to fail in cases where (i) the workflow itself is open-ended (genuine creativity, judgment, multi-step planning over genuinely novel inputs), (ii) the corpus of workflows is unenumerable, or (iii) the model is small enough that even structured tool-call generation fails. We discuss these in §6.

We call the encoded sequence a **macro**. The library of macros for a given application domain is the **macro registry**. The runtime that maps a user request to a macro and dispatches it is the **intent router**.

The architecture splits cleanly:

- **Design time (offline).** A strong model — typically Claude or GPT-4o — under developer supervision solves a workflow end-to-end and generalizes its trajectory into a parameterized handler written in ordinary code. Cost: O(strong-model inference, once per macro).
- **Runtime (online).** A weak/local model receives a user request, classifies it against the macro registry, and emits a tool call against the matching macro. The handler runs deterministically. Cost: O(weak-model inference, per request).

The cost asymmetry is load-bearing. A workflow encoded once with a frontier model (perhaps $0.50 of inference) is then executed thousands of times with a weak model (perhaps $0.0001 per execution, or zero if the weak model runs locally). The capability gap between models stops mattering for that workflow.

### 2.2 Anatomy of a macro

A macro has five parts:

1. A **name** and a natural-language **intent specification** — what the router matches user requests against.
2. A typed **argument schema**, rendered to the runtime LLM as JSON Schema. (Our benchmark, §5, demonstrates the cost of failing to render this well.)
3. A deterministic **handler** — the encoded workflow, in ordinary code, with no LLM call in the inner loop.
4. A **failure-context contract** — when the handler fails, it returns a structured error code so the runtime LLM (or a downstream recovery macro) can route on the code rather than the prose.
5. A **test fixture set** — recorded request/output pairs that pin the macro's behavior across SDK upgrades and third-party surface changes.

### 2.3 Why deterministic encoding beats reasoning at runtime

Two arguments. First, capability: 7B-parameter instruct-tuned models do single-step intent classification reliably (we report 94.5% with zero structural failures in §5), and fail unreliably at multi-step reasoning. The macro-distillation architecture explicitly takes the failure path off the runtime hot loop.

Second, observability: a deterministic handler is debuggable, reviewable in a pull request, testable in isolation, and stable across SDK versions. A planning-and-execution loop in an LLM agent framework is none of these. For operations workloads — where failure modes propagate to user trust and revenue — observability is not optional.

### 2.4 The bail-out detector

Even with the architecture confined to single-step routing, weak models occasionally produce failure modes that should not propagate to handlers: emitting structured tool calls as plain text in the message body, inventing tool names not present in the registry, repeating the same tool call with the same arguments two turns in a row, or returning prose where the caller required a tool call. We implement a **bail-out detector** that pattern-matches these failure shapes. What ships is **detection plus halt-or-escalate**: when the detector fires, the runtime escalates the failing turn to a configured fallback adapter if one exists; with no fallback configured, the turn **halts** with a structured `bailedOut` result — flagged output is not dispatched and not returned as a normal answer. **Repair (re-prompting the model with the schema) is not implemented**; v2 of this paper described the detector as able to "repair the call," which overstated the shipped behavior (see §10, item 6).

The detector's rule set is small, documented, and extensible per deployment. In the §5 benchmark it fired zero times across 200 model invocations (two runs of 100 tasks each), suggesting that on routed workloads, structured tool-call generation by Qwen-class 7B models is reliable enough that the detector is a safety net rather than a primary control surface.

### 2.5 The cognitive analogy, stated precisely

The pattern's two halves map onto the two-system account of cognition, and the mapping does explanatory work. A macro is not innate instinct; it is **acquired automaticity** — the analog of a habit or expert skill. A behavior starts as effortful deliberation; repeated enough, the brain chunks it and migrates it from expensive deliberate control to cheap automatic execution. The **distillation gate** (§3) is the engineered version of that chunking trigger: recurrence, not aspiration, is what forces compilation. The cost asymmetry of §2.1 — deliberate once, run cheaply forever — is the same argument an energy-budgeted brain makes.

The analogy also *predicts the architecture's failure mode rather than excusing it*. Automaticity is fast but brittle: habits misfire when the environment shifts. Macros rot the same way (surface drift, §6), and the correct response is the same in both systems — when the automatic path fails, return to deliberation (the bail-out detector of §2.4 is exactly that trigger). Where the analogy breaks: brains chunk continuously and unconsciously, while the gate is a discrete, tooling-enforced step; and a macro's handler is inspectable code, which no biological habit is. We use the analogy as a design compass, not as evidence.

---

## 3. The distillation gate

The runtime is engineering; libraries that produce similar runtime effects exist (the function-calling features of OpenAI and Anthropic, agent frameworks of varying ambition). The contribution we believe is most durable is cultural, enforced by tooling:

> **The distillation gate.** Every session that touches a workflow without an existing macro must encode that workflow as a macro before ending. The session does not end successfully if the encoding step is skipped.

The runtime writes an append-only session log. The CLI command `macrokit gate` reads that log and flags any session in which the model dispatched three or more *distinct* macros in a single user turn. Each flagged sequence becomes a candidate for distillation into a composite macro; the CLI emits a suggested name, schema, and stub handler.

This rule transforms macro-library accumulation from an aspirational practice into a mechanical one. Most agent-framework adoptions, in our observation, accumulate tools that grow organically and degenerate — duplicated functionality, no consolidation, no compounding. The distillation gate is the smallest practical intervention we have found that prevents this regression.

We acknowledge the gate is enforceable only because the session log exists. We further acknowledge that the gate is bypassable by any team that decides to ignore the CLI exit code; we have no defense against deliberately bypassed discipline, and offer no claim to having solved organizational dysfunction. The gate is a *tool for teams that want the discipline*, not a substitute for wanting it.

---

## 4. Implementation

The reference implementation is a TypeScript monorepo, MIT-incompatible-because-we-want-the-patent-grant Apache 2.0 licensed, structured as six packages:

| Package | Role | LOC |
|---|---|---|
| `@macrokit/runtime` | Macro registry, dispatcher, intent router, bail-out detector, session log | ~600 |
| `@macrokit/llm` | LLM adapter contract; OpenAI-compatible, Ollama, and Anthropic adapters | ~700 |
| `@macrokit/browser` | Playwright-based service for driving opaque web UIs (annotated screenshots, DOM action menus) | ~350 |
| `@macrokit/authoring` | `defineMacro()`, schema-to-JSON-Schema conversion, test harness with recording mode | ~250 |
| `@macrokit/reference-data` | Versioned, signed (ed25519) reference-data bundles | ~400 |
| `@macrokit/cli` | `init`, `lint`, `gate` commands | ~500 |

All packages typecheck strict and ship with test suites (108+ tests at publication). The repository is configured for zero telemetry and zero phone-home behavior; an adopter operating in an air-gapped environment runs Macrokit without any per-deployment configuration to disable network behaviors that were never enabled.

The runtime is provider-agnostic: macros run identically against OpenAI's API, Anthropic's API, an Ollama-served local model, or an in-process llama.cpp binary. Provider-specific code is confined to the adapter layer.

---

## 5. Evaluation

### 5.1 Pre-registration

Methodology, scoring rubric, and task corpus were committed to the public repository at a fixed git commit *before* any model was executed against the harness. The pre-registration commit is identifiable in the audit trail; subsequent commits to `bench/runs/` contain raw outputs of the actual runs. Anyone questioning whether the corpus was tuned post-hoc to flatter a model can verify the git log.

### 5.2 The corpus

The corpus comprises 100 hand-crafted natural-language requests against a six-macro maintainer-agent reference implementation:

- 15 `triage_pull_request` tasks
- 15 `triage_issue` tasks (including duplicate-detection variants)
- 12 `generate_release_notes` tasks
- 12 `close_stale_issues` tasks
- 12 `suggest_reviewers` tasks
- 8 `capture_workflow_log` tasks (browser-driven macro, included to validate that mixed-surface macro libraries behave identically)
- 11 `no_macro` tasks (the correct response is free-text, not a tool call)
- 15 `ambiguous_multi_intent` tasks (multiple plausible interpretations; canonical answer pinned, alternative documented for half-credit)

A coverage disclosure on the last bucket: the half-credit policy requires a machine-readable `alternative` field on the task, and only **4 of the 15** ambiguous tasks (AM001, AM002, AM006, AM015) carry one. The remaining 11 document their ambiguity in free-text notes only, which the scorer cannot award against. The pre-registered half-credit policy was therefore *operative* for roughly a quarter of the bucket it was designed for. The error is in the conservative direction — affected tasks could only have scored higher, not lower — but a corpus revision should carry the field on every task whose notes name an acceptable alternative. Two tasks outside this bucket have the same defect with measured consequences (SR010/SR011, §5.7).

Difficulty bands within each bucket are: `easy_direct`, `medium_paraphrase`, `hard_implicit`, `hard_distractor`. The full task list with notes is in [`bench/tasks/`](../bench/tasks/).

### 5.3 The model

Qwen 2.5 7B Instruct, Q4_K_M GGUF quantization, ~4.4 GB on disk. SHA256 `65b8fcd92af6b4fefa935c625d1ac27ea29dcb6ee14589c55a8f115ceaaa1423`. Served via `llama-server` (llama.cpp build b9354) on a 16 GB M1 MacBook with Metal acceleration. Hyperparameters: `temperature=0` (greedy), `max_tokens=512`, `-c 8192` (context), `--cache-type-k q8_0`, `--cache-type-v q8_0`, `-np 1`, `--mlock`. These match the production deployment described in §1.

We chose this model because it is the production model of the private deployment that originated the architecture. We did not run additional models **at the time this benchmark was frozen and first published**; that sentence is now scoped historically. Since the v2 deposit, the repository's [`docs/BENCHMARK.md`](BENCHMARK.md) carries a five-model table on the same frozen corpus at temperature 0 — Qwen 2.5 1.5B / 3B / 7B via Ollama at 74.0 / 79.3 / 82.3%, Llama 3.1 8B at 82.5%, and an honest negative (Mistral 7B v0.3 at 14%, a tool-call-plumbing failure caught by the bail-out detector). The headline claims of this paper rest on the original pre-registered run reported here; the multi-model table is corroborating context, with its raw artifacts committed alongside. We discuss the no-cloud-rows choice in §7.

### 5.4 Scoring

Two binary signals per task: `tool_match` (correct macro name, or `null` matching `null` when no-macro expected) and `args_match` (every expected argument present with the expected value). Each signal is worth 1 point; total 200. Half-credit (0.5 `tool_match`) is awarded on `ambiguous_multi_intent` tasks when the model picks the pre-registered alternative.

### 5.5 Result

**Headline:** 189.0 / 200 = **94.5%**. Bail-out detector fired on 0 / 100 tasks. Mean latency 5.85 s per request.

Per-bucket breakdown:

| Bucket | Score |
|---|---|
| `triage_pull_request` | 30.0 / 30 (100.0%) |
| `triage_issue` | 30.0 / 30 (100.0%) |
| `generate_release_notes` | 24.0 / 24 (100.0%) |
| `capture_workflow_log` | 16.0 / 16 (100.0%) |
| `close_stale_issues` | 21.0 / 24 (87.5%) |
| `suggest_reviewers` | 20.0 / 24 (83.3%) |
| `no_macro` | 20.0 / 22 (90.9%) |
| `ambiguous_multi_intent` | 28.0 / 30 (93.3%) |

Per-difficulty breakdown:

| Difficulty | Score |
|---|---|
| `easy_direct` | 96.0% |
| `medium_paraphrase` | 97.9% |
| `hard_implicit` | 100.0% |
| `hard_distractor` | 87.1% |

### 5.6 The two-run story

A first run of the same model on the same corpus, with the same harness but *before* a single SDK fix described below, scored **53.5%** (107.0 / 200). The fix is documented at commit `6424cc7` of the public repository. The shipped change is twelve lines in `@macrokit/authoring/src/define-macro.ts`: zod schemas are now automatically converted to JSON Schema (via `zod-to-json-schema`) and attached to each macro's `schema.jsonSchema` field. The runtime's `IntentRouter` previously fell back to a permissive `{ type: "object" }` rendering when no JSON Schema was attached; that fallback was what the model saw on run 1.

Inspecting the raw run-1 outputs reveals that the **dominant failure mode — 83 of the 88 tasks that lost points** — was a single shape: the model selected the correct macro but produced argument names that were plausible variants of, but not equal to, the schema's actual argument names. `repo_owner` and `repo_name` instead of `owner` and `repo`; `pr_number` instead of `number`; `from_ref` and `to_ref` instead of `base` and `head`; `workflow_run_id` instead of `runId`. The model was guessing reasonable names because the actual names were not in its tool spec. The remaining **five misses were wrong-tool selections** (SR010, SR011, NM009, AM008, AM012), not argument-name variants; v2 of this paper said "*every* miss," which overstated the uniformity (see §10, item 5). The split is verifiable from the committed run-1 artifact.

We argue this is the methodologically important finding of the paper. The model's *capability* on routed workloads was sufficient for the application in both runs; what changed between runs was a single SDK configuration concerning how argument names are communicated to the runtime LLM. The 41-percentage-point lift between runs represents what an SDK is for: making model capability addressable. Reporting only the second run would have obscured this; reporting both runs makes the actionable lesson visible.

### 5.7 Audit of misses

Seven tasks did not score full credit on run 2. Two are scoring artifacts: tasks `SR010` and `SR011` were flagged as multi-intent in their inline notes but were neglected to be given `alternative` fields in their JSON, which the scorer requires to award half-credit. The model picked exactly the documented alternative (`triage_pull_request`) with exactly the right arguments. Under the scorer's actual half-credit semantics — verified by running `scoreTask` on the artifact rows with the alternative field present — a half verdict awards 0.5 `tool_score` plus full `args_score` when the arguments match the alternative's, i.e. **+1.5 points per task**, yielding **192 / 200 = 96.0%** rather than 94.5%. (v2 of this paper stated 95.0% by assuming +0.5 per task, and the repository's methodology note stated 95.5% by assuming +1.0; both under-counted the scorer's behavior — see §10, item 4.) We report the published number (94.5%) and the scorer-verified counterfactual (96.0%) alongside; per pre-registration discipline, we did not edit the corpus after running. Full per-miss audit in [`docs/BENCHMARK.md`](BENCHMARK.md).

The remaining five misses split into two categories: (i) three `close_stale_issues` tasks where the model defaulted `apply: false` rather than the corpus-author-intended `apply: true` — a cautious model behavior on destructive operations that is arguably correct in production; (ii) two tasks (`NM010` and `AM012`) where the model misread template-or-batch requests as actionable single-item invocations.

---

## 6. Honest limitations

**Workflow coverage.** The pattern is most useful where the set of workflows is enumerable. For genuinely open-ended applications — exploratory research, creative writing, novel problem decomposition — the pattern is overhead; there is no encoding to perform. We do not claim Macrokit is a general agent framework.

**Surface drift.** Macros that drive third-party UIs are hostage to those UIs. When GitHub redesigns its Actions UI, the `capture_workflow_log` macro is brittle. We mitigate this with the action-menu abstraction (DOM-level rather than coordinate-level) and with rich failure context, but the underlying problem is real. We argue the right response is a fast maintenance loop on the macros, not a claim of immortality.

**Small-model floor.** Q4_K_M-quantized 7B models on Apple Silicon are roughly the smallest configuration we have observed produce reliable structured tool calls. The bail-out detector fires more often as model size decreases. We have not characterized the failure cliff precisely; that is future work.

**The benchmark is six macros.** We do not generalize from this corpus to all workflows. Adopters shipping verticals with twenty domain macros and twenty utility macros should run the harness against their own corpora before quoting cross-vertical numbers. The harness ships open precisely for this purpose.

---

## 7. On the choice not to publish cloud-API comparisons

We deliberately did not run cloud-API rows for this paper or for the launch publication.

The intended audience of Macrokit — operators in regulated verticals, deployers in markets without practical frontier-API access, applications constrained by per-call cost or latency — cannot use frontier APIs. Publishing a benchmark in which frontier APIs are the implicit ceiling and on-device performance is a managed regression from that ceiling reinforces the very framing the architecture is designed to dissolve. The on-device row is not the lower bound of a comparison; it is the architecture's primary claim.

Additionally, benchmarks produced via vendor-paid inference are inherently less reproducible than benchmarks produced via open harnesses. We ship the model SHA, the harness source, the corpus, the raw run outputs, and the scoring code. Anyone with API keys to a frontier provider can run identical comparison rows in approximately fifteen minutes of compute time. We accept community-contributed comparison rows via pull request to `bench/runs/community/`; we do not bound the set of models for which such submissions are welcomed.

We acknowledge this choice may be read as an evasion. We argue the opposite: a benchmark whose comparison rows are bought is more flatterable than a benchmark whose comparison rows are crowd-sourced.

---

## 8. Related work

Briefly (full reference list in the bibliography):

- **Toolformer** (Schick et al., 2023). Models train themselves to use tools. Macrokit's contrast: tools are encoded by a strong model offline, not learned by the runtime model.
- **ReAct** (Yao et al., 2022). Interleaved reasoning and acting. Macrokit eliminates the reasoning step at runtime; ReAct centralizes it.
- **Gorilla** (Patil et al., 2023). Teaches API calling. Macrokit ships macros; the model never sees the underlying API.
- **Function-calling features** in OpenAI and Anthropic native APIs. We use these as the underlying protocol. Macrokit's contribution is what to put in the function specs, not the function-call mechanism itself.
- **Agent frameworks** (LangChain, LlamaIndex, AutoGen, CrewAI). Compete on letting LLMs reason. We compete by eliminating runtime reasoning.

The architecture's distinctness is most clearly contrasted against the "agent that thinks step-by-step" framing. Our claim is that step-by-step thinking is the wrong tool for the workloads we describe, not a tool to be improved.

---

## 9. Conclusion

The Macrokit pattern produces 94.5% intent-routing accuracy on a pre-registered narrow-workflow benchmark using a 7B-parameter model running on a 16-GB consumer laptop, with zero structural failures. The pre-registration discipline surfaced a single SDK configuration issue between runs whose correction lifted scores by 41 percentage points. The runtime SDK is open-source, the benchmark is reproducible, and the cultural innovation — the distillation gate — is a small tool that makes a non-small practice mechanically enforceable.

For the application class we describe, frontier-API inference is not the natural ceiling that on-device inference approaches. It is a different operating regime with different constraints, available to a different set of users. Macrokit is built for users who are not in the first set, and we publish accordingly.

---

## 10. Errata & audit-trail (v2 → v3)

This paper's central methodological commitment is that its claims be auditable from the public repository. An external review of v2 found places where that commitment was not met — some material, none affecting the headline number's reproducibility from the raw artifacts, all worth stating in the paper's own voice rather than a changelog. This section is the complete list of substantive corrections in v3. Nothing here is buried elsewhere.

**1. The repository history was rewritten after the v2 deposit.** On 2026-05-31 the public repository's history was rewritten with `git filter-repo` (a content-hygiene scrub), *after* v2 of this paper was deposited. Every commit hash and timestamp in the current history is therefore **reconstructed, not original**. The relative ordering that the pre-registration argument depends on — pre-registration → run 1 → SDK fix → run 2 — still holds in the rewritten history, but a reader can no longer verify it against the hashes v2 cited. We should have disclosed the rewrite at the time; v3 does.

**2. The v2 PDF cited commit hashes that no longer resolve.** v2 referenced pre-rewrite hashes `1ac076e` (pre-registration) and `5de35d3` (SDK fix). Both now dangle. The same commits in the current history are **`ff843b1`** (pre-registration: methodology + tasks + harness) and **`6424cc7`** (the zod→JSON-Schema fix). All hashes in v3, including the Reproducibility table, are current post-rewrite hashes.

**3. The run-2 artifact mis-records its commit.** The run-2 `summary.json` header records `harnessCommit: d3e38e14` — the **pre-fix** run-1 commit. Run 2 was executed with the fix present in the working tree but tagged with a commit that does not contain it; checking out the recorded commit reproduces **53.5%, not 94.5%**. The 94.5% reproduces deterministically from the committed raw artifacts with the fix (`6424cc7`) applied; the artifact's provenance *metadata* is what was wrong, and we leave the frozen artifact unedited rather than rewrite raw data. (Mirrors the provenance erratum in `docs/BENCHMARK.md`.)

**4. The SR010/SR011 counterfactual was under-counted — twice.** v2 stated that proper half-credit on the two mis-authored ambiguous tasks would yield 95.0%; the repository's methodology note said 95.5%. Both were computed from assumed semantics rather than the scorer's actual ones. Running the scorer on the artifact rows with the missing `alternative` field present awards **+1.5 per task** (0.5 `tool_score` + full `args_score`, since the model's arguments match the alternative's), giving **192 / 200 = 96.0%**. The published headline remains 94.5% — the pre-registered rule produced it and the corpus was not edited post-hoc — but the counterfactual is now stated correctly and consistently across this paper, `BENCHMARK.md`, and `methodology.md` (§5.7).

**5. "Every miss" overstated run-1's uniformity.** v2 §5.6 claimed *every* run-1 miss was an argument-name variant. The artifact shows **83 of 88**; the other five (SR010, SR011, NM009, AM008, AM012) were wrong-tool selections. The argument about what the SDK fix demonstrates survives — the dominant failure mode was the fixable one — but the word "every" was wrong (§5.6).

**6. The bail-out detector cannot "repair the call."** v2 §2.4 described the detector as able to repair, escalate, or return a structured error. No repair path exists. What ships is detection plus halt-or-escalate: escalate if a fallback adapter is configured, otherwise the turn halts with a structured `bailedOut` result. v2's wording described a target design as shipped behavior (§2.4; mirrors the corrected `ARCHITECTURE.md`).

**7. Half-credit coverage in the ambiguous bucket was incomplete and undisclosed.** Only 4 of 15 `ambiguous_multi_intent` tasks carry the machine-readable `alternative` field the policy requires; the policy was operative for roughly a quarter of its bucket. Conservative in direction, but a coverage gap the paper should have stated (§5.2).

**8. "We did not run additional models" went stale.** True at the benchmark freeze; the repository now carries a five-model table on the same corpus. §5.3 scopes the original sentence historically and points to it.

**9. The v2 PDF self-cited the wrong DOI.** v2's PDF printed the v1 *version* DOI (`…20412772`) instead of the *concept* DOI (`10.5281/zenodo.20412771`) that resolves to the latest version. The v3 PDF cites the concept DOI.

**10. "Every run is published" was too strong.** The repository's methodology stated that every run is published, even failed ones. A set of discarded exploratory Ollama runs at the wrong sampling temperature (0.8, against the pre-registered temperature 0) was never committed. The methodology now reads "every *scored* run is published," which is what was always true of the runs this paper reports.

**11. Author metadata.** The byline is normalized to "Cheng Qian, Macrokit," and the Zenodo affiliation field for v3 is intentionally blank (v2's record carried a former affiliation that is no longer accurate).

The pattern across these items: the *numbers* survive audit — 94.5% reproduces from frozen raw artifacts with a fixed scorer — and the *provenance narrative* around them was looser than a pre-registration paper is entitled to be. The corrections above are what an audit-first methodology owes its readers when the audit finds something.

---

## Reproducibility

| Asset | Location |
|---|---|
| Methodology (pre-registration) | [`bench/methodology.md`](../bench/methodology.md) |
| Task corpus | [`bench/tasks/`](../bench/tasks/) |
| Harness source | [`bench/src/`](../bench/src/) |
| Raw run outputs | [`bench/runs/`](../bench/runs/) |
| Model GGUF SHA256 | `65b8fcd92af6b4fefa935c625d1ac27ea29dcb6ee14589c55a8f115ceaaa1423` |
| llama.cpp build | `b9354` |
| Pre-registration commit | [`ff843b1`](https://github.com/macrokit/core/commit/ff843b1) |
| SDK fix commit (run-2-enabling) | [`6424cc7`](https://github.com/macrokit/core/commit/6424cc7) |

Hashes are from the **post-rewrite** history (see §10, items 1–3): the repository history was rewritten on 2026-05-31, so these are reconstructed identifiers, current as of v3. The run-2 artifact header's recorded commit is stale (§10, item 3); trust the raw artifact contents plus `6424cc7`, not the header's `harnessCommit` field.

## Acknowledgments

This work would not have been possible without the prior practice of the team behind the private operations deployment that originated the architecture; nor without the open-weights work of the Qwen team at Alibaba and the llama.cpp project. Errors and decisions are the author's.

## Bibliography

[1] Schick, T., Dwivedi-Yu, J., Dessì, R., Raileanu, R., Lomeli, M., Zettlemoyer, L., Cancedda, N., Scialom, T. *Toolformer: Language Models Can Teach Themselves to Use Tools.* arXiv:2302.04761, Feb 2023. (Appeared NeurIPS 2023.)
[2] Yao, S., Zhao, J., Yu, D., Du, N., Shafran, I., Narasimhan, K., Cao, Y. *ReAct: Synergizing Reasoning and Acting in Language Models.* arXiv:2210.03629, Oct 2022. (Appeared ICLR 2023.)
[3] Patil, S. G., Zhang, T., Wang, X., Gonzalez, J. E. *Gorilla: Large Language Model Connected with Massive APIs.* arXiv:2305.15334, May 2023.
[4] Qwen Team, Alibaba. *Qwen2.5 Technical Report.* arXiv:2412.15115, Dec 2024.
[5] OpenAI. *Function calling and other API updates.* openai.com, June 2023; chat completions function-calling API reference, platform.openai.com/docs, 2023–2026.
[6] Anthropic. *Tool use with Claude.* Anthropic Messages API reference, docs.anthropic.com/en/docs/build-with-claude/tool-use, 2024–2026.
[7] llama.cpp project. *llama.cpp: LLM inference in C/C++.* github.com/ggml-org/llama.cpp, accessed at release tag b9354.
[8] Bartowski. *Qwen2.5-7B-Instruct-GGUF (Q4_K_M).* huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF, SHA-256 of the Q4_K_M GGUF: `65b8fcd92af6b4fefa935c625d1ac27ea29dcb6ee14589c55a8f115ceaaa1423`.
[9] LangChain. *Agents with LangChain.* python.langchain.com/docs/concepts/agents/, 2023–2026.
[10] Microsoft Research. *AutoGen: Enabling Next-Gen LLM Applications via Multi-Agent Conversation.* arXiv:2308.08155, Aug 2023.
[11] crewAIInc. *crewAI: Cutting-edge framework for orchestrating role-playing autonomous AI agents.* github.com/crewAIInc/crewAI, 2023–2026.

---

*Author contact: hello@macrokit.dev. Repository: github.com/macrokit/core. Preprint DOI: [10.5281/zenodo.20412771](https://doi.org/10.5281/zenodo.20412771).*
