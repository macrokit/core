/**
 * Pure, deterministic classifiers used by the triage macros. The whole
 * point of the Macrokit pattern is that the encoded workflows are
 * transparent and testable; these functions are why those properties hold
 * for this reference impl.
 */

export type Classification = "bug" | "feature" | "docs" | "test" | "chore";

export interface ClassifyInput {
  title: string;
  body: string | null;
  files?: ReadonlyArray<{ filename: string }>;
  /** Existing labels — preserved + occasionally informative. */
  labels?: ReadonlyArray<{ name: string }>;
}

/**
 * Classify a PR or an issue. Three signals in priority order:
 *   1. Conventional-commit title prefix: fix:/feat:/docs:/test:/chore:/refactor:/ci:/build:/perf:
 *   2. Keyword signal in the title.
 *   3. File-shape signal from changed files (PRs only).
 *
 * Returns the highest-weight bucket. Falls back to "chore" when none of the
 * signals fire — a conservative default that doesn't pretend to know.
 */
export function classify(input: ClassifyInput): Classification {
  const title = input.title.toLowerCase();
  const titlePrefix = title.match(
    /^(fix|feat|docs?|test|chore|refactor|ci|build|perf|security)(\(|:)/,
  );

  if (titlePrefix) {
    const p = titlePrefix[1]!;
    if (p === "fix" || p === "security") return "bug";
    if (p === "feat") return "feature";
    if (p === "doc" || p === "docs") return "docs";
    if (p === "test") return "test";
    if (p === "chore" || p === "refactor" || p === "ci" || p === "build" || p === "perf") {
      return "chore";
    }
  }

  if (title.match(/\b(fix|bug|broken|regress|crash|error|fail|vulnerab(le|ility))/)) {
    return "bug";
  }
  if (title.match(/\b(add|introduce|implement|support)\b/)) return "feature";

  const files = input.files ?? [];
  if (files.length === 0) return inferFromBody(input.body) ?? "chore";

  const buckets: Record<Classification, number> = {
    bug: 0,
    feature: 0,
    docs: 0,
    test: 0,
    chore: 0,
  };
  for (const f of files) {
    const fn = f.filename.toLowerCase();
    if (fn.endsWith(".md") || fn.startsWith("docs/") || fn === "readme") buckets.docs += 1;
    else if (
      fn.match(/\.(test|spec)\.[jt]sx?$/) ||
      fn.includes("/test/") ||
      fn.includes("/__tests__/")
    ) {
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
      buckets.feature += 1; // catch-all: assume non-test/docs/ci code is a feature/refactor
    }
  }
  const ranked = Object.entries(buckets).sort((a, b) => b[1] - a[1]);
  return (ranked[0]?.[0] as Classification) ?? "chore";
}

function inferFromBody(body: string | null): Classification | undefined {
  if (!body) return undefined;
  const b = body.toLowerCase();
  if (b.match(/\b(steps to reproduce|reproduction|expected|actual|stack trace|traceback)\b/)) {
    return "bug";
  }
  if (b.match(/\b(feature request|i'?d like|would be nice|proposal)\b/)) return "feature";
  return undefined;
}

/**
 * Decide whether an issue is "stale" for the close_stale_issues macro.
 * Two criteria, ALL must hold:
 *   - Open for at least `minDaysOpen` since updated_at
 *   - Comment count <= `maxComments` (active discussions are not stale)
 *   - No label in `excludeLabels` is applied (default: bug, security, pinned)
 */
export interface StaleCriteria {
  minDaysOpen?: number;
  maxComments?: number;
  excludeLabels?: ReadonlyArray<string>;
  now?: Date; // for tests
}

export function isStale(
  issue: { updated_at: string; comments: number; labels: ReadonlyArray<{ name: string }> },
  c: StaleCriteria = {},
): boolean {
  const minDays = c.minDaysOpen ?? 90;
  const maxComments = c.maxComments ?? 3;
  const exclude = new Set(
    (c.excludeLabels ?? ["bug", "security", "pinned", "good first issue"]).map((s) => s.toLowerCase()),
  );
  const now = c.now ?? new Date();

  const ageDays = (now.getTime() - Date.parse(issue.updated_at)) / 86_400_000;
  if (ageDays < minDays) return false;
  if (issue.comments > maxComments) return false;
  for (const l of issue.labels) {
    if (exclude.has(l.name.toLowerCase())) return false;
  }
  return true;
}

/**
 * Group commits into release-note sections by conventional-commit prefix.
 * Returns headings in a deterministic order; commits without a recognized
 * prefix go under "Other changes".
 */
export interface GroupedCommit {
  sha: string;
  summary: string;
  author: string;
}

export interface ReleaseSection {
  heading: string;
  commits: GroupedCommit[];
}

const HEADINGS: ReadonlyArray<{ key: string; heading: string; match: RegExp }> = [
  { key: "feat", heading: "Features", match: /^feat(\([^)]+\))?:/i },
  { key: "fix", heading: "Bug fixes", match: /^fix(\([^)]+\))?:/i },
  { key: "perf", heading: "Performance", match: /^perf(\([^)]+\))?:/i },
  { key: "security", heading: "Security", match: /^security(\([^)]+\))?:/i },
  { key: "docs", heading: "Docs", match: /^docs?(\([^)]+\))?:/i },
  { key: "refactor", heading: "Refactoring", match: /^refactor(\([^)]+\))?:/i },
  { key: "test", heading: "Tests", match: /^test(\([^)]+\))?:/i },
  { key: "build", heading: "Build / CI", match: /^(build|ci)(\([^)]+\))?:/i },
  { key: "chore", heading: "Chore", match: /^chore(\([^)]+\))?:/i },
];

export function groupReleaseCommits(
  commits: ReadonlyArray<{
    sha: string;
    commit: { message: string; author: { name: string } };
  }>,
): ReleaseSection[] {
  const sections = new Map<string, ReleaseSection>();
  const ensure = (key: string, heading: string): ReleaseSection => {
    let s = sections.get(key);
    if (!s) {
      s = { heading, commits: [] };
      sections.set(key, s);
    }
    return s;
  };
  for (const c of commits) {
    const summary = (c.commit.message.split("\n")[0] ?? "").trim();
    if (!summary) continue;
    const match = HEADINGS.find((h) => h.match.test(summary));
    const key = match?.key ?? "other";
    const heading = match?.heading ?? "Other changes";
    ensure(key, heading).commits.push({
      sha: c.sha.slice(0, 7),
      summary: summary.replace(/^[a-z]+(\([^)]+\))?:\s*/i, ""),
      author: c.commit.author.name,
    });
  }
  // Emit in HEADINGS order, then Other last.
  const out: ReleaseSection[] = [];
  for (const h of HEADINGS) {
    const s = sections.get(h.key);
    if (s) out.push(s);
  }
  const other = sections.get("other");
  if (other) out.push(other);
  return out;
}

export function renderReleaseNotes(
  sections: ReadonlyArray<ReleaseSection>,
  opts: { headingLevel?: number } = {},
): string {
  if (sections.length === 0) return "_No release-worthy changes._";
  const h = "#".repeat(opts.headingLevel ?? 2);
  const out: string[] = [];
  for (const s of sections) {
    out.push(`${h} ${s.heading}`, "");
    for (const c of s.commits) {
      out.push(`- ${c.summary} (${c.sha}, @${c.author})`);
    }
    out.push("");
  }
  return out.join("\n").trim() + "\n";
}

/**
 * Suggest reviewers for a PR by combining CODEOWNERS matches with file-touch
 * history (passed in by caller — keeps this function pure). The caller decides
 * how aggressively to assign.
 */
export interface SuggestReviewersInput {
  files: ReadonlyArray<{ filename: string }>;
  codeowners: ReadonlyArray<{ pattern: string; owners: ReadonlyArray<string> }>;
  /** Exclude e.g. the PR author. */
  exclude?: ReadonlyArray<string>;
  /** Optional file-touch history: { filename → top-2 contributors }. */
  blameTops?: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Hard cap on suggested reviewers. Default 3. */
  max?: number;
}

export function suggestReviewers(input: SuggestReviewersInput): string[] {
  const score = new Map<string, number>();
  const bump = (user: string, by: number): void => {
    score.set(user, (score.get(user) ?? 0) + by);
  };

  // CODEOWNERS: each pattern match contributes 10 per owner.
  for (const file of input.files) {
    for (const co of input.codeowners) {
      if (matchCodeownersPattern(co.pattern, file.filename)) {
        for (const o of co.owners) bump(o, 10);
      }
    }
  }
  // Blame history: top contributors per file contribute 1 each.
  if (input.blameTops) {
    for (const file of input.files) {
      const tops = input.blameTops.get(file.filename) ?? [];
      for (const u of tops) bump(u, 1);
    }
  }
  const exclude = new Set((input.exclude ?? []).map((s) => s.toLowerCase()));
  const ranked = [...score.entries()]
    .filter(([u]) => !exclude.has(u.toLowerCase()))
    .sort((a, b) => b[1] - a[1])
    .map(([u]) => u);
  return ranked.slice(0, input.max ?? 3);
}

/**
 * Minimal CODEOWNERS pattern matcher. Supports:
 *   *.ts  → any .ts file in the repo
 *   docs/* → anything in docs/ (one level)
 *   docs/** or docs/ → anything under docs/
 *   /absolute/path → exact match from repo root
 * Real CODEOWNERS is gitignore-flavored; this is good enough for the
 * reference impl. Adopters with complex ownership should swap a fuller
 * matcher in.
 */
export function matchCodeownersPattern(pattern: string, filename: string): boolean {
  const file = filename.toLowerCase();
  const p = pattern.toLowerCase();
  if (p === "*") return true;
  if (p.endsWith("/") || p.endsWith("/**")) {
    const prefix = p.replace(/\/?\*\*$/, "").replace(/\/$/, "");
    return file === prefix || file.startsWith(`${prefix}/`);
  }
  if (p.startsWith("*.")) {
    return file.endsWith(p.slice(1));
  }
  if (p.startsWith("/")) {
    return file === p.slice(1);
  }
  if (p.includes("/")) {
    return file === p || file.startsWith(`${p}/`);
  }
  return file === p || file.endsWith(`/${p}`);
}
