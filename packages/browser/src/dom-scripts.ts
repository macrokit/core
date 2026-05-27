/**
 * Pure DOM-side functions that run *inside* a page (via Playwright's
 * page.evaluate() or as injected scripts).
 *
 * IMPORTANT: each top-level exported function must be SELF-CONTAINED — all
 * helpers are nested inside the function body. Playwright serializes a
 * function via .toString() and runs the source in the browser, so anything
 * referenced from outer scope is undefined at runtime in the browser.
 *
 * For the same reason these functions take all their inputs as arguments
 * and do not import anything from elsewhere in the package.
 */

export interface DomActionItem {
  index: number;
  label: string;
  role:
    | "button"
    | "link"
    | "textbox"
    | "checkbox"
    | "radio"
    | "combobox"
    | "menuitem"
    | "tab"
    | "other";
  selector: string;
  x: number;
  y: number;
  ariaLabel?: string;
  tag: string;
}

/**
 * Find all visible interactive elements in DOM order. Returns an array of
 * DomActionItem with 1-based indices. Pure read-only — no DOM mutation.
 *
 * Self-contained for Playwright serialization.
 */
export function collectInteractiveElements(): DomActionItem[] {
  type Role = DomActionItem["role"];

  function isVisible(el: Element): boolean {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const win = el.ownerDocument?.defaultView ?? window;
    const style = win.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (parseFloat(style.opacity || "1") === 0) return false;
    return true;
  }

  function labelOf(el: Element): string {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim().slice(0, 80);

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const labelEl = el.ownerDocument?.getElementById(labelledBy);
      const t = labelEl?.textContent?.trim();
      if (t) return t.slice(0, 80);
    }

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.placeholder) return el.placeholder.slice(0, 80);
      if (el.name) return el.name.slice(0, 80);
    }

    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text) return text.slice(0, 80);

    const alt = el.querySelector("img")?.getAttribute("alt");
    if (alt) return alt.slice(0, 80);

    return "(no label)";
  }

  function roleOf(el: Element): Role {
    const explicit = el.getAttribute("role");
    if (
      explicit === "button" ||
      explicit === "link" ||
      explicit === "textbox" ||
      explicit === "checkbox" ||
      explicit === "radio" ||
      explicit === "combobox" ||
      explicit === "menuitem" ||
      explicit === "tab"
    ) {
      return explicit;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = (el as HTMLInputElement).type;
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "submit" || t === "button" || t === "reset") return "button";
      return "textbox";
    }
    return "other";
  }

  function cssEscape(s: string): string {
    return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  }

  function cssSelector(el: Element): string {
    if (el.id) return `#${cssEscape(el.id)}`;
    const path: string[] = [];
    let cur: Element | null = el;
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      let seg = cur.tagName.toLowerCase();
      const cls = (cur.getAttribute("class") || "")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map(cssEscape)
        .join(".");
      if (cls) seg += `.${cls}`;
      const parent = cur.parentElement;
      if (parent) {
        const ref: Element = cur;
        const siblings = Array.from(parent.children).filter(
          (s) => s.tagName === ref.tagName,
        );
        if (siblings.length > 1) {
          seg += `:nth-of-type(${siblings.indexOf(ref) + 1})`;
        }
      }
      path.unshift(seg);
      cur = cur.parentElement;
      if (path.length > 6) break;
    }
    return path.join(" > ");
  }

  const selectors = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "select",
    "textarea",
    "[role=button]",
    "[role=link]",
    "[role=textbox]",
    "[role=checkbox]",
    "[role=radio]",
    "[role=combobox]",
    "[role=menuitem]",
    "[role=tab]",
    "[contenteditable=true]",
    "[tabindex]:not([tabindex=\"-1\"])",
  ].join(",");

  const seen = new Set<Element>();
  const elements: Element[] = [];
  document.querySelectorAll(selectors).forEach((el) => {
    if (seen.has(el)) return;
    seen.add(el);
    if (!isVisible(el)) return;
    elements.push(el);
  });

  const items: DomActionItem[] = [];
  elements.forEach((el, i) => {
    const rect = el.getBoundingClientRect();
    const ariaLabel = el.getAttribute("aria-label") ?? undefined;
    const item: DomActionItem = {
      index: i + 1,
      label: labelOf(el),
      role: roleOf(el),
      selector: cssSelector(el),
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      tag: el.tagName.toLowerCase(),
    };
    if (ariaLabel !== undefined) item.ariaLabel = ariaLabel;
    items.push(item);
  });
  return items;
}

/**
 * Inject a numbered-badge overlay onto each item. Returns the overlay's
 * root element id so the caller can remove it after the screenshot.
 *
 * Self-contained for Playwright serialization.
 */
export function injectBadges(items: DomActionItem[], rootId = "__macrokit_overlay__"): string {
  document.getElementById(rootId)?.remove();

  const root = document.createElement("div");
  root.id = rootId;
  root.style.cssText = [
    "position:fixed",
    "inset:0",
    "pointer-events:none",
    "z-index:2147483647",
  ].join(";");

  items.forEach((item) => {
    const el = document.querySelector(item.selector);
    if (!el) return;
    const rect = (el as Element).getBoundingClientRect();
    const badge = document.createElement("div");
    badge.textContent = String(item.index);
    badge.style.cssText = [
      "position:absolute",
      `left:${Math.max(0, rect.left - 4)}px`,
      `top:${Math.max(0, rect.top - 4)}px`,
      "min-width:18px",
      "height:18px",
      "padding:0 4px",
      "background:#F97316",
      "color:#fff",
      "border-radius:3px",
      "font:600 12px/18px ui-sans-serif,system-ui,sans-serif",
      "text-align:center",
      "box-shadow:0 1px 2px rgba(0,0,0,0.25)",
      "pointer-events:none",
    ].join(";");
    root.appendChild(badge);
  });

  document.body.appendChild(root);
  return rootId;
}

/**
 * Remove a previously injected badge overlay. Self-contained.
 */
export function removeBadges(rootId = "__macrokit_overlay__"): void {
  document.getElementById(rootId)?.remove();
}
