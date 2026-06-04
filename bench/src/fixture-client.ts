/**
 * Independent-value test (see INDEPENDENT_VALUE_PREREGISTRATION.md).
 *
 * A per-item fixtured GitHub client that serves the task's canned data, so the
 * routed macro EXECUTES deterministically and we can score its end-state against
 * hand-authored ground truth (independent of the routing confusion matrix). Plus
 * the frozen V scorers for both conditions.
 */
import type { GitHubClient } from "@macrokit-example/github-maintainer/src/github-client.js";

export interface OutcomeFixture {
  pr?: {
    number: number; title: string; body: string | null; user: { login: string };
    html_url: string; draft: boolean; labels: Array<{ name: string }>;
  };
  files?: Array<{ filename: string; status: string; additions: number; deletions: number }>;
  issue?: {
    number: number; title: string; body: string | null; user: { login: string };
    html_url: string; labels: Array<{ name: string }>; comments: number;
  };
  openIssues?: Array<{ number: number; title: string }>;
  codeowners?: Array<{ pattern: string; owners: string[] }>;
}

export interface OutcomeTask {
  id: string;
  gold_intent: string;
  prompt: string;
  fixture: OutcomeFixture;
  gold_outcome: { classification?: string; labels?: string[]; reviewers?: string[]; action?: string };
}

/** Records addLabels calls so the macro-ON end-state (and OFF, if reused) is observable. */
export class FixtureGitHubClient {
  readonly addedLabels: string[] = [];
  constructor(private readonly fx: OutcomeFixture) {}

  async getPullRequest() {
    const p = this.fx.pr!;
    return { ...p, state: "open" as const };
  }
  async getPullRequestFiles() {
    return (this.fx.files ?? []).map((f) => ({ ...f, patch: undefined }));
  }
  async getIssue() {
    const i = this.fx.issue!;
    return { ...i, state: "open" as const, updated_at: "2026-01-01T00:00:00Z" };
  }
  async listOpenIssues() {
    return (this.fx.openIssues ?? []).map((i) => ({
      number: i.number, title: i.title, body: null, user: { login: "x" },
      html_url: "", labels: [], state: "open" as const, updated_at: "2026-01-01T00:00:00Z", comments: 0,
    }));
  }
  async getCodeowners() {
    return this.fx.codeowners ?? [];
  }
  async getIssueComments() { return []; }
  async addLabels(_o: string, _r: string, _n: number, labels: string[]) {
    this.addedLabels.push(...labels);
  }
  async closeIssue() {}
  async commentOnIssue() {}
  async compareCommits() { return []; }
}

export function makeFixtureClient(fx: OutcomeFixture): GitHubClient {
  return new FixtureGitHubClient(fx) as unknown as GitHubClient;
}

// ---------------------------------------------------------------------------
// FROZEN V scorers (pre-registration §1)
// ---------------------------------------------------------------------------

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a.map((s) => s.toLowerCase())), B = new Set(b.map((s) => s.toLowerCase()));
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const union = new Set([...A, ...B]).size;
  return union === 0 ? 0 : inter / union;
}

/** macro-ON: score the executed macro's structured output against gold. */
export function scoreOutcomeOn(task: OutcomeTask, routedIntent: string | null, output: unknown): number {
  const gold = task.gold_outcome;
  const gi = task.gold_intent;
  if (gi === "no_macro") {
    // gold = no action: V=1 iff the model dispatched no consequential macro.
    return routedIntent === null || routedIntent === "no_macro" ? 1 : 0;
  }
  if (routedIntent !== gi || !output || typeof output !== "object") return 0;
  const o = output as Record<string, unknown>;
  if (gi === "suggest_reviewers") {
    const produced = (o.suggestedReviewers as string[] | undefined) ?? [];
    return jaccard(produced, gold.reviewers ?? []);
  }
  // triage_pull_request / triage_issue
  const cls = String(o.classification ?? "");
  const produced = (o.suggestedLabels as string[] | undefined) ?? [];
  const clsOk = gold.classification ? (cls === gold.classification ? 0.5 : 0) : 0;
  const labelsOk = (gold.labels ?? []).every((g) => produced.map((x) => x.toLowerCase()).includes(g.toLowerCase())) ? 0.5 : 0;
  return clsOk + labelsOk;
}

/** macro-OFF: extract the end-state from the trajectory args + final text. */
export function scoreOutcomeOff(
  task: OutcomeTask,
  routedIntent: string,
  addedLabels: string[],
  finalText: string,
): number {
  const gold = task.gold_outcome;
  const gi = task.gold_intent;
  const text = finalText.toLowerCase();
  if (gi === "no_macro") {
    return routedIntent === "no_macro" && addedLabels.length === 0 ? 1 : 0;
  }
  if (gi === "suggest_reviewers") {
    const produced = (gold.reviewers ?? []).filter((r) => text.includes(r.toLowerCase()));
    // Jaccard of mentioned-gold vs gold (we can only detect gold logins in free text).
    return jaccard(produced, gold.reviewers ?? []);
  }
  // triage: classification token + label token must appear (in add_labels args or text)
  const haystack = (addedLabels.join(" ") + " " + text).toLowerCase();
  const clsOk = gold.classification && haystack.includes(gold.classification.toLowerCase()) ? 0.5 : 0;
  const labelsOk = (gold.labels ?? []).every((g) => haystack.includes(g.toLowerCase())) ? 0.5 : 0;
  return clsOk + labelsOk;
}
