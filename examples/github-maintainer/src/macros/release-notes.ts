import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";
import { GitHubClient } from "../github-client.js";
import { groupReleaseCommits, renderReleaseNotes } from "../classifiers.js";

export const generateReleaseNotes = defineMacro({
  name: "generate_release_notes",
  capabilities: ["github"],
  intent:
    "Generate release notes for a GitHub repo by comparing two refs (tags, " +
    "branches, or commit SHAs). Commits are grouped by conventional-commit " +
    "prefix and rendered as a markdown changelog.",
  schema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    base: z.string().min(1).describe("Older ref — tag, branch, or SHA."),
    head: z.string().min(1).describe("Newer ref — tag, branch, or SHA."),
    headingLevel: z.number().int().min(1).max(6).default(2),
  }),
  handler: async ({ owner, repo, base, head, headingLevel }, ctx) => {
    const gh = (ctx.tools.github as GitHubClient) ?? new GitHubClient({ token: process.env.GITHUB_TOKEN ?? undefined });
    const commits = await gh.compareCommits(owner, repo, base, head);
    const sections = groupReleaseCommits(commits);
    const markdown = renderReleaseNotes(sections, { headingLevel });
    return {
      base,
      head,
      commitCount: commits.length,
      sectionCount: sections.length,
      markdown,
    };
  },
});
