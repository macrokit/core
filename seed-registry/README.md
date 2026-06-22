# Macrokit seed registry

The **seed library** — the three public reference verticals packaged as
installable Macrokit packs. This is a *personal/local* registry (a plain,
git-backed directory), produced by dogfooding the Phase-4
`pack` → `publish` → `install` flow on real content.

## Layout

```
seed-registry/
├── index.json                       name → [versions]
└── packs/
    ├── macrokit-example__github-maintainer/1.0.0.mkpack.json
    ├── macrokit-example__paper-triage/1.0.0.mkpack.json
    └── macrokit-example__hr-recruiting/1.0.0.mkpack.json
```

Each `.mkpack.json` is a single self-describing, **source-available** artifact:
a manifest (name, version, macros, declared `capabilities`, integrity hash) plus
the verbatim source of every file. Versions are immutable per `(name, version)`.

## The packs

| Pack | Version | Macros | Capabilities |
|---|---|---|---|
| `@macrokit-example/github-maintainer` | 1.0.0 | 6 | `browser`, `github` |
| `@macrokit-example/paper-triage` | 1.0.0 | 5 | `openAlex`, `semanticScholar` |
| `@macrokit-example/hr-recruiting` | 1.0.0 | 6 | `ats` |

## Install one

```sh
# from a fresh project directory
macrokit install @macrokit-example/hr-recruiting --registry <path-to>/seed-registry
```

`install` displays the pack's declared capabilities for approval **before** any
source is vendored (D-017 trust-before-install), then writes readable source
under `.macrokit/packs/<name>/<version>/` and records `macrokit.lock.json` for
reproducible installs.

## Reproduce

```sh
cd core
node packages/cli/dist/cli.js pack examples/<vertical> --out /tmp/<v>.mkpack.json
node packages/cli/dist/cli.js publish /tmp/<v>.mkpack.json --registry seed-registry
```

The pack step runs `lint --pkg` (structural conformance) + the leakage scan and
refuses on either. The full round-trip (pack → publish → install → macros run
against fixtures) is pinned by
`packages/cli/test/reference-library-roundtrip.test.ts`.
