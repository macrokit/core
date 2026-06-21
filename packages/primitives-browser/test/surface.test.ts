import { describe, it, expect } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createBrowserSurface, BrowserToolError, TOOL_NAMES } from "../src/index.js";

/** A recorded tool call against the fake browser-mcp server. */
interface Recorded {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Fake in-memory browser-mcp server. It registers exactly the tool names the
 * real browser-mcp exposes, records every call, and returns a canned result.
 * No real browser, no network — proves the adapter's wiring offline.
 */
function fakeBrowserServer(opts?: {
  errorOn?: string;
  textFor?: (name: string, args: Record<string, unknown>) => string | undefined;
}) {
  const calls: Recorded[] = [];
  let closed = false;
  const server = new Server(
    { name: "fake-browser-mcp", version: "0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.values(TOOL_NAMES).map((name) => ({ name, inputSchema: { type: "object" } })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    calls.push({ name, arguments: args });
    if (opts?.errorOn === name) {
      return { content: [{ type: "text", text: "boom" }], isError: true };
    }
    if (name === TOOL_NAMES.screenshot) {
      return { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] };
    }
    const text = opts?.textFor?.(name, args) ?? `ok:${name}`;
    return { content: [{ type: "text", text }] };
  });

  // Protocol fires onclose when the linked transport tears down.
  server.onclose = () => {
    closed = true;
  };

  return { server, calls, isClosed: () => closed };
}

async function wire(opts?: Parameters<typeof fakeBrowserServer>[0]) {
  const fake = fakeBrowserServer(opts);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await fake.server.connect(serverT);
  const surface = await createBrowserSurface({ transport: clientT, profile: "p1" });
  return { ...fake, surface };
}

describe("@macrokit/primitives-browser — surface maps 1:1 to browser-mcp tools", () => {
  it("each method calls the correct browser-mcp tool with the correct args", async () => {
    const { surface, calls } = await wire();

    await surface.navigate("https://example.com");
    await surface.getText(".title");
    await surface.getText();
    await surface.getAttribute("a.link", "href");
    await surface.fill("#name", "Ada");
    await surface.click("#submit");
    await surface.selectOption("#country", "JP");
    await surface.pressKey("Enter");
    await surface.uploadFile("#file", "/tmp/doc.pdf");
    await surface.waitFor("#ready");
    await surface.currentUrl();
    await surface.snapshot();
    await surface.screenshot();
    await surface.eval("1 + 1");
    await surface.openTab("https://example.org");
    await surface.listTabs();
    await surface.closeTab(2);

    // The (name, args) of every call, in order — proves the mapping exactly.
    // `profile` is threaded into each call (browser-mcp scopes by profile).
    expect(calls).toEqual([
      { name: "browser_navigate", arguments: { profile: "p1", url: "https://example.com" } },
      { name: "browser_get_text", arguments: { profile: "p1", selector: ".title" } },
      { name: "browser_get_text", arguments: { profile: "p1" } },
      { name: "browser_get_attribute", arguments: { profile: "p1", selector: "a.link", attribute: "href" } },
      { name: "browser_fill", arguments: { profile: "p1", selector: "#name", value: "Ada" } },
      { name: "browser_click", arguments: { profile: "p1", selector: "#submit" } },
      { name: "browser_select_option", arguments: { profile: "p1", selector: "#country", value: "JP" } },
      { name: "browser_press_key", arguments: { profile: "p1", key: "Enter" } },
      { name: "browser_upload_file", arguments: { profile: "p1", selector: "#file", path: "/tmp/doc.pdf" } },
      { name: "browser_wait_for", arguments: { profile: "p1", condition: "#ready" } },
      { name: "browser_current_url", arguments: { profile: "p1" } },
      { name: "browser_snapshot", arguments: { profile: "p1" } },
      { name: "browser_screenshot", arguments: { profile: "p1" } },
      { name: "browser_eval", arguments: { profile: "p1", expression: "1 + 1" } },
      { name: "browser_open_tab", arguments: { profile: "p1", url: "https://example.org" } },
      { name: "browser_list_tabs", arguments: { profile: "p1" } },
      { name: "browser_close_tab", arguments: { profile: "p1", tab: 2 } },
    ]);

    await surface.close();
  });

  it("normalizes text results for read methods", async () => {
    const { surface } = await wire({
      textFor: (name) => {
        if (name === "browser_current_url") return "https://current.example";
        if (name === "browser_get_text") return "hello world";
        if (name === "browser_get_attribute") return "/dest";
        if (name === "browser_eval") return "2";
        return undefined;
      },
    });

    expect(await surface.getText()).toBe("hello world");
    expect(await surface.getAttribute("a", "href")).toBe("/dest");
    expect(await surface.currentUrl()).toBe("https://current.example");
    expect(await surface.eval("1+1")).toBe("2");
    await surface.close();
  });

  it("preserves non-text content (screenshot image) in .content", async () => {
    const { surface } = await wire();
    const shot = await surface.screenshot();
    expect(shot.isError).toBe(false);
    expect(shot.text).toBe("");
    expect(shot.content).toEqual([{ type: "image", data: "AAAA", mimeType: "image/png" }]);
    await surface.close();
  });

  it("surfaces tool errors as a structured BrowserToolError", async () => {
    const { surface } = await wire({ errorOn: "browser_click" });
    await expect(surface.click("#x")).rejects.toBeInstanceOf(BrowserToolError);
    try {
      await surface.click("#x");
    } catch (e) {
      const err = e as BrowserToolError;
      expect(err.op).toBe("click");
      expect(err.tool).toBe("browser_click");
      expect(err.args).toEqual({ profile: "p1", selector: "#x" });
      expect(err.result.text).toBe("boom");
      expect(err.result.isError).toBe(true);
    }
    await surface.close();
  });

  it("close() tears down the client connection", async () => {
    const { surface, isClosed } = await wire();
    await surface.navigate("https://example.com");
    await surface.close();
    // The in-memory pair propagates client close to the server side.
    expect(isClosed()).toBe(true);
  });

  it("requires a transport, client, or command", async () => {
    await expect(createBrowserSurface({})).rejects.toThrow(/transport, client, or command/);
  });
});
