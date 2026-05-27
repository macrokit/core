/**
 * Tests for the browser-driven macro. Uses a FakeBrowserService — no
 * chromium download, no real network. The point is to lock down the
 * handler's contract with @macrokit/browser, not to test Playwright
 * itself (the @macrokit/browser package owns that).
 */
import { describe, it, expect } from "vitest";
import { SessionLog, type MacroContext } from "@macrokit/runtime";
import type {
  ActionMenu,
  AnnotatedScreenshot,
  BrowserService,
} from "@macrokit/browser";
import { captureWorkflowLog } from "../src/macros/capture-workflow-log.js";

class FakeBrowserService implements BrowserService {
  navigatedTo: string | null = null;
  selectorRequested: string | null = null;
  fullBodyRequested = false;

  constructor(
    /** What getText returns, keyed by selector. `null` key = full-body. */
    private readonly texts: Record<string, string>,
    private readonly throwOn: Set<string> = new Set(),
  ) {}

  async navigate(url: string): Promise<void> {
    this.navigatedTo = url;
  }
  async extractActionMenu(): Promise<ActionMenu> {
    return { url: this.navigatedTo ?? "", title: "", items: [] };
  }
  async annotatedScreenshot(): Promise<AnnotatedScreenshot> {
    return {
      image: Buffer.alloc(0),
      items: [],
      url: this.navigatedTo ?? "",
      title: "",
    };
  }
  async clickIndex(): Promise<void> {}
  async type(): Promise<void> {}
  async getText(selector?: string): Promise<string> {
    if (selector === undefined) {
      this.fullBodyRequested = true;
      return this.texts["__body__"] ?? "";
    }
    this.selectorRequested = selector;
    if (this.throwOn.has(selector)) throw new Error(`no match for ${selector}`);
    return this.texts[selector] ?? "";
  }
  async close(): Promise<void> {}
}

function makeCtx(browser: BrowserService): MacroContext {
  return {
    log: new SessionLog(),
    tools: { browser },
    signal: new AbortController().signal,
  };
}

describe("capture_workflow_log", () => {
  it("navigates to the run URL and returns the primary selector's text", async () => {
    const fake = new FakeBrowserService({
      "[data-testid='checks-run-summary-content']":
        "Step 1: setup — pass\nStep 2: build — pass\nStep 3: test — FAIL\n  expected 1, got 2",
    });
    const result = await captureWorkflowLog.handler(
      { owner: "macrokit", repo: "core", runId: 123456, maxChars: 50_000 },
      makeCtx(fake),
    );
    expect(fake.navigatedTo).toBe("https://github.com/macrokit/core/actions/runs/123456");
    expect(result.url).toBe("https://github.com/macrokit/core/actions/runs/123456");
    expect(result.text).toContain("FAIL");
    expect(result.truncated).toBe(false);
    expect(result.chars).toBeGreaterThan(0);
  });

  it("falls back to `main` then to full body when primary selector is empty", async () => {
    const fake = new FakeBrowserService({
      "[data-testid='checks-run-summary-content']": "", // too short → fallback
      main: "fallback text from main section, long enough to be valid",
    });
    const result = await captureWorkflowLog.handler(
      { owner: "x", repo: "y", runId: 1, maxChars: 50_000 },
      makeCtx(fake),
    );
    expect(result.text).toContain("fallback text from main");
  });

  it("falls back to body when both selectors throw", async () => {
    const fake = new FakeBrowserService(
      { __body__: "ultimate body text" },
      new Set(["[data-testid='checks-run-summary-content']", "main"]),
    );
    const result = await captureWorkflowLog.handler(
      { owner: "x", repo: "y", runId: 1, maxChars: 50_000 },
      makeCtx(fake),
    );
    expect(result.text).toBe("ultimate body text");
  });

  it("truncates to maxChars and reports truncated=true", async () => {
    const fake = new FakeBrowserService({
      "[data-testid='checks-run-summary-content']": "X".repeat(10_000),
    });
    const result = await captureWorkflowLog.handler(
      { owner: "x", repo: "y", runId: 1, maxChars: 100 },
      makeCtx(fake),
    );
    expect(result.text).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(result.chars).toBe(100);
  });

  it("errors loudly when no BrowserService is wired", async () => {
    const ctx: MacroContext = {
      log: new SessionLog(),
      tools: {},
      signal: new AbortController().signal,
    };
    await expect(
      captureWorkflowLog.handler(
        { owner: "x", repo: "y", runId: 1, maxChars: 100 },
        ctx,
      ),
    ).rejects.toThrow(/BrowserService/);
  });
});
