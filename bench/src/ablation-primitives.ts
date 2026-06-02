import { defineMacro, type AuthoredMacro } from "@macrokit/authoring";
import { MacroRegistry } from "@macrokit/runtime";
import { z } from "zod";

/**
 * MACRO-OFF condition (see MACRO_ABLATION_PREREGISTRATION.md). The low-level
 * GitHub primitives the six workflow macros are composed from, exposed with
 * purely MECHANICAL descriptions — no encoded workflow shape, no intent. In
 * this condition the model must reason the workflow from scratch and compose
 * these itself; we decode the trajectory back to an intent label via
 * `classifyTrajectory` (the frozen rule from the pre-registration).
 *
 * Handlers return minimal stub data so the multi-step router loop can proceed
 * (the ablation scores the routing/planning decision, not handler correctness —
 * identical to the macro-ON harness, which also never runs real handlers).
 */
const repo = { owner: z.string(), repo: z.string() };

function prim(
  name: string,
  description: string,
  shape: z.ZodRawShape,
  result: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): AuthoredMacro<any, any> {
  return defineMacro({
    name,
    intent: description,
    category: "utility",
    schema: z.object(shape),
    handler: async () => result,
  });
}

export const ABLATION_PRIMITIVES: ReadonlyArray<AuthoredMacro<unknown, unknown>> = [
  prim("gh_get_pull", "Fetch one pull request's fields: title, body, author, base/head refs, file/line counts.", { ...repo, number: z.number().int() }, { number: 1, title: "stub", user: "octocat", additions: 1, deletions: 0, changedFiles: 1 }),
  prim("gh_get_pull_files", "List the files changed in a pull request, with per-file status and line counts.", { ...repo, number: z.number().int() }, [{ filename: "src/x.ts", status: "modified", additions: 1, deletions: 0 }]),
  prim("gh_get_issue", "Fetch one issue's fields: title, body, author, labels, comment count, timestamps.", { ...repo, number: z.number().int() }, { number: 1, title: "stub", labels: [], comments: 0 }),
  prim("gh_list_open_issues", "List open issues in a repository (number, title, labels, updated_at).", { ...repo }, [{ number: 1, title: "stub", labels: [], updated_at: "2026-01-01T00:00:00Z" }]),
  prim("gh_get_issue_comments", "List the comments on one issue.", { ...repo, number: z.number().int() }, [{ user: "octocat", body: "stub" }]),
  prim("gh_compare_commits", "Compare two refs and return the commit list between them (sha, message, author).", { ...repo, base: z.string(), head: z.string() }, [{ sha: "abc", message: "feat: stub", author: "octocat" }]),
  prim("gh_get_codeowners", "Fetch and parse the repository's CODEOWNERS file into (pattern, owners) entries.", { ...repo }, [{ pattern: "*", owners: ["@octocat"] }]),
  prim("gh_add_labels", "Add labels to an issue or pull request.", { ...repo, number: z.number().int(), labels: z.array(z.string()) }, { ok: true }),
  prim("gh_close_issue", "Close an issue, optionally with a reason.", { ...repo, number: z.number().int(), reason: z.string().optional() }, { ok: true }),
  prim("gh_comment_on_issue", "Post a comment on an issue or pull request.", { ...repo, number: z.number().int(), body: z.string() }, { ok: true }),
  prim("gh_get_actions_run_log", "Fetch the rendered log text of a GitHub Actions workflow run.", { ...repo, runId: z.number().int().optional() }, { log: "stub log" }),
];

export function buildPrimitiveRegistry(): MacroRegistry {
  const reg = new MacroRegistry();
  for (const p of ABLATION_PRIMITIVES) reg.register(p);
  return reg;
}

/**
 * The FROZEN decode rule (MACRO_ABLATION_PREREGISTRATION.md §2): map the SET of
 * primitive ops the model called, in priority order (first match wins), to one
 * intent in the shared 7-class label space.
 */
export function classifyTrajectory(toolsCalled: ReadonlyArray<string>): string {
  const s = new Set(toolsCalled);
  if (s.has("gh_get_actions_run_log")) return "capture_workflow_log";
  if (s.has("gh_compare_commits")) return "generate_release_notes";
  if (s.has("gh_get_codeowners")) return "suggest_reviewers";
  if (s.has("gh_close_issue") || s.has("gh_comment_on_issue")) return "close_stale_issues";
  if (s.has("gh_get_pull") || s.has("gh_get_pull_files")) return "triage_pull_request";
  if (s.has("gh_get_issue") || s.has("gh_list_open_issues") || s.has("gh_get_issue_comments")) return "triage_issue";
  return "no_macro";
}

export const MACRO_OFF_SYSTEM_EXTRA = [
  "There is NO pre-built workflow or high-level action available — only the low-level GitHub",
  "primitives listed above. To handle the user's request, decide which primitive operations are",
  "needed and call them (you may call several in sequence). Operate only on the repository named",
  "in the request. Any labelling or closing is a primitive call; do not assume a one-shot macro exists.",
].join("\n");
