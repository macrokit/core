import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";
import { OpenAlexClient, SemanticScholarClient } from "../api-client.js";

export const checkOpenAccess = defineMacro({
  name: "check_open_access",
  capabilities: ["openAlex", "semanticScholar"],
  intent:
    "Check whether an academic paper is open-access via OpenAlex. Returns " +
    "the OA status (closed / bronze / hybrid / green / gold / diamond), the " +
    "best-available OA URL when one exists, and the license. Falls back to " +
    "Semantic Scholar's openAccessPdf field if OpenAlex doesn't know the paper.",
  schema: z.object({
    paperId: z
      .string()
      .min(1)
      .describe(
        "DOI (preferred — OpenAlex addresses works natively by DOI) or arXiv ID. " +
          "arXiv-only IDs fall back to Semantic Scholar's open-access info.",
      ),
  }),
  handler: async ({ paperId }, ctx) => {
    const openalex = (ctx.tools.openAlex as OpenAlexClient) ?? new OpenAlexClient();
    const s2 = (ctx.tools.semanticScholar as SemanticScholarClient) ?? new SemanticScholarClient();

    const trimmed = paperId.trim();
    const isArxivOnly = /^(arXiv:)?\d{4}\.\d{4,5}(v\d+)?$/.test(trimmed);

    if (isArxivOnly) {
      // OpenAlex can't address bare arXiv IDs reliably; ask S2.
      const paper = await s2.getPaper(paperId);
      return {
        paperId: paper.paperId,
        title: paper.title,
        source: "semantic-scholar" as const,
        isOpenAccess: paper.openAccessPdf !== null,
        oaStatus: paper.openAccessPdf ? "open" : "closed",
        oaUrl: paper.openAccessPdf?.url ?? null,
        license: null,
      };
    }

    const work = await openalex.getWork(paperId);
    return {
      paperId: work.id,
      title: work.title,
      source: "openalex" as const,
      isOpenAccess: work.open_access.is_oa,
      oaStatus: work.open_access.oa_status,
      oaUrl: work.best_oa_location?.pdf_url ?? work.open_access.oa_url ?? null,
      license: work.best_oa_location?.license ?? null,
    };
  },
});
