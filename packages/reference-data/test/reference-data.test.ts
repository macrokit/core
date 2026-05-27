import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  BundleCache,
  generateKeyPair,
  hexToBytes,
  loadBundle,
  ReferenceDataError,
  sha256Hex,
  signManifest,
  verifyManifest,
  bytesToHex,
  type BundleManifest,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Bundle fixture
// ---------------------------------------------------------------------------

interface Fixture {
  dir: string;
  manifest: BundleManifest;
  publicKey: Uint8Array;
}

async function buildSignedFixture(
  overrides: Partial<BundleManifest> = {},
  files: Array<{ path: string; bytes: Uint8Array; format: "json" | "csv" }> = defaultFiles(),
): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "macrokit-refdata-"));
  for (const f of files) {
    writeFileSync(join(dir, f.path), Buffer.from(f.bytes));
  }
  const { publicKey, privateKey } = await generateKeyPair();
  const unsigned: Omit<BundleManifest, "signature"> = {
    name: "test-bundle",
    version: "1.0.0",
    publishedAt: new Date().toISOString(),
    files: files.map((f) => ({
      path: f.path,
      format: f.format,
      sha256: sha256Hex(Buffer.from(f.bytes)),
    })),
    signedBy: bytesToHex(publicKey),
    ...overrides,
  };
  const signed = await signManifest(unsigned, privateKey);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(signed, null, 2));
  return { dir, manifest: signed, publicKey };
}

function defaultFiles() {
  const brands = new TextEncoder().encode(
    JSON.stringify([
      { id: "acme", label: "Acme Co.", banned: false },
      { id: "evil", label: "Evil Corp.", banned: true },
    ]),
  );
  const categoriesCsv = new TextEncoder().encode(
    "id,label,parent\nhw,Hardware,\ngpu,GPUs,hw\ncpu,CPUs,hw\n",
  );
  return [
    { path: "brands.json", bytes: brands, format: "json" as const },
    { path: "categories.csv", bytes: categoriesCsv, format: "csv" as const },
  ];
}

// ---------------------------------------------------------------------------
// signing
// ---------------------------------------------------------------------------

describe("signManifest / verifyManifest", () => {
  it("round-trips a signed manifest", async () => {
    const { publicKey, privateKey } = await generateKeyPair();
    const unsigned: Omit<BundleManifest, "signature"> = {
      name: "x",
      version: "1.0.0",
      publishedAt: "2026-05-27T00:00:00Z",
      files: [{ path: "a.json", format: "json", sha256: "00" }],
    };
    const signed = await signManifest(unsigned, privateKey);
    expect(signed.signature).toBeTruthy();
    expect(await verifyManifest(signed, publicKey)).toBe(true);
  });

  it("rejects tampering with any signed field", async () => {
    const { publicKey, privateKey } = await generateKeyPair();
    const unsigned: Omit<BundleManifest, "signature"> = {
      name: "x",
      version: "1.0.0",
      publishedAt: "2026-05-27T00:00:00Z",
      files: [{ path: "a.json", format: "json", sha256: "00" }],
    };
    const signed = await signManifest(unsigned, privateKey);
    const tampered = { ...signed, version: "1.0.1" };
    expect(await verifyManifest(tampered, publicKey)).toBe(false);
  });

  it("returns false on missing signature", async () => {
    const { publicKey } = await generateKeyPair();
    const unsigned: BundleManifest = {
      name: "x",
      version: "1.0.0",
      publishedAt: "2026-05-27T00:00:00Z",
      files: [{ path: "a.json", format: "json", sha256: "00" }],
    };
    expect(await verifyManifest(unsigned, publicKey)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadBundle
// ---------------------------------------------------------------------------

describe("loadBundle", () => {
  let fixture: Fixture;
  beforeAll(async () => {
    fixture = await buildSignedFixture();
  });

  it("loads JSON and CSV files from disk", async () => {
    const bundle = await loadBundle(fixture.dir);
    expect(bundle.manifest.name).toBe("test-bundle");
    expect(bundle.records.brands).toHaveLength(2);
    expect(bundle.records.categories).toHaveLength(3);
    expect((bundle.records.brands as Array<{ id: string }>)[0]?.id).toBe("acme");
    expect((bundle.records.categories as Array<{ id: string }>)[1]?.id).toBe("gpu");
  });

  it("validates rows against caller schemas", async () => {
    const brandSchema = z.object({
      id: z.string(),
      label: z.string(),
      banned: z.boolean(),
    });
    const bundle = await loadBundle(fixture.dir, {
      schemas: { brands: brandSchema },
    });
    const brands = bundle.records.brands as Array<z.infer<typeof brandSchema>>;
    expect(brands[0]?.banned).toBe(false);
  });

  it("rejects sha256 mismatch", async () => {
    const tampered = await buildSignedFixture();
    // Overwrite a file but keep the manifest's old sha256.
    writeFileSync(join(tampered.dir, "brands.json"), '[{"id":"hacked"}]');
    await expect(loadBundle(tampered.dir)).rejects.toMatchObject({
      code: "sha256_mismatch",
    });
  });

  it("verifies signature when a public key is configured", async () => {
    await expect(
      loadBundle(fixture.dir, { publicKeyHex: bytesToHex(fixture.publicKey) }),
    ).resolves.toBeDefined();
  });

  it("fails when signed with the wrong key", async () => {
    const { publicKey: wrongKey } = await generateKeyPair();
    await expect(
      loadBundle(fixture.dir, { publicKeyHex: bytesToHex(wrongKey) }),
    ).rejects.toMatchObject({ code: "signature_invalid" });
  });

  it("rejects expired bundles", async () => {
    const expired = await buildSignedFixture({
      expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    await expect(loadBundle(expired.dir)).rejects.toMatchObject({ code: "expired" });
  });

  it("loads expired bundles when allowExpired is true", async () => {
    const expired = await buildSignedFixture({
      expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    const result = await loadBundle(expired.dir, { allowExpired: true });
    expect(result.manifest.name).toBe("test-bundle");
  });

  it("rejects manifests with non-semver versions", async () => {
    const bad = mkdtempSync(join(tmpdir(), "macrokit-refdata-bad-"));
    writeFileSync(
      join(bad, "manifest.json"),
      JSON.stringify({
        name: "x",
        version: "latest",
        publishedAt: "2026-05-27T00:00:00Z",
        files: [{ path: "a.json", format: "json", sha256: "00" }],
      }),
    );
    await expect(loadBundle(bad)).rejects.toMatchObject({ code: "manifest_invalid" });
  });
});

// ---------------------------------------------------------------------------
// BundleCache
// ---------------------------------------------------------------------------

describe("BundleCache", () => {
  function newCache(): { cache: BundleCache; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "macrokit-cache-"));
    return { cache: new BundleCache({ path: join(dir, "cache.db") }), dir };
  }

  it("round-trips a bundle through the cache", async () => {
    const { cache } = newCache();
    const fixture = await buildSignedFixture();
    const bundle = await loadBundle(fixture.dir);
    cache.put(bundle);
    const hit = cache.get("test-bundle", "1.0.0");
    expect(hit?.records.brands).toHaveLength(2);
    cache.close();
  });

  it("treats expired cache entries as misses", async () => {
    const { cache } = newCache();
    const fixture = await buildSignedFixture();
    const bundle = await loadBundle(fixture.dir);
    cache.put(bundle, 1); // 1ms TTL
    await new Promise((r) => setTimeout(r, 20));
    expect(cache.get("test-bundle", "1.0.0")).toBeUndefined();
    cache.close();
  });

  it("getLatest picks the highest semver", async () => {
    const { cache } = newCache();
    const f1 = await buildSignedFixture({ version: "1.2.0" });
    const f2 = await buildSignedFixture({ version: "1.10.0" });
    const f3 = await buildSignedFixture({ version: "1.2.5" });
    cache.put(await loadBundle(f1.dir));
    cache.put(await loadBundle(f2.dir));
    cache.put(await loadBundle(f3.dir));
    expect(cache.getLatest("test-bundle")?.manifest.version).toBe("1.10.0");
    cache.close();
  });

  it("list and delete behave as expected", async () => {
    const { cache } = newCache();
    const f1 = await buildSignedFixture({ version: "1.0.0" });
    const f2 = await buildSignedFixture({ version: "1.1.0" });
    cache.put(await loadBundle(f1.dir));
    cache.put(await loadBundle(f2.dir));
    expect(cache.list()).toHaveLength(2);
    expect(cache.delete("test-bundle", "1.0.0")).toBe(1);
    expect(cache.list()).toHaveLength(1);
    expect(cache.delete("test-bundle")).toBe(1);
    expect(cache.list()).toHaveLength(0);
    cache.close();
  });
});

describe("hex helpers", () => {
  it("round-trip", () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 255]);
    const hex = bytesToHex(bytes);
    expect(hex).toBe("00010f10ff");
    expect(Array.from(hexToBytes(hex))).toEqual(Array.from(bytes));
  });
});
