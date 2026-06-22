import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";
import type { AtsClient } from "../primitives/ats-client.js";
import { scoreResumeFit } from "../scoring.js";

export const screenResume = defineMacro({
  name: "screen_resume",
  intent:
    "Screen ONE candidate's resume against ONE requisition: compute a fit score, " +
    "list matched and missing must-have skills, check the experience floor and " +
    "location compatibility, and return an advance / maybe / reject recommendation. " +
    "Read-only assessment of a single candidate — does not rank a pool and does " +
    "not contact anyone.",
  capabilities: ["ats"],
  schema: z.object({
    candidateId: z.string().min(1).describe("ATS candidate ID, e.g. CAND-2001."),
    requisitionId: z
      .string()
      .optional()
      .describe("Requisition to screen against. Defaults to the candidate's own requisition."),
  }),
  handler: async ({ candidateId, requisitionId }, ctx) => {
    const ats = ctx.tools.ats as AtsClient | undefined;
    if (!ats) throw new Error("screen_resume: no ATS surface available.");
    const candidate = await ats.getCandidate(candidateId);
    const req = await ats.getRequisition(requisitionId ?? candidate.requisitionId);
    const fit = scoreResumeFit(candidate, req);
    return {
      candidateId: candidate.id,
      candidateName: candidate.name,
      requisitionId: req.id,
      requisitionTitle: req.title,
      ...fit,
    };
  },
});
