# Contributing macros to the Macrokit ecosystem

This document is for people who want to **publish reusable macro libraries** for a vertical and have them discoverable by other Macrokit adopters.

If you want to contribute to the SDK itself (`@macrokit/runtime`, `@macrokit/llm`, etc.), that's a different document — see `CONTRIBUTING.md` (TODO).

## The two-tier model

Macrokit deliberately separates curated reference implementations from community macro packages.

| Tier | Where | Cadence | Curated by | Examples |
|---|---|---|---|---|
| **Official examples** | `core/examples/<name>/` in this repo | Reviewed PRs | Macrokit maintainers | The GitHub maintainer agent (`examples/github-maintainer/`). |
| **Community packages** | Standalone npm packages, your own repo | Whatever pace you want | You | A library you publish that ships macros for *your* vertical. |

The split is intentional. Curated examples teach the pattern; community packages let the ecosystem expand without the bottleneck of a single repo's review queue. Both are first-class — the registry lists community packages alongside the official examples, and lint/gate work the same against both.

## Why publish a community package instead of upstreaming?

Upstream into `core/examples/` when:

- Your vertical is genuinely general-interest (HR/recruiting, academic paper triage, GitHub maintainer tasks) AND
- The macros do not depend on private credentials, brand lists, or proprietary scoring rules AND
- You're willing to maintain it under the project's review standards.

Publish as a community package when:

- Your vertical is narrow or domain-specific (your company's internal admin tool, your team's CI/CD operations, your industry's compliance flows).
- The macros encode workflow choices your organization made — wrong defaults for someone else's deployment.
- You want versioning and release cadence independent of Macrokit's.
- You don't want your code reviewed by maintainers who don't know your domain.

The vast majority of useful macro work belongs in community packages, not in `core/examples/`. We curate examples to teach the pattern, not to host every vertical.

## Naming convention

Community packages SHOULD be published as:

- `macrokit-macros-<vertical>` (unscoped), e.g. `macrokit-macros-paper-triage`, `macrokit-macros-github-maintainer`, `macrokit-macros-rfp-intake`.
- `@<scope>/macrokit-macros-<vertical>` (scoped), e.g. `@acme/macrokit-macros-internal-tools`.

The literal substring `macrokit-macros-` makes packages findable by registry search and signals to readers that the package follows the conventions in this document. The `<vertical>` segment is whatever you'd call the surface or workflow group; pick something specific.

Reserve `@macrokit/macros-*` and `@macrokit-example/*` for official maintainer use; community packages should not publish under those scopes.

## Minimum requirements for a valid macro package

A package qualifies as a "Macrokit macro package" if all of the following hold. `macrokit lint --pkg <path>` checks each automatically.

### Exports

The package MUST export one or more values produced by `defineMacro()` from `@macrokit/authoring`. Each macro MUST have all four required fields:

```ts
import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";

export const triagePaper = defineMacro({
  name: "triage_paper",                                  // required: stable identifier
  intent: "summarize and classify an arXiv paper by id", // required: natural-language description for the router
  schema: z.object({ paperId: z.string() }),             // required: typed argument schema
  handler: async ({ paperId }, ctx) => { /* ... */ },    // required: deterministic workflow
});
```

Names must match `/^[a-z][a-z0-9_]*$/` (lowercase, digits, underscores; starts with a letter). The intent string is what the router matches user requests against — it must be descriptive, not a placeholder.

### Tests

Every macro MUST have at least one test fixture. Either:

- A `.test.ts` (or `.test.tsx`) file that imports `testMacro` from `@macrokit/authoring` and exercises the handler against recorded `(args, expected)` pairs, OR
- A `.fixtures.json` file alongside the macro source with the same shape.

The tests don't need to call the LLM — that's the runtime's job. They pin the *workflow*, which is the part that changes.

### README.md

The package root MUST contain a `README.md` covering:

1. **Vertical name and one-line scope.** "Macros for triaging academic preprints across arXiv, Semantic Scholar, and OpenAlex."
2. **Macro list.** Bullet list of `name` and `intent` for each exported macro. Copy-pasted from `defineMacro` is fine — the schema lives in the code.
3. **Surface(s) driven.** Which app, API, or service does the workflow touch? Include base URLs where applicable.
4. **Credential requirements.** If the macros need an API key, document the env var name and link to where users obtain the key. Do **not** ship credentials in the package.
5. **Installation snippet.** `npm install your-package @macrokit/authoring`.

### Peer dependency

`@macrokit/authoring` MUST be declared as a `peerDependency`, NOT a regular dependency:

```jsonc
{
  "name": "macrokit-macros-paper-triage",
  "peerDependencies": {
    "@macrokit/authoring": "^0.1.0",
    "zod": "^3.23.0"
  }
}
```

This prevents npm-tree duplication when the consumer already has `@macrokit/authoring`. Bundling it would mean two `defineMacro` symbols in memory, two schema validators, two registries — silent dispatch failures.

The same applies to `zod` (or your schema library of choice): peer dep, never bundled.

### No telemetry, no phone-home, no hardcoded credentials

A macro handler that calls home to your servers — even for "anonymous usage stats" — turns every downstream adopter's deployment into a data leak. The pattern Macrokit exists to enable is *local, private, audit-friendly* execution. Phoning home defeats that.

- Do NOT include any default outbound HTTP call to a domain you control.
- Do NOT include hardcoded API keys, tokens, OAuth secrets, or service-account JSON. Read them from `process.env` and document the env var names in your README.
- Do NOT include analytics SDKs, error trackers that auto-init, or any "init-on-import" side effects.

Macros are libraries. Libraries don't open sockets on import.

## How the distillation gate applies to community packages

The single most important Macrokit discipline — "every session that touches a workflow without a macro must encode it as a macro before ending" — applies to community packages too, recursively.

If your package ships ten macros and an adopter's session log shows them invoking three of yours in a row to build a higher-order workflow, the gate flags it. The right response is to ship a composite macro in the next release. Macro libraries that compound are the goal; tool graveyards are the failure mode.

If you find yourself shipping a release every time someone hits the gate, that's healthy — that's exactly the cadence the discipline produces. If you find yourself shipping new utility primitives ("read_file", "fetch", "run_bash") instead of domain macros, push back on the adopter's instinct to compose at runtime.

## How to get listed in the community registry

The registry lives at `github.com/macrokit/.github/community/registry.json`.

To get your package listed:

1. Verify your package passes `macrokit lint --pkg <path>` — every check green.
2. Ship at least **five benchmark tasks** as part of your repo. A benchmark task is a `(prompt, expected_tool_call, expected_args)` triple matching the format in [the Macrokit launch benchmark](https://github.com/macrokit/core/blob/main/docs/BENCHMARK.md). Five is a minimum; more is better. Tasks let adopters run the harness against your macros with their model of choice.
3. Have a README that meets the minimums above.
4. License the package under **Apache 2.0** (preferred) or **MIT**. We do not list packages under copyleft, source-available, or non-commercial licenses — the ecosystem optics matter, and Macrokit itself is Apache 2.0.
5. Open a PR against `github.com/macrokit/.github` adding an entry to `community/registry.json`. The entry shape and example are documented at `community/README.md` in that repo.

Maintainers review listing PRs for: package name follows convention, package is installable from npm, the lint command passes, the README meets the minimum, and a quick smell-check that the macros don't ship credentials or telemetry. Approval is intended to be fast — usually within a few days. Listing does not imply endorsement of the workflows themselves, only that the package meets the structural bar.

If your package is rejected, the rejection comes with the specific failed check; fix and re-open.

## Discoverability — the `macrokit-macros` GitHub topic

In addition to the registry, tag your repo with the GitHub topic **`macrokit-macros`**. The topic is the soft-discovery channel: searching `topic:macrokit-macros` on github.com finds packages whether or not they're in the registry.

If your package is registry-listed, the topic is redundant but harmless. If it's not (yet), the topic still gets you found by Macrokit-curious developers browsing the topic page.

## What not to include

The following are explicit anti-requests for community packages.

- **No ecommerce reference impls.** This is the same constraint Macrokit's own examples follow. Healthcare and legal are also generally off-limits as canonical reference impls — compliance gravity makes them a poor learning surface for a public ecosystem.
- **No mock LLMs in handlers.** If your macro needs an LLM in the inner loop (rare; usually means the workflow should be encoded differently), pull the adapter from `ctx.tools.llm`, don't construct one. Stubbing one inside the handler hides where the dependency lives.
- **No browser launches in module top-level.** Browser-driven macros should import `BrowserService` as a type and read the service from `ctx.tools.browser`. Launching Chromium at import time turns a casual `import` into a multi-hundred-megabyte download.
- **No global registry mutation.** Don't import `MacroRegistry` and side-effect-register your macros at module load. Export the macros as values; let the adopter compose them into their own registry.

## Submitting

When your package is ready:

1. Publish to npm.
2. Tag the repo with the `macrokit-macros` topic on GitHub.
3. Open a PR against `github.com/macrokit/.github` adding the registry entry (see the registry README for the exact schema).

The registry PR is the only required step for ecosystem visibility. Everything else is your own release process.

## Questions

Issues and discussion: `github.com/macrokit/core/issues` (use the `community` label).
