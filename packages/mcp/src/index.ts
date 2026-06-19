/**
 * @macrokit/mcp — minimal public MCP server for a Macrokit project.
 *
 * Wire it into an MCP host (Claude Code / Cursor):
 *   claude mcp add macrokit -- macrokit mcp ./my-project
 *
 * It exposes the project's macros (list_macros / run_macro) and primitives (as
 * individual tools), and records every call to .macrokit/sessions/ so
 * `macrokit gate` can flag un-encoded workflows. Record + run + gate — no
 * auto-distill (that is the separate Studio IDE).
 */
export { startMcpServer, buildMcpServer, openSessionLog, sessionLogPath, type BuildServerOptions } from "./server.js";
export { loadProject, readManifest, type LoadedProject, type MacroInfo, type ProjectManifest } from "./load-project.js";
