# pr-triager — dogfood demo

A tiny GitHub PR triager built using **only** the public APIs of Macrokit. Lives inside the Macrokit monorepo as a sanity check on the SDK's surface: if anything here reaches past `@macrokit/runtime`, `@macrokit/llm`, or `@macrokit/authoring`, the abstraction is wrong and the SDK needs work.

## What it does

Given a natural-language request like *"triage PR 123 in microsoft/vscode"*:

1. The weak/local LLM (Ollama qwen2.5 7B by default) classifies the intent and dispatches the `triage_pull_request` macro with extracted arguments.
2. The macro's handler runs deterministically:
   - Fetches the PR via the GitHub REST API (`/pulls/:n` + `/pulls/:n/files`).
   - Classifies it as **bug** / **feature** / **docs** / **test** / **chore** using title prefixes, keyword signals, and changed-file shape.
   - Returns suggested labels (size + classification + preserved existing labels).
3. The LLM gets the structured result back, summarizes it for the user in plain English.

No LLM call inside the handler. The classifier is rule-based: transparent, fast, and unit-tested.

## Run it

```sh
# 1. From the repo root:
pnpm -r build

# 2. In another shell, an Ollama server with a tool-capable model:
ollama serve
ollama pull qwen2.5:7b-instruct

# 3. Run the demo:
cd core/examples/pr-triager
pnpm start "triage PR 123 in macrokit/core"
```

You can also point at OpenAI / DeepSeek / Qwen / OpenRouter / any OpenAI-compatible endpoint via env:

```sh
OPENAI_BASE_URL=https://api.openai.com/v1 \
OPENAI_API_KEY=sk-... \
LLM_MODEL=gpt-4o-mini \
pnpm start "triage PR 5 in macrokit/website"
```

Set `GITHUB_TOKEN` to lift the unauthenticated 60 req/hour rate limit:

```sh
GITHUB_TOKEN=$(gh auth token) pnpm start "triage PR 1 in some/repo"
```

## How it was built — the authoring process

A reference for how to author macros with Macrokit. Same loop the launch tutorial will walk a reader through.

### Step 1 — describe the workflow to a strong model

I worked with Claude to outline what "triage a PR" means in concrete steps:

> Given (owner, repo, number): fetch the PR JSON; fetch the changed-files list; classify by title prefix (conventional commits), then keyword fallback, then file shape; emit suggested labels.

That outline is the encoded workflow. **All multi-step reasoning happens here, at design-time, with the strong model.** At runtime the weak model never thinks about any of these steps — it just decides "user wants triage → call this one tool."

### Step 2 — write the handler

The handler (`src/macros.ts`) is the outline turned into TypeScript: three function calls, no LLM in the loop. Stable, fast, debuggable.

```ts
export const triagePullRequest = defineMacro({
  name: "triage_pull_request",
  intent: "Triage a GitHub pull request: classify ...",
  schema: z.object({ owner: z.string(), repo: z.string(), number: z.number().int().positive() }),
  handler: async ({ owner, repo, number }) => { /* fetch + classify + label */ },
});
```

### Step 3 — register and wire the runtime

`src/main.ts`: build the runtime with the macro registered, point it at an LLM, call `chat()`.

That's the whole authoring loop. Strong model + developer at design-time encode the macro. Weak model at runtime only routes.

### Step 4 — test the deterministic core

`test/classify.test.ts` covers the classifier across the title-prefix and file-shape branches. No mocking of the LLM, no GitHub-API mocking — these tests pin the *workflow*, which is the only piece that needs locking down. The LLM-driven routing is exercised at higher levels.

### Step 5 — let the distillation gate keep you honest

After a session of running the demo, run:

```sh
pnpm gate
```

This invokes `macrokit gate` against the project's session log. If you found yourself composing several utility macros to do what one domain macro should handle, the gate flags it with a suggested name and stub. Encode the suggested macro and re-run.

## Why it stays this small

The dogfood demo's job is to verify the SDK is usable, not to be impressive. Adding a second macro at this stage would either:

1. Demonstrate composition (which `@macrokit/runtime` doesn't need help proving — composition is a future-author concern), or
2. Add scope that distracts from the "did one full loop work end-to-end" question.

The Days 5–10 reference implementation will be a substantive multi-macro maintainer agent. This one stays small on purpose.
