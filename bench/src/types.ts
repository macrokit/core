export type Bucket =
  | "triage_pull_request"
  | "triage_issue"
  | "generate_release_notes"
  | "close_stale_issues"
  | "suggest_reviewers"
  | "capture_workflow_log"
  | "no_macro"
  | "ambiguous_multi_intent";

export type Difficulty =
  | "easy_direct"
  | "medium_paraphrase"
  | "hard_implicit"
  | "hard_distractor";

export interface Expected {
  /** null = the model should answer in free text, no tool call expected. */
  tool: string | null;
  args?: Record<string, unknown>;
}

export interface Task {
  id: string;
  bucket: Bucket;
  difficulty: Difficulty;
  prompt: string;
  expected: Expected;
  notes?: string;
  /**
   * For ambiguous_multi_intent tasks: the alternative tool a maintainer
   * might reasonably pick. Half credit awarded if the model picks this.
   */
  alternative?: { tool: string; args?: Record<string, unknown> };
}

export type Verdict =
  | "full"        // 2 points: tool + args match
  | "tool_only"   // 1 point: tool matched, args wrong
  | "half"        // 1 point: picked the documented alternative on an ambiguous task
  | "miss";       // 0 points: wrong tool or no tool when expected, or vice versa

export interface TaskResult {
  taskId: string;
  bucket: Bucket;
  difficulty: Difficulty;
  prompt: string;
  expected: Expected;
  actualTool: string | null;
  actualArgs: Record<string, unknown> | undefined;
  verdict: Verdict;
  toolScore: number; // 0, 0.5, or 1
  argsScore: number; // 0 or 1
  bailOutCode: string | null;
  latencyMs: number;
  rawText: string;
  errorMessage?: string;
}

export interface RunHeader {
  modelId: string;
  modelDisplay: string;
  llmProvider: string;
  baseUrl?: string;
  startedAt: string;
  harnessCommit?: string;
  corpusCommit?: string;
  notes?: string;
}

export interface RunSummary {
  header: RunHeader;
  taskCount: number;
  totalScore: number;
  maxScore: number;
  percent: number;
  bucketBreakdown: Record<string, { total: number; max: number; percent: number; count: number }>;
  difficultyBreakdown: Record<string, { total: number; max: number; percent: number; count: number }>;
  bailOutCount: number;
  bailOutBreakdown: Record<string, number>;
  meanLatencyMs: number;
  finishedAt: string;
}
