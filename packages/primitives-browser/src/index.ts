/**
 * @macrokit/primitives-browser — the generic `browser` primitive.
 *
 * A thin MCP-CLIENT adapter that wraps a local browser-mcp server and exposes
 * its tools as a clean `browser` surface. Wire it into the Runtime:
 *
 *   import { createBrowserSurface } from "@macrokit/primitives-browser";
 *   const browser = await createBrowserSurface({ command: "npx", args: ["browser-mcp"] });
 *   const runtime = new Runtime({ ..., toolSurfaces: { browser } });
 *   // a macro declaring capabilities: ["browser"] reaches it at ctx.tools.browser
 *
 * GENERIC ONLY — no domain logic. Domain/vertical macros live in a separate
 * private package that *consumes* this surface.
 */
export {
  createBrowserSurface,
  BrowserToolError,
  type BrowserSurface,
  type BrowserResult,
  type ContentBlock,
  type CreateBrowserSurfaceOptions,
} from "./surface.js";
export { TOOL_NAMES, type BrowserOp } from "./tool-map.js";
