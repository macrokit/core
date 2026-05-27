import type { CompleteResult, ToolSpec } from "./types.js";

/**
 * The bail-out detector catches the small, well-known set of failure modes
 * weak LLMs exhibit when they are out of their depth. See docs/THE_PATTERN.md §4.
 *
 * Each detector returns either { fired: false } or a structured fire with a
 * stable `code` so callers can route on the code rather than the prose.
 */

export type BailOutCode =
  | "tool_call_as_text"
  | "unknown_tool"
  | "repeated_tool_call"
  | "no_tool_when_required"
  | "explicit_escalation";

export interface BailOutFire {
  fired: true;
  code: BailOutCode;
  message: string;
  hint: string;
}

export interface BailOutPass {
  fired: false;
}

export type BailOutResult = BailOutFire | BailOutPass;

const PASS: BailOutPass = { fired: false };

export interface BailOutDetectorOptions {
  /** Tool specs the router advertised this turn. */
  tools: ToolSpec[];
  /**
   * Recent normalized tool-call history. The most recent call is index 0.
   * Used to detect repeat-loops.
   */
  recentToolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  /** Most recent user message — used for explicit-escalation phrases. */
  userMessage?: string;
  /**
   * If true, the detector treats "no tool call AND tools were available" as
   * a fire. Off by default — many turns are valid free-form answers.
   */
  requireToolCall?: boolean;
}

/**
 * Detector entry point. Pass the adapter's CompleteResult plus context;
 * receive either PASS or a structured fire.
 */
export function detectBailOut(
  result: CompleteResult,
  opts: BailOutDetectorOptions,
): BailOutResult {
  // 1. Explicit user escalation: user asked for the strong model.
  if (opts.userMessage && EXPLICIT_ESCALATION.test(opts.userMessage)) {
    return {
      fired: true,
      code: "explicit_escalation",
      message: "User explicitly asked to escalate this turn.",
      hint: "Route this turn to the configured fallback adapter (frontier API).",
    };
  }

  // 2. Tool call printed as text instead of structured tool_calls.
  if (result.toolCalls.length === 0 && looksLikeToolCallText(result.text)) {
    return {
      fired: true,
      code: "tool_call_as_text",
      message:
        "Model emitted what looks like a tool call as plain text instead of " +
        "a structured tool_calls field.",
      hint:
        "Re-prompt with an explicit reminder that tool calls must be emitted " +
        "in the structured tool_calls field, not as JSON in content.",
    };
  }

  // 3. Tool name not in the advertised set.
  const validNames = new Set(opts.tools.map((t) => t.name));
  for (const tc of result.toolCalls) {
    if (!validNames.has(tc.name)) {
      return {
        fired: true,
        code: "unknown_tool",
        message: `Model called tool "${tc.name}" which is not in the advertised set.`,
        hint:
          `Re-prompt listing valid tools: ${[...validNames].join(", ")}. ` +
          "If the user's intent matches none, return a free-form response instead.",
      };
    }
  }

  // 4. Repeat-loop: same tool with same args as the most-recent call.
  if (opts.recentToolCalls && opts.recentToolCalls.length > 0 && result.toolCalls[0]) {
    const last = opts.recentToolCalls[0]!;
    const current = result.toolCalls[0];
    if (
      current.name === last.name &&
      stableStringify(current.args) === stableStringify(last.args)
    ) {
      return {
        fired: true,
        code: "repeated_tool_call",
        message:
          `Model called "${current.name}" with identical arguments twice in a row.`,
        hint:
          "The previous call's result is already in the transcript. Surface " +
          "the result to the user, or escalate to the fallback adapter.",
      };
    }
  }

  // 5. No tool call when caller required one.
  if (opts.requireToolCall && result.toolCalls.length === 0) {
    return {
      fired: true,
      code: "no_tool_when_required",
      message:
        "Caller required a tool call this turn but the model returned " +
        "free-form text instead.",
      hint:
        "Re-prompt with tool_choice='required', or escalate to a stronger " +
        "adapter for this turn.",
    };
  }

  return PASS;
}

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

/**
 * Recognizes shapes a weak model uses when it intends a tool call but emits
 * it as content:
 *   - JSON object whose first key is `name`/`tool`/`function`/`action`
 *   - "tool_call: name(args)" style
 *   - bare "`function_call`" markdown fence opener
 *
 * Kept short and documented; adopters extend by passing their own custom
 * detector around this one.
 */
const TOOL_CALL_TEXT_PATTERNS: RegExp[] = [
  /^\s*\{?\s*"?(tool|name|function|action|tool_call)"?\s*:/i,
  /^\s*tool[_ ]?call\s*[:=]/i,
  /^\s*```(json|tool_call|function_call)\s*$/im,
];

function looksLikeToolCallText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  return TOOL_CALL_TEXT_PATTERNS.some((re) => re.test(trimmed));
}

const EXPLICIT_ESCALATION =
  /\b(use|switch to|try|fall ?back to)\s+(claude|gpt[- ]?4o?|sonnet|opus|the (better|strong(er)?|smart(er)?) model)/i;

function stableStringify(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  return JSON.stringify(
    keys.reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = obj[k];
      return acc;
    }, {}),
  );
}
