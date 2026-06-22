import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";
import type { AtsClient } from "../primitives/ats-client.js";
import { buildInterviewInvite } from "../scoring.js";

export const scheduleInterview = defineMacro({
  name: "schedule_interview",
  intent:
    "Prepare an interview invite for a candidate — interviewers, proposed time " +
    "slots, stage, and duration. CONSEQUENTIAL: booking is gated behind `send` " +
    "and DEFAULTS TO DRY-RUN (send=false) — it returns the assembled invite for " +
    "human confirmation and writes it to the ATS only when explicitly told to.",
  capabilities: ["ats"],
  schema: z.object({
    candidateId: z.string().min(1).describe("Candidate to interview, e.g. CAND-2001."),
    requisitionId: z
      .string()
      .optional()
      .describe("Requisition. Defaults to the candidate's own requisition."),
    interviewers: z.array(z.string().min(1)).min(1).describe("Interviewer names or emails."),
    proposedSlots: z
      .array(z.string().min(1))
      .min(1)
      .describe("ISO-8601 start times to offer, e.g. 2026-07-01T15:00:00Z."),
    stage: z.string().default("interview").describe("Pipeline stage label for this round."),
    durationMinutes: z.number().int().positive().default(45),
    send: z
      .boolean()
      .default(false)
      .describe("If true, actually create the interview in the ATS. Default false = dry-run."),
  }),
  handler: async (
    { candidateId, requisitionId, interviewers, proposedSlots, stage, durationMinutes, send },
    ctx,
  ) => {
    const ats = ctx.tools.ats as AtsClient | undefined;
    if (!ats) throw new Error("schedule_interview: no ATS surface available.");
    const candidate = await ats.getCandidate(candidateId);
    const req = await ats.getRequisition(requisitionId ?? candidate.requisitionId);
    const invite = buildInterviewInvite({
      candidate,
      requisition: req,
      interviewers,
      proposedSlots,
      stage,
      durationMinutes,
    });

    let interviewId: string | null = null;
    if (send) {
      ({ id: interviewId } = await ats.createInterview(invite));
    }
    return {
      candidateId: candidate.id,
      candidateName: candidate.name,
      requisitionId: req.id,
      dryRun: !send,
      scheduled: send,
      interviewId,
      invite,
    };
  },
});
