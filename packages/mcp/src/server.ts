/**
 * The minimal public Macrokit MCP server.
 *
 * Exposes a project-on-disk's macros + primitives to an MCP host (Claude Code /
 * Cursor) and records every tool call to .macrokit/sessions/, so `macrokit gate`
 * can flag un-encoded workflows. It does record + run + gate — nothing more.
 * Auto-distill-on-recurrence is the separate (private) Studio IDE; it is NOT here.
 */
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Dispatcher, SessionLog } from "@macrokit/runtime";
import { loadProject, type LoadedProject } from "./load-project.js";

export interface BuildServerOptions {
  project: LoadedProject;
  log: SessionLog;
  /** Tool surfaces passed to macro handlers. Default {} — macros self-provide. */
  toolSurfaces?: Record<string, unknown>;
}

function shapeOf(registry: LoadedProject["registry"], name: string): Record<string, z.ZodTypeAny> {
  const macro = registry.lookup(name);
  const schema = macro?.schema as { shape?: Record<string, z.ZodTypeAny> } | undefined;
  return schema?.shape ?? {};
}

export function buildMcpServer(opts: BuildServerOptions): McpServer {
  const { project, log } = opts;
  const dispatcher = new Dispatcher({
    registry: project.registry,
    log,
    toolSurfaces: opts.toolSurfaces ?? {},
  });

  const server = new McpServer(
    { name: "macrokit", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  let seq = 0;
  const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });

  // 1. list_macros — the project's workflow macros.
  server.registerTool(
    "list_macros",
    {
      description:
        "List the workflow macros registered in this Macrokit project (name, intent, " +
        "and argument names). Prefer a macro over composing raw primitives when one fits.",
      inputSchema: {},
    },
    async () =>
      text(
        project.macros.map((m) => ({ name: m.name, intent: m.intent, params: m.params, file: m.file })),
      ),
  );

  // 2. run_macro — dispatch a named macro deterministically.
  server.registerTool(
    "run_macro",
    {
      description:
        "Run a registered workflow macro by name. Pass its arguments as `args`. The call " +
        "and result are recorded to the project's session log.",
      inputSchema: {
        name: z.string().describe("the macro name (see list_macros)"),
        args: z.record(z.unknown()).optional().describe("arguments matching the macro's schema"),
      },
    },
    async ({ name, args }: { name: string; args?: Record<string, unknown> }) => {
      const result = await dispatcher.dispatch({ tool: name, args: args ?? {}, callId: `m${seq++}` });
      return result.ok
        ? text(result.value)
        : { content: [{ type: "text" as const, text: `error (${result.error.code}): ${result.error.message}` }], isError: true };
    },
  );

  // 3. Each primitive as its own tool — the raw operations the agent composes
  //    when no macro fits. These are the calls `macrokit gate` later flags.
  for (const prim of project.primitives) {
    server.registerTool(
      prim.name,
      { description: `${prim.intent} (primitive)`, inputSchema: shapeOf(project.registry, prim.name) },
      async (args: Record<string, unknown>) => {
        const result = await dispatcher.dispatch({ tool: prim.name, args, callId: `p${seq++}` });
        return result.ok
          ? text(result.value)
          : { content: [{ type: "text" as const, text: `error (${result.error.code}): ${result.error.message}` }], isError: true };
      },
    );
  }

  return server;
}

/** A session-log path under the project: .macrokit/sessions/<ISO>.jsonl. */
export function sessionLogPath(projectDir: string, now = new Date()): string {
  return join(projectDir, ".macrokit", "sessions", `mcp-${now.toISOString().replace(/[:.]/g, "-")}.jsonl`);
}

/**
 * Open a file-backed session log and seed a `user` turn marker, so the dispatched
 * tool calls group under one turn for `macrokit gate`. (One MCP session = one
 * gate turn — the minimal-server convention; the gate flags a session that did
 * 3+ un-encoded primitive calls.)
 */
export function openSessionLog(projectDir: string): SessionLog {
  const log = new SessionLog({ path: sessionLogPath(projectDir) });
  log.append({ type: "user", text: "MCP session (Claude Code / Cursor)" } as never);
  return log;
}

export async function startMcpServer(projectDir: string): Promise<void> {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const project = await loadProject(projectDir);
  const log = openSessionLog(project.dir);
  const server = buildMcpServer({ project, log });
  // stdout is the MCP transport — diagnostics MUST go to stderr.
  process.stderr.write(
    `macrokit MCP server — project "${project.manifest.name}"\n` +
      `  ${project.macros.length} macro(s): ${project.macros.map((m) => m.name).join(", ") || "(none)"}\n` +
      `  ${project.primitives.length} primitive(s): ${project.primitives.map((m) => m.name).join(", ") || "(none)"}\n` +
      `  session log: ${sessionLogPath(project.dir)}\n` +
      `  run \`macrokit gate ${project.dir}/.macrokit/sessions\` to flag un-encoded workflows.\n`,
  );
  await server.connect(new StdioServerTransport());
  // connect() resolves once the transport is wired; keep the process alive until
  // the host disconnects (stdin closes). Without this the caller (the CLI, which
  // ends with process.exit) would tear the server down mid-handshake.
  await new Promise<void>((resolveClose) => {
    server.server.onclose = () => resolveClose();
  });
}
