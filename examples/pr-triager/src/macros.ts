import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";

/**
 * The dogfood demo macro: triage a GitHub pull request.
 *
 * Self-contained — uses fetch() against api.github.com, applies a
 * deterministic classifier, returns a structured result. The LLM only
 * decides "user asked me to triage a PR → call triage_pull_request" and
 * extracts {owner, repo, number} from the request.
 *
 * Design choices worth noting:
 *
 * 1. **The classifier is deterministic.** No LLM call inside the handler.
 *    The whole point of the pattern is to encode workflows so weak models
 *    only have to route — pushing the LLM back into the handler would
 *    undo that.
 *
 * 2. **Rules over training.** The classifier is a small set of file-path
 *    and title-prefix rules. They're transparent, testable, and easy to
 *    adjust per project. A learned classifier would be slightly more
 *    accurate and dramatically less debuggable.
 *
 * 3. **No GitHub auth required for public repos.** Anonymous api.github.com
 *    calls work up to 60 req/hour. The `GITHUB_TOKEN` env var, if set,
 *    bumps that to 5000.
 */
export const triagePullRequest = defineMacro({
  name: "triage_pull_request",
  intent:
    "Triage a GitHub pull request: classify it (bug/feature/docs/test/chore) " +
    "and suggest labels based on title and changed files.",
  schema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    number: z.number().int().positive(),
  }),
  handler: async ({ owner, repo, number }) => {
    const pr = await fetchPullRequest(owner, repo, number);
    const files = await fetchPullRequestFiles(owner, repo, number);
    const classification = classify(pr, files);
    return {
      number,
      title: pr.title,
      author: pr.user.login,
      classification,
      suggestedLabels: suggestLabels(pr, files, classification),
      changedFiles: files.length,
      url: pr.html_url,
    };
  },
});

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  user: { login: string };
  html_url: string;
  labels: Array<{ name: string }>;
  draft: boolean;
}

interface PullRequestFile {
  filename: string;
  additions: number;
  deletions: number;
  status: string;
}

async function fetchPullRequest(
  owner: string,
  repo: string,
  number: number,
): Promise<PullRequest> {
  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
    headers: githubHeaders(),
  });
  if (!r.ok) {
    throw new Error(
      `GitHub returned ${r.status} fetching ${owner}/${repo}#${number}: ${await safeText(r)}`,
    );
  }
  return (await r.json()) as PullRequest;
}

async function fetchPullRequestFiles(
  owner: string,
  repo: string,
  number: number,
): Promise<PullRequestFile[]> {
  const r = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`,
    { headers: githubHeaders() },
  );
  if (!r.ok) {
    throw new Error(
      `GitHub returned ${r.status} fetching files for ${owner}/${repo}#${number}: ${await safeText(r)}`,
    );
  }
  return (await r.json()) as PullRequestFile[];
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "macrokit-pr-triager",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

async function safeText(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return "<unreadable>";
  }
}

// ---------------------------------------------------------------------------
// Classifier (the encoded "workflow")
// ---------------------------------------------------------------------------

export type Classification = "bug" | "feature" | "docs" | "test" | "chore";

export function classify(
  pr: { title: string; body: string | null },
  files: ReadonlyArray<{ filename: string }>,
): Classification {
  const title = pr.title.toLowerCase();
  const titlePrefix = title.match(/^(fix|feat|docs?|test|chore|refactor|ci|build|perf)(\(|:)/);

  if (titlePrefix) {
    const p = titlePrefix[1]!;
    if (p === "fix") return "bug";
    if (p === "feat") return "feature";
    if (p === "doc" || p === "docs") return "docs";
    if (p === "test") return "test";
    if (p === "chore" || p === "refactor" || p === "ci" || p === "build" || p === "perf") {
      return "chore";
    }
  }

  if (title.match(/\b(fix|bug|broken|regress|crash|error|fail)/)) return "bug";
  if (title.match(/\b(add|introduce|implement|support)\b/)) return "feature";

  // Fall back to file-shape signal
  const buckets: Record<Classification, number> = { bug: 0, feature: 0, docs: 0, test: 0, chore: 0 };
  for (const f of files) {
    const fn = f.filename.toLowerCase();
    if (fn.endsWith(".md") || fn.startsWith("docs/") || fn === "readme") buckets.docs += 1;
    else if (fn.match(/\.(test|spec)\.[jt]sx?$/) || fn.includes("/test/") || fn.includes("/__tests__/")) {
      buckets.test += 1;
    } else if (
      fn.startsWith(".github/") ||
      fn.startsWith("ci/") ||
      fn === "package-lock.json" ||
      fn === "pnpm-lock.yaml" ||
      fn === "yarn.lock"
    ) {
      buckets.chore += 1;
    } else {
      buckets.feature += 1; // catch-all: assume code change is a feature/refactor
    }
  }
  const ranked = Object.entries(buckets).sort((a, b) => b[1] - a[1]);
  return (ranked[0]?.[0] as Classification) ?? "chore";
}

function suggestLabels(
  pr: PullRequest,
  files: ReadonlyArray<PullRequestFile>,
  classification: Classification,
): string[] {
  const labels = new Set<string>();
  labels.add(classification);
  if (pr.draft) labels.add("needs-review-when-ready");
  const total = files.reduce((n, f) => n + f.additions + f.deletions, 0);
  if (total > 500) labels.add("large-change");
  else if (total < 20) labels.add("small-change");
  // Preserve any already-applied labels so triage doesn't churn.
  for (const l of pr.labels) labels.add(l.name);
  return [...labels];
}
