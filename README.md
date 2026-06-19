# Macrokit

[![CI](https://github.com/macrokit/core/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/macrokit/core/actions/workflows/ci.yml)

**An open-source SDK that lets weak and local LLMs work like frontier models on narrow workflows.**

[macrokit.dev](https://macrokit.dev) · Apache 2.0 · TypeScript · Live

---

## What it is

Macrokit is a runtime and SDK for shipping LLM applications under cloud-API constraints — data residency, compliance, air-gapped networks, or budget.

It works by moving multi-step reasoning to **design-time**: a strong model (Claude, GPT-4o) encodes a workflow once as a deterministic *macro*. At **runtime**, a weak or local model only has to do **intent classification** — "user wants X → call macro Y." The hard work happens once, offline. The cheap work happens every request.

This recapitulates how brains manage the cost of thinking: a slow, expensive *deliberation* path (System 2 — the strong model) compiles repeated reasoning into a fast, cheap *automatic* path (System 1 — the macro), and the cheap reflex carries the overwhelming majority of the load. A fast cheap reflex and a slow expensive mind, with the reflex carrying the load.

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

The short version: every framework here lets the model *reason at runtime*; Macrokit *removes* runtime reasoning so a weak/local model can carry it — and ships the evidence that it does. Off-the-shelf 1.5B–8B models clear a pre-registered [100-task benchmark](docs/BENCHMARK.md) (74–82.5%), and a [pre-registered ablation](docs/MACRO_ABLATION.md) shows encoding the workflow delivers more useful work per unit of compute than making the same model reason it live.

- **Not an agent framework.** Agent frameworks compete on letting LLMs *reason*. Macrokit competes by *eliminating* runtime reasoning. Different philosophy. (See `docs/THE_PATTERN.md` §9.)
- **Not a skills or prompt format.** A *skill* tells a strong model how to think. A *macro* is the compiled, deterministic result of that thinking — it runs on weak and local models with no reasoning at runtime. Macros can call MCP tools as primitives; Macrokit sits *above* MCP, not against it.
- **Not a model.** BYO-model. Ships adapters for OpenAI-compatible APIs, Ollama, and llama.cpp out of the box.
- **Not RPA.** RPA records UI clicks at the pixel level. Macros are recorded at the semantic level — typed tool calls with named arguments — and are diff-reviewable code.
- **Not a save-a-chain convenience.** Macrokit's *distillation gate* surfaces multi-step sequences worth encoding and proposes a macro for them — so the macro library compounds by discipline, not by remembering to save. The accumulated library, not the runtime, is the moat.
- **Not a no-code platform.** Authoring a macro assumes a developer plus a strong model in the loop. End users see only the chat interface.

## What you get

- **`@macrokit/runtime`** — intent router, macro registry, dispatcher, session log.
- **`@macrokit/llm`** — model adapters (OpenAI-compatible, Ollama, llama.cpp) with a bail-out detector that catches weak-model failure modes before they reach your application.
- **`@macrokit/browser`** — Playwright-based browser service with annotated-screenshot and DOM action-menu primitives. Weak models pick numbered elements instead of estimating coordinates.
- **`@macrokit/authoring`** — `defineMacro()`, a test harness with recording mode, schema helpers.
- **`@macrokit/reference-data`** — versioned, signed reference-data bundles for the lookup tables most production macro libraries need.
- **`@macrokit/mcp`** — a public stdio MCP server: expose a project's macros + primitives as tools to Claude Code / Cursor, record the session, and let `macrokit gate` flag un-encoded workflows. See [Wire it into Claude Code / Cursor](#wire-it-into-claude-code--cursor-5-minutes).
- **`macrokit` CLI** — `init`, `lint`, `mcp`, and the headline `macrokit gate` command that enforces the distillation discipline (see below).

## The distillation gate

The genuinely novel piece of Macrokit is not the runtime. The runtime is engineering. The novel piece is a small cultural rule, enforced by tooling:

> Every session that touches a workflow without an existing macro must encode that workflow as a macro before ending.

`macrokit gate` reads the runtime's session log and flags any user turn that ran three or more distinct **un-encoded** tool calls — a workflow done *without* a macro — and suggests a name, schema, and stub handler for the macro that captures it. It discovers your project's encoded macros from `./macros` (override with `--macros <dir>`), so a turn that merely chained existing macros is *not* flagged; if no macro set is found it falls back to counting all distinct calls. Wire it into your CI and the macro library compounds at the rate the team uses the system — instead of becoming a graveyard of one-off helpers like most tool collections do.

Full argument: `docs/THE_PATTERN.md` §5.

## 60-second hello world

> Runs against any OpenAI-compatible endpoint (Ollama shown below). `macrokit init <name>` scaffolds a project around exactly this shape.

**Install.** The `@macrokit/*` packages run from source today — it's a pnpm workspace. (npm releases are coming; once they land, `npm install @macrokit/runtime @macrokit/llm @macrokit/authoring` replaces the clone step.)

```sh
git clone https://github.com/macrokit/core.git macrokit && cd macrokit
pnpm install && pnpm -r build
```

Then run a reference agent in [`examples/`](examples/), or import the packages from a workspace app:

```ts
import { defineMacro } from "@macrokit/authoring";
import { MacroRegistry, Runtime } from "@macrokit/runtime";
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

## Wire it into Claude Code / Cursor (5 minutes)

Macrokit ships a public MCP server (`@macrokit/mcp`) so the agent you already use can call your project's macros — and its raw primitives — as tools.

1. **Scaffold (or open) a project:**
   ```sh
   macrokit init my-app --vertical github
   ```
2. **Add the server to your agent** (Claude Code shown; Cursor takes the same command in its MCP settings):
   ```sh
   claude mcp add macrokit -- macrokit mcp ./my-app
   ```
3. **Work normally.** The agent now has these tools:
   - **`list_macros`** — your project's workflow macros (name, intent, args);
   - **`run_macro`** — run one by name;
   - **each primitive in `primitives/`** as its own tool (`gh_list_issues`, `gh_list_pulls`, …) for the raw workflow when no macro fits.

   Every tool call is appended to `.macrokit/sessions/`.
4. **Encode what recurs.** When the agent does a workflow with no macro — three or more raw primitive calls in a row — flag it:
   ```sh
   macrokit gate ./my-app/.macrokit/sessions --macros ./my-app/macros
   ```
   It names the un-encoded sequence and suggests a macro stub. Write it with `defineMacro`; next time the agent (or a weak local model via the runtime) routes to that macro instead of re-deriving the steps.

That loop — **agent calls tools → session recorded → `macrokit gate` flags un-encoded work → you encode a macro** — is the whole public flow.

> **Scope (honest):** this is the minimal **record + run + gate** server. It does **not** auto-distill macros on recurrence — that's the separate Macrokit Studio IDE. `macrokit mcp` uses this public server by default; it prefers a richer private Studio server only when `MACROKIT_STUDIO_DIR` is set or `@macrokit-studio/preview` is installed.

## Docs

- **[`docs/THE_PATTERN.md`](docs/THE_PATTERN.md)** — the pattern, the theorem, the distillation gate, the public/private boundary. Start here.
- **[`docs/AUTHORING_PITFALLS.md`](docs/AUTHORING_PITFALLS.md)** — the seven ways an encoded macro silently rots against a real surface (values frozen at record time, invalid emitted artifacts, non-idempotent UI steps, oversized transfers, global timeouts, fabricated success, stale reference data) and the authoring rule that closes each.
- **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — the SDK's component layout and the runtime loop in detail.
- **[`docs/BENCHMARK.md`](docs/BENCHMARK.md)** — the launch benchmark: methodology, two-run story, honest analysis of misses, and why we don't run frontier rows ourselves.
- **[`docs/WHY_IT_WORKS.md`](docs/WHY_IT_WORKS.md)** — *optional.* The theoretical account of why the pattern produces value (value per joule), citing the *A Mathematical Theory of Value* preprint. Not needed to use Macrokit.
- **Quickstart** — `macrokit init my-app --vertical github`, then run it against a local model (see [60-second hello world](#60-second-hello-world) above and [`examples/`](examples/)).
- **[macrokit.dev](https://macrokit.dev)** — the project site and how-it-works walkthrough.

## Status

Live and open. Apache 2.0, on `main`, running today. Install it, scaffold a project, point it at a local model.

The pattern Macrokit codifies has been running in a private production deployment since early 2026 (an operations tool for users without frontier-API access). Macrokit is the vertical-agnostic extraction of that work into a reusable SDK.

The [benchmark](docs/BENCHMARK.md) exercises the SDK on a public maintainer-agent corpus (100 tasks, temperature 0). Off-the-shelf **local** models clear the bar:

| Local model | Params | Score | Bail-outs |
|---|---|---:|---:|
| Qwen 2.5 1.5B (Ollama) | 1.5B | 74.0% | 0 |
| Qwen 2.5 3B (Ollama) | 3B | 79.3% | 0 |
| Qwen 2.5 7B (Ollama) | 7B | 82.3% | 0 |
| Llama 3.1 8B (Ollama) | 8B | 82.5% | 5 |
| Qwen 2.5 7B Q4_K_M (production reference) | 7B | **94.5%** | 0 |

No frontier rows — [that's deliberate](docs/BENCHMARK.md#why-no-frontier-models-in-our-published-numbers). Raw runs for every model are in [`bench/runs/`](bench/runs/), and the doc also publishes the one model that *flunks* (Mistral 7B v0.3, 14% — the bail-out detector caught it narrating tool calls instead of making them) so you can see the bar isn't rigged.

Two reference implementations ship in [`examples/`](examples/) — `github-maintainer` and `paper-triage` — so the pattern is demonstrable, not just describable. We don't publish dated roadmaps; we ship to `main` and say what's actually running.

## License

Apache 2.0. See [`LICENSE`](LICENSE).

The patent grant matters in enterprise contexts; that is the reason for Apache over MIT.

## Contributing

There are two contribution paths, with different rules.

**Publishing your own macros for a vertical.** This is the path most contributors want. Macrokit deliberately keeps `core/examples/` small (curated reference implementations); vertical macro libraries live as standalone npm packages you publish yourself, and get discovered via the community registry and the `macrokit-macros` GitHub topic. See [`CONTRIBUTING_MACROS.md`](CONTRIBUTING_MACROS.md) for the naming convention, minimum requirements, and how to get listed. The `macrokit lint --pkg <path>` command checks your package against the conformance bar before you open a registry PR.

The registry is the seed of a broader ecosystem we intend to grow: a place to share and discover the vertical macro libraries authors build, so adopting a new vertical can start from proven macros instead of a cold start. If that direction interests you as an early author, say hello via [@macrokitdev](https://x.com/macrokitdev).

**SDK-internal contributions** (changes to `@macrokit/runtime`, `@macrokit/llm`, `@macrokit/browser`, `@macrokit/authoring`, `@macrokit/reference-data`, `@macrokit/cli`) currently go through issues and discussion on this repo's tracker rather than direct PRs, while the API surface settles. Open an issue first and we'll talk.

If you are building under the constraints Macrokit is designed for and want to be a design partner, contact via [macrokit.dev](https://macrokit.dev) or [@macrokitdev](https://x.com/macrokitdev) on X.
