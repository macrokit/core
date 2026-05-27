/**
 * Tiny GitHub REST client. No third-party SDK — fetch(), zero deps. The
 * macros that drive GitHub all go through this. Adopters that want a full
 * SDK (octokit) can swap it in; the macros use the typed shapes below so
 * the dependency is local to this file.
 */

export interface GitHubClientOptions {
  /** Personal access token. If absent, unauthenticated rate limits apply (60 req/hour). */
  token?: string;
  /** Override for tests. */
  fetch?: typeof fetch;
  /** Override base URL (e.g. for GitHub Enterprise). Default https://api.github.com. */
  baseUrl?: string;
}

export interface GhUser {
  login: string;
}

export interface GhLabel {
  name: string;
  color?: string;
}

export interface GhPullRequest {
  number: number;
  title: string;
  body: string | null;
  user: GhUser;
  html_url: string;
  labels: GhLabel[];
  draft: boolean;
  state: "open" | "closed";
}

export interface GhPullRequestFile {
  filename: string;
  additions: number;
  deletions: number;
  status: string;
}

export interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  user: GhUser;
  html_url: string;
  labels: GhLabel[];
  state: "open" | "closed";
  updated_at: string;
  comments: number;
  /** GitHub returns pull_request on issues that are PRs. We filter those out. */
  pull_request?: { url: string };
}

export interface GhComment {
  id: number;
  user: GhUser;
  body: string;
  created_at: string;
}

export interface GhCommit {
  sha: string;
  commit: { message: string; author: { name: string; date: string } };
  author?: GhUser | null;
}

export interface GhCodeowner {
  pattern: string;
  owners: string[];
}

export class GitHubClient {
  private readonly token?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GitHubClientOptions = {}) {
    if (opts.token !== undefined) this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  // ---------- Pull requests ----------

  getPullRequest(owner: string, repo: string, n: number): Promise<GhPullRequest> {
    return this.get<GhPullRequest>(`/repos/${owner}/${repo}/pulls/${n}`);
  }

  getPullRequestFiles(
    owner: string,
    repo: string,
    n: number,
  ): Promise<GhPullRequestFile[]> {
    return this.get<GhPullRequestFile[]>(
      `/repos/${owner}/${repo}/pulls/${n}/files?per_page=100`,
    );
  }

  // ---------- Issues ----------

  getIssue(owner: string, repo: string, n: number): Promise<GhIssue> {
    return this.get<GhIssue>(`/repos/${owner}/${repo}/issues/${n}`);
  }

  /**
   * List open issues (NOT pull requests — GitHub mixes them in this endpoint;
   * we filter post-fetch). Pages up to `max` issues.
   */
  async listOpenIssues(
    owner: string,
    repo: string,
    opts: { max?: number } = {},
  ): Promise<GhIssue[]> {
    const max = opts.max ?? 100;
    const perPage = Math.min(100, max);
    const out: GhIssue[] = [];
    let page = 1;
    while (out.length < max) {
      const batch = await this.get<GhIssue[]>(
        `/repos/${owner}/${repo}/issues?state=open&per_page=${perPage}&page=${page}`,
      );
      if (batch.length === 0) break;
      for (const i of batch) {
        if (!i.pull_request) out.push(i);
        if (out.length >= max) break;
      }
      if (batch.length < perPage) break;
      page += 1;
    }
    return out;
  }

  getIssueComments(owner: string, repo: string, n: number): Promise<GhComment[]> {
    return this.get<GhComment[]>(`/repos/${owner}/${repo}/issues/${n}/comments?per_page=100`);
  }

  // ---------- Commits ----------

  /**
   * Compare two refs and return the commits between them, ordered chronologically.
   * GitHub's compare endpoint caps at 250 commits — for longer ranges, adopters
   * should fall back to paged /commits queries.
   */
  async compareCommits(
    owner: string,
    repo: string,
    base: string,
    head: string,
  ): Promise<GhCommit[]> {
    const data = await this.get<{ commits: GhCommit[] }>(
      `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    );
    return data.commits ?? [];
  }

  // ---------- Codeowners ----------

  /**
   * Best-effort CODEOWNERS fetch. Tries .github/CODEOWNERS, then docs/, then
   * root. Returns parsed entries or [] if no file exists.
   */
  async getCodeowners(owner: string, repo: string): Promise<GhCodeowner[]> {
    for (const path of [".github/CODEOWNERS", "docs/CODEOWNERS", "CODEOWNERS"]) {
      const text = await this.getRawContent(owner, repo, path);
      if (text !== null) return parseCodeowners(text);
    }
    return [];
  }

  async getRawContent(owner: string, repo: string, path: string): Promise<string | null> {
    const url = `${this.baseUrl}/repos/${owner}/${repo}/contents/${path}`;
    const r = await this.fetchImpl(url, {
      headers: {
        ...this.headers(),
        Accept: "application/vnd.github.raw+json",
      },
    });
    if (r.status === 404) return null;
    if (!r.ok) {
      throw new GitHubError(
        `GET ${url}: ${r.status} ${r.statusText}`,
        r.status,
        await safeText(r),
      );
    }
    return await r.text();
  }

  // ---------- Mutations ----------

  async addLabels(owner: string, repo: string, n: number, labels: string[]): Promise<void> {
    await this.request("POST", `/repos/${owner}/${repo}/issues/${n}/labels`, { labels });
  }

  async closeIssue(
    owner: string,
    repo: string,
    n: number,
    reason: "completed" | "not_planned" = "not_planned",
  ): Promise<void> {
    await this.request("PATCH", `/repos/${owner}/${repo}/issues/${n}`, {
      state: "closed",
      state_reason: reason,
    });
  }

  async commentOnIssue(owner: string, repo: string, n: number, body: string): Promise<void> {
    await this.request("POST", `/repos/${owner}/${repo}/issues/${n}/comments`, { body });
  }

  // ---------- Internals ----------

  private async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const r = await this.fetchImpl(url, { headers: this.headers() });
    if (!r.ok) {
      throw new GitHubError(`GET ${url}: ${r.status} ${r.statusText}`, r.status, await safeText(r));
    }
    return (await r.json()) as T;
  }

  private async request(method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<void> {
    const url = `${this.baseUrl}${path}`;
    const r = await this.fetchImpl(url, {
      method,
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) {
      throw new GitHubError(
        `${method} ${url}: ${r.status} ${r.statusText}`,
        r.status,
        await safeText(r),
      );
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "macrokit-github-maintainer",
    };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

async function safeText(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return "<unreadable>";
  }
}

/**
 * Minimal CODEOWNERS parser: each non-comment line is `<pattern> <@owner> ...`.
 * Sufficient for the suggest_reviewers macro; not a full CODEOWNERS implementation.
 */
export function parseCodeowners(text: string): GhCodeowner[] {
  const out: GhCodeowner[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const tokens = line.split(/\s+/);
    if (tokens.length < 2) continue;
    const [pattern, ...owners] = tokens;
    out.push({
      pattern: pattern!,
      owners: owners.filter((o) => o.startsWith("@")).map((o) => o.slice(1)),
    });
  }
  return out;
}
