// Fixture: a minimal but complete community macro package.
// macrokit lint --pkg should pass against this directory.
import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";

export const triagePaper = defineMacro({
  name: "triage_paper",
  intent: "summarize and classify an academic paper by its identifier",
  schema: z.object({
    paperId: z.string().min(1),
    dimension: z.enum(["relevance", "novelty", "method"]).default("relevance"),
  }),
  handler: async ({ paperId, dimension }) => {
    // Fixture handler — does no network I/O. A real package would fetch
    // metadata from arXiv / Semantic Scholar / OpenAlex and score it.
    return { paperId, dimension, score: 0.5, oneLine: "(fixture)" };
  },
});
