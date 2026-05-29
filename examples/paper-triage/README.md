# paper-triage — Macrokit reference implementation #2

An academic paper triage agent, built using only the public APIs of Macrokit. The second curated reference implementation alongside [`github-maintainer/`](../github-maintainer/).

Both examples share the same project shape — `src/api-client.ts` + `src/classifiers.ts` + `src/macros/*.ts` + `src/main.ts` — so adopters can compare them side-by-side and see what stays the same vs. what changes with the vertical. The pattern is the same; the surface is different.

## What it does

Given a natural-language request from a researcher / lit-review person, the weak/local LLM classifies intent and dispatches one of five macros. None of the macros call an LLM inside their handler — the encoded workflows are pure deterministic code driving public APIs.

| Macro | Surface | What it does |
|---|---|---|
| `triage_paper(paperId)` | Semantic Scholar | Fetch metadata; classify by primary subject (ML / CS / math / physics / bio / medicine / social-science / other); suggest reading-queue tags (`recent`, `well-cited`, `highly-cited`, `seminal-era`, `low-citation`, `influential`); return one-line summary + open-access PDF URL when known. |
| `compare_papers(paperIds[])` | Semantic Scholar (batch) | Fetch 2–10 papers in one call; return a comparison table (year, citations, primary subject, first author, OA status). Useful for shortlist decisions. |
| `find_related_papers(paperId, max?, query?)` | Semantic Scholar recommendations | Find papers related to a seed paper; optionally re-rank against a free-text query to focus on a specific subtopic. |
| `bibliography_lookup(query, max?)` | Semantic Scholar search | Free-text search; return BibTeX entries with stable citation keys (`lastname + year + first-significant-word`) for the top matches. |
| `check_open_access(paperId)` | OpenAlex (DOI) / Semantic Scholar (arXiv) | Return OA status (`closed` / `bronze` / `hybrid` / `green` / `gold` / `diamond`), best-available OA URL, license. Falls back to Semantic Scholar's `openAccessPdf` for arXiv-only IDs. |

## Why this vertical

The handoff lists academic paper triage as one of two reference verticals (alongside GitHub maintainer ops) chosen from domains outside the maintainers' own commercial verticals. It's structurally **different** from `github-maintainer/` in three useful ways:

1. **Mostly read-only.** GitHub macros write back (close issues, add labels); paper-triage macros only read. The deterministic-handler claim ("workflows are encoded, the LLM only routes") is the same; the failure mode profile is gentler.
2. **No auth required.** Public academic APIs accept anonymous reads. Adopters can run the example without account setup.
3. **Different rate-limit shape.** Semantic Scholar throttles aggressively on the anonymous tier; the example handles 429s by failing the handler cleanly — surfacing the structured error to the routing LLM, which then summarizes for the user.

If you're learning Macrokit, building this example yourself (or modifying it) teaches the same pattern as building `github-maintainer` from scratch, against a different surface.

## Architecture

```
src/
├── api-client.ts          Tiny fetch()-based clients for Semantic Scholar
│                          and OpenAlex. No SDK dependencies — the entire
│                          public surface needed is ~150 LOC.
├── classifiers.ts         Pure deterministic logic — classifyPaper,
│                          suggestTags, buildBibtex (with stable citation
│                          keys), rankByQuery, toComparisonRow. The
│                          deterministic core of every macro lives here.
├── macros/                One macro per file; thin handler composing
│                          api-client + classifiers.
└── main.ts                Wires the registry, instantiates shared
                           API clients, picks an LLM adapter, dispatches.

test/classifiers.test.ts   31 unit tests pinning the deterministic core.
                           No network. No LLM calls. Pure functions only.
```

**Design discipline carried through every macro** (same as `github-maintainer/`):

1. **No LLM call inside a handler.** Routing is the LLM's only job; the encoded workflow runs as plain TypeScript.
2. **Deterministic rules beat learned classifiers.** Rules are auditable, fast, and adjustable per project. A learned subject classifier would be slightly more accurate and dramatically less debuggable.
3. **API clients injected via `ctx.tools`.** The Semantic Scholar and OpenAlex clients are constructed once in `main.ts` and shared across macro invocations — token + base URL configured in one place; macros stay testable by injecting a fake.
4. **Errors flow back as structured `MacroError`s.** When a 404 / 429 / 5xx hits the handler, the dispatcher catches it and surfaces a typed error to the routing LLM. The LLM then summarizes for the user.

## Run it

```sh
# 1. From the repo root: build all workspace packages
pnpm -r build

# 2. Start an Ollama server with a tool-capable model (or skip if you use
#    an OpenAI-compatible provider):
ollama serve
ollama pull qwen2.5:7b-instruct

# 3. Run the example:
cd core/examples/paper-triage
pnpm start "triage paper 2401.12345"
pnpm start "compare 1706.03762 and 2005.14165"
pnpm start "find 5 papers related to 1706.03762 about training stability"
pnpm start "look up 3 papers about retrieval-augmented generation"
pnpm start "is 10.1145/3372297.3417883 open access?"
```

Optional environment variables:

```sh
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini

SEMANTIC_SCHOLAR_API_KEY=...   # raises S2 rate limits; not required for basic use
OPENALEX_CONTACT_EMAIL=you@example.com   # puts you in OpenAlex's "polite pool"
```

## What it does NOT do

- **No PDF parsing.** Macrokit's paper-triage example only consumes the open metadata APIs (S2, OpenAlex). Adopters who want abstract-based summarization or full-text content can extend the handlers — but the LLM still shouldn't be in the inner loop. Fetch the PDF, extract text deterministically, feed the result back to the router.
- **No paid databases.** No Web of Science, Scopus, Dimensions integration. The example exists to demonstrate the pattern on freely-accessible academic infrastructure.
- **No citation graph traversal.** `find_related_papers` uses S2's recommendations endpoint (which already incorporates citation signal); the example does not implement BFS over the citation graph itself. That'd be a useful follow-up macro for an adopter to build.

## License

Apache 2.0. Same as the rest of the project.
