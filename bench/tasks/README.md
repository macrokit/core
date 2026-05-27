# Task corpus

Pre-registered, frozen at commit time. Editing files in this directory after a benchmark run constitutes p-hacking; don't.

| File | Bucket | Count |
|---|---|---|
| `01-triage-pull-request.jsonl` | `triage_pull_request` | 15 |
| `02-triage-issue.jsonl` | `triage_issue` | 15 |
| `03-release-notes.jsonl` | `generate_release_notes` | 12 |
| `04-stale-issues.jsonl` | `close_stale_issues` | 12 |
| `05-suggest-reviewers.jsonl` | `suggest_reviewers` | 12 |
| `06-capture-workflow-log.jsonl` | `capture_workflow_log` | 8 |
| `07-no-macro.jsonl` | `no_macro` | 11 |
| `08-ambiguous.jsonl` | `ambiguous_multi_intent` | 15 |
| **Total** | | **100** |

Difficulty distribution within buckets is documented inline in each task's `difficulty` field. The mix targets roughly: 35% `easy_direct`, 35% `medium_paraphrase`, 20% `hard_implicit`, 10% `hard_distractor` — but exact counts vary per bucket because some buckets (`no_macro`, `ambiguous_multi_intent`) are entirely distractor-flavored by construction.

See `../methodology.md` for the full pre-registration document, scoring rubric, and reproducibility info.
