import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";
import type { AtsClient } from "../primitives/ats-client.js";
import { buildReferenceRequests } from "../scoring.js";

export const checkReferencesDryRun = defineMacro({
  name: "check_references_dryrun",
  intent:
    "Prepare reference-check requests for a candidate's listed references. " +
    "CONSEQUENTIAL — contacting references reaches real third parties, so this " +
    "DEFAULTS TO DRY-RUN (send=false): it returns the prepared per-reference " +
    "request bodies for human review and dispatches them via the ATS only when " +
    "explicitly told to send.",
  capabilities: ["ats"],
  schema: z.object({
    candidateId: z.string().min(1).describe("Candidate whose references to contact, e.g. CAND-2001."),
    requisitionId: z
      .string()
      .optional()
      .describe("Requisition context. Defaults to the candidate's own requisition."),
    send: z
      .boolean()
      .default(false)
      .describe("If true, actually send the reference requests. Default false = dry-run, contacts no one."),
  }),
  handler: async ({ candidateId, requisitionId, send }, ctx) => {
    const ats = ctx.tools.ats as AtsClient | undefined;
    if (!ats) throw new Error("check_references_dryrun: no ATS surface available.");
    const candidate = await ats.getCandidate(candidateId);
    const req = await ats.getRequisition(requisitionId ?? candidate.requisitionId);
    const requests = buildReferenceRequests(candidate, req);

    const sentIds: string[] = [];
    if (send) {
      for (const request of requests) {
        const { id } = await ats.requestReference(request);
        sentIds.push(id);
      }
    }
    return {
      candidateId: candidate.id,
      candidateName: candidate.name,
      requisitionId: req.id,
      referenceCount: requests.length,
      dryRun: !send,
      contacted: send,
      sentIds,
      requests,
    };
  },
});
