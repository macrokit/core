/**
 * Build script for the label-taxonomy bundle. Run once to (re)generate
 * `manifest.json` after editing `labels.json`. The manifest is signed with
 * the ed25519 keypair embedded below (publisher-side).
 *
 *   tsx refdata/label-taxonomy/build.ts
 *
 * The public key alone is committed in this file as a constant; downstream
 * consumers verify against it. The private key is intentionally NOT in the
 * repo — at launch we'll move signing to a separate keypair stored out of
 * band. For the reference impl, we generate a fresh keypair, print the
 * private key for the operator to save (or discard, since this is a demo
 * dataset), and emit the signed manifest.
 *
 * Usage in macros: see ../label-taxonomy.ts which loads the bundle via
 * @macrokit/reference-data, validates the public key matches, and exposes
 * the parsed labels.
 */

import {
  generateKeyPair,
  sha256Hex,
  signManifest,
  bytesToHex,
  type BundleManifest,
} from "@macrokit/reference-data";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const labelsPath = join(here, "labels.json");
const manifestPath = join(here, "manifest.json");

async function build(): Promise<void> {
  const labelsBytes = readFileSync(labelsPath);
  const { publicKey, privateKey } = await generateKeyPair();

  const unsigned: Omit<BundleManifest, "signature"> = {
    name: "macrokit-github-maintainer-labels",
    version: "1.0.0",
    publishedAt: new Date().toISOString(),
    files: [
      {
        path: "labels.json",
        format: "json",
        sha256: sha256Hex(labelsBytes),
      },
    ],
    signedBy: bytesToHex(publicKey),
  };
  const signed = await signManifest(unsigned, privateKey);
  writeFileSync(manifestPath, JSON.stringify(signed, null, 2) + "\n");

  process.stdout.write(
    `\nLabel-taxonomy bundle rebuilt.\n` +
      `  manifest:    ${manifestPath}\n` +
      `  public key:  ${bytesToHex(publicKey)}\n` +
      `  private key: ${bytesToHex(privateKey)}  (NOT committed — save out of band)\n\n`,
  );
}

build().catch((err: unknown) => {
  process.stderr.write(`build failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
