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
  const entry = resolveStudioServer();
  if (!entry) {
    process.stderr.write(
      "macrokit studio: the Studio IDE isn't available.\n\n" +
        "The IDE ships in the @macrokit-studio/preview package (local dev tool).\n" +
        "Install it, or set MACROKIT_STUDIO_SERVER to its server entry, then retry.\n",
    );
    return 1;
  }
  if (!existsSync(opts.projectDir)) {
    process.stderr.write(`macrokit studio: ${opts.projectDir} does not exist.\n`);
    return 2;
  }

  const args = [
    // The server entry is TypeScript run directly; Node strips types natively
    // (>=22.18 / >=23.6 / 24). --no-warnings hides the experimental notice.
    "--no-warnings",
    entry,
    opts.projectDir,
  ];
  if (opts.port) args.push("--port", String(opts.port));
  if (opts.open === false) args.push("--no-open");

  return await new Promise<number>((resolveExit) => {
    const child = spawn(process.execPath, args, { stdio: "inherit" });
    child.on("error", (err) => {
      process.stderr.write(`macrokit studio: failed to launch — ${err.message}\n`);
      resolveExit(1);
    });
    child.on("exit", (code) => resolveExit(code ?? 0));
  });
}

/** Locate the Studio server entry without a static dependency on the package. */
function resolveStudioServer(): string | undefined {
  // 1. Explicit override.
  const env = process.env.MACROKIT_STUDIO_SERVER;
  if (env && existsSync(env)) return env;

  // 2. Installed as a package (resolved from the project / cwd).
  for (const base of [process.cwd(), import.meta.url]) {
    try {
      const req = createRequire(base.startsWith("file:") ? base : resolve(base, "noop.js"));
      // The package exposes its server entry under this subpath export.
      return req.resolve("@macrokit-studio/preview/server");
    } catch {
      /* not installed here; keep looking */
    }
  }

  // 3. Sibling repo in the monorepo-style layout (core/ and studio/ siblings).
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // from core/packages/cli/{dist,src} up to the macrokit root, then studio.
    resolve(here, "../../../../studio/server/cli.ts"),
    resolve(here, "../../../../../studio/server/cli.ts"),
    resolve(process.cwd(), "studio/server/cli.ts"),
    resolve(process.cwd(), "../studio/server/cli.ts"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;

  return undefined;
}
