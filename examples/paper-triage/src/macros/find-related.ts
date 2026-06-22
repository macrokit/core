import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";
import { SemanticScholarClient } from "../api-client.js";
import { rankByQuery } from "../classifiers.js";

export const findRelatedPapers = defineMacro({
  name: "find_related_papers",
  capabilities: ["semanticScholar"],
  intent:
    "Find papers related to a given arXiv ID or DOI via Semantic Scholar's " +
    "recommendations endpoint. Optionally re-rank the recommendations against " +
    "a free-text query to focus on a specific subtopic.",
  schema: z.object({
    paperId: z.string().min(1),
    max: z.number().int().min(1).max(50).default(10),
    query: z
      .string()
      .optional()
      .describe(
        "Optional free-text query to re-rank recommendations against (e.g. 'training stability'). " +
          "If omitted, recommendations are returned in Semantic Scholar's default order.",
      ),
  }),
  handler: async ({ paperId, max, query }, ctx) => {
    const s2 = (ctx.tools.semanticScholar as SemanticScholarClient) ?? new SemanticScholarClient();
    const { recommendedPapers } = await s2.recommendations(paperId, max);
    const ranked = rankByQuery({
      recommendations: recommendedPapers,
      ...(query ? { query } : {}),
    });
    return {
      seedPaperId: paperId,
      query: query ?? null,
      count: ranked.length,
      papers: ranked.map((r) => ({
        paperId: r.paperId,
        title: r.title,
        year: r.year,
        firstAuthor: r.authors[0]?.name ?? "(unknown)",
        citationCount: r.citationCount,
        score: Math.round(r.score * 1000) / 1000,
      })),
    };
  },
});
