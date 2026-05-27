import { defineMacro } from "@macrokit/authoring";
import type { BrowserService } from "@macrokit/browser";
import { z } from "zod";

/**
 * The one browser-driven macro in this reference implementation.
 *
 * GitHub Actions DOES have an API for workflow run logs
 * (GET /repos/.../actions/runs/{id}/logs returns a zip). What it does NOT
 * give you is the rendered, color-stripped, group-expanded log text that
 * a maintainer actually reads in the UI to debug a long-running job —
 * with step grouping, timing, and "Show all" expansions preserved. This
 * macro captures that.
 *
 * Why this is the right shape for a Macrokit reference impl:
 *
 *   1. The maintainer's mental model of "the log" is the rendered UI text,
 *      not the raw zip. Matching the human's frame of reference matters.
 *   2. It demonstrates that the same macro library can mix API-driven and
 *      browser-driven macros transparently. The runtime doesn't know or
 *      care which is which.
 *   3. It exercises @macrokit/browser end-to-end (navigate + extract text)
 *      against a real, busy, production-grade SPA — not a contrived demo.
 *
 * The macro accepts a BrowserService via ctx.tools.browser so adopters can
 * inject their own (Playwright backend, Chrome-extension backend, etc.).
 * For tests, a fake BrowserService is enough — no chromium download needed.
 */
export const captureWorkflowLog = defineMacro({
  name: "capture_workflow_log",
  intent:
    "Capture the rendered text of a GitHub Actions workflow run's logs by " +
    "driving the github.com UI. Use this when you need the same log view a " +
    "human would see — step grouping, expansions, timing annotations — " +
    "rather than the raw zip the GitHub API provides.",
  schema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    runId: z.number().int().positive(),
    /** Cap the returned text to this many characters. Default 50k. */
    maxChars: z.number().int().positive().default(50_000),
  }),
  handler: async ({ owner, repo, runId, maxChars }, ctx) => {
    const browser = ctx.tools.browser as BrowserService | undefined;
    if (!browser) {
      throw new Error(
        "capture_workflow_log requires a BrowserService at ctx.tools.browser. " +
          "Wire @macrokit/browser's PlaywrightBrowserService into Runtime.toolSurfaces.",
      );
    }
    const url = `https://github.com/${owner}/${repo}/actions/runs/${runId}`;
    await browser.navigate(url, { waitFor: "networkidle" });

    // The logs container has a stable data-testid on the run view as of
    // 2026-05; fall back to <main>, then to full body text if GitHub
    // changes the UI underneath us. Selector failures throw; empty results
    // are treated as "missed, try next."
    let text = "";
    for (const sel of ["[data-testid='checks-run-summary-content']", "main"]) {
      try {
        const t = await browser.getText(sel);
        if (t && t.length > 0) {
          text = t;
          break;
        }
      } catch {
        // try next selector
      }
    }
    if (text.length === 0) {
      try {
        text = await browser.getText();
      } catch {
        text = "";
      }
    }
    const truncated = text.length > maxChars;
    return {
      url,
      runId,
      truncated,
      chars: Math.min(text.length, maxChars),
      text: truncated ? text.slice(0, maxChars) : text,
    };
  },
});
