import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";
import { GitHubClient } from "../github-client.js";
import { isStale } from "../classifiers.js";

export const closeStaleIssues = defineMacro({
  name: "close_stale_issues",
  intent:
    "Find open GitHub issues that have been inactive past a threshold and " +
    "close them with a polite comment. Skips issues labeled bug, security, " +
    "pinned, or good first issue. Returns a dry-run list by default.",
  schema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    minDaysOpen: z.number().int().positive().default(90),
    maxComments: z.number().int().nonnegative().default(3),
    excludeLabels: z.array(z.string()).default(["bug", "security", "pinned", "good first issue"]),
    apply: z.boolean().default(false).describe("If true, actually close + comment. Otherwise dry-run."),
    closingComment: z
      .string()
      .default(
        "This issue has been inactive for a while. Closing as stale — please " +
          "reopen if it's still relevant. Thanks for the report.",
      ),
    max: z.number().int().positive().default(200),
  }),
  handler: async (
    { owner, repo, minDaysOpen, maxComments, excludeLabels, apply, closingComment, max },
    ctx,
  ) => {
    const gh = (ctx.tools.github as GitHubClient) ?? new GitHubClient({ token: process.env.GITHUB_TOKEN ?? undefined });
    const open = await gh.listOpenIssues(owner, repo, { max });
    const stale = open.filter((i) =>
      isStale(i, { minDaysOpen, maxComments, excludeLabels }),
    );

    const closed: Array<{ number: number; title: string; url: string }> = [];
    if (apply) {
      for (const i of stale) {
        await gh.commentOnIssue(owner, repo, i.number, closingComment);
        await gh.closeIssue(owner, repo, i.number, "not_planned");
        closed.push({ number: i.number, title: i.title, url: i.html_url });
      }
    }

    return {
      considered: open.length,
      staleCount: stale.length,
      stale: stale.map((i) => ({ number: i.number, title: i.title, url: i.html_url })),
      applied: apply,
      closed,
    };
  },
});
