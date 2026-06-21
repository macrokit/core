import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { lintPackage } from "./lint.js";
import { scanLeakage, type LeakageResult } from "./leakage.js";
import { isValidVersion } from "./semver.js";

/**
 * `macrokit pack` — bundle a macro directory into a versioned, source-available
 * pack (D-017: packs are readable source, never opaque binaries).
 *
 * The pack is a single self-describing JSON file: a manifest plus the verbatim
 * text of every source file. One file is the simplest immutable, copyable,
 * diff-able artifact for a personal registry (MACRO_PROTOCOL_DRAFT §"single-file
 * JSON vs package layout" — we pick single-file for v1). The manifest carries
 * each macro's declared `capabilities`, which `install` surfaces for approval
 * before activating — that trust-before-install step is the whole point of the
 * capability manifest.
 *
 * Pack time runs two gates and REFUSES on either:
 *   - `lint --pkg` structural conformance (peer dep, README, macro export, tests)
 *   - the leakage scan (Sacred Rule #1 / D-014) over the packed source.
 */

export const PACK_FORMAT_VERSION = "1";
export const PACK_EXT = ".mkpack.json";

export interface PackedMacro {
  name: string;
  intent: string;
  /** Declared capabilities (D-017), or null when the macro declared none. */
  capabilities: string[] | null;
}

export interface PackManifest {
  macrokit: { pack: string };
  name: string;
  version: string;
  license?: string;
  author?: string;
  description?: string;
  /** Entry source file (relative path) holding the macro export(s). */
  entry: string;
  macros: PackedMacro[];
  /** Sorted union of all declared capabilities across the pack's macros. */
  capabilities: string[];
  /** True if any macro declared no capabilities (legacy-permissive). */
  hasUndeclaredCapabilities: boolean;
  /** Verbatim source: relative path → file text. Source-available. */
  files: Record<string, string>;
  /** sha256 over the canonicalized file set; recorded for reproducible installs. */
  integrity: string;
}

export interface BuildPackResult {
  manifest: PackManifest;
  /** Suggested filename: `<name>-<version>.mkpack.json`. */
  filename: string;
  /** Serialized pack JSON. */
  json: string;
}

export class PackError extends Error {
  constructor(
    message: string,
    public readonly detail: {
      lintFailures?: string[];
      leakage?: LeakageResult;
    } = {},
  ) {
    super(message);
    this.name = "PackError";
  }
}

interface SourceMeta {
  name: string;
  version: string;
  license?: string;
  author?: string;
  description?: string;
}

/** Read identity (name/version/license/author) from package.json, falling back to macrokit.json. */
function readMeta(dir: string): SourceMeta {
  const pkgPath = join(dir, "package.json");
  const mkPath = join(dir, "macrokit.json");
  let meta: Partial<SourceMeta> = {};
  if (existsSync(pkgPath)) {
    try {
      const j = JSON.parse(readFileSync(pkgPath, "utf8"));
      meta = {
        name: j.name,
        version: j.version,
        license: j.license,
        author: typeof j.author === "string" ? j.author : j.author?.name,
        description: j.description,
      };
    } catch {
      /* fall through to macrokit.json */
    }
  }
  if ((!meta.name || !meta.version) && existsSync(mkPath)) {
    try {
      const j = JSON.parse(readFileSync(mkPath, "utf8"));
      meta.name = meta.name ?? j.name;
      meta.version = meta.version ?? j.version;
      meta.license = meta.license ?? j.license;
    } catch {
      /* ignore */
    }
  }
  if (!meta.name) {
    throw new PackError(
      `No package name found in ${dir} (need a "name" in package.json or macrokit.json).`,
    );
  }
  if (!meta.version || !isValidVersion(meta.version)) {
    throw new PackError(
      `Invalid or missing version in ${dir}: "${meta.version ?? "(none)"}". ` +
        `A pack must declare a strict semver version (e.g. 1.0.0).`,
    );
  }
  return meta as SourceMeta;
}

function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      const p = join(dir, name);
      let s;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) walk(p);
      else if (s.isFile() && (extname(name) === ".ts" || extname(name) === ".tsx")) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** Files included verbatim in the pack: all source + a curated set of metadata files. */
function listPackedFiles(root: string): string[] {
  const set = new Set(listSourceFiles(root));
  for (const name of readdirSafe(root)) {
    const lower = name.toLowerCase();
    if (
      lower === "readme.md" ||
      lower === "license" ||
      lower === "license.md" ||
      lower === "license.txt" ||
      name === "package.json" ||
      name === "macrokit.json"
    ) {
      set.add(join(root, name));
    }
  }
  // include fixtures dir (json) so installs can replay-verify
  const fixturesDir = join(root, "fixtures");
  if (existsSync(fixturesDir)) {
    for (const f of readdirSafe(fixturesDir)) {
      if (f.endsWith(".json")) set.add(join(fixturesDir, f));
    }
  }
  return [...set].sort();
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Static macro extraction (name / intent / capabilities) — heuristic, matching
// how lint.ts already reads defineMacro() without executing the package.
// ---------------------------------------------------------------------------

export function extractMacros(source: string): PackedMacro[] {
  const macros: PackedMacro[] = [];
  let idx = 0;
  while (idx < source.length) {
    const m = source.slice(idx).match(/defineMacro\s*(?:<[^>]*>)?\s*\(/);
    if (!m) break;
    const openParen = idx + (m.index ?? 0) + m[0].length - 1;
    const end = matchingCloseParen(source, openParen);
    if (end === -1) break;
    const body = source.slice(openParen + 1, end);
    const name = matchString(body, /\bname\s*:\s*(["'`])([^"'`]+)\1/);
    const intent = matchString(body, /\bintent\s*:\s*(["'`])([\s\S]*?)\1/);
    if (name && intent !== undefined) {
      macros.push({ name, intent, capabilities: extractCapabilities(body) });
    }
    idx = end + 1;
  }
  return macros;
}

function matchString(body: string, re: RegExp): string | undefined {
  const m = body.match(re);
  return m ? m[2] : undefined;
}

/** Pull `capabilities: [ ... ]` string entries, or null when not declared. */
function extractCapabilities(body: string): string[] | null {
  const m = body.match(/\bcapabilities\s*:\s*\[([^\]]*)\]/);
  if (!m) return null;
  const inner = m[1]!;
  const caps: string[] = [];
  const re = /(["'`])([^"'`]+)\1/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(inner)) !== null) caps.push(mm[2]!);
  return caps;
}

function matchingCloseParen(source: string, openIdx: number): number {
  let depth = 0;
  let inStr: '"' | "'" | "`" | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openIdx; i < source.length; i++) {
    const c = source[i]!;
    const next = source[i + 1];
    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function computeIntegrity(files: Record<string, string>): string {
  const h = createHash("sha256");
  for (const path of Object.keys(files).sort()) {
    h.update(path);
    h.update("\0");
    h.update(files[path]!);
    h.update("\0");
  }
  return "sha256-" + h.digest("hex");
}

/**
 * Build a pack from a macro directory. Runs the lint + leakage gates and throws
 * PackError on any failure (refuse-to-pack). Pure: writes nothing to disk.
 */
export function buildPack(macroDir: string): BuildPackResult {
  if (!existsSync(macroDir) || !statSync(macroDir).isDirectory()) {
    throw new PackError(`${macroDir} is not a directory.`);
  }

  // Gate 1: structural conformance.
  const lint = lintPackage(macroDir);
  if (lint.findings.length > 0) {
    throw new PackError(
      `pack refused: ${lint.findings.length} lint --pkg check(s) failed. ` +
        `Fix structural conformance before packing.`,
      { lintFailures: lint.findings.map((f) => `${f.rule}: ${f.message}`) },
    );
  }

  // Gate 2: leakage scan over the packed source (Sacred Rule #1 / D-014).
  const leakage = scanLeakage(macroDir);
  if (!leakage.ok) {
    throw new PackError(
      `pack refused: leakage scan found ${leakage.hard.length} hard hit(s). ` +
        `The pipeline never packages private-deployment content into a public artifact.`,
      { leakage },
    );
  }

  const meta = readMeta(macroDir);

  // Collect files + extract macros.
  const files: Record<string, string> = {};
  const macros: PackedMacro[] = [];
  let entry: string | undefined;
  for (const abs of listPackedFiles(macroDir)) {
    const rel = relative(macroDir, abs).split("\\").join("/");
    const text = readFileSync(abs, "utf8");
    files[rel] = text;
    if (rel.endsWith(".ts") || rel.endsWith(".tsx")) {
      const found = extractMacros(text);
      if (found.length > 0) {
        macros.push(...found);
        // First source file containing a macro becomes the entry.
        if (!entry) entry = rel;
      }
    }
  }

  if (macros.length === 0) {
    throw new PackError(
      `pack refused: no defineMacro() export found in ${macroDir}. ` +
        `A pack must contain at least one macro.`,
    );
  }

  const capSet = new Set<string>();
  let hasUndeclared = false;
  for (const m of macros) {
    if (m.capabilities === null) hasUndeclared = true;
    else for (const c of m.capabilities) capSet.add(c);
  }

  const manifest: PackManifest = {
    macrokit: { pack: PACK_FORMAT_VERSION },
    name: meta.name,
    version: meta.version,
    ...(meta.license ? { license: meta.license } : {}),
    ...(meta.author ? { author: meta.author } : {}),
    ...(meta.description ? { description: meta.description } : {}),
    entry: entry!,
    macros,
    capabilities: [...capSet].sort(),
    hasUndeclaredCapabilities: hasUndeclared,
    files,
    integrity: computeIntegrity(files),
  };

  const filename = `${safeName(meta.name)}-${meta.version}${PACK_EXT}`;
  const json = JSON.stringify(manifest, null, 2) + "\n";
  return { manifest, filename, json };
}

/** Turn a (possibly scoped) package name into a filesystem-safe slug. */
export function safeName(name: string): string {
  return name.replace(/^@/, "").replace(/\//g, "__");
}
