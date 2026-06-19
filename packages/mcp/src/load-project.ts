/**
 * Load a Macrokit project from disk into a runnable @macrokit/runtime registry.
 *
 * Reads `macrokit.json`, imports the macro files under `macros/` and the
 * primitive files under `primitives/`, and registers the exported Macro objects.
 * Bare `@macrokit/*` + `zod` imports in those files resolve to THIS package's
 * installed copies via the loader hook (loader.mjs); TypeScript is stripped
 * natively by Node (>=22.18 / 24).
 *
 * This is the same on-disk macro discovery `macrokit gate`/`init` assume — the
 * macrokit.json + macros/ layout the scaffolder writes.
 */
import { register } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { MacroRegistry, type Macro } from "@macrokit/runtime";

export interface ProjectManifest {
  name: string;
  version?: string;
  vertical?: string;
  paths?: { macros?: string; primitives?: string; fixtures?: string };
}

export interface MacroInfo {
  name: string;
  intent: string;
  /** Argument names from the macro's JSON schema (best-effort). */
  params: string[];
  /** "domain" (a workflow macro) or "utility" (a low-level primitive). */
  category: "domain" | "utility";
  /** Source file (relative), for provenance. */
  file: string;
}

export interface LoadedProject {
  dir: string;
  manifest: ProjectManifest;
  registry: MacroRegistry;
  /** Domain macros — surfaced via list_macros + run_macro. */
  macros: MacroInfo[];
  /** Utility primitives — surfaced as individual tools. */
  primitives: MacroInfo[];
}

let hookRegistered = false;

/** Register the loader hook once, aliasing the SDK + zod to this package's copies. */
function registerProjectLoader(): void {
  if (hookRegistered) return;
  hookRegistered = true;
  const aliases: Record<string, string> = {};
  for (const id of ["@macrokit/runtime", "@macrokit/authoring", "zod"]) {
    try {
      aliases[id] = import.meta.resolve(id);
    } catch {
      /* leave unaliased; the project's own node_modules may resolve it */
    }
  }
  try {
    // loader.mjs sits beside the built dist/index.js (copied by the build).
    register("./loader.mjs", import.meta.url, { data: { aliases } });
  } catch {
    /* hooks unavailable (e.g. under a bundler test runner); imports still work */
  }
}

function isMacro(v: unknown): v is Macro {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.name === "string" &&
    typeof m.intent === "string" &&
    !!m.schema &&
    typeof m.handler === "function"
  );
}

function paramsOf(m: Macro): string[] {
  const schema = m.schema as { jsonSchema?: { properties?: Record<string, unknown> } };
  const props = schema?.jsonSchema?.properties;
  return props ? Object.keys(props) : [];
}

export function readManifest(dir: string): ProjectManifest {
  const root = resolvePath(dir);
  const manifestPath = join(root, "macrokit.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `No macrokit.json in ${root}. Is this a Macrokit project? ` +
        `Create one with: macrokit init <name> --vertical github`,
    );
  }
  return JSON.parse(readFileSync(manifestPath, "utf8")) as ProjectManifest;
}

async function loadDir(
  dir: string,
  registry: MacroRegistry,
  out: MacroInfo[],
  defaultCategory: "domain" | "utility",
): Promise<void> {
  if (!existsSync(dir)) return;
  const files = readdirSync(dir)
    .filter((f) => (f.endsWith(".ts") || f.endsWith(".mjs") || f.endsWith(".js")) && !f.endsWith(".d.ts"))
    .sort();
  for (const f of files) {
    const url = pathToFileURL(join(dir, f)).href;
    let mod: Record<string, unknown>;
    try {
      mod = (await import(url)) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`failed to load ${f}: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const exp of Object.values(mod)) {
      if (isMacro(exp) && !registry.has(exp.name)) {
        registry.register(exp);
        out.push({
          name: exp.name,
          intent: exp.intent,
          params: paramsOf(exp),
          category: ((exp as { category?: string }).category as "domain" | "utility") ?? defaultCategory,
          file: f,
        });
      }
    }
  }
}

export async function loadProject(dir: string): Promise<LoadedProject> {
  const root = resolvePath(dir);
  const manifest = readManifest(root);
  registerProjectLoader();

  const registry = new MacroRegistry();
  const loaded: MacroInfo[] = [];
  await loadDir(join(root, manifest.paths?.macros ?? "macros"), registry, loaded, "domain");
  await loadDir(join(root, manifest.paths?.primitives ?? "primitives"), registry, loaded, "utility");

  // Split by the macro's own category: domain = workflow macros (list_macros /
  // run_macro), utility = primitives (exposed as individual tools).
  const macros = loaded.filter((m) => m.category !== "utility");
  const primitives = loaded.filter((m) => m.category === "utility");
  return { dir: root, manifest, registry, macros, primitives };
}
