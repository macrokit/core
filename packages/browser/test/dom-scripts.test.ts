/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  collectInteractiveElements,
  injectBadges,
  removeBadges,
} from "../src/dom-scripts.js";

function setBody(html: string): void {
  document.body.innerHTML = html;
}

// jsdom doesn't compute layout, so getBoundingClientRect returns zeros.
// Stub it so isVisible() and badge positioning have something to work with.
function stubLayout(rect: { width: number; height: number; left: number; top: number } = {
  width: 100,
  height: 24,
  left: 10,
  top: 10,
}): void {
  Element.prototype.getBoundingClientRect = function () {
    return {
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    } as DOMRect;
  };
}

beforeEach(() => {
  stubLayout();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("collectInteractiveElements", () => {
  it("finds buttons, links, inputs, and textareas in DOM order", () => {
    setBody(`
      <a href="/x">Home</a>
      <button>Save</button>
      <input type="text" name="email" placeholder="you@example.com">
      <textarea aria-label="bio"></textarea>
    `);
    const items = collectInteractiveElements();
    expect(items.map((i) => [i.index, i.role, i.label])).toEqual([
      [1, "link", "Home"],
      [2, "button", "Save"],
      [3, "textbox", "you@example.com"],
      [4, "textbox", "bio"],
    ]);
  });

  it("respects role attributes overriding tag inference", () => {
    setBody(`
      <div role="button" tabindex="0">Fancy Btn</div>
      <span role="link">Fake Link</span>
    `);
    const items = collectInteractiveElements();
    expect(items.find((i) => i.label === "Fancy Btn")?.role).toBe("button");
    expect(items.find((i) => i.label === "Fake Link")?.role).toBe("link");
  });

  it("skips hidden and zero-sized elements", () => {
    setBody(`
      <button>Visible</button>
      <button style="display:none">Hidden display</button>
      <button style="visibility:hidden">Hidden vis</button>
      <button style="opacity:0">Transparent</button>
    `);
    const items = collectInteractiveElements();
    expect(items.map((i) => i.label)).toEqual(["Visible"]);
  });

  it("returns x,y at the element center", () => {
    stubLayout({ width: 200, height: 40, left: 50, top: 100 });
    setBody(`<button>Click</button>`);
    const [item] = collectInteractiveElements();
    expect(item).toMatchObject({ x: 150, y: 120 });
  });

  it("prefers aria-label over text content for the label", () => {
    setBody(`<button aria-label="Close dialog">×</button>`);
    const [item] = collectInteractiveElements();
    expect(item?.label).toBe("Close dialog");
  });

  it("falls back to img alt when an anchor wraps an image", () => {
    setBody(`<a href="/logo"><img alt="Macrokit logo" /></a>`);
    const [item] = collectInteractiveElements();
    expect(item?.label).toBe("Macrokit logo");
  });

  it("produces a CSS selector that re-finds the element", () => {
    setBody(`<div><div><button class="primary big">Save</button></div></div>`);
    const [item] = collectInteractiveElements();
    expect(item?.selector).toBeTruthy();
    const found = document.querySelector(item!.selector);
    expect(found?.textContent).toBe("Save");
  });

  it("uses #id selector when available", () => {
    setBody(`<button id="submit-btn">Submit</button>`);
    const [item] = collectInteractiveElements();
    expect(item?.selector).toBe("#submit-btn");
  });
});

describe("injectBadges / removeBadges", () => {
  it("adds an overlay div containing one badge per item", () => {
    setBody(`<button>One</button><button>Two</button>`);
    const items = collectInteractiveElements();
    const rootId = injectBadges(items);
    const root = document.getElementById(rootId)!;
    expect(root).toBeTruthy();
    expect(root.children.length).toBe(2);
    expect(root.children[0]?.textContent).toBe("1");
    expect(root.children[1]?.textContent).toBe("2");
  });

  it("is idempotent — repeat calls replace the previous overlay", () => {
    setBody(`<button>Solo</button>`);
    const items = collectInteractiveElements();
    injectBadges(items);
    injectBadges(items);
    const overlays = document.querySelectorAll("#__macrokit_overlay__");
    expect(overlays.length).toBe(1);
  });

  it("removeBadges cleans up the overlay", () => {
    setBody(`<button>X</button>`);
    const items = collectInteractiveElements();
    injectBadges(items);
    removeBadges();
    expect(document.getElementById("__macrokit_overlay__")).toBeNull();
  });

  it("removeBadges is safe to call when no overlay exists", () => {
    expect(() => removeBadges()).not.toThrow();
  });
});
