/**
 * Pure, deterministic functions used by the paper-triage macros.
 * Mirrors the github-maintainer/classifiers.ts pattern: handlers are thin
 * wrappers around these functions plus HTTP I/O.
 *
 * The macros' headline claim is that runtime LLMs only have to ROUTE; the
 * deterministic core does the actual classification work. These functions
 * are the deterministic core.
 */

import type { S2Paper, S2Recommendation } from "./api-client.js";

export type PrimarySubject =
  | "computer-science"
  | "machine-learning"
  | "mathematics"
  | "physics"
  | "biology"
  | "medicine"
  | "social-science"
  | "other";

/**
 * Classify a paper into a coarse subject bucket. Two signals in priority order:
 *
 *   1. The Semantic Scholar `s2FieldsOfStudy` array, when present, is the
 *      most accurate source — it's a hand-curated taxonomy.
 *   2. Keyword scan of title + abstract as a fallback.
 *
 * Returns "other" if neither signal fires.
 */
export interface ClassifyInput {
  title: string;
  abstract?: string | null;
  fieldsOfStudy?: ReadonlyArray<string> | null;
  s2FieldsOfStudy?: ReadonlyArray<{ category: string }> | null;
}

export function classifyPaper(input: ClassifyInput): PrimarySubject {
  const fields = new Set<string>();
  for (const f of input.s2FieldsOfStudy ?? []) fields.add(f.category.toLowerCase());
  for (const f of input.fieldsOfStudy ?? []) fields.add(f.toLowerCase());

  if (fields.has("computer science")) {
    // Subdivide CS papers based on title/abstract keywords.
    const blob = `${input.title} ${input.abstract ?? ""}`.toLowerCase();
    if (
      blob.match(
        /\b(neural network|deep learning|transformer|llm|language model|reinforcement learning|generative|diffusion|gradient descent|backpropagation)\b/,
      )
    ) {
      return "machine-learning";
    }
    return "computer-science";
  }
  if (fields.has("mathematics")) return "mathematics";
  if (fields.has("physics")) return "physics";
  if (fields.has("biology")) return "biology";
  if (fields.has("medicine") || fields.has("clinical medicine")) return "medicine";
  if (
    fields.has("sociology") ||
    fields.has("economics") ||
    fields.has("political science") ||
    fields.has("psychology")
  ) {
    return "social-science";
  }

  // Keyword fallback when no fields-of-study returned.
  const blob = `${input.title} ${input.abstract ?? ""}`.toLowerCase();
  if (blob.match(/\b(neural network|deep learning|transformer|llm|language model|gpt|bert)\b/)) {
    return "machine-learning";
  }
  if (blob.match(/\b(algorithm|complexity|compiler|operating system|software engineering)\b/)) {
    return "computer-science";
  }
  if (blob.match(/\b(theorem|proof|lemma|conjecture|topology|algebra)\b/)) return "mathematics";
  if (blob.match(/\b(particle|quantum|relativity|cosmology|astrophysics)\b/)) return "physics";
  if (blob.match(/\b(gene|protein|cell biology|genome|enzyme|organism)\b/)) return "biology";
  if (blob.match(/\b(patient|clinical trial|disease|diagnosis|treatment)\b/)) return "medicine";
  return "other";
}

/**
 * Suggest a small set of tags an editor might apply when adding the paper
 * to a reading queue. Tags are stable strings; callers can map them to
 * labels in whatever issue tracker / DB they use.
 */
export interface TagsInput {
  primarySubject: PrimarySubject;
  citationCount: number | null;
  year: number | null;
  influentialCitationCount?: number | null;
  /** "now" for tests; defaults to current date when omitted. */
  now?: Date;
}

export function suggestTags(input: TagsInput): string[] {
  const now = input.now ?? new Date();
  const tags = new Set<string>([input.primarySubject]);
  if (input.year !== null && input.year !== undefined) {
    const ageYears = now.getFullYear() - input.year;
    if (ageYears <= 1) tags.add("recent");
    else if (ageYears >= 10) tags.add("seminal-era");
  }
  const cites = input.citationCount ?? 0;
  if (cites >= 1000) tags.add("highly-cited");
  else if (cites >= 100) tags.add("well-cited");
  else if (cites < 5 && input.year !== null && input.year !== undefined) {
    const ageYears = now.getFullYear() - input.year;
    if (ageYears >= 2) tags.add("low-citation");
  }
  if (input.influentialCitationCount && input.influentialCitationCount >= 50) {
    tags.add("influential");
  }
  return [...tags];
}

/**
 * Generate a BibTeX entry from S2 paper metadata. Output uses a stable
 * citation key: first-author-surname + year + first significant word of
 * title. Deterministic, no LLM in the loop.
 */
export interface BibtexInput {
  paperId: string;
  title: string;
  authors: ReadonlyArray<{ name: string }>;
  year: number | null;
  publicationVenue?: { name?: string } | null;
  externalIds?: Record<string, string | number | null> | null;
}

export function buildBibtex(input: BibtexInput): string {
  const key = buildCitationKey(input);
  const authorField = input.authors.map((a) => normalizeAuthor(a.name)).join(" and ");
  const venueName = input.publicationVenue?.name ?? "";
  const doi = (input.externalIds?.DOI as string | undefined) ?? "";
  const arxiv = (input.externalIds?.ArXiv as string | undefined) ?? "";

  const type = venueName ? "article" : arxiv ? "misc" : "article";
  const fields: Array<[string, string | number | null]> = [
    ["author", authorField],
    ["title", input.title],
    ["year", input.year],
  ];
  if (venueName) fields.push(["journal", venueName]);
  if (doi) fields.push(["doi", doi]);
  if (arxiv) fields.push(["eprint", arxiv]);
  if (arxiv) fields.push(["archivePrefix", "arXiv"]);

  const body = fields
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `  ${k} = {${escapeBibtex(String(v))}},`)
    .join("\n");
  return `@${type}{${key},\n${body}\n}`;
}

function buildCitationKey(input: BibtexInput): string {
  const lastName =
    input.authors[0] && lastNameOf(input.authors[0].name).toLowerCase().replace(/[^a-z]/g, "");
  const year = input.year ?? "nd";
  const titleWord =
    input.title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOP.has(w))[0] ?? "paper";
  return `${lastName ?? "anon"}${year}${titleWord}`;
}

const STOP = new Set([
  "the",
  "and",
  "with",
  "from",
  "into",
  "this",
  "that",
  "their",
  "these",
  "those",
  "using",
  "based",
  "toward",
  "about",
]);

function normalizeAuthor(name: string): string {
  // Convert "Jane M. Doe" → "Doe, Jane M.". If already comma-form, leave alone.
  if (name.includes(",")) return name.trim();
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0]!;
  const surname = parts[parts.length - 1]!;
  const rest = parts.slice(0, -1).join(" ");
  return `${surname}, ${rest}`;
}

function lastNameOf(name: string): string {
  if (name.includes(",")) return name.split(",")[0]!.trim();
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1] ?? name;
}

function escapeBibtex(s: string): string {
  // BibTeX special characters; minimal escaping. Adopters with strict
  // BibTeX tooling can post-process.
  return s.replace(/([{}\\])/g, "\\$1");
}

/**
 * Rank a set of recommendations against a query string. Lightweight TF-style
 * scoring on title + (provided) abstract field. Returns rec list sorted by
 * descending score. Pure function — no LLM, no API calls.
 */
export interface RankInput {
  recommendations: ReadonlyArray<S2Recommendation>;
  query?: string;
}

export interface RankedRecommendation extends S2Recommendation {
  score: number;
}

export function rankByQuery(input: RankInput): RankedRecommendation[] {
  if (!input.query || input.query.trim().length === 0) {
    return input.recommendations.map((r) => ({ ...r, score: 0 }));
  }
  const queryTokens = tokenize(input.query);
  const scored = input.recommendations.map((r) => {
    const titleTokens = tokenize(r.title);
    let overlap = 0;
    for (const t of queryTokens) if (titleTokens.has(t)) overlap += 1;
    const base = queryTokens.size === 0 ? 0 : overlap / queryTokens.size;
    const cit = Math.log1p(r.citationCount ?? 0) / 10; // light citation prior
    return { ...r, score: base + cit };
  });
  return scored.sort((a, b) => b.score - a.score);
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );
}

/**
 * Build a comparison table-row for one paper. Pure — the macro will fetch
 * the metadata via the API client, then map each paper through this to
 * produce a comparable record.
 */
export interface ComparisonRow {
  paperId: string;
  title: string;
  year: number | null;
  citationCount: number | null;
  primarySubject: PrimarySubject;
  firstAuthor: string;
  isOpenAccess: boolean;
}

export function toComparisonRow(paper: S2Paper): ComparisonRow {
  return {
    paperId: paper.paperId,
    title: paper.title,
    year: paper.year,
    citationCount: paper.citationCount,
    primarySubject: classifyPaper({
      title: paper.title,
      abstract: paper.abstract,
      fieldsOfStudy: paper.fieldsOfStudy,
      s2FieldsOfStudy: paper.s2FieldsOfStudy,
    }),
    firstAuthor: paper.authors[0]?.name ?? "(unknown)",
    isOpenAccess: paper.openAccessPdf !== null,
  };
}
