/**
 * Reference-data bundle format.
 *
 * A bundle is a directory (or HTTPS-served URL pointing at one) containing:
 *
 *   manifest.json   — descriptor, semver, file sha256s, optional ed25519 signature
 *   <file>.json     — newline-delimited or array JSON records
 *   <file>.csv      — comma-separated records, header row required
 *
 * The manifest is the single source of truth; the loader trusts the
 * manifest, the manifest is signed.
 */

export interface BundleFileDescriptor {
  /** Filename relative to the bundle root. */
  path: string;
  /** SHA-256 of the file's bytes, hex-encoded. */
  sha256: string;
  /** "json" or "csv" — drives the parser the loader picks. */
  format: "json" | "csv";
  /** Optional row count for sanity checks. */
  rows?: number;
}

export interface BundleManifest {
  name: string;
  version: string;
  /** ISO 8601 timestamp. */
  publishedAt: string;
  /** Optional ISO 8601 expiry. Loader rejects bundles past expiry. */
  expiresAt?: string;
  files: ReadonlyArray<BundleFileDescriptor>;
  /**
   * Optional ed25519 signature over the canonical-JSON serialization of
   * this manifest WITH the `signature` field stripped. Hex-encoded 64 bytes.
   * Verified by the loader when a public key is configured.
   */
  signature?: string;
  /**
   * Hex-encoded ed25519 public key the signature was produced with.
   * Optional — adopters typically configure trusted keys out of band rather
   * than trusting whatever the manifest claims.
   */
  signedBy?: string;
}

export interface LoadedBundle<TRecords extends Record<string, unknown[]> = Record<string, unknown[]>> {
  manifest: BundleManifest;
  /** Map of bundle-file name (without extension) → parsed, validated records. */
  records: TRecords;
}

/** Caller-supplied per-file zod-like schemas. The loader runs .parse() on each row. */
export interface BundleRowSchema<T = unknown> {
  parse(input: unknown): T;
}
