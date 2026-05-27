import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { BundleManifest, LoadedBundle } from "./types.js";

/**
 * Local bundle cache.
 *
 * Implementation note: the architecture doc (§2.5) called for a SQLite cache.
 * In practice the cache holds tens — not millions — of entries (one per
 * cached bundle/version), and the entries are already keyed in memory once
 * loaded, so the SQL surface bought nothing. A plain JSON file with atomic
 * rename-on-write does the same job at a fraction of the install footprint
 * and with zero native dependencies.
 *
 * The API surface (`put`, `get`, `getLatest`, `list`, `delete`, `close`) is
 * preserved so an adopter who needs a different backend can swap in a
 * subclass without touching the loader. If millions-of-entries shows up as
 * a real use case post-launch we can ship a SQLite implementation as a
 * separate package and let adopters pick.
 */

export interface BundleCacheOptions {
  /** Path to the JSON cache file. Created if missing. */
  path: string;
  /** Optional default TTL applied to inserted bundles, in milliseconds. */
  defaultTtlMs?: number;
}

export interface CachedBundle {
  manifest: BundleManifest;
  records: Record<string, unknown[]>;
  cachedAt: number;
  /** Milliseconds since epoch; null if no TTL. */
  expiresAt: number | null;
}

interface CacheFile {
  version: 1;
  entries: Record<string, CachedBundle>; // key = `${name}@${version}`
}

function emptyCache(): CacheFile {
  // Returns a fresh object every call. Do NOT replace with a shared constant
  // and `{...EMPTY}` — that would share the `entries` reference across caches
  // and writes to one would silently appear in others.
  return { version: 1, entries: {} };
}

export class BundleCache {
  private readonly path: string;
  private readonly defaultTtlMs?: number;
  private data: CacheFile;

  constructor(opts: BundleCacheOptions) {
    this.path = opts.path;
    if (opts.defaultTtlMs !== undefined) this.defaultTtlMs = opts.defaultTtlMs;
    mkdirSync(dirname(this.path), { recursive: true });
    this.data = this.load();
  }

  put(bundle: LoadedBundle, ttlMs?: number): void {
    const ttl = ttlMs ?? this.defaultTtlMs;
    const cachedAt = Date.now();
    const expiresAt = ttl !== undefined ? cachedAt + ttl : null;
    const key = `${bundle.manifest.name}@${bundle.manifest.version}`;
    this.data.entries[key] = {
      manifest: bundle.manifest,
      records: bundle.records,
      cachedAt,
      expiresAt,
    };
    this.flush();
  }

  get(name: string, version: string): CachedBundle | undefined {
    const entry = this.data.entries[`${name}@${version}`];
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      // Treat expired entries as misses. Don't auto-evict — that turns
      // reads into writes and complicates concurrent access.
      return undefined;
    }
    return entry;
  }

  /** Latest cached version of a bundle by name. Ignores TTL. */
  getLatest(name: string): CachedBundle | undefined {
    const matches = Object.values(this.data.entries).filter(
      (e) => e.manifest.name === name,
    );
    if (matches.length === 0) return undefined;
    return matches.sort((a, b) =>
      compareSemver(b.manifest.version, a.manifest.version),
    )[0];
  }

  list(): Array<{
    name: string;
    version: string;
    cachedAt: number;
    expiresAt: number | null;
  }> {
    return Object.values(this.data.entries)
      .map((e) => ({
        name: e.manifest.name,
        version: e.manifest.version,
        cachedAt: e.cachedAt,
        expiresAt: e.expiresAt,
      }))
      .sort((a, b) =>
        a.name === b.name ? compareSemver(a.version, b.version) : a.name.localeCompare(b.name),
      );
  }

  delete(name: string, version?: string): number {
    let removed = 0;
    if (version) {
      const key = `${name}@${version}`;
      if (this.data.entries[key]) {
        delete this.data.entries[key];
        removed = 1;
      }
    } else {
      for (const k of Object.keys(this.data.entries)) {
        if (this.data.entries[k]!.manifest.name === name) {
          delete this.data.entries[k];
          removed += 1;
        }
      }
    }
    if (removed > 0) this.flush();
    return removed;
  }

  close(): void {
    // No-op for the JSON backend; preserved for API parity with a SQLite
    // backend an adopter might swap in.
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private load(): CacheFile {
    if (!existsSync(this.path)) return emptyCache();
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as CacheFile;
      if (parsed.version !== 1 || typeof parsed.entries !== "object") {
        return emptyCache();
      }
      return parsed;
    } catch {
      // Corrupt or partial-write file: start fresh. The cache is non-
      // authoritative — losing it means re-fetching, not data loss.
      return emptyCache();
    }
  }

  private flush(): void {
    // Atomic write: write to a temp file, then rename. Avoids the "torn write"
    // problem where a process death mid-write would leave a half-written
    // JSON file the next read would fail on.
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.path);
  }
}

function compareSemver(a: string, b: string): number {
  const pa = a.split("-")[0]!.split(".").map((n) => parseInt(n, 10));
  const pb = b.split("-")[0]!.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const da = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (da !== 0) return da;
  }
  return a.localeCompare(b);
}
