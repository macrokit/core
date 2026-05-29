# Macrokit

[![CI](https://github.com/macrokit/core/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/macrokit/core/actions/workflows/ci.yml)

**An open-source SDK that lets weak and local LLMs work like frontier models on narrow workflows.**

[macrokit.dev](https://macrokit.dev) · Apache 2.0 · TypeScript · Pre-release

---

## What it is

Macrokit is a runtime and SDK for shipping LLM applications under cloud-API constraints — data residency, compliance, air-gapped networks, or budget.

It works by moving multi-step reasoning to **design-time**: a strong model (Claude, GPT-4o) encodes a workflow once as a deterministic *macro*. At **runtime**, a weak or local model only has to do **intent classification** — "user wants X → call macro Y." The hard work happens once, offline. The cheap work happens every request.

Read **[`docs/THE_PATTERN.md`](docs/THE_PATTERN.md)** for the full argument.

## Who it's for

You should look at Macrokit if you are building an LLM application and at least one of the following is true:

- The frontier-API bill is the biggest line in your unit economics.
- Your users live in a jurisdiction where calling a US-controlled API is a non-starter (data residency, regulatory restrictions).
- You ship into air-gapped or on-device environments and a cloud round-trip is not an option.
- The workflows your model performs are mostly the same shape — operations work, back-office automation, drive-this-dashboard tasks — done thousands or millions of times.
- You have tried agent frameworks and your weak/local model loses the thread three steps in.

You should *not* look at Macrokit if your application's value comes from genuinely novel reasoning each request, or if a frontier API is acceptable and the unit economics already work.

## How it differs

- **Not an agent framework.** Agent frameworks compete on letting LLMs *reason*. Macrokit competes by *eliminating* runtime reasoning. Different philosophy. (See `docs/THE_PATTERN.md` §9.)
- **Not a model.** BYO-model. Ships adapters for OpenAI-compatible APIs, Ollama, and llama.cpp out of the box.
- **Not RPA.** RPA records UI clicks at the pixel level. Macros are recorded at the semantic level — typed tool calls with named arguments — and are diff-reviewable code.
- **Not a no-code platform.** Authoring a macro assumes a developer plus a strong model in the loop. End users see only the chat interface.

## What you get

- **`@macrokit/runtime`** — intent router, macro registry, dispatcher, session log.
- **`@macrokit/llm`** — model adapters (OpenAI-compatible, Ollama, llama.cpp) with a bail-out detector that catches weak-model failure modes before they reach your application.
- **`@macrokit/browser`** — Playwright-based browser service with annotated-screenshot and DOM action-menu primitives. Weak models pick numbered elements instead of estimating coordinates.
- **`@macrokit/authoring`** — `defineMacro()`, a test harness with recording mode, schema helpers.
- **`@macrokit/reference-data`** — versioned, signed reference-data bundles for the lookup tables most production macro libraries need.
- **`macrokit` CLI** — `init`, `lint`, and the headline `macrokit gate` command that enforces the distillation discipline (see below).

## The distillation gate

The genuinely novel piece of Macrokit is not the runtime. The runtime is engineering. The novel piece is a small cultural rule, enforced by tooling:

> Every session that touches a workflow without an existing macro must encode that workflow as a macro before ending.

`macrokit gate` reads the runtime's session log and flags any session that did three or more raw tool calls in a row without dispatching a macro. It suggests a name, schema, and stub handler for the missing macro. Wire it into your CI and the macro library compounds at the rate the team uses the system — instead of becoming a graveyard of one-off helpers like most tool collections do.

Full argument: `docs/THE_PATTERN.md` §5.

## 60-second hello world

> The runtime is under active development. The snippet below is the target API for the first release (Week 12). It will work end-to-end at launch; today it compiles and runs the trivial smoke test.

```ts
import { defineMacro, MacroRegistry } from "@macrokit/authoring";
import { Runtime } from "@macrokit/runtime";
import { OpenAICompatibleAdapter } from "@macrokit/llm";
import { z } from "zod";

const echo = defineMacro({
  name: "echo",
  intent: "echo back whatever the user said, optionally shouting",
  schema: z.object({ text: z.string(), shout: z.boolean().default(false) }),
  handler: async ({ text, shout }) => ({ text: shout ? text.toUpperCase() : text }),
});

const runtime = new Runtime({
  registry: new MacroRegistry().register(echo),
  llm: new OpenAICompatibleAdapter({
    baseUrl: "http://localhost:11434/v1",   // any OpenAI-compatible endpoint
    model:   "qwen2.5:7b-instruct",
    apiKey:  process.env.LLM_API_KEY ?? "ollama",
  }),
});

const result = await runtime.chat("can you shout 'hello macrokit' back at me");
console.log(result.text);   // → "HELLO MACROKIT"
```

The point of this example is what's *not* in it. No agent loop. No planning prompt. No fallback handler. The weak model classifies the intent, the macro runs deterministically, the result comes back. That is the whole runtime contract.

## Docs

- **[`docs/THE_PATTERN.md`](docs/THE_PATTERN.md)** — the pattern, the theorem, the distillation gate, the public/private boundary. Start here.
- **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — the SDK's component layout and the runtime loop in detail.
- **[`docs/BENCHMARK.md`](docs/BENCHMARK.md)** — the launch benchmark: methodology, two-run story, honest analysis of misses, and why we don't run frontier rows ourselves.
- **Quickstart** — landing with the launch (docs site at [macrokit.dev](https://macrokit.dev)).
- **API reference** — landing with the launch (auto-generated, on the docs site).

## Status

Pre-release. Targeting public launch in Q3 2026.

The pattern Macrokit codifies has been running in a private production deployment since early 2026 (operations tooling for users without frontier-API access). Macrokit is the vertical-agnostic extraction of that work into a reusable SDK. The [`launch benchmark`](docs/BENCHMARK.md) exercises it on a public maintainer-agent corpus: a 7B local model scored 94.5% with zero structural failures.

We will not publish a roadmap until launch. We will not promise dates. We will ship one substantive non-sensitive reference implementation alongside the launch so the pattern is demonstrable, not just describable.

## License

Apache 2.0. See [`LICENSE`](LICENSE).

The patent grant matters in enterprise contexts; that is the reason for Apache over MIT.

## Contributing

There are two contribution paths, with different rules.

**Publishing your own macros for a vertical.** This is the path most contributors want. Macrokit deliberately keeps `core/examples/` small (curated reference implementations); vertical macro libraries live as standalone npm packages you publish yourself, and get discovered via the community registry and the `macrokit-macros` GitHub topic. See [`CONTRIBUTING_MACROS.md`](CONTRIBUTING_MACROS.md) for the naming convention, minimum requirements, and how to get listed. The `macrokit lint --pkg <path>` command checks your package against the conformance bar before you open a registry PR.

The registry is the seed of a broader ecosystem we intend to grow: a place to share and discover the vertical macro libraries authors build, so adopting a new vertical can start from proven macros instead of a cold start. If that direction interests you as an early author, say hello via [@macrokitdev](https://x.com/macrokitdev).

**SDK-internal contributions** (changes to `@macrokit/runtime`, `@macrokit/llm`, `@macrokit/browser`, `@macrokit/authoring`, `@macrokit/reference-data`, `@macrokit/cli`) are not yet accepting external PRs while the API surface stabilizes. Issues and discussion are welcome on this repo's tracker. A full contribution guideline + RFC process lands after the first stable minor.

If you are building under the constraints Macrokit is designed for and want to be a design partner, contact via [macrokit.dev](https://macrokit.dev) or [@macrokitdev](https://x.com/macrokitdev) on X.
