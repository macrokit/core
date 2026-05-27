/**
 * Browser-service types — the surface a macro author and the runtime see.
 * The Playwright backend (and any future backend) implements these.
 */

export type ActionRole =
  | "button"
  | "link"
  | "textbox"
  | "checkbox"
  | "radio"
  | "combobox"
  | "menuitem"
  | "tab"
  | "other";

/**
 * One interactive element on a page, in the form a weak LLM can act on:
 * a stable label, a role, a numeric handle (for the screenshot variant),
 * and a CSS selector (for direct clicks bypassing the screenshot).
 */
export interface ActionItem {
  /** 1-based index, in DOM order. Used as the "click number" by the LLM. */
  index: number;
  /** Short human-readable label — visible text or aria-label. */
  label: string;
  /** Semantic role. */
  role: ActionRole;
  /** CSS selector that targets this element. */
  selector: string;
  /** Page coordinate of the element's center. */
  x: number;
  y: number;
  /** Original aria-label, if any. */
  ariaLabel?: string;
  /** Tag name (lowercase). */
  tag: string;
}

export interface ActionMenu {
  url: string;
  title: string;
  items: ActionItem[];
}

export interface AnnotatedScreenshot {
  /** PNG bytes. */
  image: Buffer;
  /** Same index data as ActionMenu.items — what the badge numbers map to. */
  items: ActionItem[];
  url: string;
  title: string;
}

/**
 * Backend-agnostic surface a macro handler calls. The Playwright backend is
 * the default implementation; a Chrome-extension backend is planned for
 * post-launch.
 */
export interface BrowserService {
  /** Navigate to a URL and wait for the configured load state. */
  navigate(url: string, opts?: { waitFor?: "load" | "domcontentloaded" | "networkidle" }): Promise<void>;

  /** Pure-DOM action menu — cheap, no screenshot. Preferred when the page is not image-only. */
  extractActionMenu(): Promise<ActionMenu>;

  /** Annotated screenshot — page rendered with numbered badges + index. */
  annotatedScreenshot(): Promise<AnnotatedScreenshot>;

  /** Click an item by its index (returned in the action menu / screenshot). */
  clickIndex(index: number): Promise<void>;

  /** Type into the focused / selector-matched element. */
  type(selector: string, text: string): Promise<void>;

  /**
   * Return the visible text content of the page or a specific element.
   * Pass a CSS selector to scope to one node; omit it to return the full
   * page body text. Whitespace is collapsed.
   */
  getText(selector?: string): Promise<string>;

  /** Release any held resources (close the page / browser context). */
  close(): Promise<void>;
}
