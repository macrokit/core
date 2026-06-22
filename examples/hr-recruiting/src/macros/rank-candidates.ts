import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";
import type { AtsClient } from "../primitives/ats-client.js";
import { rankCandidates as rankFn } from "../scoring.js";

export const rankCandidates = defineMacro({
  name: "rank_candidates",
  intent:
    "Rank a POOL of candidates for one requisition from best to worst fit. " +
    "Scores every candidate in the requisition's pipeline (or a given subset) " +
    "and returns them ordered, each with a fit score and recommendation. " +
    "Read-only shortlist building — compares many candidates, unlike screen_resume " +
    "which assesses a single one; contacts no one.",
  capabilities: ["ats"],
  schema: z.object({
    requisitionId: z.string().min(1).describe("Requisition whose pipeline to rank, e.g. REQ-1001."),
    candidateIds: z
      .array(z.string())
      .optional()
      .describe("Optional subset of candidate IDs. Defaults to the whole pipeline."),
    top: z.number().int().positive().optional().describe("If set, return only the top N."),
  }),
  handler: async ({ requisitionId, candidateIds, top }, ctx) => {
    const ats = ctx.tools.ats as AtsClient | undefined;
    if (!ats) throw new Error("rank_candidates: no ATS surface available.");
    const req = await ats.getRequisition(requisitionId);
    const pool = await ats.listCandidates(requisitionId);
    const subset = candidateIds ? pool.filter((c) => candidateIds.includes(c.id)) : pool;
    const ranked = rankFn(req, subset);
    return {
      requisitionId: req.id,
      requisitionTitle: req.title,
      poolSize: subset.length,
      ranked: top ? ranked.slice(0, top) : ranked,
    };
  },
});
