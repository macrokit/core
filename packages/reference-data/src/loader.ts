import { readFileSync, existsSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { sha256Hex, verifyManifest, hexToBytes } from "./signing.js";
import type {
  BundleFileDescriptor,
  BundleManifest,
  BundleRowSchema,
  LoadedBundle,
} from "./types.js";

export interface LoadBundleOptions {
  /**
   * Per-bundle-file schemas. Keyed by file name without extension.
   * The loader runs `.parse(row)` on every record.
   */
  schemas?: Record<string, BundleRowSchema>;

  /**
   * Trusted ed25519 public key (hex). If set, the manifest's signature is
   * verified and the load fails on mismatch or missing signature.
   */
  publicKeyHex?: string;

  /** Allow loading bundles whose `expiresAt` has passed. Default false. */
  allowExpired?: boolean;
}

/**
 * Load a bundle from a local directory or an HTTPS URL pointing at a
 * directory listing (one manifest.json + the referenced files). Validates
 * sha256s, validates rows against caller schemas, optionally verifies the
 * signature.
 */
export async function loadBundle(
  source: string,
  opts: LoadBundleOptions = {},
): Promise<LoadedBundle> {
  const reader = source.startsWith("http://") || source.startsWith("https://")
    ? httpReader(source)
    : fileReader(source);

  const manifestBytes = await reader.read("manifest.json");
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as BundleManifest;

  validateManifestShape(manifest);
  if (!opts.allowExpired) assertNotExpired(manifest);

  if (opts.publicKeyHex) {
    const ok = await verifyManifest(manifest, hexToBytes(opts.publicKeyHex));
    if (!ok) {
      throw new ReferenceDataError(
        `Bundle "${manifest.name}@${manifest.version}" signature did not verify ` +
          `against the configured public key.`,
        { code: "signature_invalid", manifest },
      );
    }
  }

  const records: Record<string, unknown[]> = {};
  for (const file of manifest.files) {
    const bytes = await reader.read(file.path);
    assertFileIntegrity(file, bytes);
    const key = basename(file.path, extname(file.path));
    const rows = parseFileBytes(bytes, file.format);
    const schema = opts.schemas?.[key];
    records[key] = schema ? rows.map((r) => schema.parse(r)) : rows;
  }

  return { manifest, records };
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

interface BundleReader {
  read(path: string): Promise<Uint8Array>;
}

function fileReader(root: string): BundleReader {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new ReferenceDataError(
      `Bundle source "${root}" is not a directory.`,
      { code: "source_invalid" },
    );
  }
  return {
    read: async (relPath: string) => {
      const full = join(root, relPath);
      if (!existsSync(full)) {
        throw new ReferenceDataError(
          `Bundle file missing: ${relPath}`,
          { code: "file_missing", path: relPath },
        );
      }
      return new Uint8Array(readFileSync(full));
    },
  };
}

function httpReader(rootUrl: string): BundleReader {
  const base = rootUrl.replace(/\/+$/, "");
  return {
    read: async (relPath: string) => {
      const url = `${base}/${relPath}`;
      const r = await fetch(url);
      if (!r.ok) {
        throw new ReferenceDataError(
          `Bundle fetch failed: ${url} returned ${r.status}`,
          { code: "fetch_failed", url, status: r.status },
        );
      }
      return new Uint8Array(await r.arrayBuffer());
    },
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateManifestShape(m: BundleManifest): void {
  if (!m.name || typeof m.name !== "string") {
    throw new ReferenceDataError("Manifest missing `name`", { code: "manifest_invalid" });
  }
  if (!m.version || !m.version.match(/^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/)) {
    throw new ReferenceDataError(
      `Manifest version "${m.version}" is not semver`,
      { code: "manifest_invalid" },
    );
  }
  if (!Array.isArray(m.files) || m.files.length === 0) {
    throw new ReferenceDataError("Manifest must declare at least one file", {
      code: "manifest_invalid",
    });
  }
}

function assertNotExpired(m: BundleManifest): void {
  if (!m.expiresAt) return;
  const expiry = Date.parse(m.expiresAt);
  if (Number.isFinite(expiry) && expiry < Date.now()) {
    throw new ReferenceDataError(
      `Bundle "${m.name}@${m.version}" expired at ${m.expiresAt}`,
      { code: "expired", manifest: m },
    );
  }
}

function assertFileIntegrity(file: BundleFileDescriptor, bytes: Uint8Array): void {
  const actual = sha256Hex(Buffer.from(bytes));
  if (actual !== file.sha256.toLowerCase()) {
    throw new ReferenceDataError(
      `Bundle file ${file.path} sha256 mismatch: ` +
        `expected ${file.sha256}, got ${actual}`,
      { code: "sha256_mismatch", path: file.path },
    );
  }
}

function parseFileBytes(bytes: Uint8Array, format: "json" | "csv"): unknown[] {
  const text = new TextDecoder().decode(bytes);
  if (format === "json") return parseJsonRecords(text);
  return parseCsvRecords(text);
}

function parseJsonRecords(text: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) return JSON.parse(trimmed) as unknown[];
  // Newline-delimited JSON (JSONL).
  const rows: unknown[] = [];
  for (const line of trimmed.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    rows.push(JSON.parse(t));
  }
  return rows;
}

function parseCsvRecords(text: string): unknown[] {
  // Minimal RFC 4180-ish CSV: comma-delimited, double-quote escaping, header row.
  // Sufficient for reference-data lookup tables; complex CSV should be JSONL.
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]!);
  const out: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]!);
    const row: Record<string, string> = {};
    headers.forEach((h, j) => {
      row[h] = cells[j] ?? "";
    });
    out.push(row);
  }
  return out;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQ = false;
        }
      } else {
        cur += c;
      }
    } else {
      if (c === ",") {
        out.push(cur);
        cur = "";
      } else if (c === '"' && cur.length === 0) {
        inQ = true;
      } else {
        cur += c;
      }
    }
  }
  out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ReferenceDataError extends Error {
  readonly code: string;
  readonly context: Record<string, unknown>;

  constructor(message: string, context: { code: string } & Record<string, unknown>) {
    super(message);
    this.name = "ReferenceDataError";
    this.code = context.code;
    this.context = context;
  }
}
