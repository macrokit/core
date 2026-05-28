/**
 * Small fetch-based clients for two public academic APIs:
 *
 *   Semantic Scholar Graph API (api.semanticscholar.org/graph/v1)
 *     — paper metadata, search, recommendations
 *   OpenAlex API           (api.openalex.org)
 *     — open-access status, OA URL, license
 *
 * No auth required for basic use; rate-limit-friendly defaults (a single
 * User-Agent identifying this example). Adopters who need higher quotas
 * configure an API key + appropriate base URL.
 *
 * All paper IDs accepted by both clients use the prefix-aware syntax:
 *   "arXiv:2401.12345"   (arXiv preprint)
 *   "DOI:10.1145/12345"  (any DOI)
 *   "10.1145/12345"      (DOI without prefix — auto-detected)
 *   "2401.12345"         (bare arXiv ID — auto-prefixed)
 */

export interface SemanticScholarClientOptions {
  /** Optional API key (S2 issues these for higher rate limits). */
  apiKey?: string;
  /** Custom fetch — used in tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Override base URL. Default https://api.semanticscholar.org/graph/v1 */
  baseUrl?: string;
}

export interface S2Paper {
  paperId: string;
  externalIds: Record<string, string | number | null> | null;
  title: string;
  abstract: string | null;
  year: number | null;
  authors: Array<{ authorId: string | null; name: string }>;
  citationCount: number | null;
  influentialCitationCount: number | null;
  fieldsOfStudy: string[] | null;
  s2FieldsOfStudy: Array<{ category: string; source: string }> | null;
  openAccessPdf: { url: string; status: string } | null;
  publicationVenue: { name?: string; type?: string } | null;
  publicationDate: string | null;
}

export interface S2SearchResult {
  paperId: string;
  title: string;
  year: number | null;
  authors: Array<{ name: string }>;
  citationCount: number | null;
}

export interface S2Recommendation {
  paperId: string;
  title: string;
  year: number | null;
  citationCount: number | null;
  authors: Array<{ name: string }>;
}

const S2_PAPER_FIELDS = [
  "paperId",
  "externalIds",
  "title",
  "abstract",
  "year",
  "authors",
  "citationCount",
  "influentialCitationCount",
  "fieldsOfStudy",
  "s2FieldsOfStudy",
  "openAccessPdf",
  "publicationVenue",
  "publicationDate",
].join(",");

const S2_SEARCH_FIELDS = ["paperId", "title", "year", "authors", "citationCount"].join(",");

export class SemanticScholarClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SemanticScholarClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://api.semanticscholar.org/graph/v1").replace(/\/+$/, "");
    if (opts.apiKey !== undefined) this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  getPaper(paperId: string): Promise<S2Paper> {
    const id = normalizePaperId(paperId);
    return this.get<S2Paper>(`/paper/${encodeURIComponent(id)}?fields=${S2_PAPER_FIELDS}`);
  }

  async getPapers(paperIds: ReadonlyArray<string>): Promise<S2Paper[]> {
    // S2 supports batch lookup via POST /paper/batch.
    const r = await this.fetchImpl(`${this.baseUrl}/paper/batch?fields=${S2_PAPER_FIELDS}`, {
      method: "POST",
      headers: this.headers("application/json"),
      body: JSON.stringify({ ids: paperIds.map(normalizePaperId) }),
    });
    if (!r.ok) throw new S2Error(`batch lookup failed: ${r.status}`, r.status);
    return (await r.json()) as S2Paper[];
  }

  search(query: string, max = 10): Promise<{ total: number; data: S2SearchResult[] }> {
    const q = encodeURIComponent(query);
    return this.get<{ total: number; data: S2SearchResult[] }>(
      `/paper/search?query=${q}&limit=${max}&fields=${S2_SEARCH_FIELDS}`,
    );
  }

  recommendations(paperId: string, max = 10): Promise<{ recommendedPapers: S2Recommendation[] }> {
    const id = normalizePaperId(paperId);
    return this.get<{ recommendedPapers: S2Recommendation[] }>(
      `/paper/${encodeURIComponent(id)}/recommendations?limit=${max}&fields=${S2_SEARCH_FIELDS}`,
    );
  }

  private async get<T>(path: string): Promise<T> {
    const r = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: this.headers() });
    if (!r.ok) {
      throw new S2Error(`GET ${path}: ${r.status} ${r.statusText}`, r.status);
    }
    return (await r.json()) as T;
  }

  private headers(contentType?: string): Record<string, string> {
    const h: Record<string, string> = {
      "User-Agent": "macrokit-paper-triage-example/0.0.1 (https://macrokit.dev)",
    };
    if (contentType) h["Content-Type"] = contentType;
    if (this.apiKey) h["x-api-key"] = this.apiKey;
    return h;
  }
}

export class S2Error extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "S2Error";
  }
}

// ---------------------------------------------------------------------------
// OpenAlex
// ---------------------------------------------------------------------------

export interface OpenAlexClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Email goes in the User-Agent — OpenAlex's "polite pool" gives faster responses. */
  contactEmail?: string;
}

export interface OpenAlexWork {
  id: string;
  doi: string | null;
  title: string | null;
  publication_year: number | null;
  open_access: {
    is_oa: boolean;
    oa_status: "diamond" | "gold" | "green" | "hybrid" | "bronze" | "closed";
    oa_url: string | null;
    any_repository_has_fulltext?: boolean;
  };
  best_oa_location: {
    license: string | null;
    pdf_url: string | null;
    source?: { display_name?: string };
  } | null;
}

export class OpenAlexClient {
  private readonly baseUrl: string;
  private readonly contactEmail?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAlexClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://api.openalex.org").replace(/\/+$/, "");
    if (opts.contactEmail !== undefined) this.contactEmail = opts.contactEmail;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  /** Look up a work by DOI, OpenAlex ID, or PMID. */
  async getWork(id: string): Promise<OpenAlexWork> {
    const url = `${this.baseUrl}/works/${encodeURIComponent(openAlexIdentifier(id))}`;
    const r = await this.fetchImpl(url, { headers: this.headers() });
    if (!r.ok) {
      throw new OpenAlexError(`GET ${url}: ${r.status} ${r.statusText}`, r.status);
    }
    return (await r.json()) as OpenAlexWork;
  }

  private headers(): Record<string, string> {
    const ua = this.contactEmail
      ? `macrokit-paper-triage-example/0.0.1 (mailto:${this.contactEmail})`
      : "macrokit-paper-triage-example/0.0.1 (https://macrokit.dev)";
    return { "User-Agent": ua };
  }
}

export class OpenAlexError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "OpenAlexError";
  }
}

// ---------------------------------------------------------------------------
// ID normalization (pure — tested directly)
// ---------------------------------------------------------------------------

/**
 * Convert any reasonable paper-id form into the S2-accepted prefix-aware
 * string. Pure function; tested in classifiers.test.ts.
 *
 *   "arXiv:2401.12345"  → "arXiv:2401.12345"
 *   "2401.12345"        → "arXiv:2401.12345"
 *   "DOI:10.1145/X"     → "DOI:10.1145/X"
 *   "10.1145/X"         → "DOI:10.1145/X"
 *   "<32-char hex>"     → "<32-char hex>"   (S2 internal ID)
 *   anything else       → returned as-is, S2 will reject it cleanly
 */
export function normalizePaperId(id: string): string {
  const trimmed = id.trim();
  if (/^(arXiv:|DOI:|MAG:|ACL:|PMID:|PMCID:|CorpusId:|URL:)/i.test(trimmed)) return trimmed;
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(trimmed)) return `arXiv:${trimmed}`;
  if (/^10\.\d{4,}/.test(trimmed)) return `DOI:${trimmed}`;
  return trimmed;
}

/**
 * OpenAlex accepts DOIs as either bare ("10.x") or prefixed ("doi:...").
 * For internal IDs OpenAlex uses uppercase letters prefix (W123, A123).
 */
export function openAlexIdentifier(id: string): string {
  const trimmed = id.trim();
  // Strip a leading "DOI:" if present — OpenAlex prefers lowercase "doi:".
  if (/^DOI:/i.test(trimmed)) return `doi:${trimmed.slice(4)}`;
  if (/^10\.\d{4,}/.test(trimmed)) return `doi:${trimmed}`;
  // arXiv IDs aren't natively addressable in OpenAlex by themselves; the
  // caller should resolve to a DOI first if possible. Pass through.
  return trimmed;
}
