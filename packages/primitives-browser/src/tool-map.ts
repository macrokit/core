/**
 * tool-map.ts — the SINGLE source of truth that maps the clean `browser`
 * surface onto the underlying browser-mcp server's actual tool names.
 *
 * v1 targets the `browser-mcp` server specifically (tool names are
 * authoritative, taken from its Playwright tool surface). To ride a different
 * browser MCP server later (e.g. Playwright-MCP) you change THIS map and the
 * arg-builders below — nothing else in the package hard-codes a tool name.
 */

/** Logical operations the surface exposes, in one place. */
export type BrowserOp =
  | "navigate"
  | "getText"
  | "getAttribute"
  | "fill"
  | "click"
  | "selectOption"
  | "pressKey"
  | "uploadFile"
  | "waitFor"
  | "currentUrl"
  | "snapshot"
  | "screenshot"
  | "eval"
  | "openTab"
  | "listTabs"
  | "closeTab";

/**
 * Logical-op → browser-mcp tool name. The ONLY place tool names live.
 * Swap the values to retarget a different browser MCP server.
 */
export const TOOL_NAMES: Record<BrowserOp, string> = {
  navigate: "browser_navigate",
  getText: "browser_get_text",
  getAttribute: "browser_get_attribute",
  fill: "browser_fill",
  click: "browser_click",
  selectOption: "browser_select_option",
  pressKey: "browser_press_key",
  uploadFile: "browser_upload_file",
  waitFor: "browser_wait_for",
  currentUrl: "browser_current_url",
  snapshot: "browser_snapshot",
  screenshot: "browser_screenshot",
  eval: "browser_eval",
  openTab: "browser_open_tab",
  listTabs: "browser_list_tabs",
  closeTab: "browser_close_tab",
};
