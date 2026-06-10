import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeSession,
  extractUserTurns,
  findSessionLogs,
  loadSessionLog,
  type SessionLogEntry,
} from "../src/gate.js";

// Convenience builders
const t = (overrides: Partial<SessionLogEntry> & { type: SessionLogEntry["type"] }): SessionLogEntry => ({
  ts: "2026-05-27T00:00:00Z",
  ...overrides,
});

const userTurn = (
  text: string,
  toolCalls: Array<{ tool: string; args: unknown }>,
  reply = "ok",
): SessionLogEntry[] => [
  t({ type: "user", text }),
  ...toolCalls.flatMap((tc) => [
    t({ type: "tool_call", ...tc }),
    t({ type: "tool_result", tool: tc.tool, ok: true }),
  ]),
  t({ type: "assistant", text: reply }),
];

describe("extractUserTurns", () => {
  it("splits a log into user turns and counts tool calls per turn", () => {
    const entries = [
      ...userTurn("triage paper 2401.123", [{ tool: "fetch_meta", args: { id: "2401.123" } }]),
      ...userTurn("now classify it", [{ tool: "classify", args: { id: "2401.123" } }]),
    ];
    const turns = extractUserTurns(entries);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.toolCalls.map((c) => c.name)).toEqual(["fetch_meta"]);
    expect(turns[1]?.toolCalls.map((c) => c.name)).toEqual(["classify"]);
  });

  it("handles a hanging turn (no final assistant entry)", () => {
    const entries = userTurn("incomplete", [{ tool: "x", args: {} }]).slice(0, -1);
    const turns = extractUserTurns(entries);
    expect(turns).toHaveLength(1);
  });
});

describe("analyzeSession (the distillation gate)", () => {
  it("flags a turn that dispatches >= 3 distinct macros", () => {
    const entries = userTurn("triage all open issues for user 42", [
      { tool: "fetch_user_profile", args: { id: 42 } },
      { tool: "list_open_issues", args: { id: 42 } },
      { tool: "label_issues", args: { ids: [1, 2, 3], label: "needs-triage" } },
      { tool: "notify_assignees", args: { ids: [1, 2, 3] } },
    ]);
    const violations = analyzeSession("/tmp/s.jsonl", entries);
    expect(violations).toHaveLength(1);
    const v = violations[0]!;
    expect(v.toolCalls).toHaveLength(4);
    expect(v.suggestion.name).toBeTruthy();
    expect(v.suggestion.stub).toContain("defineMacro");
    expect(v.suggestion.stub).toContain("fetch_user_profile");
    expect(v.suggestion.stub).toContain("notify_assignees");
  });

  it("does not flag a turn with one macro call (the normal case)", () => {
    const entries = userTurn("triage 2401.123", [
      { tool: "triage_arxiv_paper", args: { paperId: "2401.123" } },
    ]);
    expect(analyzeSession("/tmp/s.jsonl", entries)).toEqual([]);
  });

  it("does not flag a tight loop of the same macro (different concern)", () => {
    const entries = userTurn("retry retry retry", [
      { tool: "fetch", args: { url: "https://x.example" } },
      { tool: "fetch", args: { url: "https://x.example" } },
      { tool: "fetch", args: { url: "https://x.example" } },
    ]);
    // Same name+args three times collapses to 1 distinct call.
    expect(analyzeSession("/tmp/s.jsonl", entries)).toEqual([]);
  });

  it("flags only the offending turn, not adjacent clean turns", () => {
    const entries = [
      ...userTurn("hi", [{ tool: "greet", args: {} }]),
      ...userTurn("do the big thing", [
        { tool: "a", args: { x: 1 } },
        { tool: "b", args: { x: 1 } },
        { tool: "c", args: { x: 1 } },
      ]),
      ...userTurn("ok thanks", []),
    ];
    const vs = analyzeSession("/tmp/s.jsonl", entries);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.turnIndex).toBe(2);
  });

  it("honors a custom threshold", () => {
    const entries = userTurn("two-step", [
      { tool: "step_one", args: {} },
      { tool: "step_two", args: {} },
    ]);
    expect(analyzeSession("/tmp/s.jsonl", entries, { threshold: 2 })).toHaveLength(1);
    expect(analyzeSession("/tmp/s.jsonl", entries, { threshold: 3 })).toHaveLength(0);
  });

  it("downweights utility macros when picking the suggested name", () => {
    const entries = userTurn("publish the release notes for v1.2.0", [
      { tool: "bash", args: { cmd: "git tag" } },
      { tool: "read_file", args: { path: "CHANGELOG.md" } },
      { tool: "publish_release_notes", args: { version: "v1.2.0" } },
    ]);
    const vs = analyzeSession("/tmp/s.jsonl", entries, {
      categoryOf: (n) =>
        n === "bash" || n === "read_file" ? "utility" : "domain",
    });
    expect(vs).toHaveLength(1);
    // Either we derived "publish_release" from user text, or fell back to the
    // domain-only composite ("composite_publish_release_notes").
    expect(vs[0]?.suggestion.name).toMatch(/release|publish/);
  });
});

describe("loadSessionLog + findSessionLogs", () => {
  it("round-trips JSONL even with a malformed trailing line", () => {
    const dir = mkdtempSync(join(tmpdir(), "macrokit-gate-"));
    const path = join(dir, "session.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ ts: "x", type: "user", text: "hi" }),
        JSON.stringify({ ts: "x", type: "assistant", text: "hi back" }),
        "{ partial-write-died-mid", // malformed — must be skipped silently
      ].join("\n") + "\n",
    );
    const entries = loadSessionLog(path);
    expect(entries).toHaveLength(2);
  });

  it("finds .jsonl files recursively", () => {
    const dir = mkdtempSync(join(tmpdir(), "macrokit-gate-walk-"));
    const sub = join(dir, "nested");
    require("node:fs").mkdirSync(sub, { recursive: true });
    writeFileSync(join(dir, "a.jsonl"), "");
    writeFileSync(join(sub, "b.jsonl"), "");
    writeFileSync(join(dir, "skip.txt"), "");
    const found = findSessionLogs(dir);
    expect(found.map((p) => p.split("/").slice(-2).join("/"))).toEqual(
      expect.arrayContaining(["nested/b.jsonl"]),
    );
    expect(found.some((p) => p.endsWith("a.jsonl"))).toBe(true);
    expect(found.some((p) => p.endsWith("skip.txt"))).toBe(false);
  });
});

describe("isEncoded — documented un-encoded-workflow semantics", () => {
  it("does NOT flag a turn that chained 3+ already-encoded macros", () => {
    const entries = userTurn("triage everything", [
      { tool: "triage_pull_request", args: { n: 1 } },
      { tool: "triage_issue", args: { n: 2 } },
      { tool: "suggest_reviewers", args: { n: 3 } },
    ]);
    const isEncoded = (name: string) =>
      new Set(["triage_pull_request", "triage_issue", "suggest_reviewers"]).has(name);
    expect(analyzeSession("s", entries, { isEncoded })).toHaveLength(0);
  });

  it("DOES flag a turn that did 3+ raw primitives (workflow without a macro)", () => {
    const entries = userTurn("triage by hand", [
      { tool: "gh_get_pull", args: { n: 1 } },
      { tool: "gh_get_pull_files", args: { n: 1 } },
      { tool: "gh_add_labels", args: { n: 1, labels: ["x"] } },
    ]);
    const isEncoded = (_name: string) => false; // none of these are encoded macros
    const v = analyzeSession("s", entries, { isEncoded });
    expect(v).toHaveLength(1);
  });

  it("counts only the un-encoded calls toward the threshold", () => {
    const entries = userTurn("mixed", [
      { tool: "triage_pull_request", args: { n: 1 } }, // encoded — ignored
      { tool: "gh_get_pull", args: { n: 1 } },
      { tool: "gh_get_pull_files", args: { n: 1 } },
    ]);
    const isEncoded = (name: string) => name === "triage_pull_request";
    // only 2 raw calls -> below threshold 3 -> no violation
    expect(analyzeSession("s", entries, { isEncoded })).toHaveLength(0);
  });
});
