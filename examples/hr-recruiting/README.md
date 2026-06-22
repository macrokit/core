# hr-recruiting — Macrokit reference implementation

A **recruiter/employer-side** HR agent, built using **only** the public APIs of Macrokit. The third reference vertical alongside [`github-maintainer`](../github-maintainer) and [`paper-triage`](../paper-triage), it serves the same three purposes:

1. **Validates the SDK surface** — if anything here reaches past `@macrokit/runtime`, `@macrokit/llm`, or `@macrokit/authoring`, the abstraction is wrong.
2. **Demonstrates the pattern in a third domain** — HR/recruiting, with the safety posture a hiring workflow demands.
3. **Adds a third domain to the routing benchmark** — its macros join github + paper in the multi-macro routing test (~16 macros, 3 domains).

> **Recruiter side, not candidate side.** This is the employer's workflow — screen, rank, schedule, reach out. It is deliberately the *opposite role* from any candidate-side job-application flow, and shares no code or data with one.

> **Synthetic data only.** Every requisition, candidate, resume, reference, and email in [`src/fixtures/dataset.ts`](src/fixtures/dataset.ts) is invented for documentation/testing. No real people, no real PII. Emails use the reserved `example.test` domain so nothing is deliverable. The ATS/HRIS surface is a **fixtured, in-memory** client — no real vendor, no live calls.

## What it does

A natural-language request from a recruiter routes to one of six deterministic macros. The weak/local LLM only classifies intent and extracts arguments — it never plans the workflow.

| Macro | Capability | What it does |
|---|---|---|
| `parse_requisition(requisitionId? \| text?)` | `ats` | Parse a requisition into structured fields — level, min years, remote flag, must-have vs nice-to-have skills. Read-only. |
| `screen_resume(candidateId, requisitionId?)` | `ats` | Screen **one** candidate against **one** requisition: fit score, matched/missing must-haves, experience + location checks, advance/maybe/reject. Read-only. |
| `rank_candidates(requisitionId, candidateIds?, top?)` | `ats` | Rank a **pool** of candidates best-fit first. Read-only shortlist building. |
| `draft_candidate_outreach(candidateId, requisitionId?, tone?, send?)` | `ats` | Draft a personalized outreach message. **Dry-run by default** (`send=false`). |
| `schedule_interview(candidateId, interviewers, proposedSlots, …, send?)` | `ats` | Assemble an interview invite. **Dry-run by default** (`send=false`). |
| `check_references_dryrun(candidateId, requisitionId?, send?)` | `ats` | Prepare reference-check requests. **Dry-run by default** (`send=false`) — contacts no one unless told to. |

### Safety: consequential actions default to dry-run

The three macros that can reach the outside world (sending a message, booking an interview, contacting references) all gate the mutation behind an explicit `send: false` default. A bare request **previews** the action and returns it for human approval; the mutation fires only when the user explicitly says to send. This carries the routing study's finding that a weak model will otherwise happily default a destructive flag on — so the *default* is off, by construction, not by the model's judgment.

## Architecture

```
src/
├── primitives/
│   └── ats-client.ts   Generic ATS/HRIS interface + InMemoryAtsClient (fixtured,
│                        records mutations; NOT a real vendor). Swap for your own.
├── fixtures/
│   └── dataset.ts      SYNTHETIC requisitions + candidates (no real PII).
├── scoring.ts          Pure deterministic logic — scoreResumeFit, rankCandidates,
│                        parseRequisitionText, draftOutreach, builders.
├── macros/             Six macros via defineMacro; each declares capabilities: ["ats"].
└── main.ts             Wires registry + fixtured ats surface + LLM + Runtime.
```

The macros are thin: fetch fixtured data via the `ats` surface, call into `scoring.ts`, and (for the consequential ones) decide whether to commit based on `send`. All the encoded judgment lives in `scoring.ts`, which is what the tests pin down.

## Run it

```sh
pnpm --filter @macrokit-example/hr-recruiting start "rank the candidates for REQ-1001, top 3"
pnpm --filter @macrokit-example/hr-recruiting start "draft outreach to CAND-2002 for REQ-1001"   # previews only
pnpm --filter @macrokit-example/hr-recruiting test
```

Needs Ollama (`qwen2.5:7b-instruct`) by default, or set `OPENAI_BASE_URL` for an OpenAI-compatible provider. The tests need neither — they run the macros directly against the fixtured ATS.
