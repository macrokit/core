import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";
import type { AtsClient } from "../primitives/ats-client.js";
import { draftOutreach } from "../scoring.js";

export const draftCandidateOutreach = defineMacro({
  name: "draft_candidate_outreach",
  intent:
    "Draft a personalized outreach message inviting one candidate to consider a " +
    "requisition, in a chosen tone. CONSEQUENTIAL: sending is gated behind " +
    "`send` and DEFAULTS TO DRY-RUN (send=false) — it returns the drafted subject " +
    "and body for human review and sends via the ATS only when explicitly told to.",
  capabilities: ["ats"],
  schema: z.object({
    candidateId: z.string().min(1).describe("Candidate to reach out to, e.g. CAND-2001."),
    requisitionId: z
      .string()
      .optional()
      .describe("Requisition to pitch. Defaults to the candidate's own requisition."),
    tone: z.enum(["warm", "formal", "brief"]).default("warm"),
    send: z
      .boolean()
      .default(false)
      .describe("If true, actually send the message via the ATS. Default false = draft only."),
  }),
  handler: async ({ candidateId, requisitionId, tone, send }, ctx) => {
    const ats = ctx.tools.ats as AtsClient | undefined;
    if (!ats) throw new Error("draft_candidate_outreach: no ATS surface available.");
    const candidate = await ats.getCandidate(candidateId);
    const req = await ats.getRequisition(requisitionId ?? candidate.requisitionId);
    const message = draftOutreach(candidate, req, tone);

    let sentId: string | null = null;
    if (send) {
      ({ id: sentId } = await ats.sendMessage(message));
    }
    return {
      candidateId: candidate.id,
      candidateName: candidate.name,
      requisitionId: req.id,
      tone,
      dryRun: !send,
      sent: send,
      messageId: sentId,
      message,
    };
  },
});
