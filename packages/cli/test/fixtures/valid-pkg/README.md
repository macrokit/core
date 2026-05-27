# macrokit-macros-paper-triage (fixture)

Fixture package used by `@macrokit/cli` tests to verify that `macrokit lint --pkg` passes against a conformant community macro package.

**Vertical:** academic paper triage (illustrative — this fixture does not perform any network calls).

**Macros exported:**

- `triage_paper(paperId)` — summarize and classify a paper by its ID.

**Surfaces driven:** none at runtime — this is a fixture. A real paper-triage package would drive `arxiv.org`, `api.semanticscholar.org`, etc.

**Credential requirements:** none.

**Installation:**

```sh
npm install macrokit-macros-paper-triage @macrokit/authoring zod
```

This is a fixture used by the Macrokit CLI test suite. Do not publish it.
