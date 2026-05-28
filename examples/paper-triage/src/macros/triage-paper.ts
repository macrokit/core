import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";
import { SemanticScholarClient } from "../api-client.js";
import { classifyPaper, suggestTags } from "../classifiers.js";

export const triagePaper = defineMacro({
  name: "triage_paper",
  intent:
    "Triage an academic paper by its arXiv ID or DOI: fetch metadata, " +
    "classify by primary subject, suggest reading-queue tags (recent / " +
    "well-cited / highly-cited / etc.), and return a one-line summary.",
  schema: z.object({
    paperId: z
      .string()
      .min(1)
      .describe("arXiv ID (e.g. 2401.12345 or arXiv:2401.12345) or DOI (e.g. 10.1145/12345)"),
  }),
  handler: async ({ paperId }, ctx) => {
    const s2 = (ctx.tools.semanticScholar as SemanticScholarClient) ?? new SemanticScholarClient();
    const paper = await s2.getPaper(paperId);
    const primarySubject = classifyPaper({
      title: paper.title,
      abstract: paper.abstract,
      fieldsOfStudy: paper.fieldsOfStudy,
      s2FieldsOfStudy: paper.s2FieldsOfStudy,
    });
    const tags = suggestTags({
      primarySubject,
      citationCount: paper.citationCount,
      year: paper.year,
      influentialCitationCount: paper.influentialCitationCount,
    });
    return {
      paperId: paper.paperId,
      title: paper.title,
      year: paper.year,
      firstAuthor: paper.authors[0]?.name ?? "(unknown)",
      authorCount: paper.authors.length,
      primarySubject,
      tags,
      citationCount: paper.citationCount,
      venue: paper.publicationVenue?.name ?? null,
      oneLine: buildOneLine(paper.title, paper.year, paper.authors[0]?.name),
      openAccessPdf: paper.openAccessPdf?.url ?? null,
    };
  },
});

function buildOneLine(title: string, year: number | null, firstAuthor?: string): string {
  const surname =
    firstAuthor && (firstAuthor.includes(",") ? firstAuthor.split(",")[0] : firstAuthor.split(/\s+/).pop());
  const author = surname ? `${surname} et al.` : "Anonymous";
  const yearStr = year ? `(${year})` : "(n.d.)";
  return `${author} ${yearStr} — ${title}`;
}
