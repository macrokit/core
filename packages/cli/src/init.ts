import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `macrokit init` — scaffold a new project on disk.
 *
 * Two scaffold shapes, selected by `--vertical`:
 *
 *  - no `--vertical` (or `--vertical starter`): the minimal seed — one trivial
 *    macro, the runtime wired up. The adopter grows real macros from there.
 *
 *  - `--vertical github` (and future verticals): a real *by-product* project
 *    layout — a `macrokit.json` manifest, `macros/` (one macro per file via
 *    defineMacro), `primitives/` (the low-level tools macros call), and
 *    `fixtures/` (offline test data), seeded with a working starter macro.
 *    This is the layout Macrokit Studio (the local IDE) opens and runs.
 *
 * Reference verticals are the safe set in DECISIONS.md D-008: github, devops,
 * hr, support, paper-triage — never the private reference deployment's domain.
 * github is the seeded reference for now.
 */

export type Vertical = "starter" | "github";

export interface InitOptions {
  /** Project root to scaffold into. Created if missing. */
  dir: string;
  /** Project name (becomes the package.json `name` + manifest `name`). */
  name: string;
  /** Which template to scaffold. Defaults to "starter". */
  vertical?: Vertical;
  /** Default runtime model-provider for the manifest. */
  provider?: "openai-compatible" | "ollama";
  /** If true, overwrite existing files. */
  force?: boolean;
}

export interface InitResult {
  filesWritten: string[];
  skipped: string[];
  vertical: Vertical;
}

const KNOWN_VERTICALS: ReadonlyArray<Vertical> = ["starter", "github"];

export function isVertical(v: string): v is Vertical {
  return (KNOWN_VERTICALS as ReadonlyArray<string>).includes(v);
}

export function initProject(opts: InitOptions): InitResult {
  const { dir, name, vertical = "starter", provider = "ollama", force = false } = opts;
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, ".macrokit", "sessions"), { recursive: true });

  const filesWritten: string[] = [];
  const skipped: string[] = [];

  const write = (relPath: string, content: string): void => {
    const p = join(dir, relPath);
    if (existsSync(p) && !force) {
      skipped.push(relPath);
      return;
    }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    filesWritten.push(relPath);
  };

  // Files common to every scaffold.
  write("macrokit.json", MANIFEST(name, vertical, provider));
  write("package.json", PACKAGE_JSON(name, vertical));
  write("tsconfig.json", TSCONFIG);
  write(".gitignore", GITIGNORE);
  write("README.md", README(name, vertical));

  if (vertical === "github") {
    scaffoldGithub(write);
  } else {
    scaffoldStarter(write, provider);
  }

  return { filesWritten, skipped, vertical };
}

function dirname(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? "." : p.slice(0, idx);
}

// ---------------------------------------------------------------------------
// Manifest + shared project files
// ---------------------------------------------------------------------------

const MANIFEST = (
  name: string,
  vertical: Vertical,
  provider: "openai-compatible" | "ollama",
): string =>
  JSON.stringify(
    {
      // The Macrokit project manifest. Macrokit Studio reads this to open the
      // project, locate its macros, and pick the runtime (weak) model.
      name,
      version: "0.1.0",
      vertical,
      sdk: "^0.1.0",
      // The weak/local model the runtime routes with. Studio's local server
      // builds the matching adapter; the browser demo uses WebLLM instead.
      model: {
        runtime:
          provider === "ollama"
            ? { provider: "ollama", model: "qwen2.5:7b-instruct", baseUrl: "http://localhost:11434" }
            : {
                provider: "openai-compatible",
                model: "gpt-4o-mini",
                baseUrl: "https://api.openai.com/v1",
              },
      },
      // Where the project keeps its pieces (relative to this file).
      paths: { macros: "macros", primitives: "primitives", fixtures: "fixtures" },
    },
    null,
    2,
  ) + "\n";

const PACKAGE_JSON = (name: string, vertical: Vertical): string =>
  JSON.stringify(
    {
      name,
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: {
        // Run the public MCP server so your agent (Claude Code / Cursor) can call this project's macros.
        mcp: "macrokit mcp .",
        // Flag un-encoded workflows in recorded sessions.
        gate: "macrokit gate .macrokit/sessions --macros macros",
        // Optional: open in the local Studio IDE (requires the separate @macrokit-studio/preview).
        studio: "macrokit studio .",
        lint: vertical === "github" ? "macrokit lint macros" : "macrokit lint src",
      },
      dependencies: {
        "@macrokit/runtime": "*",
        "@macrokit/llm": "*",
        "@macrokit/authoring": "*",
        zod: "^3.23.8",
      },
      devDependencies: {
        "@macrokit/cli": "*",
        tsx: "^4.19.0",
        typescript: "^5.7.0",
      },
    },
    null,
    2,
  ) + "\n";

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": false
  },
  "include": ["macros/**/*", "primitives/**/*", "src/**/*"]
}
`;

const GITIGNORE = `node_modules
dist
.macrokit/sessions
.env
.DS_Store
`;

const README = (name: string, vertical: Vertical): string => `# ${name}

A Macrokit ${vertical === "github" ? "**github-maintainer**" : ""} by-product project. See
https://macrokit.dev for the pattern essay and architecture.

## Wire it into your agent (Claude Code / Cursor)

\`\`\`sh
claude mcp add macrokit -- macrokit mcp .
\`\`\`

This runs the public Macrokit MCP server: your agent can now call this project's
macros (and its raw primitives) as tools, every call is recorded, and:

\`\`\`sh
macrokit gate .macrokit/sessions --macros macros
\`\`\`

flags any workflow you ran *without* a macro and suggests one to encode. That loop
— agent calls tools → session recorded → \`macrokit gate\` flags → you encode a macro —
is the whole point.

*(Optional: \`macrokit studio .\` opens a local GUI IDE — it requires the separate
\`@macrokit-studio/preview\` package; the MCP server above needs nothing extra.)*

## Layout

\`\`\`
macrokit.json     manifest (name, vertical, runtime model)
macros/           one macro per file (defineMacro) — the workflows the model routes to
${vertical === "github" ? "primitives/       low-level tools the macros call (GitHub REST client)\nfixtures/         offline sample data for tests\n" : "src/              entrypoint + a starter macro\n"}\`\`\`

## Distillation gate

After a session, run \`npm run gate\` to find workflows that should be encoded as macros.
`;

// ---------------------------------------------------------------------------
// starter (default) scaffold — minimal, no domain
// ---------------------------------------------------------------------------

function scaffoldStarter(
  write: (rel: string, content: string) => void,
  provider: "openai-compatible" | "ollama",
): void {
  write("macros/echo.ts", STARTER_ECHO_MACRO);
  write("src/main.ts", STARTER_MAIN(provider));
}

const STARTER_ECHO_MACRO = `import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";

// Replace this with the macros your application needs. Each macro encodes
// one workflow end-to-end — the LLM only routes to them, it does not
// compose them at runtime. See https://macrokit.dev/#pattern.
export const echo = defineMacro({
  name: "echo",
  intent: "echo back whatever the user said, optionally shouting",
  schema: z.object({
    text: z.string(),
    shout: z.boolean().default(false),
  }),
  handler: async ({ text, shout }) => ({
    text: shout ? text.toUpperCase() : text,
  }),
});
`;

const STARTER_MAIN = (provider: "openai-compatible" | "ollama"): string => `import { MacroRegistry, Runtime } from "@macrokit/runtime";
${
  provider === "ollama"
    ? 'import { OllamaAdapter } from "@macrokit/llm";'
    : 'import { OpenAICompatibleAdapter } from "@macrokit/llm";'
}
import { echo } from "../macros/echo.js";

const llm = ${
    provider === "ollama"
      ? `new OllamaAdapter({ model: "qwen2.5:7b-instruct" });`
      : `new OpenAICompatibleAdapter({
  baseUrl: process.env.LLM_BASE_URL ?? "https://api.openai.com/v1",
  model: process.env.LLM_MODEL ?? "gpt-4o-mini",
  apiKey: process.env.LLM_API_KEY ?? "",
});`
  }

const runtime = new Runtime({
  registry: new MacroRegistry().register(echo),
  sessionLogPath: \`.macrokit/sessions/\${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl\`,
  llm,
});

const userMessage = process.argv.slice(2).join(" ") || "please shout 'hello macrokit'";
const result = await runtime.chat(userMessage);
console.log(result.text);
`;

// ---------------------------------------------------------------------------
// github vertical scaffold — a real by-product project
// ---------------------------------------------------------------------------

function scaffoldGithub(write: (rel: string, content: string) => void): void {
  write("primitives/github-client.ts", GH_CLIENT);
  write("primitives/github-primitives.ts", GH_PRIMITIVES);
  write("macros/summarize-open-issues.ts", GH_MACRO_SUMMARIZE);
  write("macros/triage-newest-pull.ts", GH_MACRO_TRIAGE);
  write("fixtures/example-repo.json", GH_FIXTURE);
}

// Low-level primitives, authored as `category: "utility"` macros. The MCP
// server (`macrokit mcp`) exposes each as its own tool, so an agent can do the
// raw workflow when no macro fits — exactly the calls `macrokit gate` flags
// when 3+ pile up without a macro, prompting you to encode one.
const GH_PRIMITIVES = `import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";
import { GitHubClient } from "./github-client.js";

const repo = { owner: z.string().min(1), repo: z.string().min(1) };
function gh(ctx: { tools?: { github?: unknown } }): GitHubClient {
  return (ctx.tools?.github as GitHubClient | undefined) ?? new GitHubClient();
}

export const ghListIssues = defineMacro({
  name: "gh_list_issues",
  intent: "List open issues in a repository (number, title, labels, comment count).",
  category: "utility",
  schema: z.object({ ...repo }),
  handler: async ({ owner, repo: r }, ctx) => gh(ctx).listIssues(owner, r, "open"),
});

export const ghListPulls = defineMacro({
  name: "gh_list_pulls",
  intent: "List open pull requests in a repository, newest first.",
  category: "utility",
  schema: z.object({ ...repo }),
  handler: async ({ owner, repo: r }, ctx) => gh(ctx).listPulls(owner, r, "open"),
});

export const ghListPullFiles = defineMacro({
  name: "gh_list_pull_files",
  intent: "List the files changed in a pull request.",
  category: "utility",
  schema: z.object({ ...repo, number: z.number().int().positive() }),
  handler: async ({ owner, repo: r, number }, ctx) => gh(ctx).listPullFiles(owner, r, number),
});

export const ghSuggestLabelsDryRun = defineMacro({
  name: "gh_suggest_labels_dryrun",
  intent: "DRY-RUN: report which labels WOULD be applied to an issue/PR (never writes).",
  category: "utility",
  schema: z.object({ ...repo, number: z.number().int().positive(), labels: z.array(z.string()) }),
  handler: async ({ owner, repo: r, number, labels }, ctx) => gh(ctx).suggestLabelsDryRun(owner, r, number, labels),
});
`;

const GH_CLIENT = `/**
 * Thin GitHub REST client — PUBLIC repos only, read-mostly. One DRY-RUN write
 * (\`suggestLabelsDryRun\`) that never mutates the repo. No OAuth, no accounts.
 * Macros pull this from \`ctx.tools.github\` (injected by Studio / the runtime),
 * falling back to a fresh client so the macro also runs standalone.
 */
const GH_API = "https://api.github.com";

export interface GitHubClientOptions {
  token?: string;
  fetch?: typeof fetch;
}

export interface IssueSummary {
  number: number;
  title: string;
  labels: string[];
  comments: number;
  createdAt: string;
}

export interface PullSummary {
  number: number;
  title: string;
  user: string;
  createdAt: string;
  draft: boolean;
}

export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

export class GitHubClient {
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GitHubClientOptions = {}) {
    if (opts.token) this.token = opts.token;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async listIssues(owner: string, repo: string, state = "open"): Promise<IssueSummary[]> {
    const arr = await this.get<Array<Record<string, unknown>>>(
      \`/repos/\${owner}/\${repo}/issues?state=\${encodeURIComponent(state)}&per_page=20\`,
    );
    return arr
      .filter((i) => i.pull_request === undefined)
      .map((i) => ({
        number: Number(i.number),
        title: String(i.title ?? ""),
        labels: ((i.labels as Array<Record<string, unknown>>) ?? []).map((l) => String(l.name ?? "")),
        comments: Number(i.comments ?? 0),
        createdAt: String(i.created_at ?? ""),
      }));
  }

  async listPulls(owner: string, repo: string, state = "open"): Promise<PullSummary[]> {
    const arr = await this.get<Array<Record<string, unknown>>>(
      \`/repos/\${owner}/\${repo}/pulls?state=\${encodeURIComponent(state)}&per_page=20&sort=created&direction=desc\`,
    );
    return arr.map((p) => ({
      number: Number(p.number),
      title: String(p.title ?? ""),
      user: String((p.user as Record<string, unknown> | null)?.login ?? "unknown"),
      createdAt: String(p.created_at ?? ""),
      draft: Boolean(p.draft),
    }));
  }

  async listPullFiles(owner: string, repo: string, n: number): Promise<PullFile[]> {
    const arr = await this.get<Array<Record<string, unknown>>>(
      \`/repos/\${owner}/\${repo}/pulls/\${n}/files?per_page=50\`,
    );
    return arr.map((f) => ({
      filename: String(f.filename ?? ""),
      status: String(f.status ?? ""),
      additions: Number(f.additions ?? 0),
      deletions: Number(f.deletions ?? 0),
    }));
  }

  /** DRY-RUN: report which labels WOULD be applied. Never writes. */
  suggestLabelsDryRun(owner: string, repo: string, n: number, labels: string[]) {
    return {
      dryRun: true as const,
      target: \`\${owner}/\${repo}#\${n}\`,
      wouldApply: labels,
      note: "dry-run — no write performed",
    };
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(\`\${GH_API}\${path}\`, { headers: this.headers() });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(\`GitHub \${res.status} on \${path}\${body ? ": " + body.slice(0, 200) : ""}\`);
    }
    return (await res.json()) as T;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "macrokit-project",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.token) h.Authorization = \`Bearer \${this.token}\`;
    return h;
  }
}
`;

const GH_MACRO_SUMMARIZE = `import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";
import { GitHubClient } from "../primitives/github-client.js";

/**
 * Seeded starter macro. A single read-only step — the most reliable task for a
 * weak model to route to. Edit it, or add your own files alongside it.
 */
export const summarizeOpenIssues = defineMacro({
  name: "summarize_open_issues",
  intent:
    "Summarize the open issues in a repository: list current open issues with " +
    "their labels and comment counts. Use for requests like 'what issues are " +
    "open' or 'summarize the open issues'.",
  schema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
  }),
  handler: async ({ owner, repo }, ctx) => {
    const gh = (ctx.tools?.github as GitHubClient | undefined) ?? new GitHubClient();
    const issues = await gh.listIssues(owner, repo, "open");
    return {
      repo: \`\${owner}/\${repo}\`,
      openIssues: issues.length,
      issues: issues.map((i) => ({
        number: i.number,
        title: i.title,
        labels: i.labels,
        comments: i.comments,
      })),
    };
  },
});
`;

const GH_MACRO_TRIAGE = `import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";
import { GitHubClient } from "../primitives/github-client.js";

/**
 * A multi-step macro: list open PRs → inspect the newest + its files →
 * propose review labels (DRY-RUN, never writes). Encodes the whole workflow
 * so the weak model only has to route to it, never to plan the steps.
 */
export const triageNewestPull = defineMacro({
  name: "triage_newest_pull",
  intent:
    "Triage the newest open pull request in a repository: list open PRs, " +
    "inspect the newest one and the files it changes, then propose review " +
    "labels (dry-run). Use for requests like 'triage the latest PR'.",
  schema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
  }),
  handler: async ({ owner, repo }, ctx) => {
    const gh = (ctx.tools?.github as GitHubClient | undefined) ?? new GitHubClient();
    const pulls = await gh.listPulls(owner, repo, "open");
    const newest = pulls[0];
    if (!newest) {
      return { repo: \`\${owner}/\${repo}\`, triaged: null, note: "no open pull requests" };
    }
    const files = await gh.listPullFiles(owner, repo, newest.number);
    const labels = proposeLabels(newest.title, files);
    const dryRun = gh.suggestLabelsDryRun(owner, repo, newest.number, labels);
    return {
      repo: \`\${owner}/\${repo}\`,
      triaged: { number: newest.number, title: newest.title, changedFiles: files.length },
      proposedLabels: labels,
      dryRun,
    };
  },
});

/** Tiny heuristic: title prefix + file shape → review labels. */
function proposeLabels(title: string, files: ReadonlyArray<{ filename: string }>): string[] {
  const labels = new Set<string>(["needs-review"]);
  const t = title.toLowerCase();
  if (/^(fix|bug)\\b|\\bfix:/.test(t)) labels.add("bug");
  else if (/^(feat|add)\\b|\\bfeat:/.test(t)) labels.add("enhancement");
  if (files.every((f) => f.filename.endsWith(".md") || f.filename.startsWith("docs/"))) {
    labels.add("documentation");
  }
  if (files.some((f) => /\\.(test|spec)\\.[jt]sx?$/.test(f.filename))) labels.add("tests");
  return [...labels];
}
`;

const GH_FIXTURE = JSON.stringify(
  {
    repo: "octocat/hello-world",
    issues: [
      { number: 51, title: "Flaky upload test", labels: ["bug"], comments: 4, createdAt: "2026-05-20T00:00:00Z" },
      { number: 47, title: "Document the retry policy", labels: ["documentation"], comments: 1, createdAt: "2026-05-18T00:00:00Z" },
    ],
    pulls: [
      { number: 42, title: "Add retry/backoff to uploader", user: "alice", createdAt: "2026-05-24T10:00:00Z", draft: false },
      { number: 39, title: "Fix docs typo", user: "bob", createdAt: "2026-05-23T08:00:00Z", draft: false },
    ],
    pullFiles: {
      "42": [
        { filename: "src/uploader.ts", status: "modified", additions: 100, deletions: 6 },
        { filename: "test/uploader.test.ts", status: "added", additions: 20, deletions: 2 },
      ],
    },
  },
  null,
  2,
) + "\n";
