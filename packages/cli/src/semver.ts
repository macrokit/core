/**
 * Minimal semver for the personal-registry pipeline. The pack/publish/install
 * flow needs deterministic version comparison and a small range grammar — not
 * the full npm semver surface. We support exactly what reproducible installs
 * from a personal registry need:
 *
 *   - exact:   "1.2.3"
 *   - caret:   "^1", "^1.2", "^1.2.3"   (compatible-with — allow >= within same major)
 *   - tilde:   "~1.2", "~1.2.3"          (approximately — allow >= within same minor)
 *   - any:     "*", "latest", "" (undefined)
 *
 * Pre-release / build metadata is intentionally NOT supported: a personal
 * registry of distilled macros publishes clean release versions. We refuse to
 * parse a pre-release tag rather than silently mis-resolve it.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

const CORE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Parse a strict `major.minor.patch` string. Throws on anything else. */
export function parseVersion(v: string): SemVer {
  const m = v.trim().match(CORE);
  if (!m) {
    throw new Error(
      `invalid semver "${v}": expected major.minor.patch (e.g. 1.0.0). ` +
        `Pre-release/build tags are not supported in a personal registry.`,
    );
  }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), raw: v.trim() };
}

export function isValidVersion(v: string): boolean {
  return CORE.test(v.trim());
}

/** Negative if a<b, 0 if equal, positive if a>b. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}

/**
 * Does `version` satisfy `range`? Range grammar documented above. An empty /
 * undefined range, "*", or "latest" matches any valid version.
 */
export function satisfies(version: string, range: string | undefined): boolean {
  if (!isValidVersion(version)) return false;
  const r = (range ?? "").trim();
  if (r === "" || r === "*" || r === "latest") return true;

  const v = parseVersion(version);

  if (r.startsWith("^")) {
    const lower = parsePartial(r.slice(1));
    if (!lower) return false;
    // >= lower AND < next-major (or next-minor when major is 0 — npm caret rule)
    if (cmp(v, lower) < 0) return false;
    if (lower.major > 0) return v.major === lower.major;
    if (lower.minorGiven) return v.major === 0 && v.minor === lower.minor;
    return v.major === 0;
  }

  if (r.startsWith("~")) {
    const lower = parsePartial(r.slice(1));
    if (!lower) return false;
    if (cmp(v, lower) < 0) return false;
    // ~1.2.3 / ~1.2 → same major.minor; ~1 → same major
    if (lower.minorGiven) return v.major === lower.major && v.minor === lower.minor;
    return v.major === lower.major;
  }

  // Bare partials: "1" → ^1 semantics, "1.2" → same major.minor, exact x.y.z → ==.
  if (CORE.test(r)) return compareVersions(version, r) === 0;
  const partial = parsePartial(r);
  if (!partial) return false;
  if (partial.minorGiven) return v.major === partial.major && v.minor === partial.minor;
  return v.major === partial.major;
}

/**
 * The highest version in `versions` that satisfies `range`, or undefined if
 * none do. Deterministic: ties are impossible (versions are unique), and the
 * comparison is total. Invalid versions in the list are ignored.
 */
export function maxSatisfying(versions: string[], range: string | undefined): string | undefined {
  const ok = versions.filter((v) => isValidVersion(v) && satisfies(v, range));
  if (ok.length === 0) return undefined;
  return ok.sort(compareVersions)[ok.length - 1];
}

interface Partial {
  major: number;
  minor: number;
  patch: number;
  minorGiven: boolean;
}

function parsePartial(s: string): Partial | null {
  const parts = s.trim().split(".");
  if (parts.length === 0 || parts.length > 3) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return {
    major: nums[0]!,
    minor: nums[1] ?? 0,
    patch: nums[2] ?? 0,
    minorGiven: nums.length >= 2,
  };
}

function cmp(v: SemVer, lower: Partial): number {
  return v.major - lower.major || v.minor - lower.minor || v.patch - lower.patch;
}
