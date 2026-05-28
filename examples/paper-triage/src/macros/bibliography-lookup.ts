import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";
import { SemanticScholarClient } from "../api-client.js";
import { buildBibtex } from "../classifiers.js";

export const bibliographyLookup = defineMacro({
  name: "bibliography_lookup",
  intent:
    "Search the academic literature by free-text query and return BibTeX " +
    "entries for the top matches. Useful when adding citations to a paper " +
    "and you have a topic but not specific IDs.",
  schema: z.object({
    query: z.string().min(3),
    max: z.number().int().min(1).max(20).default(5),
  }),
  handler: async ({ query, max }, ctx) => {
    const s2 = (ctx.tools.semanticScholar as SemanticScholarClient) ?? new SemanticScholarClient();
    const search = await s2.search(query, max);
    // Search returns minimal fields; that's enough for a citation key
    // and basic BibTeX. Adopters who want richer entries can swap
    // search() for getPaper() per result, at a rate-limit cost.
    const entries = search.data.map((p) =>
      buildBibtex({
        paperId: p.paperId,
        title: p.title,
        authors: p.authors,
        year: p.year,
      }),
    );
    return {
      query,
      totalMatches: search.total,
      returned: search.data.length,
      results: search.data.map((p, i) => ({
        paperId: p.paperId,
        title: p.title,
        year: p.year,
        firstAuthor: p.authors[0]?.name ?? "(unknown)",
        citationCount: p.citationCount,
        bibtex: entries[i] ?? "",
      })),
    };
  },
});
