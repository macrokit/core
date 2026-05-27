# github-maintainer — Macrokit reference implementation

A maintainer agent for GitHub repositories, built using **only** the public APIs of Macrokit. Lives inside the Macrokit monorepo and serves three purposes:

1. **Validates the SDK surface** — if anything here reaches past `@macrokit/runtime`, `@macrokit/llm`, `@macrokit/authoring`, `@macrokit/reference-data`, or `@macrokit/browser`, the abstraction is wrong.
2. **Demonstrates the pattern on a real third-party surface** — GitHub, the daily-driver tool for the launch audience.
3. **Provides the task corpus for the launch benchmark** — the macros here are what the Days 11–13 model comparison runs against.

This started life on Day 4 as a one-macro dogfood (`triage_pull_request`). Days 5–10 extends it into a six-macro maintainer agent across GitHub's REST API plus one browser-driven adjacent surface.

## What it does

A natural-language request from a maintainer routes to one of six deterministic macros. The weak/local LLM only classifies intent and extracts arguments — it never plans the workflow.

| Macro | What it does |
|---|---|
| `triage_pull_request(owner, repo, number, apply?)` | Classify a PR (bug / feature / docs / test / chore) using title prefix → keyword → file-shape; suggest size + status labels. With `apply: true`, writes labels back. |
| `triage_issue(owner, repo, number, apply?)` | Classify an issue, surface up to 3 likely duplicates by title-token Jaccard against other open issues, suggest labels. |
| `generate_release_notes(owner, repo, base, head, headingLevel?)` | Compare two refs, group commits by conventional-commit prefix, render a markdown changelog. |
| `close_stale_issues(owner, repo, minDaysOpen?, maxComments?, excludeLabels?, apply?, closingComment?)` | Find issues inactive past a threshold (default 90 days), excluding bug/security/pinned/good-first-issue. With `apply: true`, comments + closes. Dry-run by default. |
| `suggest_reviewers(owner, repo, number, max?)` | Match PR's changed files against the repo's CODEOWNERS, exclude the author, suggest up to N reviewers. |
| `capture_workflow_log(owner, repo, runId, maxChars?)` | **[Browser-driven]** Drive the GitHub Actions web UI via `@macrokit/browser` to capture the rendered text of a workflow run's logs. The API gives you a zip of raw text; this gives you the same view a human reads — step grouping, expansions, timing annotations. Opt in with `MACROKIT_BROWSER=playwright`. |

## Architecture

```
src/
├── github-client.ts       Tiny fetch()-based REST client; no third-party SDK.
├── classifiers.ts         Pure deterministic logic — classify, isStale,
│                          groupReleaseCommits, renderReleaseNotes,
│                          suggestReviewers, matchCodeownersPattern.
├── macros/                One macro per file; each is a thin handler that
│                          composes github-client + classifiers.
└── main.ts                Wires the registry, picks an LLM adapter, dispatches
                           one user turn.

refdata/label-taxonomy/    Signed reference-data bundle (manifest + labels.json).
                          Built with `pnpm refdata:build`. Loaded via
                          @macrokit/reference-data at runtime to keep the label
                          set out of source.

test/classifiers.test.ts   21 unit tests pinning the deterministic core.
```

**Design discipline carried through every macro:**

1. **No LLM call inside a handler.** Routing is the LLM's only job; the encoded workflow runs as plain TypeScript.
2. **Deterministic fallbacks beat learned classifiers.** Rules are auditable, fast, and adjustable per repo. A learned classifier would be slightly more accurate and dramatically less debuggable.
3. **`apply: false` by default for any mutating macro.** Staleness, label assignment, and issue closure all return the proposed action as data first. Adopters opt into actually doing it.
4. **One shared `GitHubClient` injected via `ctx.tools.github`.** Token + base URL configured in one place; macros stay testable by injecting a fake.

## Run it

```sh
# From the repo root: build all workspace packages
pnpm -r build

# Pick an LLM. Either Ollama locally (default):
ollama serve
ollama pull qwen2.5:7b-instruct

# … or any OpenAI-compatible provider:
export OPENAI_BASE_URL=https://api.openai.com/v1
export OPENAI_API_KEY=sk-...
export LLM_MODEL=gpt-4o-mini

# Optional but recommended: a PAT for higher rate limits
export GITHUB_TOKEN=$(gh auth token)

cd core/examples/github-maintainer
pnpm start "triage PR 5 in macrokit/core"
pnpm start "find stale issues older than 120 days in microsoft/vscode (dry run)"
pnpm start "generate release notes for macrokit/core from v0.0.1 to main"
pnpm start "suggest reviewers for PR 5 in some/repo"
```

## How a macro was authored — the canonical tutorial

This is the loop the launch docs will walk a reader through. Reproducing it here keeps the discipline honest in the working code.

### Step 1 — describe the workflow to a strong model

Working with Claude, the maintainer outlined `close_stale_issues` in plain prose:

> *"Find open issues that haven't been touched in 90+ days, have no more than 3 comments, and don't carry bug/security/pinned/good-first-issue labels. List them. If asked to apply, comment with a polite closing message and close them as not_planned."*

That outline is the encoded workflow. All multi-step reasoning happens here, at design-time, with the strong model present. The runtime LLM is never asked to plan this.

### Step 2 — pin the rules in pure functions

`src/classifiers.ts` holds `isStale()` — a 12-line pure function that takes an issue and a criteria object and returns boolean. Unit-testable in isolation. No API, no LLM, no side effects.

### Step 3 — write the handler

`src/macros/stale-issues.ts` is the outline turned into TypeScript: fetch → filter → optional apply. Eight lines of actual logic; the rest is schema, intent string, and structured return.

### Step 4 — register and wire

`src/main.ts` registers the macro on a `MacroRegistry`, instantiates a shared `GitHubClient`, builds a `Runtime`, calls `chat()`.

### Step 5 — pin the deterministic core in tests

`test/classifiers.test.ts` covers `isStale` across age, comment-count, and excluded-label branches. The test suite never calls the LLM and never calls GitHub — those are exercised at higher levels.

### Step 6 — let the distillation gate keep you honest

After a working session:

```sh
pnpm gate
```

Reads `.macrokit/sessions/*.jsonl` and flags any user turn that dispatched three or more distinct macros. If you composed `triage_pull_request → suggest_reviewers → close_stale_issues` in one breath, the gate suggests a `weekly_triage(repo)` composite. Encode the suggestion and re-run.

## Reference-data bundle

`refdata/label-taxonomy/` is a signed `@macrokit/reference-data` bundle: one `manifest.json` (ed25519-signed) and one `labels.json` describing the label set the triage macros are allowed to apply. Adopters can fork the bundle, change the labels, rebuild + sign, and the macros pick up the new set without code changes.

```sh
pnpm refdata:build  # regenerates manifest.json + emits a fresh keypair
```

The private key from `refdata:build` is intentionally not committed — for a real publisher, that key lives in a secrets manager and is used out of band. The public key embedded in the manifest is what consumers verify against.

## What's intentionally NOT here

- **No Octokit dependency.** A 200-line fetch-based REST client covers what we need. Adopters with deeper GitHub needs can swap Octokit in by replacing `github-client.ts`; the macros use the typed shapes, not Octokit's surface.
- **No LLM-driven classification.** The Days 11–13 benchmark compares the same `classify()` function across five model providers running through Macrokit's router. If the classifier itself used an LLM, the benchmark would be measuring two things at once.
- **No web-UI driving for actions GitHub exposes via API.** The browser-driven macro (`capture_workflow_log`) exists for a surface where the API is genuinely lacking, not as a generic "do it through the browser" demo.
