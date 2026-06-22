import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";
import { GitHubClient } from "../github-client.js";
import { suggestReviewers } from "../classifiers.js";

export const suggestReviewersMacro = defineMacro({
  name: "suggest_reviewers",
  capabilities: ["github"],
  intent:
    "Suggest reviewers for a GitHub PR by combining CODEOWNERS matches with " +
    "the PR's changed files. Excludes the PR author.",
  schema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    number: z.number().int().positive(),
    max: z.number().int().min(1).max(10).default(3),
  }),
  handler: async ({ owner, repo, number, max }, ctx) => {
    const gh =
      (ctx.tools.github as GitHubClient) ??
      new GitHubClient({ token: process.env.GITHUB_TOKEN ?? undefined });
    const [pr, files, codeowners] = await Promise.all([
      gh.getPullRequest(owner, repo, number),
      gh.getPullRequestFiles(owner, repo, number),
      gh.getCodeowners(owner, repo),
    ]);
    const reviewers = suggestReviewers({
      files,
      codeowners,
      exclude: [pr.user.login],
      max,
    });
    return {
      number,
      author: pr.user.login,
      changedFiles: files.length,
      codeownersFound: codeowners.length > 0,
      suggestedReviewers: reviewers,
      url: pr.html_url,
    };
  },
});
