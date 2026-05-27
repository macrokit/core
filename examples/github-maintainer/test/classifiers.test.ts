import { describe, it, expect } from "vitest";
import {
  classify,
  groupReleaseCommits,
  isStale,
  matchCodeownersPattern,
  renderReleaseNotes,
  suggestReviewers,
} from "../src/classifiers.js";
import { findDuplicateCandidates } from "../src/macros/triage-issue.js";
import { parseCodeowners } from "../src/github-client.js";

const f = (filename: string) => ({ filename });

describe("classify", () => {
  it("honors conventional-commit title prefixes", () => {
    expect(classify({ title: "fix: divide by zero", body: null })).toBe("bug");
    expect(classify({ title: "feat(api): add v2 endpoint", body: null })).toBe("feature");
    expect(classify({ title: "docs: clarify quickstart", body: null })).toBe("docs");
    expect(classify({ title: "test: cover edge case", body: null })).toBe("test");
    expect(classify({ title: "chore(deps): bump zod", body: null })).toBe("chore");
    expect(classify({ title: "security: harden parser", body: null })).toBe("bug");
  });

  it("falls back to keyword signals", () => {
    expect(classify({ title: "Crash on empty registry", body: null })).toBe("bug");
    expect(classify({ title: "Add Ollama adapter", body: null })).toBe("feature");
  });

  it("uses file shape when the title is uninformative", () => {
    expect(
      classify({ title: "Update wording", body: null, files: [f("docs/quickstart.md")] }),
    ).toBe("docs");
    expect(
      classify({
        title: "more coverage",
        body: null,
        files: [f("packages/runtime/test/x.test.ts")],
      }),
    ).toBe("test");
    expect(
      classify({
        title: "bump",
        body: null,
        files: [f(".github/workflows/ci.yml"), f("pnpm-lock.yaml")],
      }),
    ).toBe("chore");
  });

  it("uses body heuristics when there are no files (issues)", () => {
    expect(
      classify({
        title: "Page errors out",
        body: "Steps to reproduce:\n1. Open settings\nExpected: ok\nActual: error",
      }),
    ).toBe("bug");
    expect(
      classify({
        title: "Want dark mode",
        body: "Feature request: I'd like a dark mode toggle in settings.",
      }),
    ).toBe("feature");
  });

  it("returns chore as a conservative default", () => {
    expect(classify({ title: "...", body: null })).toBe("chore");
  });
});

describe("isStale", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  const open = (overrides: Partial<Parameters<typeof isStale>[0]> = {}) => ({
    updated_at: "2026-01-01T00:00:00Z",
    comments: 0,
    labels: [] as Array<{ name: string }>,
    ...overrides,
  });

  it("flags an inactive issue with no comments and no excluded labels", () => {
    expect(isStale(open(), { now, minDaysOpen: 90 })).toBe(true);
  });

  it("does not flag an active issue", () => {
    expect(isStale(open({ updated_at: "2026-05-25T00:00:00Z" }), { now })).toBe(false);
  });

  it("does not flag a highly-discussed issue even if old", () => {
    expect(isStale(open({ comments: 50 }), { now, maxComments: 3 })).toBe(false);
  });

  it("respects excludeLabels", () => {
    expect(isStale(open({ labels: [{ name: "Bug" }] }), { now })).toBe(false);
    expect(isStale(open({ labels: [{ name: "Pinned" }] }), { now })).toBe(false);
    expect(isStale(open({ labels: [{ name: "good first issue" }] }), { now })).toBe(false);
  });
});

describe("groupReleaseCommits + renderReleaseNotes", () => {
  const commits = [
    { sha: "aaaaaaa", commit: { message: "feat(api): add v2 endpoint", author: { name: "alice" } } },
    { sha: "bbbbbbb", commit: { message: "fix: divide by zero", author: { name: "bob" } } },
    { sha: "ccccccc", commit: { message: "docs: clarify quickstart", author: { name: "carol" } } },
    { sha: "ddddddd", commit: { message: "refactor internals", author: { name: "dan" } } },
  ];

  it("groups commits by conventional-commit prefix in stable order", () => {
    const sections = groupReleaseCommits(commits);
    expect(sections.map((s) => s.heading)).toEqual([
      "Features",
      "Bug fixes",
      "Docs",
      "Other changes",
    ]);
  });

  it("renders markdown with the configured heading level", () => {
    const md = renderReleaseNotes(groupReleaseCommits(commits), { headingLevel: 3 });
    expect(md).toMatch(/^### Features/m);
    expect(md).toContain("add v2 endpoint (aaaaaaa, @alice)");
    expect(md).toContain("divide by zero (bbbbbbb, @bob)");
  });

  it("emits an empty marker on no commits", () => {
    expect(renderReleaseNotes([])).toContain("No release-worthy changes");
  });
});

describe("findDuplicateCandidates", () => {
  it("returns higher-overlap titles first and applies minScore", () => {
    const target = { number: 100, title: "Browser screenshot crashes on Safari" };
    const dupes = findDuplicateCandidates(
      target,
      [
        { number: 99, title: "Safari screenshot crashes" }, // strong overlap
        { number: 98, title: "Add Linux build instructions" }, // no overlap
        { number: 97, title: "screenshot bug in Safari browser" }, // strong overlap
        { number: 96, title: "Random unrelated title" }, // no overlap
      ],
      { topK: 5, minScore: 0.2 },
    );
    expect(dupes.map((d) => d.number)).toEqual([99, 97]);
    expect(dupes[0]!.score).toBeGreaterThanOrEqual(dupes[1]!.score);
  });

  it("excludes the target issue itself", () => {
    const dupes = findDuplicateCandidates(
      { number: 100, title: "Safari screenshot crashes" },
      [{ number: 100, title: "Safari screenshot crashes" }],
    );
    expect(dupes).toEqual([]);
  });
});

describe("matchCodeownersPattern", () => {
  it("matches *.ext patterns", () => {
    expect(matchCodeownersPattern("*.ts", "src/foo.ts")).toBe(true);
    expect(matchCodeownersPattern("*.ts", "src/foo.js")).toBe(false);
  });
  it("matches directory patterns", () => {
    expect(matchCodeownersPattern("docs/", "docs/quickstart.md")).toBe(true);
    expect(matchCodeownersPattern("docs/**", "docs/nested/file.md")).toBe(true);
    expect(matchCodeownersPattern("docs/", "src/foo.ts")).toBe(false);
  });
  it("matches absolute paths from repo root", () => {
    expect(matchCodeownersPattern("/README.md", "README.md")).toBe(true);
    expect(matchCodeownersPattern("/README.md", "docs/README.md")).toBe(false);
  });
});

describe("suggestReviewers", () => {
  it("ranks CODEOWNERS matches highest", () => {
    const reviewers = suggestReviewers({
      files: [{ filename: "src/router.ts" }, { filename: "docs/x.md" }],
      codeowners: [
        { pattern: "*.ts", owners: ["alice"] },
        { pattern: "docs/", owners: ["bob"] },
      ],
    });
    expect(reviewers).toContain("alice");
    expect(reviewers).toContain("bob");
  });

  it("excludes the PR author", () => {
    const reviewers = suggestReviewers({
      files: [{ filename: "src/router.ts" }],
      codeowners: [{ pattern: "*.ts", owners: ["alice", "bob"] }],
      exclude: ["alice"],
    });
    expect(reviewers).not.toContain("alice");
    expect(reviewers).toContain("bob");
  });

  it("applies the max cap", () => {
    const reviewers = suggestReviewers({
      files: [{ filename: "src/router.ts" }],
      codeowners: [{ pattern: "*.ts", owners: ["a", "b", "c", "d", "e"] }],
      max: 2,
    });
    expect(reviewers).toHaveLength(2);
  });
});

describe("parseCodeowners", () => {
  it("parses a simple CODEOWNERS file, ignoring comments + blank lines", () => {
    const parsed = parseCodeowners(`
# global default
*       @owner-a
# docs
docs/   @docs-owner @owner-b
src/runtime/*.ts @runtime-team
    `);
    expect(parsed).toEqual([
      { pattern: "*", owners: ["owner-a"] },
      { pattern: "docs/", owners: ["docs-owner", "owner-b"] },
      { pattern: "src/runtime/*.ts", owners: ["runtime-team"] },
    ]);
  });
});
