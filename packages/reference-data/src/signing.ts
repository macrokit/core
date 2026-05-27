import * as ed from "@noble/ed25519";
import { createHash } from "node:crypto";
import type { BundleManifest } from "./types.js";

/**
 * ed25519-backed manifest signing. @noble/ed25519 v2 uses webcrypto for
 * hashing on its async paths (signAsync, verifyAsync, getPublicKeyAsync),
 * and webcrypto is available on Node 20+. No additional hash wiring needed.
 *
 * We keep this module deliberately small — the only "policy" is canonical
 * JSON: keys sorted, no whitespace. Sign or verify the canonical bytes of
 * the manifest with the `signature` field stripped. That gives reproducible
 * signatures across producers and verifiers regardless of language.
 */

/**
 * Sign a manifest. Returns a new manifest with `signature` (hex) populated,
 * leaving the input unmutated.
 */
export async function signManifest(
  manifest: Omit<BundleManifest, "signature">,
  privateKey: Uint8Array,
): Promise<BundleManifest> {
  const bytes = canonicalManifestBytes(manifest);
  const sig = await ed.signAsync(bytes, privateKey);
  return { ...manifest, signature: bytesToHex(sig) };
}

/**
 * Verify a manifest's signature against a trusted public key. Returns true
 * iff the signature is present, well-formed, and valid.
 */
export async function verifyManifest(
  manifest: BundleManifest,
  publicKey: Uint8Array,
): Promise<boolean> {
  if (!manifest.signature) return false;
  const { signature, ...rest } = manifest;
  const bytes = canonicalManifestBytes(rest);
  try {
    return await ed.verifyAsync(hexToBytes(signature), bytes, publicKey);
  } catch {
    return false;
  }
}

/** Generate a new ed25519 keypair (async because v2 derives pubkey via webcrypto). */
export async function generateKeyPair(): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { publicKey, privateKey };
}

/**
 * Canonical JSON serialization: keys sorted, no whitespace. Same input
 * always produces the same bytes, so signatures are reproducible across
 * producer and verifier.
 */
export function canonicalManifestBytes(
  manifest: Omit<BundleManifest, "signature">,
): Uint8Array {
  return new TextEncoder().encode(canonicalStringify(manifest));
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalStringify).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          canonicalStringify((value as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}

/** SHA-256 of bytes, hex-encoded. Used for per-file integrity checks. */
export function sha256Hex(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex string has odd length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
