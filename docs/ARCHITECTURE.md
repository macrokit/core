# Macrokit Architecture

*The shape of the SDK and how its pieces fit together.*

**Status:** Live core, with some **target-architecture** sections not yet shipped. The six packages exist
on `main` and the runtime/router/dispatcher/registry, the OpenAI-compatible + Ollama adapters, the
bail-out *detector*, `defineMacro()`, the browser primitives, and `macrokit init / lint / gate` are real and
tested. The following described here are **NOT yet implemented** (target shape, called out inline too):
the `LlamaCppAdapter`, adapter streaming, an `embed` method, bail-out **repair/escalate** (only *detection*
ships — see the runtime note), the `macrokit refdata` CLI, interactive `macrokit init`, pluggable/remote
registry storage, and fsync'd session logs. Treat unmarked claims as shipped and marked ones as planned.

Read `THE_PATTERN.md` first if you haven't. This document assumes the pattern (intent routing plus macro distillation) and describes the concrete components that implement it.

---

## 1. Design constraints

The architecture answers to five constraints. Every component decision below traces back to one of them.

1. **Weak models must be sufficient at runtime.** Anything that requires multi-step planning, error recovery, or open-ended reasoning must happen offline or in deterministic code, not in the runtime LLM call.
2. **The pattern is public; macro libraries are private.** The SDK ships open source. An adopter's macro repository is theirs, by default private, never required to leave their network. Nothing in the SDK calls home.
3. **BYO model and BYO surface.** The runtime is indifferent to which model serves the LLM calls and which surface (API, browser, filesystem, custom protocol) the macros operate. Provider-specific code is confined to adapter packages.
4. **Versioning is enterprise gravity.** Macros are programs; programs need semver, signed releases, and migration discipline. The architecture treats macros and reference data as first-class versioned artifacts, not as configuration.
5. **No premature abstraction.** Two reference deployments (one toy, one substantive non-sensitive vertical) inform the API. Designing for twelve hypothetical verticals is how SDKs become unusable.

## 2. The package layout

The SDK is a monorepo of TypeScript packages, published independently. ESM-first, Node 20+ baseline. All packages compile with `tsup` and ship type declarations.

```
core/packages/
├── runtime/          # intent router, registry, dispatcher, session log
├── llm/              # model adapters + tool-call normalization + bail-out detector
├── browser/          # annotated-screenshot + action-menu, Playwright by default
├── authoring/        # defineMacro(), test harness, recording mode, schema helpers
├── reference-data/   # versioned reference-data loader, signed bundles, SQLite cache
└── cli/              # `macrokit init / lint / gate` (+ `studio`/`mcp` launchers; `refdata` planned)
```

Each package has a single, narrow responsibility. The packages compose by import — nothing in the runtime knows about the browser package; nothing in the LLM package knows about the authoring helpers. Adopters install only what they need.

### 2.1 `runtime`

The smallest package, intentionally. Owns:

- **Type definitions:** `Macro`, `MacroRegistry`, `IntentRouter`, `Dispatcher`, `ToolCall`, `ToolResult`, `SessionLog`.
- **`MacroRegistry`:** in-memory, `register(macro)`, `lookup(name)`, `dispatch(toolCall)`. (Pluggable/remote-backed storage for orgs with thousands of macros is a design intent, not a shipped interface — today it's in-memory only.)
- **`IntentRouter`:** given a registry, a model adapter, and a user request, produces a tool call or a free-form response. Owns the per-turn prompt builder.
- **`Dispatcher`:** validates arguments against the macro's schema, calls the handler, captures failure context, writes to the session log.
- **`SessionLog`:** append-only JSONL file under `.macrokit/sessions/`. Every user turn, every tool call, every result. The distillation gate reads this.

The runtime core is deliberately small (~300 lines). Routing and dispatch are the whole job; anything beyond that is scope creep.

### 2.2 `llm`

A single interface (`LLMAdapter`) with a small set of methods (`complete`, `completeWithTools`, `embed`) and provider-specific adapters that implement it.

Shipping adapters:

- `OpenAICompatibleAdapter` — covers OpenAI, DeepSeek, Qwen API, Zhipu, Kimi, Together, OpenRouter, and any other provider that speaks the OpenAI chat-completions schema. One adapter, configured by base URL and API key.
- `OllamaAdapter` — talks to a local Ollama server. (Streaming: planned, not shipped.)
- `LlamaCppAdapter` — **planned, not shipped.** llama.cpp models are reachable today via the
  OpenAI-compatible adapter pointed at a `llama-server` HTTP endpoint (this is how the benchmark's reference
  7B was served); a dedicated in-process `node-llama-cpp` adapter is future work.

Provider tool-call schemas differ in small but breaking ways (function-call wrapping, tool-result message shape, streaming-event format). The package normalizes them to one internal shape so the runtime can be provider-agnostic. The adapters are the only code that knows which provider is in use.

**The bail-out detector lives here**, because every adapter passes its raw response through it before returning to the runtime. The detector pattern-matches the failure modes weak models exhibit when out of their depth — tool calls emitted as plain text, calls to nonexistent tools, repeated identical calls (loops), prose-shaped output where a tool call was expected. **What ships today is *detection*** — the events are flagged on the turn result. *Acting* on a fire is only partial: if a fallback adapter is configured, the failing turn can **escalate** to it; **repair (re-prompt with the schema) is not yet implemented**, and **with no fallback configured the runtime currently still dispatches/returns the flagged output** (a known gap — `router.ts` — being closed; do not rely on the detector to *block* bad output yet). The detector's rule set is small, documented, and extensible per deployment. We resist letting it become a soft-AGI scoring system.

### 2.3 `browser`

The surface most macros that drive third-party UIs will need.

Two backends, one interface:

- **Playwright backend (default):** runs in Node, manages browser contexts, supports persistent profiles per "user identity."
- **Chrome-extension backend:** drives the user's own logged-in Chrome through a small extension. Useful when an adopter wants the macros to operate within an existing browser session rather than a headless context. The extension lives in a separate repository (planned; not yet released).

Both backends expose the same `BrowserService` API. The two interface primitives that matter:

- **`annotatedScreenshot(page)`** — query all visible interactive elements, inject a numbered-badge overlay, capture the screenshot, return `{ image, index: [{ label, role, x, y, selector }] }`. The badge overlay is removed immediately after capture. The model picks a number; the runtime translates the number to a coordinate or selector. The model does no spatial reasoning. (Pattern reference: `THE_PATTERN.md` §7.)
- **`extractActionMenu(page)`** — pure-DOM version of the same idea: returns `[{ label, role, selector, ariaLabel }]` without a screenshot. Faster, cheaper, and what most macros should reach for first. The screenshot version is the fallback when the page is genuinely image-only.

Both functions are used inside macro handlers, not by the runtime LLM directly. A macro author who needs "go to URL X and return the action menu" writes a handler that calls `BrowserService` and returns the result; the LLM sees only the typed macro signature.

### 2.4 `authoring`

What an adopter imports when writing macros. The smallest possible surface that still enforces discipline.

```ts
import { defineMacro, defineRegistry, testMacro } from "@macrokit/authoring";
import { z } from "zod";

export const triagePR = defineMacro({
  name: "triage_pull_request",
  intent: "triage a GitHub pull request: classify it, suggest labels, suggest reviewers",
  schema: z.object({
    repo: z.string(),       // "owner/name"
    prNumber: z.number(),
  }),
  handler: async ({ repo, prNumber }, ctx) => { /* … */ },
  tests: [/* recorded fixtures */],
});
```

`defineMacro` is a typed factory; the registry is a typed collection; `testMacro` runs a macro against its fixtures with mocked tool surfaces.

**Recording mode.** During macro development, the runtime can be put into a recording mode that captures `(toolCall, result)` pairs to disk. Those become the fixtures the test harness replays. This is the only way to keep macro tests honest as third-party surfaces change: you re-record against the live surface periodically, the diff in fixtures is the diff in the surface, and the test harness flags drift.

`authoring` deliberately does *not* ship "smart" helpers (LLM-powered code completion of macros, auto-discovery of selectors, etc.). Macro authoring is a human-plus-strong-model task; the SDK's job is to give that pair good primitives, not to replace either side of it.

### 2.5 `reference-data`

Many macro libraries carry data alongside code: lookup tables, vocabulary lists, scoring weights, model-specific prompt templates. Treating that data as application code (committed alongside source) makes it hard to ship updates without a release; treating it as runtime configuration makes it unsigned and unversioned.

`reference-data` is the in-between: a pattern for shipping versioned, signed reference data as a separate artifact.

- **Loader:** reads CSV/JSON files into typed records, schema-validated via `zod`.
- **Local cache:** SQLite-backed, with TTL, under the OS-appropriate application-data directory.
- **CLI command (planned, not shipped):** `macrokit refdata sync <name>` would pull a signed bundle from a URL the project configures (an S3 path, a static-hosting URL, anything that serves HTTPS), verifying signatures locally before the bundle replaces the cached copy. The `reference-data` *library* ships; the `refdata` CLI lifecycle is future work.
- **Versioning:** each bundle is a semver release. Downgrade and pinning are first-class.

This package is intentionally generic. It does not assume what's in the data. The reference deployments will exercise it (a recruiting reference impl will likely ship a `roles_taxonomy` bundle; a paper-triage one will ship a `venues_taxonomy`). The generic loader is the contribution; the data is each adopter's.

### 2.6 `cli`

The user-facing entry points.

- **`macrokit init`** — scaffolds a new project (`init <name> --vertical <X>`) with a `macrokit.json`
  manifest, `macros/`, `primitives/`, and `fixtures/`. (The interactive provider/browser prompts described
  here are planned; today it takes flags.) Produces a working scaffold with the runtime wired up.
- **`macrokit lint`** — static checks on a project's macros: missing tests, missing intent strings, schema/handler argument mismatches, banned patterns (e.g. handlers that call the model again — almost always a sign the macro should have been split).
  - **`macrokit lint --pkg <path>`** — same lint binary, different mode: validate a *standalone community macro package* against the structural bar in [`CONTRIBUTING_MACROS.md`](../CONTRIBUTING_MACROS.md). Four checks — `@macrokit/authoring` declared as peerDependency, at least one `defineMacro()` with all four required fields exported, at least one test/fixture file, `README.md` at the root. Used by registry-PR reviewers and by adopters self-checking before opening a listing PR. Exits 1 on any failure for CI use.
- **`macrokit gate`** — the distillation-gate enforcer. Reads `.macrokit/sessions/*.jsonl`. Flags sessions where three or more raw tool calls happened in a row for a workflow that does not have a macro. Prints suggested macro names, schemas, and a stub handler signature. CI-friendly: exits non-zero when violations exist, so the gate can be wired into the merge checks of a team that wants to enforce the discipline. (Pattern reference: `THE_PATTERN.md` §5.)
- **`macrokit refdata <sync | verify | pin>`** — the reference-data lifecycle. *(Planned; the `reference-data` library ships, the CLI does not yet.)*

The CLI is where most adopters will spend the most time, so its UX matters disproportionately. We treat it as a product, not as glue.

## 3. The runtime loop in detail

A single user turn, end to end:

```
1. User sends message.
2. Runtime appends to session log: { type: "user", text, ts }.
3. IntentRouter builds the per-turn prompt:
     - system message (registry-aware, teaches "route, don't reason")
     - recent history (configurable window)
     - registered macros, rendered as tool-call schemas in the
       adapter's native format
     - user message
4. LLMAdapter.completeWithTools(prompt, tools) is called.
5. Raw response passes through the bail-out detector.
       on fire: detect + flag (escalate if a fallback is configured; repair = planned)
       on pass: continue
6. If the response is a tool call:
       a. Dispatcher validates args against macro.schema.
       b. Dispatcher calls macro.handler(args, ctx).
       c. Handler runs deterministically; ctx exposes tool surfaces
          (BrowserService, HTTP, DB, filesystem, …) provided by the
          adopter at runtime-construction time.
       d. Result is appended to session log: { type: "tool_result", … }.
       e. Loop back to step 3 if the macro signals "continue turn"
          (e.g. it returned an interim result and expects the model
          to respond). Most macros return terminal results.
7. If the response is free-form text:
       a. Returned to the user as the assistant turn.
       b. Appended to session log.
8. Session log is written (append-only JSONL) before returning. *(Durable fsync-on-write: planned, not yet implemented.)*
```

A few things this loop deliberately does *not* do.

- **No automatic chaining.** If a workflow needs three macros in sequence, that is a composite macro the author wrote, not three router decisions. The runtime never asks the model "what should we do next." (See `THE_PATTERN.md` §4.)
- **No silent retries.** A failed tool call returns its failure context to the model so the model can route to a recovery macro, or to the user if no recovery exists. Hidden retries make failure modes invisible and are a major source of "agent that does the wrong thing five times" reports in the wild.
- **No model self-talk.** The router prompt does not include "think step by step" or chain-of-thought scaffolding for the macro selection. The macro selection is a one-shot classification; if it needs reasoning, the macro registry is missing a macro.

## 4. The public/private boundary, in code

The architecture takes the pattern's public/private split seriously. Concretely:

- **Open source, Apache 2.0:** every package in `core/packages/`, every reference implementation in `core/examples/`, every doc in `core/docs/`, the docs site at `macrokit.dev`.
- **Adopter-owned, typically private:** macro repositories. Each adopter has a repository (or several, by vertical) of `defineMacro(...)` definitions, test fixtures, and reference-data bundles. The SDK provides the loader and the test harness; the macros are theirs.
- **Adopter-owned, may be public:** specific macros an adopter chooses to share. The reference implementations Macrokit ships are intentionally non-sensitive verticals chosen to demonstrate the pattern without revealing the playbooks of operators in regulated or competitive verticals.

The SDK respects this boundary in one further way: it does not phone home. There is no anonymous-usage-stats opt-in, no auto-update check, no telemetry endpoint. An adopter who runs Macrokit in an air-gapped environment does not have to disable anything; nothing was enabled.

## 5. Versioning and stability

The pre-1.0 phase will involve breaking changes; we will batch them and document them in `UPGRADING.md` per release. Post-1.0 the SDK follows strict semver. Specifically:

- **`runtime` and `authoring`:** the `defineMacro` API and the `Macro`/`MacroRegistry` types are the most important stability surface. A macro written against `@macrokit/authoring@1.0` must continue to load against any `1.x`. Schema-validation library versions (currently `zod`) are pinned in peer dependencies to avoid the trap of an SDK upgrade silently breaking schemas.
- **`llm`:** adapter contracts are stable within a major; the set of adapters can grow without a major bump.
- **`browser`:** the `BrowserService` interface is stable within a major; backends can be added without a major bump.
- **`cli`:** flag stability matches the SDK major; output formats are guaranteed only for the `--format=json` variants. Human-readable output may change.

Reference-data bundles version independently per adopter. The SDK's loader handles arbitrary semver ranges.

## 6. What we are not building (yet, or at all)

To pre-empt the obvious feature requests:

- **A hosted runtime.** Macrokit ships as a library you embed. We may eventually publish a reference hosted runtime for evaluation purposes; we will not build a SaaS that requires you to send your macros to us.
- **A macro exchange.** A federated registry of public macros across verticals is conceivable, but loads the project with curation, signing-key, and policy questions that are wrong to take on pre-launch.
- **An IDE plugin.** Macros are written in TypeScript files; existing IDE tooling is sufficient.
- **A LangChain-style "agent graph" layer.** Out of scope by design — the whole point of the pattern is to not have one.
- **A non-TypeScript primary SDK.** The runtime is in TypeScript. A Python port is conceivable post-launch if demand justifies it; we will not ship a Python SDK that lags behind the TS one.

## 7. What's shipped

Live and open on `main`:

- `runtime` — intent router, macro registry, dispatcher, session log; covers the single-user, single-process case.
- `llm` — `OpenAICompatibleAdapter`, `OllamaAdapter`, `AnthropicAdapter` (design-time authoring), plus a bail-out detector with a documented extensibility model.
- `browser` — Playwright backend.
- `authoring` — `defineMacro`, test harness, recording mode.
- `reference-data` — loader, cache, `sync`/`verify`/`pin`.
- `cli` — `init`, `lint`, `gate` (and `studio`/`mcp` launchers for the local IDE).
- Two reference implementations in `examples/` (`github-maintainer`, `paper-triage`) against publicly observable surfaces.
- `macrokit.dev` carrying this document and `THE_PATTERN.md`.

Not built yet (decided by what adopters actually ask for): hosted runtime, additional language SDKs, the Chrome-extension backend, distributed/multi-process runtime support, fine-grained per-macro permissioning.

---

*The architecture is fixed in shape; detail hardens as real usage reveals which assumptions were wrong.*
