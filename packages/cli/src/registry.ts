import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  PACK_EXT,
  safeName,
  type PackManifest,
} from "./pack.js";
import { isValidVersion, maxSatisfying } from "./semver.js";

/**
 * The personal/local registry + project install side of the pipeline.
 *
 * A registry is just a resolvable directory (optionally a git-backed folder —
 * we never auto-commit or push it; the owner does). It MAY hold the owner's own
 * private packs: this is the D-014 pattern ("adopter keeps domain macros in
 * their own private registry"). It is NOT the public hub, and nothing here ever
 * pushes to a network location.
 *
 * Layout:
 *   <registry>/packs/<safeName>/<version>.mkpack.json   immutable per (name,version)
 *   <registry>/index.json                                name → [versions]  (convenience)
 *
 * Project install records a lockfile so installs are reproducible:
 *   <project>/macrokit.lock.json
 * and vendors readable source under:
 *   <project>/.macrokit/packs/<safeName>/<version>/<files…>
 */

export const DEFAULT_REGISTRY = join(homedir(), ".macrokit", "registry");
export const LOCKFILE = "macrokit.lock.json";

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

function packsRoot(registry: string): string {
  return join(registry, "packs");
}

function packPath(registry: string, name: string, version: string): string {
  return join(packsRoot(registry), safeName(name), `${version}${PACK_EXT}`);
}

function parseManifest(json: string, where: string): PackManifest {
  let m: PackManifest;
  try {
    m = JSON.parse(json);
  } catch (err) {
    throw new RegistryError(`${where}: not valid JSON (${(err as Error).message}).`);
  }
  if (!m || typeof m !== "object" || !m.macrokit || typeof m.name !== "string") {
    throw new RegistryError(`${where}: not a Macrokit pack (missing manifest fields).`);
  }
  if (!isValidVersion(m.version)) {
    throw new RegistryError(`${where}: invalid pack version "${m.version}".`);
  }
  return m;
}

export interface PublishResult {
  name: string;
  version: string;
  path: string;
  registry: string;
}

/**
 * Publish a pack file to a personal registry. Immutable per (name, version):
 * refuses to overwrite an existing version. Never pushes anywhere.
 */
export function publishPack(packFile: string, opts: { registry?: string } = {}): PublishResult {
  const registry = resolve(opts.registry ?? DEFAULT_REGISTRY);
  if (!existsSync(packFile)) {
    throw new RegistryError(`pack file not found: ${packFile}`);
  }
  const manifest = parseManifest(readFileSync(packFile, "utf8"), packFile);
  const dest = packPath(registry, manifest.name, manifest.version);

  if (existsSync(dest)) {
    throw new RegistryError(
      `refusing to overwrite ${manifest.name}@${manifest.version} in ${registry} — ` +
        `published versions are immutable. Bump the version and re-pack.`,
    );
  }

  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, readFileSync(packFile, "utf8"));
  updateIndex(registry, manifest.name, manifest.version);

  return { name: manifest.name, version: manifest.version, path: dest, registry };
}

function updateIndex(registry: string, name: string, version: string): void {
  const indexPath = join(registry, "index.json");
  let index: Record<string, string[]> = {};
  if (existsSync(indexPath)) {
    try {
      index = JSON.parse(readFileSync(indexPath, "utf8"));
    } catch {
      index = {};
    }
  }
  const versions = new Set(index[name] ?? []);
  versions.add(version);
  index[name] = [...versions].sort();
  mkdirSync(registry, { recursive: true });
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");
}

/** List published versions of a pack in a registry (newest-last). */
export function listVersions(registry: string, name: string): string[] {
  const dir = join(packsRoot(registry), safeName(name));
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(PACK_EXT))
    .map((f) => f.slice(0, -PACK_EXT.length))
    .filter(isValidVersion)
    .sort();
}

export interface Resolved {
  name: string;
  version: string;
  manifest: PackManifest;
  packPath: string;
}

/** Resolve a name + semver range to a concrete published version. */
export function resolvePack(name: string, range: string | undefined, registry: string): Resolved {
  const versions = listVersions(registry, name);
  if (versions.length === 0) {
    throw new RegistryError(
      `no published versions of "${name}" found in ${registry}. ` +
        `Did you publish it? (macrokit publish <pack> --registry ${registry})`,
    );
  }
  const picked = maxSatisfying(versions, range);
  if (!picked) {
    throw new RegistryError(
      `no version of "${name}" satisfies "${range}". Available: ${versions.join(", ")}.`,
    );
  }
  const p = packPath(registry, name, picked);
  const manifest = parseManifest(readFileSync(p, "utf8"), p);
  return { name, version: picked, manifest, packPath: p };
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

export interface CapabilityDisclosure {
  name: string;
  version: string;
  capabilities: string[];
  hasUndeclaredCapabilities: boolean;
  macros: Array<{ name: string; capabilities: string[] | null }>;
}

export interface InstallOptions {
  registry?: string;
  projectDir?: string;
  /**
   * Approval gate (trust-before-install, D-017). Called with the pack's
   * declared capabilities BEFORE any source is written. Returning false aborts
   * the install with nothing written. Defaults to refusing (safe default) so a
   * caller must consciously approve.
   */
  approve?: (disclosure: CapabilityDisclosure) => boolean | Promise<boolean>;
}

export interface InstallResult {
  name: string;
  version: string;
  registry: string;
  /** Absolute path to the vendored entry source file. */
  entryPath: string;
  vendorDir: string;
  capabilities: string[];
  macros: string[];
  approved: boolean;
}

export function disclosureFor(manifest: PackManifest): CapabilityDisclosure {
  return {
    name: manifest.name,
    version: manifest.version,
    capabilities: manifest.capabilities,
    hasUndeclaredCapabilities: manifest.hasUndeclaredCapabilities,
    macros: manifest.macros.map((m) => ({ name: m.name, capabilities: m.capabilities })),
  };
}

/**
 * Install a pack into a project: resolve a version, surface its declared
 * capabilities for approval, and only on approval vendor the readable source +
 * record a lockfile entry. Returns approved:false (writing nothing) if the
 * approval gate declines.
 */
export async function installPack(
  spec: string,
  opts: InstallOptions = {},
): Promise<InstallResult> {
  const registry = resolve(opts.registry ?? DEFAULT_REGISTRY);
  const projectDir = resolve(opts.projectDir ?? process.cwd());
  const approve = opts.approve ?? (() => false);

  const { name, range } = parseSpec(spec);
  const resolved = resolvePack(name, range, registry);
  const manifest = resolved.manifest;
  const disclosure = disclosureFor(manifest);

  const ok = await approve(disclosure);
  if (!ok) {
    return {
      name: manifest.name,
      version: manifest.version,
      registry,
      entryPath: "",
      vendorDir: "",
      capabilities: manifest.capabilities,
      macros: manifest.macros.map((m) => m.name),
      approved: false,
    };
  }

  // Vendor the readable source.
  const vendorDir = join(projectDir, ".macrokit", "packs", safeName(manifest.name), manifest.version);
  for (const [rel, text] of Object.entries(manifest.files)) {
    const dest = join(vendorDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, text);
  }
  const entryPath = join(vendorDir, manifest.entry);

  // Register in the lockfile for reproducible installs.
  writeLockEntry(projectDir, {
    name: manifest.name,
    version: manifest.version,
    registry,
    integrity: manifest.integrity,
    capabilities: manifest.capabilities,
    entry: manifest.entry,
    macros: manifest.macros.map((m) => m.name),
  });

  return {
    name: manifest.name,
    version: manifest.version,
    registry,
    entryPath,
    vendorDir,
    capabilities: manifest.capabilities,
    macros: manifest.macros.map((m) => m.name),
    approved: true,
  };
}

export function parseSpec(spec: string): { name: string; range: string | undefined } {
  // Support scoped names (@scope/pkg@^1). Split on the LAST '@' that isn't index 0.
  const at = spec.lastIndexOf("@");
  if (at <= 0) return { name: spec, range: undefined };
  return { name: spec.slice(0, at), range: spec.slice(at + 1) };
}

interface LockEntry {
  name: string;
  version: string;
  registry: string;
  integrity: string;
  capabilities: string[];
  entry: string;
  macros: string[];
}

interface Lockfile {
  lockfileVersion: number;
  packages: Record<string, Omit<LockEntry, "name">>;
}

export function readLockfile(projectDir: string): Lockfile {
  const p = join(projectDir, LOCKFILE);
  if (!existsSync(p)) return { lockfileVersion: 1, packages: {} };
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (j && typeof j === "object" && j.packages) return j as Lockfile;
  } catch {
    /* fall through */
  }
  return { lockfileVersion: 1, packages: {} };
}

function writeLockEntry(projectDir: string, entry: LockEntry): void {
  const lock = readLockfile(projectDir);
  const { name, ...rest } = entry;
  lock.packages[name] = rest;
  writeFileSync(join(projectDir, LOCKFILE), JSON.stringify(lock, null, 2) + "\n");
}
