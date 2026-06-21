# @macrokit/primitives-browser

The generic **`browser`** primitive for Macrokit — the first member of the
primitive standard library (D-019).

It is a thin **MCP-client adapter**: it connects to a local
[`browser-mcp`](https://github.com/) server over stdio and re-exposes that
server's tools as one clean, typed surface that macros call via
`ctx.tools.browser`. (This is the *opposite* of `@macrokit/mcp`, which is a
*server* that exposes Macrokit to an agent.)

Macrokit therefore **rides the MCP tool ecosystem** instead of reimplementing a
browser. To target a different browser MCP server later (e.g. Playwright-MCP),
change the one tool-name map in [`src/tool-map.ts`](./src/tool-map.ts) — nothing
else hard-codes a tool name.

## Local-first by default (D-019)

Studio + the weak model + the browser + files are co-located on one machine.
This package talks to a **local** browser-mcp over stdio — **no SSH, no network
hop** baked in. Remote transport is the caller's concern.

## Usage

```ts
import { Runtime } from "@macrokit/runtime";
import { createBrowserSurface } from "@macrokit/primitives-browser";

// Spawn a local browser-mcp server and wire its surface into the Runtime.
const browser = await createBrowserSurface({ command: "npx", args: ["browser-mcp"] });

const runtime = new Runtime({
  /* ...registry, router, model... */
  toolSurfaces: { browser },
});

// teardown when done
await browser.close();
```

A macro reaches the surface at `ctx.tools.browser` **only if it declares the
capability** (D-017):

```ts
export default defineMacro({
  name: "open_and_read",
  capabilities: ["browser"], // the dispatcher's membrane grants only this surface
  async run(ctx) {
    await ctx.tools.browser.navigate("https://example.com");
    return ctx.tools.browser.getText("h1");
  },
});
```

## Surface

| Method | browser-mcp tool |
| --- | --- |
| `navigate(url)` | `browser_navigate` |
| `getText(selector?)` | `browser_get_text` |
| `getAttribute(selector, attr)` | `browser_get_attribute` |
| `fill(selector, value)` | `browser_fill` |
| `click(selector)` | `browser_click` |
| `selectOption(selector, value)` | `browser_select_option` |
| `pressKey(key)` | `browser_press_key` |
| `uploadFile(selector, path)` | `browser_upload_file` |
| `waitFor(condition)` | `browser_wait_for` |
| `currentUrl()` | `browser_current_url` |
| `snapshot()` | `browser_snapshot` |
| `screenshot()` | `browser_screenshot` |
| `eval(expression)` | `browser_eval` |
| `openTab(url?)` | `browser_open_tab` |
| `listTabs()` | `browser_list_tabs` |
| `closeTab(tab?)` | `browser_close_tab` |

Read methods return a `string`. Action methods and `snapshot()` / `screenshot()`
return a normalized `BrowserResult` (`{ text, content, isError }`) so image
content survives. A tool that reports an error throws a structured
`BrowserToolError` carrying the op, resolved tool name, and args.

Every call is scoped to a browser-mcp **profile** (a named persistent cookie
jar); set it with `createBrowserSurface({ profile })` — defaults to `"default"`.

## Scope

**Generic only.** This package contains zero domain logic. Vertical macros live
in a separate private package that *consumes* this surface.

## Connection options

`createBrowserSurface(opts)` accepts one of:

- `command` (+ `args`, `env`, `cwd`) — spawn a local browser-mcp over stdio.
- `transport` — inject a pre-built MCP transport (used by tests; no real browser).
- `client` — attach a pre-connected MCP `Client`.

## License

Apache-2.0 · maker: Cheng Qian
