# @macrokit/cli

Command-line tools for Macrokit projects. Ships four subcommands:

```sh
npx @macrokit/cli --help

# or, after `pnpm install @macrokit/cli` (or npm/yarn equivalent):
macrokit --help
```

See the full project at [macrokit.dev](https://macrokit.dev) and the SDK pattern essay at [`docs/THE_PATTERN.md`](https://github.com/macrokit/core/blob/main/docs/THE_PATTERN.md).

## `macrokit init <name>`

Scaffolds a new Macrokit project: `package.json`, `tsconfig.json`, one trivial macro, a `Runtime` wired up, a session-log directory.

```sh
macrokit init my-project --provider ollama
cd my-project
npm install
npm start
```

Flags:

- `--dir <path>` — target directory (default: `./<name>`).
- `--provider <ollama|openai-compatible>` — model adapter to wire into the starter (default: `ollama`).
- `--force` — overwrite files if they exist.

## `macrokit lint [<path>]`

Static checks on a project's macro source files. Defaults to `./src`.

Rules:

- `macro_name_invalid` — `defineMacro` names must match `/^[a-z][a-z0-9_]*$/`.
- `intent_empty` — `defineMacro` must have a non-empty `intent` string (the router classifies against it).
- `handler_recurses_into_chat` — handlers that call `runtime.chat()` are almost always a sign the macro should have been split.

Exits 1 on any finding (CI-friendly).

### `macrokit lint --pkg <path>`

Same binary, different mode: validate a **standalone community macro package** against the structural bar in [`CONTRIBUTING_MACROS.md`](https://github.com/macrokit/core/blob/main/CONTRIBUTING_MACROS.md). Used by registry-PR reviewers and by adopters self-checking before opening a listing PR.

Four checks, each with a stable rule code:

| Rule | Catches |
|---|---|
| `pkg_no_peer_dep_authoring` | `@macrokit/authoring` not declared as a `peerDependency` (double-loading the registry breaks dispatch silently). |
| `pkg_no_readme` | No `README.md` at the package root. |
| `pkg_no_macro_export` | No `.ts`/`.tsx` source contains a `defineMacro({…})` with all four required fields (`name`, `intent`, `schema`, `handler`). |
| `pkg_no_tests` | No `*.test.ts(x)` or `*.fixtures.json` files under the package. |

All checks are static-only — no `npm install`, no code execution, no trust placed on arbitrary npm payloads.

```sh
macrokit lint --pkg ./path/to/your/macro-package
```

Exits 0 if all checks pass, 1 on any failure, 2 if the path doesn't exist.

## `macrokit gate [<path>] [--threshold N] [--json]`

The **distillation gate** — the cultural contribution of Macrokit, in CLI form. Reads `.macrokit/sessions/*.jsonl` (the session logs the runtime writes) and flags any user turn that dispatched **three or more distinct macros** in a row. Each such sequence is a candidate for being a single composite macro that should have been encoded before the session ended.

```sh
macrokit gate                # reads .macrokit/sessions/ by default
macrokit gate --threshold 4  # raise the bar
macrokit gate --json         # machine-readable output
```

For each violation, the gate prints:

- The session path and turn index.
- The sequence of macros that were composed.
- A suggested name and a ready-to-edit `defineMacro({…})` stub.

Exits 1 on any violation — wire it into your CI to enforce the discipline mechanically.

Pattern reference: [`THE_PATTERN.md` §5](https://github.com/macrokit/core/blob/main/docs/THE_PATTERN.md).

## `macrokit refdata <sync|verify|pin>`

Reference-data bundle lifecycle — fetches, verifies, and pins versioned (and optionally ed25519-signed) reference-data bundles defined by your project. See [`@macrokit/reference-data`](https://github.com/macrokit/core/tree/main/packages/reference-data) for the bundle format.

## License

Apache-2.0. See the [project license](https://github.com/macrokit/core/blob/main/LICENSE).

## See also

- [macrokit.dev](https://macrokit.dev) — landing page, benchmark headline.
- [`docs/THE_PATTERN.md`](https://github.com/macrokit/core/blob/main/docs/THE_PATTERN.md) — the pattern essay.
- [`docs/BENCHMARK.md`](https://github.com/macrokit/core/blob/main/docs/BENCHMARK.md) — pre-registered benchmark methodology.
- [`CONTRIBUTING_MACROS.md`](https://github.com/macrokit/core/blob/main/CONTRIBUTING_MACROS.md) — publishing your own community macro package.
