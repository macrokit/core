import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";
import { GitHubClient } from "../github-client.js";
import { classify } from "../classifiers.js";

export const triageIssue = defineMacro({
  name: "triage_issue",
  capabilities: ["github"],
  intent:
    "Triage a GitHub issue: classify it (bug/feature/docs/chore), suggest " +
    "labels based on the title and body, and identify potential duplicates " +
    "via title-token overlap with other open issues.",
  schema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    number: z.number().int().positive(),
    apply: z.boolean().default(false),
  }),
  handler: async ({ owner, repo, number, apply }, ctx) => {
    const gh = (ctx.tools.github as GitHubClient) ?? new GitHubClient({ token: process.env.GITHUB_TOKEN ?? undefined });
    const issue = await gh.getIssue(owner, repo, number);
    const classification = classify({ title: issue.title, body: issue.body, labels: issue.labels });
    const suggested: string[] = [classification];
    if (issue.comments === 0) suggested.push("needs-response");
    for (const l of issue.labels) suggested.push(l.name);

    // Duplicate-detection: look at other open issues and rank by title-token overlap.
    const otherOpen = await gh.listOpenIssues(owner, repo, { max: 50 });
    const dupes = findDuplicateCandidates(issue, otherOpen);

    if (apply) {
      const toAdd = [...new Set(suggested)].filter(
        (l) => !issue.labels.some((x) => x.name === l),
      );
      if (toAdd.length > 0) await gh.addLabels(owner, repo, number, toAdd);
    }

    return {
      number,
      title: issue.title,
      classification,
      suggestedLabels: [...new Set(suggested)],
      potentialDuplicates: dupes,
      url: issue.html_url,
      applied: apply,
    };
  },
});

export function findDuplicateCandidates(
  target: { number: number; title: string },
  candidates: ReadonlyArray<{ number: number; title: string }>,
  opts: { topK?: number; minScore?: number } = {},
): Array<{ number: number; title: string; score: number }> {
  const topK = opts.topK ?? 3;
  const minScore = opts.minScore ?? 0.35;
  const targetTokens = tokenize(target.title);
  if (targetTokens.size === 0) return [];
  const scored: Array<{ number: number; title: string; score: number }> = [];
  for (const c of candidates) {
    if (c.number === target.number) continue;
    const ct = tokenize(c.title);
    if (ct.size === 0) continue;
    const score = jaccard(targetTokens, ct);
    if (score >= minScore) scored.push({ number: c.number, title: c.title, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "you", "are",
  "but", "not", "any", "all", "can", "into", "have", "has", "had",
  "use", "uses", "using", "when", "while", "then", "than", "also",
  "issue", "bug", "feature", "request", "support", "please",
]);

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}
