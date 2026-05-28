import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";
import { SemanticScholarClient } from "../api-client.js";
import { toComparisonRow } from "../classifiers.js";

export const comparePapers = defineMacro({
  name: "compare_papers",
  intent:
    "Compare 2–10 academic papers side-by-side by their arXiv IDs or DOIs. " +
    "Returns a table-row per paper with year, citation count, primary " +
    "subject, first author, and open-access status. Useful for lit-review " +
    "shortlist decisions.",
  schema: z.object({
    paperIds: z.array(z.string().min(1)).min(2).max(10),
  }),
  handler: async ({ paperIds }, ctx) => {
    const s2 = (ctx.tools.semanticScholar as SemanticScholarClient) ?? new SemanticScholarClient();
    const papers = await s2.getPapers(paperIds);
    // S2's batch endpoint returns nulls for unknown IDs in-position. Keep
    // them so the caller can see which inputs didn't resolve.
    const rows = papers.map((p) =>
      p
        ? toComparisonRow(p)
        : {
            paperId: "(unknown)",
            title: "(could not resolve)",
            year: null,
            citationCount: null,
            primarySubject: "other" as const,
            firstAuthor: "(unknown)",
            isOpenAccess: false,
          },
    );
    return {
      requested: paperIds.length,
      resolved: papers.filter((p) => p !== null).length,
      rows,
    };
  },
});
