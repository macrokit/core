/**
 * surface.ts — the generic `browser` tool surface and its factory.
 *
 * This is an MCP **client** adapter (the opposite of @macrokit/mcp's server):
 * it connects to a LOCAL browser-mcp server over stdio and re-exposes that
 * server's tools as a clean, typed surface that Macrokit macros reach via
 * `ctx.tools.browser`. Wire it into the Runtime as
 * `toolSurfaces: { browser: surface }`; a consuming macro then declares
 * `capabilities: ["browser"]` (D-017) to be granted access.
 *
 * Single-machine / local-first by default (D-019): the browser-mcp server runs
 * on the same machine. There is NO SSH here — remote transport is the caller's
 * concern. Tests inject a custom transport so they never open a real browser.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type BrowserOp, TOOL_NAMES } from "./tool-map.js";

/** A single content block returned by an MCP tool (text, image, etc.). */
export interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [k: string]: unknown;
}

/** Normalized result of a browser-mcp tool call. */
export interface BrowserResult {
  /** Concatenated text of every text content block. */
  text: string;
  /** Raw MCP content blocks (preserves images / binary for screenshots). */
  content: ContentBlock[];
  /** True when the underlying tool reported an error. */
  isError: boolean;
}

/**
 * Structured failure raised when a browser-mcp tool reports an error. Carries
 * the logical op, the resolved tool name, and the arguments sent, so a macro's
 * error handler (or the dispatcher) can react without string-scraping.
 */
export class BrowserToolError extends Error {
  readonly op: BrowserOp;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly result: BrowserResult;

  constructor(op: BrowserOp, tool: string, args: Record<string, unknown>, result: BrowserResult) {
    super(`browser.${op} (${tool}) failed: ${result.text || "tool reported an error"}`);
    this.name = "BrowserToolError";
    this.op = op;
    this.tool = tool;
    this.args = args;
    this.result = result;
  }
}

/** The clean, typed `browser` surface macros call via ctx.tools.browser. */
export interface BrowserSurface {
  /** Navigate the active tab to a URL. */
  navigate(url: string): Promise<BrowserResult>;
  /** Read visible text, optionally scoped to a selector. */
  getText(selector?: string): Promise<string>;
  /** Read an attribute from the element matching a selector. */
  getAttribute(selector: string, attr: string): Promise<string>;
  /** Type a value into an input/textarea. */
  fill(selector: string, value: string): Promise<BrowserResult>;
  /** Click the element matching a selector. */
  click(selector: string): Promise<BrowserResult>;
  /** Choose an option in a <select>. */
  selectOption(selector: string, value: string): Promise<BrowserResult>;
  /** Press a key (e.g. "Enter", "Escape"). */
  pressKey(key: string): Promise<BrowserResult>;
  /** Upload a local file to a file input. */
  uploadFile(selector: string, path: string): Promise<BrowserResult>;
  /** Wait for a condition (selector, text, or timeout — passed through). */
  waitFor(condition: string): Promise<BrowserResult>;
  /** Get the active tab's current URL. */
  currentUrl(): Promise<string>;
  /** Accessibility / DOM snapshot of the page (usually text). */
  snapshot(): Promise<BrowserResult>;
  /** Capture a screenshot (image content preserved in `.content`). */
  screenshot(): Promise<BrowserResult>;
  /** Evaluate a JS expression in the page and return its result. */
  eval(expression: string): Promise<string>;
  /** Open a new tab, optionally navigating to a URL. */
  openTab(url?: string): Promise<BrowserResult>;
  /** List open tabs. */
  listTabs(): Promise<BrowserResult>;
  /** Close a tab (by index/id if the server supports it). */
  closeTab(tab?: string | number): Promise<BrowserResult>;
  /**
   * Low-level escape hatch: invoke any logical op with raw args. Use only when
   * a server-specific argument is needed that the typed methods do not surface.
   */
  invoke(op: BrowserOp, args?: Record<string, unknown>): Promise<BrowserResult>;
  /** Disconnect the MCP client and tear down its transport. */
  close(): Promise<void>;
}

/** Options for {@link createBrowserSurface}. */
export interface CreateBrowserSurfaceOptions {
  /**
   * Command to spawn a LOCAL browser-mcp server over stdio (e.g.
   * `{ command: "npx", args: ["browser-mcp"] }`). Used when neither
   * `transport` nor `client` is supplied.
   */
  command?: string;
  /** Arguments for `command`. */
  args?: string[];
  /** Environment for the spawned process. */
  env?: Record<string, string>;
  /** Working directory for the spawned process. */
  cwd?: string;
  /**
   * Inject a pre-built MCP transport instead of spawning. Tests pass an
   * in-memory transport here so no real browser/network is touched.
   */
  transport?: Transport;
  /**
   * Attach to a pre-connected MCP {@link Client} (advanced). If given, the
   * surface uses it as-is and `close()` still disconnects it.
   */
  client?: Client;
  /**
   * browser-mcp profile name (named persistent cookie jar). Threaded into
   * every tool call's arguments. Defaults to "default".
   */
  profile?: string;
  /** Client identity reported to the server. */
  clientInfo?: { name: string; version: string };
}

const DEFAULT_PROFILE = "default";

function normalize(raw: unknown): BrowserResult {
  const r = raw as { content?: ContentBlock[]; isError?: boolean };
  const content = Array.isArray(r?.content) ? r.content : [];
  const text = content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
  return { text, content, isError: r?.isError === true };
}

/**
 * Open a connection to a local browser-mcp server and return the `browser`
 * surface. The caller owns teardown via `surface.close()`.
 */
export async function createBrowserSurface(
  opts: CreateBrowserSurfaceOptions = {},
): Promise<BrowserSurface> {
  const profile = opts.profile ?? DEFAULT_PROFILE;

  let client: Client;
  let ownsClient = true;

  if (opts.client) {
    client = opts.client;
    ownsClient = false;
  } else {
    client = new Client(opts.clientInfo ?? { name: "macrokit-primitives-browser", version: "0.0.1" });
    const transport =
      opts.transport ??
      new StdioClientTransport({
        command: requireCommand(opts.command),
        args: opts.args,
        env: opts.env,
        cwd: opts.cwd,
      });
    await client.connect(transport);
  }

  async function call(op: BrowserOp, args: Record<string, unknown> = {}): Promise<BrowserResult> {
    const tool = TOOL_NAMES[op];
    // browser-mcp scopes every action to a named profile; thread it through
    // unless the caller already specified one in args.
    const argsWithProfile = "profile" in args ? args : { profile, ...args };
    const result = normalize(await client.callTool({ name: tool, arguments: argsWithProfile }));
    if (result.isError) throw new BrowserToolError(op, tool, argsWithProfile, result);
    return result;
  }

  return {
    navigate: (url) => call("navigate", { url }),
    getText: async (selector) => (await call("getText", selector === undefined ? {} : { selector })).text,
    getAttribute: async (selector, attr) =>
      (await call("getAttribute", { selector, attribute: attr })).text,
    fill: (selector, value) => call("fill", { selector, value }),
    click: (selector) => call("click", { selector }),
    selectOption: (selector, value) => call("selectOption", { selector, value }),
    pressKey: (key) => call("pressKey", { key }),
    uploadFile: (selector, path) => call("uploadFile", { selector, path }),
    waitFor: (condition) => call("waitFor", { condition }),
    currentUrl: async () => (await call("currentUrl")).text,
    snapshot: () => call("snapshot"),
    screenshot: () => call("screenshot"),
    eval: async (expression) => (await call("eval", { expression })).text,
    openTab: (url) => call("openTab", url === undefined ? {} : { url }),
    listTabs: () => call("listTabs"),
    closeTab: (tab) => call("closeTab", tab === undefined ? {} : { tab }),
    invoke: (op, args) => call(op, args ?? {}),
    close: async () => {
      if (ownsClient) await client.close();
    },
  };
}

function requireCommand(command?: string): string {
  if (!command) {
    throw new Error(
      "createBrowserSurface: no transport, client, or command given. Provide `command` " +
        "(+ `args`) to spawn a local browser-mcp server, or pass a `transport`/`client`.",
    );
  }
  return command;
}
