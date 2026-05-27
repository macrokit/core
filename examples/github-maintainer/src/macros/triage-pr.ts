import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";
import { GitHubClient } from "../github-client.js";
import { classify } from "../classifiers.js";

export const triagePullRequest = defineMacro({
  name: "triage_pull_request",
  intent:
    "Triage a GitHub pull request: classify it (bug/feature/docs/test/chore) " +
    "and suggest labels based on title and changed files.",
  schema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    number: z.number().int().positive(),
    apply: z.boolean().default(false).describe("If true, write suggested labels back to the PR."),
  }),
  handler: async ({ owner, repo, number, apply }, ctx) => {
    const gh = (ctx.tools.github as GitHubClient) ?? new GitHubClient({ token: process.env.GITHUB_TOKEN ?? undefined });
    const pr = await gh.getPullRequest(owner, repo, number);
    const files = await gh.getPullRequestFiles(owner, repo, number);
    const classification = classify({ title: pr.title, body: pr.body, files, labels: pr.labels });
    const suggested = suggestLabels(pr, files, classification);

    if (apply) {
      const newLabels = suggested.filter((l) => !pr.labels.some((x) => x.name === l));
      if (newLabels.length > 0) {
        await gh.addLabels(owner, repo, number, newLabels);
      }
    }

    return {
      number,
      title: pr.title,
      author: pr.user.login,
      classification,
      suggestedLabels: suggested,
      changedFiles: files.length,
      url: pr.html_url,
      applied: apply,
    };
  },
});

function suggestLabels(
  pr: { draft: boolean; labels: ReadonlyArray<{ name: string }> },
  files: ReadonlyArray<{ additions: number; deletions: number }>,
  classification: string,
): string[] {
  const labels = new Set<string>();
  labels.add(classification);
  if (pr.draft) labels.add("needs-review-when-ready");
  const total = files.reduce((n, f) => n + f.additions + f.deletions, 0);
  if (total > 500) labels.add("large-change");
  else if (total < 20) labels.add("small-change");
  for (const l of pr.labels) labels.add(l.name);
  return [...labels];
}
