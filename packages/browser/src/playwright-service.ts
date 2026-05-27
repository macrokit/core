import type { Browser, BrowserContext, Page } from "playwright-core";
import {
  collectInteractiveElements,
  injectBadges,
  type DomActionItem,
} from "./dom-scripts.js";
import type {
  ActionItem,
  ActionMenu,
  AnnotatedScreenshot,
  BrowserService,
} from "./types.js";

export interface PlaywrightBrowserServiceOptions {
  /**
   * Caller-provided Playwright page. Lets adopters share a persistent
   * browser context (cookies, sessions) across macro invocations.
   */
  page: Page;
  /**
   * Optional handles to close in `close()`. If you opened the browser, pass
   * it here so the service can clean up.
   */
  browser?: Browser;
  context?: BrowserContext;
}

/**
 * Playwright-backed BrowserService. Adopters supply the Page; the service
 * adds annotated-screenshot + action-menu primitives on top of it.
 *
 * Why caller-provided page: production macros usually need a persistent,
 * authenticated browser context. Making the service own the browser would
 * either lose that or force every macro to wrangle Playwright directly.
 */
export class PlaywrightBrowserService implements BrowserService {
  private readonly page: Page;
  private readonly browser?: Browser;
  private readonly context?: BrowserContext;

  constructor(opts: PlaywrightBrowserServiceOptions) {
    this.page = opts.page;
    if (opts.browser !== undefined) this.browser = opts.browser;
    if (opts.context !== undefined) this.context = opts.context;
  }

  async navigate(
    url: string,
    opts: { waitFor?: "load" | "domcontentloaded" | "networkidle" } = {},
  ): Promise<void> {
    await this.page.goto(url, { waitUntil: opts.waitFor ?? "domcontentloaded" });
  }

  async extractActionMenu(): Promise<ActionMenu> {
    const items = await this.page.evaluate(collectInteractiveElements);
    const url = this.page.url();
    const title = await this.page.title();
    return { url, title, items: items.map(toActionItem) };
  }

  async annotatedScreenshot(): Promise<AnnotatedScreenshot> {
    const items = await this.page.evaluate(collectInteractiveElements);
    await this.page.evaluate(injectBadges, items);
    try {
      const image = await this.page.screenshot({ fullPage: false, type: "png" });
      const url = this.page.url();
      const title = await this.page.title();
      return { image, items: items.map(toActionItem), url, title };
    } finally {
      // Always clean up the overlay, even if screenshot threw.
      await this.page
        .evaluate(() => {
          document.getElementById("__macrokit_overlay__")?.remove();
        })
        .catch(() => undefined);
    }
  }

  async clickIndex(index: number): Promise<void> {
    const items = (await this.page.evaluate(collectInteractiveElements)) as DomActionItem[];
    const target = items.find((i) => i.index === index);
    if (!target) {
      throw new Error(
        `clickIndex(${index}): no interactive element with that index. ` +
          `Re-run extractActionMenu() to get a fresh list (the page may have changed).`,
      );
    }
    // Prefer the selector — coordinates can drift if the page reflows.
    const locator = this.page.locator(target.selector).first();
    await locator.click();
  }

  async type(selector: string, text: string): Promise<void> {
    await this.page.locator(selector).first().fill(text);
  }

  async getText(selector?: string): Promise<string> {
    const raw = selector
      ? ((await this.page.locator(selector).first().textContent()) ?? "")
      : await this.page.evaluate(() => document.body.innerText);
    return raw.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  async close(): Promise<void> {
    // Don't close the page if we don't own the browser — that would clobber
    // the caller's session.
    if (this.context) await this.context.close().catch(() => undefined);
    if (this.browser) await this.browser.close().catch(() => undefined);
  }
}

function toActionItem(d: DomActionItem): ActionItem {
  const out: ActionItem = {
    index: d.index,
    label: d.label,
    role: d.role,
    selector: d.selector,
    x: d.x,
    y: d.y,
    tag: d.tag,
  };
  if (d.ariaLabel !== undefined) out.ariaLabel = d.ariaLabel;
  return out;
}
