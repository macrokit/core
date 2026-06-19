import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `macrokit studio` — launch the local Studio IDE over a project on disk.
 *
 * The IDE (local server + browser GUI) lives in the separate `macrokit/studio`
 * package, NOT here: the SDK CLI stays decoupled from it (the core repo must
 * build without Studio installed). So this command RESOLVES the Studio server
 * entry at runtime and spawns it — a thin, optional-plugin launcher. If Studio
 * isn't installed, we say so instead of failing cryptically.
 */

export interface LaunchStudioOptions {
  projectDir: string;
  port?: number;
  open?: boolean;
}

export async function launchStudio(opts: LaunchStudioOptions): Promise<number> {
  const entry = resolveStudioEntry("cli.ts");
  if (!entry) return notAvailable("studio");
  if (!existsSync(opts.projectDir)) {
    process.stderr.write(`macrokit studio: ${opts.projectDir} does not exist.\n`);
    return 2;
  }
  const args = ["--no-warnings", entry, opts.projectDir];
  if (opts.port) args.push("--port", String(opts.port));
  if (opts.open === false) args.push("--no-open");
  return spawnNode("studio", args);
}

export interface LaunchMcpOptions {
  projectDir: string;
}

/**
 * Launch the Macrokit MCP server over stdio (an MCP host like Claude Code /
 * Cursor spawns `macrokit mcp <path>` and talks to it directly).
 *
 * Default = the minimal PUBLIC `@macrokit/mcp` server (record + run + gate),
 * started in-process so this process's stdio IS the MCP transport. If the
 * richer PRIVATE Studio MCP server is present (MACROKIT_STUDIO_DIR /
 * @macrokit-studio/preview, which adds auto-distill on recurrence), prefer it.
 */
export async function launchMcp(opts: LaunchMcpOptions): Promise<number> {
  if (!existsSync(opts.projectDir)) {
    process.stderr.write(`macrokit mcp: ${opts.projectDir} does not exist.\n`);
    return 2;
  }
  // Richer private path ONLY when explicitly present (env override or the
  // package installed) — NOT the dev-sibling guess, so the public server is the
  // real default for external users.
  const studioEntry = resolveStudioEntryExplicit("mcp.ts");
  if (studioEntry) {
    return spawnNode("mcp", ["--no-warnings", studioEntry, opts.projectDir]);
  }
  // Public minimal server, in-process (stdout = the MCP transport).
  try {
    const mod = (await import("@macrokit/mcp")) as { startMcpServer: (dir: string) => Promise<void> };
    await mod.startMcpServer(opts.projectDir);
    return 0;
  } catch (err) {
    process.stderr.write(
      `macrokit mcp: failed to start the public MCP server — ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

function spawnNode(cmd: string, args: string[]): Promise<number> {
  return new Promise<number>((resolveExit) => {
    const child = spawn(process.execPath, args, { stdio: "inherit" });
    child.on("error", (err) => {
      process.stderr.write(`macrokit ${cmd}: failed to launch — ${err.message}\n`);
      resolveExit(1);
    });
    child.on("exit", (code) => resolveExit(code ?? 0));
  });
}

function notAvailable(cmd: string): number {
  process.stderr.write(
    `macrokit ${cmd}: the Studio IDE isn't available.\n\n` +
      "The IDE ships in the @macrokit-studio/preview package (local dev tool).\n" +
      "Install it, or set MACROKIT_STUDIO_DIR to its directory, then retry.\n",
  );
  return 1;
}

/**
 * EXPLICIT-only Studio resolution: an MACROKIT_STUDIO_DIR override or an
 * installed @macrokit-studio/preview package. NO dev-sibling guessing — used by
 * `macrokit mcp` so the public @macrokit/mcp server is the default unless the
 * private Studio is deliberately present.
 */
function resolveStudioEntryExplicit(file: string): string | undefined {
  const envDir = process.env.MACROKIT_STUDIO_DIR;
  if (envDir) {
    const p = resolve(envDir, "server", file);
    if (existsSync(p)) return p;
  }
  for (const base of [process.cwd(), import.meta.url]) {
    try {
      const req = createRequire(base.startsWith("file:") ? base : resolve(base, "noop.js"));
      const serverEntry = req.resolve("@macrokit-studio/preview/server");
      const cand = resolve(dirname(serverEntry), file);
      if (existsSync(cand)) return cand;
    } catch {
      /* not installed */
    }
  }
  return undefined;
}

/**
 * Locate a Studio server entry file (cli.ts / mcp.ts) without a static
 * dependency on the package — the core CLI must build without Studio installed.
 * Used by `macrokit studio` (dev-sibling guess included for convenience).
 */
function resolveStudioEntry(file: string): string | undefined {
  // 1. Explicit directory override.
  const envDir = process.env.MACROKIT_STUDIO_DIR;
  if (envDir) {
    const p = resolve(envDir, "server", file);
    if (existsSync(p)) return p;
  }
  // Back-compat: a full path to the cli entry.
  if (file === "cli.ts" && process.env.MACROKIT_STUDIO_SERVER && existsSync(process.env.MACROKIT_STUDIO_SERVER)) {
    return process.env.MACROKIT_STUDIO_SERVER;
  }

  // 2. Installed as a package (resolved from the project / cwd).
  for (const base of [process.cwd(), import.meta.url]) {
    try {
      const req = createRequire(base.startsWith("file:") ? base : resolve(base, "noop.js"));
      const serverEntry = req.resolve("@macrokit-studio/preview/server");
      const cand = resolve(dirname(serverEntry), file);
      if (existsSync(cand)) return cand;
    } catch {
      /* not installed here; keep looking */
    }
  }

  // 3. Sibling repo in the monorepo-style layout (core/ and studio/ siblings).
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, `../../../../studio/server/${file}`),
    resolve(here, `../../../../../studio/server/${file}`),
    resolve(process.cwd(), `studio/server/${file}`),
    resolve(process.cwd(), `../studio/server/${file}`),
  ];
  for (const c of candidates) if (existsSync(c)) return c;

  return undefined;
}
