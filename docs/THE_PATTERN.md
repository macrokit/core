# The Macrokit Pattern

*Intent routing plus macro distillation: how weak and local LLMs reach frontier-model behavior on narrow workflows.*

**Status:** Draft v0.1 — Week 1 of public development. This document doubles as the preprint draft. Citations, related work, and the formal evaluation section are stubs to be filled in before submission.

---

## 1. The problem

A practitioner who wants to deploy an LLM application today faces a forced choice:

- **Frontier API models** (Claude Sonnet/Opus, GPT-4o, Gemini 2.5 Pro) are strong enough to plan multi-step workflows, recover from errors, and parse messy real-world surfaces. They are also expensive per call, require network access to a US-controlled API, and are unavailable or unreliable in jurisdictions with data-residency rules, air-gapped networks, or capped budgets.
- **Weak models** — small open-weights LLMs (~3B to ~14B parameters), Chinese commercial APIs (qwen-plus, glm-4-flash, deepseek-chat), and on-device runtimes (Ollama, llama.cpp, MLX) — are cheap, private, and locally controllable, but fall over on multi-step reasoning. They drift into prose when they should be calling tools. They hallucinate tool names. They loop. They give up at the first error.

The dominant response in 2024–2026 has been to push the weak side: train smaller models to reason better, build agent frameworks (LangChain, AutoGen, CrewAI) that scaffold the reasoning loop, accept the higher latency and brittleness as the cost of doing business.

This document describes a different response.

> **Observation.** For most production LLM applications, the workflows the model needs to perform are *not* novel reasoning problems. They are deterministic, parameterizable sequences of tool calls — the same shape of work, with different arguments, run thousands of times. The hard part is not deciding *what* to do once you understand the request. The hard part is reasoning your way to that understanding step by step.

If that observation holds, the answer is not to make weak models reason better. The answer is to remove the reasoning requirement at runtime.

This is the architecture brains already use to manage the cost of thinking. Deliberate reasoning is metabolically expensive, so an efficient mind compiles repeated deliberation into cheap automatic reflexes and reserves expensive thinking for the genuinely novel — the System 2 / System 1 split of dual-process theory. Macrokit ports it to LLMs: the strong model is System 2 (slow, expensive, for the novel), a macro is System 1 (fast, cheap, deterministic, for the routine), and the design-time encoding step is *compiled deliberation* — the artificial analog of how the brain chunks a practiced behavior down from costly cortex to cheap basal ganglia. The rest of this document is the engineering that makes that split concrete.

## 2. The theorem

> **Theorem (informal).** Any workflow a strong model can solve by reasoning step-by-step on a known surface can be encoded as a deterministic, parameterized sequence of tool calls. Once encoded, executing the workflow requires only intent classification — a one-shot routing problem that small models handle reliably.

We call the encoded sequence a **macro**. The library of macros for a given domain is the **macro registry**. The runtime that maps a user request to a macro and dispatches it is the **intent router**.

The theorem is not a formal claim — it is a working hypothesis that has held in at least one private production deployment serving users without frontier-API access since early 2026. It is the hypothesis Macrokit is built to make testable in other domains. The launch benchmark exercises it on a smaller, fully public corpus: see [`BENCHMARK.md`](BENCHMARK.md).

The theorem implies a workflow split:

- **Design-time (offline):** a strong model, supervised by a developer, solves a workflow end-to-end once, generalizes the trajectory, and writes the macro. This happens rarely, costs little in aggregate, and produces a versioned, reviewable, deterministic artifact.
- **Runtime (online):** a weak model receives a user request, classifies it against the macro registry, and calls the matching macro with arguments extracted from the request. The macro executes deterministically. The weak model never plans the workflow itself.

The cost asymmetry is the point. A workflow is encoded once with a frontier model (perhaps $0.50 of inference); it is executed thousands of times with a weak model (perhaps $0.0001 per execution). The capability gap between models stops mattering for that workflow.

## 3. The anatomy of a macro

A macro is the unit of distilled knowledge in this pattern. It has five parts:

1. **A name and an intent specification.** A natural-language description of what the macro does, in the vocabulary the end user will use. The intent specification is what the runtime classifier matches against.
2. **A typed argument schema.** What information the macro needs from the user request to execute. The runtime extracts arguments from the request and validates them against the schema before dispatch.
3. **A deterministic handler.** The actual sequence of tool calls — API calls, database queries, browser actions, file reads, computations — that implements the workflow. Written in ordinary code, not LLM-generated at runtime.
4. **A failure-context contract.** When the handler fails, it returns structured context: which step failed, why, what was tried, what the next macro to call might be. This is what lets a weak model recover by pattern-matching the failure shape rather than reasoning about it.
5. **A test fixture set.** Recorded request → expected-output pairs that pin the macro's behavior. Tests are how a macro library stays correct across model upgrades, surface changes, and refactors.

A toy example, in the vertical of academic-paper triage:

```ts
defineMacro({
  name: "triage_arxiv_paper",
  intent: "summarize and classify an arXiv paper by its ID or URL",
  schema: z.object({
    paperId: z.string(),    // "2401.12345" or full URL
    classifier: z.enum(["relevance", "novelty", "method"]).default("relevance")
  }),
  handler: async ({ paperId, classifier }, ctx) => {
    const meta = await ctx.tools.arxiv.fetchMetadata(paperId);
    const pdf  = await ctx.tools.arxiv.fetchPdf(paperId);
    const text = await ctx.tools.pdf.extract(pdf, { pages: "1-3" });
    const score = await ctx.tools.classify(text, { dimension: classifier });
    return { paperId, title: meta.title, score, oneLine: meta.summary };
  },
  tests: [/* recorded fixtures */]
});
```

At runtime, the weak model sees:

> User: *"can you triage 2401.12345 for me, I care about whether the method is new"*

…and produces exactly one tool call:

```json
{ "tool": "triage_arxiv_paper", "args": { "paperId": "2401.12345", "classifier": "method" } }
```

It does not plan the workflow. It does not decide to fetch the PDF, then extract pages, then score. All of that happened offline, encoded by the strong model that wrote the handler. The weak model only routes.

## 4. The runtime loop

The Macrokit runtime is a thin dispatcher. Pseudocode:

```
for each user turn:
    request = user.message
    macros  = registry.list()
    choice  = weak_model.complete(
                prompt = build_router_prompt(macros, history, request),
                tools  = macros.as_tool_schemas()
              )
    if choice.is_tool_call() and choice.tool in macros:
        result = registry[choice.tool].handler(choice.args)
        weak_model.observe(result)
    else if bail_out_detector.fires(choice):
        escalate_or_repair(choice)
    else:
        return choice.text   # free-form answer, no macro applied
```

Three details are load-bearing.

**The prompt builder is the model's only view of capability.** The registry renders to a per-provider tool-call schema (OpenAI, Anthropic, Ollama, etc., all differ slightly). The system prompt teaches the model that the macro registry is the answer to almost every concrete request, and that free-form text is the last resort, not the first. Many failure modes a weak model exhibits in agent frameworks ("I'll plan this out step by step…") collapse if the prompt frames the task as routing rather than reasoning.

**The bail-out detector is the safety net.** Weak models reliably produce one of a small set of failure patterns when they are out of their depth: they emit a tool call as plain text instead of structured JSON, they call a tool that doesn't exist, they call the same tool with the same arguments two turns in a row (a loop), or they print "I would do X, then Y…" instead of acting. The detector pattern-matches these and either repairs the call (re-prompting with the schema), escalates to a configured frontier API for that turn, or returns a structured error that downstream code can act on. The detector is small (a few hundred lines of regex and trajectory checks) and entirely independent of the model. It is what makes weak-model deployment honest rather than aspirational.

**Macros are composable but composition is also a macro.** If a workflow is "run macro A, then macro B, then macro C, with B's output flowing into C's input," that should be a single macro named, for example, `run_full_triage_pipeline`, not three router decisions. A weak model that chains three macros via three router turns is reasoning over the workflow at runtime — exactly what we are trying to avoid. Composition lives in the handler, not in the router.

## 5. The distillation gate

This is the part of the pattern that is genuinely novel, and the part most likely to be skipped.

A macro library is only useful if it is *complete enough for the workflows users actually run*. Most agent-framework adoptions accumulate tool collections that grow organically, redundantly, and incoherently — each session adds a tool, no session consolidates, the library becomes a graveyard of one-off helpers. The runtime works but the library does not compound.

Macrokit's prescription:

> **The distillation gate.** Every session that touches a workflow without an existing macro must encode that workflow as a macro before ending. The session does not end successfully if the encoding step is skipped.

In practice the gate is enforced by tooling. The runtime writes a session log: every tool call, every user turn, every result. The `macrokit gate` CLI reads the log and flags sessions where three or more raw tool calls happened in a row for a workflow that has no macro:

```
$ macrokit gate
Session 2026-05-24T14:02:11Z touched 4 raw tool calls for an unmacro'd workflow:
  → fetch_user_profile(id=…)
  → list_user_open_issues(id=…)
  → label_issues(ids=…, label="needs-triage")
  → notify_assignees(issue_ids=…)

Encode this sequence as a macro before ending the session.
Suggested name: triage_open_issues_for_user(user_id)
Suggested schema: { user_id: string, label: string = "needs-triage" }
```

The cultural shift the gate produces is the *whole point*. Without it, the macro library is a thing some people on the team write when they remember. With it, every session that does work also encodes work — the library compounds at the rate the team uses the system.

The runtime is engineering. The distillation gate is the cultural innovation. We claim the latter is what makes this pattern compound where adjacent ones (agent frameworks, RPA libraries, prompt collections) have not.

## 6. The public/private boundary

Macros are versioned, parameterized programs. Their *contents* — the URLs, selectors, decision rules, scoring formulas, banned-input lists, vendor names, customer lists — can be the most operationally valuable IP an organization owns. Their *shape* — the pattern of "intent classified → macro dispatched → result returned" — is generic and worth nothing as a secret.

Macrokit is built around this asymmetry:

- **The pattern is public.** The SDK, the runtime, the authoring kit, the CLI, the distillation gate, the bail-out detector, the reference data layer, and a small number of toy reference implementations in non-sensitive verticals are open source under Apache 2.0.
- **Macro libraries are private by default.** An organization's macros live in their own repository, typically private. Macrokit provides the loader, the test harness, the linter, and the signing/distribution helpers. It does not require the macros to be public, and does not phone home about them.

This boundary is the answer to the natural objection from regulated buyers: *"we cannot send our workflow logic to a US-hosted API."* The runtime can be entirely local. The macros can be entirely private. Only the pattern and the SDK are public. An organization can adopt Macrokit, build a substantial macro library, run it on local models on local hardware, and never call out to any external service. That property is not a marketing claim; it is what falls out of the architecture if you take the pattern seriously.

## 7. Where computer use fits in

Many real workflows do not have public APIs. They live behind login walls, in dashboards, internal admin tools, vendor portals. A practical macro library will need a way to drive a browser.

Generic computer use ("look at the screenshot, estimate the coordinates, click") is the worst possible interface for a weak model. It demands exactly the multi-step spatial reasoning weak models are bad at. The interface we recommend, and that Macrokit ships in `packages/browser`, is built around two observations:

1. **The model should never estimate coordinates.** Before any screenshot is returned to the model, an overlay numbers every interactive element on the page; alongside the image, the runtime returns a structured index of `{label, role, x, y, selector}`. The model picks a number; the runtime translates the number into a coordinate or selector. The model does no spatial reasoning.
2. **Most pages don't need a screenshot at all.** A pure-DOM `extractActionMenu()` returns the structured list of clickable elements and form fields. Vision is only needed when the surface is genuinely image-only (a canvas, a screenshot embedded in a document). Most enterprise dashboards yield to DOM extraction, which is faster, cheaper, and more reliable.

Both interfaces — annotated screenshot and action menu — are themselves macro-friendly. A typical workflow ends up with a macro `navigate_to_active_listings()` that wraps "go to URL X, wait for selector Y, return the action menu." The weak model never sees the URL or the selector. It sees a typed function it can call.

## 8. Honest limitations

This pattern is not a silver bullet. The cases it does *not* handle well:

**Genuinely novel reasoning.** "Write a friendly response to this angry customer." "Propose a price for a brand-new product category." "Decide which of these fifty options to escalate." These are open-ended judgment tasks. A macro can scaffold the work — pull the relevant context, structure the response — but the judgment itself needs a capable model. The honest answer is to route those turns to a configured frontier API. Hybrid routing (weak model handles the routine 80–90%, frontier handles the novel remainder) is part of the Macrokit runtime, opt-in per deployment.

**Workflows that change every time.** If the "shape" of the work is genuinely different each time — exploratory research, open-ended debugging, creative writing — there is nothing to encode. The pattern's value comes from the ratio of (executions of a workflow) to (encodings of that workflow). When that ratio is 1, the pattern is overhead.

**Surfaces that change underneath you.** A macro that navigates a third-party UI is hostage to that UI. When the UI changes, the macro breaks. Macrokit mitigates this with rich failure context (so the bail-out detector can route to a maintenance flow), and with the action-menu abstraction (which is more robust than hardcoded selectors), but the underlying problem is real. The honest mitigation is a fast maintenance loop, not a claim that the macros are immortal.

**Very small models.** The pattern lowers the floor of model capability needed to be useful, but does not remove it. The model must still produce a structured tool call reliably. As of early 2026, ~7B-parameter instruct-tuned models are roughly the floor for serious deployment; below that, the bail-out detector fires more often than the routing succeeds. This is an empirical bound, not a fundamental one, and we expect it to drop as small-model quality continues to rise.

## 9. What this is not

A short positioning note, because the surrounding literature is crowded.

- **Macrokit is not an agent framework.** LangChain, AutoGen, CrewAI compete on the quality of LLM reasoning loops — better planners, better memory, better critic models. Macrokit competes by *eliminating* the runtime reasoning loop. Different philosophy. The right comparison is to "agents that route" rather than "agents that think."
- **Macrokit is not a model.** It is BYO-model. Macros run identically against an OpenAI API, a DeepSeek API, an Ollama-served Qwen, or an in-process llama.cpp binary. The adapter layer normalizes tool-call schemas across providers.
- **Macrokit is not RPA.** Robotic Process Automation records UI events at the pixel/keystroke level. The recording is brittle to layout changes and tells the human nothing about what the workflow *means*. Macros are recorded at the semantic level — tool calls with typed arguments — and the recording is the developer-readable encoding of the workflow's intent.
- **Macrokit is not a fine-tuning pipeline.** Fine-tuning the weak model to behave better is a parallel path, and a respectable one. We do not pursue it as the primary lever because the gap between a 7B model and a frontier model is a capacity gap, not a training-data gap. Macros sidestep the capacity gap by moving the reasoning offline. (See the *Related work* section, to be expanded in the preprint.)
- **Macrokit is not a no-code platform.** Authoring a macro requires a developer and a strong model in the loop. The end user of a Macrokit-built application sees only the chat interface; the macros are an implementation detail.

## 10. When to use it, when not to

A pragmatic decision rule.

**Use this pattern when:**

- The same workflows are run thousands or millions of times.
- The cost or latency of frontier APIs is a hard constraint per call.
- Data-residency, compliance, or air-gap requirements forbid sending workflow data to a US-controlled API.
- The set of workflows is enumerable — you can list them, even if the list is long.
- The downstream system the LLM operates is opaque (third-party UI, vendor dashboard, internal tool) rather than a clean API you control.

**Skip this pattern when:**

- Each request is genuinely novel and the model must reason from first principles.
- A frontier API is acceptable and the unit economics work.
- The workflows are already exposed as clean APIs the LLM can call directly without encoding.

The first list is much larger than people first assume — almost any "operations" or "back-office" LLM use case lives there. The second list is much smaller than the agent-framework discourse suggests.

## 11. Where Macrokit goes next

Macrokit launches in Q3 2026. The six-package SDK (runtime, LLM adapter layer, browser, authoring kit, reference-data, CLI) is in the repository alongside one non-trivial reference implementation: a multi-surface GitHub maintainer agent driving five macros against the GitHub API plus one browser-driven macro against the GitHub Actions UI. The expanded version of this document — adding evaluation against a pre-registered 100-task benchmark and a related-work section — is deposited as a Zenodo preprint at launch with a citable DOI.

A pattern is only as durable as the practice that surrounds it. If Macrokit is just a runtime, it is one library among many. If the distillation gate becomes a discipline that teams actually adopt — every session that touches a workflow without a macro encodes one before ending — then over a year or two, the macro libraries that teams accumulate become the operational moat of those teams, the SDK becomes incidental, and the pattern compounds.

That is the bet.

---

*Draft v0.1, 2026-05-27. Feedback and pushback welcome at the project's public issue tracker once it opens.*
