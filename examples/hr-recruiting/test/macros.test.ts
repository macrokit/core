/**
 * Macro-level tests: the macros load, register, and run against the FIXTURED
 * ATS surface (no live calls). Mirrors the other examples' macro tests, and
 * pins down the two things this vertical is meant to demonstrate:
 *   1. capability scoping (D-017) — macros declare `["ats"]` and reach it,
 *   2. the dry-run safety default — consequential macros do NOT mutate unless
 *      told to (carries the 2-A apply:true finding).
 */
import { describe, it, expect } from "vitest";
import { Dispatcher, MacroRegistry, SessionLog, type ToolResult } from "@macrokit/runtime";
import { InMemoryAtsClient } from "../src/primitives/ats-client.js";
import { SAMPLE_DATASET } from "../src/fixtures/dataset.js";
import {
  checkReferencesDryRun,
  draftCandidateOutreach,
  parseRequisition,
  rankCandidates,
  scheduleInterview,
  screenResume,
} from "../src/macros/index.js";

const ALL = [
  parseRequisition,
  screenResume,
  rankCandidates,
  draftCandidateOutreach,
  scheduleInterview,
  checkReferencesDryRun,
];

function harness() {
  const ats = new InMemoryAtsClient(SAMPLE_DATASET);
  const registry = new MacroRegistry();
  for (const m of ALL) registry.register(m);
  const log = new SessionLog();
  const dispatcher = new Dispatcher({ registry, log, toolSurfaces: { ats } });
  const run = async (tool: string, args: Record<string, unknown>): Promise<ToolResult> =>
    dispatcher.dispatch({ tool, args });
  return { ats, registry, dispatcher, run };
}

function value(res: ToolResult): Record<string, unknown> {
  if (!res.ok) throw new Error(`dispatch failed: ${res.error.code} ${res.error.message}`);
  return res.value as Record<string, unknown>;
}

describe("registration", () => {
  it("registers all six recruiter macros with unique, valid names", () => {
    const { registry } = harness();
    expect(registry.list().map((m) => m.name).sort()).toEqual([
      "check_references_dryrun",
      "draft_candidate_outreach",
      "parse_requisition",
      "rank_candidates",
      "schedule_interview",
      "screen_resume",
    ]);
  });

  it("every macro declares the `ats` capability (D-017)", () => {
    for (const m of ALL) expect(m.capabilities).toEqual(["ats"]);
  });
});

describe("read-only macros run against fixtures", () => {
  it("parse_requisition structures a fetched requisition", async () => {
    const { run } = harness();
    const v = value(await run("parse_requisition", { requisitionId: "REQ-1001" }));
    expect(v.title).toBe("Senior Backend Engineer");
    expect(v.level).toBe("senior");
    expect(v.minYearsExperience).toBe(5);
  });

  it("screen_resume assesses a single candidate", async () => {
    const { run } = harness();
    const v = value(await run("screen_resume", { candidateId: "CAND-2003" }));
    expect(v.requisitionId).toBe("REQ-1001");
    expect(v.recommendation).toBe("advance");
    expect(v.missingMustHave).toEqual([]);
  });

  it("rank_candidates orders the pipeline and honors top-N", async () => {
    const { run } = harness();
    const v = value(await run("rank_candidates", { requisitionId: "REQ-1001", top: 2 }));
    const ranked = v.ranked as Array<{ candidateId: string }>;
    expect(ranked).toHaveLength(2);
    expect(ranked[0]!.candidateId).toBe("CAND-2003");
  });
});

describe("safety: consequential macros default to dry-run", () => {
  it("draft_candidate_outreach drafts but does NOT send by default", async () => {
    const { ats, run } = harness();
    const v = value(await run("draft_candidate_outreach", { candidateId: "CAND-2002" }));
    expect(v.dryRun).toBe(true);
    expect(v.sent).toBe(false);
    expect(v.messageId).toBeNull();
    expect((v.message as { body: string }).body).toContain("Jordan");
    expect(ats.mutations.messages).toHaveLength(0); // nothing left the system
  });

  it("schedule_interview previews but does NOT book by default", async () => {
    const { ats, run } = harness();
    const v = value(
      await run("schedule_interview", {
        candidateId: "CAND-2003",
        interviewers: ["Dana Okoro"],
        proposedSlots: ["2026-07-01T15:00:00Z"],
      }),
    );
    expect(v.dryRun).toBe(true);
    expect(v.scheduled).toBe(false);
    expect(ats.mutations.interviews).toHaveLength(0);
  });

  it("check_references_dryrun prepares but contacts NO ONE by default", async () => {
    const { ats, run } = harness();
    const v = value(await run("check_references_dryrun", { candidateId: "CAND-2001" }));
    expect(v.dryRun).toBe(true);
    expect(v.contacted).toBe(false);
    expect(v.referenceCount).toBe(2);
    expect(ats.mutations.referenceRequests).toHaveLength(0);
  });

  it("only mutates when send:true is explicit", async () => {
    const { ats, run } = harness();
    const out = value(await run("draft_candidate_outreach", { candidateId: "CAND-2002", send: true }));
    expect(out.sent).toBe(true);
    expect(out.messageId).not.toBeNull();
    expect(ats.mutations.messages).toHaveLength(1);

    await run("check_references_dryrun", { candidateId: "CAND-2001", send: true });
    expect(ats.mutations.referenceRequests).toHaveLength(2);
  });
});

describe("capability membrane (D-017)", () => {
  it("dispatches fine when the declared `ats` surface is present", async () => {
    const { run } = harness();
    const res = await run("screen_resume", { candidateId: "CAND-2001" });
    expect(res.ok).toBe(true);
  });

  it("surfaces a structured schema error for malformed args (no throw)", async () => {
    const { run } = harness();
    const res = await run("schedule_interview", { candidateId: "CAND-2001" }); // missing interviewers/slots
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("schema_validation_failed");
  });
});
