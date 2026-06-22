import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";
import type { AtsClient } from "../primitives/ats-client.js";
import { parseRequisitionText } from "../scoring.js";

export const parseRequisition = defineMacro({
  name: "parse_requisition",
  intent:
    "Parse a job requisition into structured fields — seniority level, minimum " +
    "years of experience, remote flag, and must-have vs nice-to-have skills. " +
    "Accepts raw requisition text directly, or a requisition ID to fetch from " +
    "the ATS first. Read-only; extracts and structures, never posts a job.",
  capabilities: ["ats"],
  schema: z.object({
    requisitionId: z
      .string()
      .optional()
      .describe("ATS requisition ID (e.g. REQ-1001). Provide this OR `text`."),
    text: z
      .string()
      .optional()
      .describe("Raw requisition / job-description text to parse. Provide this OR `requisitionId`."),
  }),
  handler: async ({ requisitionId, text }, ctx) => {
    const ats = ctx.tools.ats as AtsClient | undefined;
    let source = text;
    let title: string | null = null;
    if (!source) {
      if (!requisitionId) {
        throw new Error("parse_requisition needs either `text` or `requisitionId`.");
      }
      if (!ats) throw new Error("parse_requisition: no ATS surface available to fetch the requisition.");
      const req = await ats.getRequisition(requisitionId);
      source = req.description;
      title = req.title;
    }
    const parsed = parseRequisitionText(source);
    return {
      requisitionId: requisitionId ?? null,
      title,
      ...parsed,
    };
  },
});
