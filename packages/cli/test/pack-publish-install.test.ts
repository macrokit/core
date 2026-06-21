import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPack, PackError } from "../src/pack.js";
import { publishPack, RegistryError } from "../src/registry.js";
import { installPack, disclosureFor, listVersions, resolvePack } from "../src/registry.js";
import { maxSatisfying, satisfies } from "../src/semver.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// Sandbox MUST live under packages/cli so the vendored TS source can resolve
// @macrokit/authoring + zod via the workspace node_modules when dynamically
// imported (the round-trip's "the macro actually runs" check).
const SANDBOX = mkdtempSync(join(HERE, ".roundtrip-"));

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

/** Author a minimal-but-valid community macro package on disk. */
function authorPackage(
  dir: string,
  opts: { name: string; version: string; capabilities?: string; offset?: number },
): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: opts.name,
        version: opts.version,
        description: "Round-trip test pack.",
        license: "Apache-2.0",
        type: "module",
        peerDependencies: { "@macrokit/authoring": "^0.0.1", zod: "^3.23.0" },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, "README.md"),
    `# ${opts.name}\nMacros for arithmetic. Surface: none. No credentials.\n- \`add_n\` — add n.\nInstall: \`npm install ${opts.name} @macrokit/authoring\`.\n`,
  );
  const caps = opts.capabilities ?? `["math"]`;
  const offset = opts.offset ?? 0;
  writeFileSync(
    join(dir, "src", "macros.ts"),
    `import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";
export const addN = defineMacro({
  name: "add_n",
  intent: "add n to a base number (round-trip test macro)",
  capabilities: ${caps},
  schema: z.object({ base: z.number(), n: z.number() }),
  handler: async ({ base, n }) => ({ result: base + n + ${offset} }),
});
`,
  );
  writeFileSync(
    join(dir, "test", "macros.test.ts"),
    `import { testMacro } from "@macrokit/authoring";
import { addN } from "../src/macros.js";
testMacro(addN, [{ args: { base: 1, n: 1 }, expected: { result: ${2 + offset} } }]);
`,
  );
}

describe("pack → publish → install round-trip", () => {
  it("packs, publishes, installs, and the installed macro actually runs", async () => {
    const pkgDir = join(SANDBOX, "pkg");
    const registry = join(SANDBOX, "registry");
    const projectDir = join(SANDBOX, "project");
    mkdirSync(projectDir, { recursive: true });
    authorPackage(pkgDir, { name: "macrokit-macros-rt", version: "1.0.0" });

    // --- pack ---
    const built = buildPack(pkgDir);
    expect(built.manifest.name).toBe("macrokit-macros-rt");
    expect(built.manifest.version).toBe("1.0.0");
    expect(built.manifest.capabilities).toEqual(["math"]);
    expect(built.manifest.macros.map((m) => m.name)).toContain("add_n");
    // source-available: the verbatim source is embedded.
    expect(built.manifest.files["src/macros.ts"]).toContain("defineMacro");
    expect(built.manifest.integrity).toMatch(/^sha256-[0-9a-f]{64}$/);

    const packFile = join(SANDBOX, built.filename);
    writeFileSync(packFile, built.json);

    // --- publish ---
    const pub = publishPack(packFile, { registry });
    expect(pub.version).toBe("1.0.0");
    expect(existsSync(pub.path)).toBe(true);
    expect(listVersions(registry, "macrokit-macros-rt")).toEqual(["1.0.0"]);

    // --- install (capabilities surfaced + approved) ---
    let disclosed: string[] | undefined;
    const res = await installPack("macrokit-macros-rt@^1", {
      registry,
      projectDir,
      approve: (d) => {
        disclosed = d.capabilities;
        return true;
      },
    });
    // The approval gate genuinely received the declared capabilities.
    expect(disclosed).toEqual(["math"]);
    expect(res.approved).toBe(true);
    expect(res.version).toBe("1.0.0");
    expect(existsSync(res.entryPath)).toBe(true);
    expect(existsSync(join(projectDir, "macrokit.lock.json"))).toBe(true);

    // --- the installed macro runs (fails if any stage stubbed the source) ---
    const mod = (await import(/* @vite-ignore */ res.entryPath)) as {
      addN: { handler: (a: { base: number; n: number }, ctx: unknown) => Promise<{ result: number }> };
    };
    const out = await mod.addN.handler({ base: 40, n: 2 }, {});
    expect(out.result).toBe(42);
  });

  it("refuses to overwrite a published (name, version) — immutability", () => {
    const pkgDir = join(SANDBOX, "pkg-immut");
    const registry = join(SANDBOX, "registry-immut");
    authorPackage(pkgDir, { name: "macrokit-macros-immut", version: "2.0.0" });
    const built = buildPack(pkgDir);
    const packFile = join(SANDBOX, built.filename);
    writeFileSync(packFile, built.json);

    expect(publishPack(packFile, { registry }).version).toBe("2.0.0");
    expect(() => publishPack(packFile, { registry })).toThrow(RegistryError);
    expect(() => publishPack(packFile, { registry })).toThrow(/immutable/);
  });

  it("writes nothing when the capability approval is declined", async () => {
    const pkgDir = join(SANDBOX, "pkg-decline");
    const registry = join(SANDBOX, "registry-decline");
    const projectDir = join(SANDBOX, "project-decline");
    mkdirSync(projectDir, { recursive: true });
    authorPackage(pkgDir, { name: "macrokit-macros-decline", version: "1.0.0" });
    const built = buildPack(pkgDir);
    const packFile = join(SANDBOX, built.filename);
    writeFileSync(packFile, built.json);
    publishPack(packFile, { registry });

    const res = await installPack("macrokit-macros-decline", {
      registry,
      projectDir,
      approve: () => false,
    });
    expect(res.approved).toBe(false);
    expect(res.entryPath).toBe("");
    expect(existsSync(join(projectDir, "macrokit.lock.json"))).toBe(false);
    expect(existsSync(join(projectDir, ".macrokit"))).toBe(false);
  });

  it("resolves the highest version satisfying a semver range", async () => {
    const registry = join(SANDBOX, "registry-multi");
    for (const v of ["1.0.0", "1.2.0", "2.0.0"]) {
      const pkgDir = join(SANDBOX, `pkg-multi-${v}`);
      authorPackage(pkgDir, { name: "macrokit-macros-multi", version: v, offset: 0 });
      const built = buildPack(pkgDir);
      const packFile = join(SANDBOX, built.filename);
      writeFileSync(packFile, built.json);
      publishPack(packFile, { registry });
    }
    expect(listVersions(registry, "macrokit-macros-multi")).toEqual(["1.0.0", "1.2.0", "2.0.0"]);
    expect(resolvePack("macrokit-macros-multi", "^1", registry).version).toBe("1.2.0");
    expect(resolvePack("macrokit-macros-multi", "^2", registry).version).toBe("2.0.0");
    expect(resolvePack("macrokit-macros-multi", undefined, registry).version).toBe("2.0.0");
    expect(() => resolvePack("macrokit-macros-multi", "^3", registry)).toThrow(/satisfies/);
  });

  it("surfaces undeclared capabilities as a warning flag", () => {
    const pkgDir = join(SANDBOX, "pkg-undeclared");
    // No `capabilities:` field at all → legacy-permissive.
    mkdirSync(join(pkgDir, "src"), { recursive: true });
    mkdirSync(join(pkgDir, "test"), { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "macrokit-macros-undeclared",
        version: "1.0.0",
        license: "Apache-2.0",
        type: "module",
        peerDependencies: { "@macrokit/authoring": "^0.0.1", zod: "^3.23.0" },
      }),
    );
    writeFileSync(join(pkgDir, "README.md"), "# undeclared\nMacros. No surface. No creds.\n- `bare` — bare.\n");
    writeFileSync(
      join(pkgDir, "src", "macros.ts"),
      `import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";
export const bare = defineMacro({ name: "bare", intent: "do a bare thing", schema: z.object({}), handler: async () => null });
`,
    );
    writeFileSync(join(pkgDir, "test", "x.fixtures.json"), "{}");
    const built = buildPack(pkgDir);
    expect(built.manifest.hasUndeclaredCapabilities).toBe(true);
    const d = disclosureFor(built.manifest);
    expect(d.macros[0]!.capabilities).toBe(null);
  });
});

describe("pack gates refuse on failure", () => {
  it("refuses to pack a package that fails lint --pkg (no peer dep)", () => {
    const pkgDir = join(SANDBOX, "pkg-lintfail");
    mkdirSync(join(pkgDir, "src"), { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
    expect(() => buildPack(pkgDir)).toThrow(PackError);
    try {
      buildPack(pkgDir);
    } catch (e) {
      expect((e as PackError).detail.lintFailures?.length).toBeGreaterThan(0);
    }
  });

  // Helper: write a structurally-valid pack with the given README body, so the
  // leakage gate (not lint) is what decides pass/fail.
  function authorMinimalValid(pkgDir: string, name: string, readmeBody: string): void {
    mkdirSync(join(pkgDir, "src"), { recursive: true });
    mkdirSync(join(pkgDir, "test"), { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name,
        version: "1.0.0",
        license: "Apache-2.0",
        type: "module",
        peerDependencies: { "@macrokit/authoring": "^0.0.1", zod: "^3.23.0" },
      }),
    );
    writeFileSync(join(pkgDir, "README.md"), readmeBody);
    writeFileSync(
      join(pkgDir, "src", "macros.ts"),
      `import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";
export const m = defineMacro({ name: "m", intent: "do thing", capabilities: [], schema: z.object({}), handler: async () => null });
`,
    );
    writeFileSync(join(pkgDir, "test", "x.fixtures.json"), "{}");
  }

  it("refuses to pack content matching a generic secret pattern", () => {
    const pkgDir = join(SANDBOX, "pkg-secret");
    // A fake AWS-shaped key. Built by concatenation so the matching literal does
    // NOT appear in THIS test's source (keeps the dev leakage scan clean) — only
    // the on-disk, gitignored sandbox file carries the full token at runtime.
    const fakeKey = "AKIA" + "ABCDEFGHIJKLMNOP";
    authorMinimalValid(
      pkgDir,
      "macrokit-macros-secret",
      `# secret\nMacros. Do not embed credentials like ${fakeKey} in source.\n- \`m\` — m.\n`,
    );
    expect(() => buildPack(pkgDir)).toThrow(/leakage/);
  });

  it("refuses to pack an adopter's own deny term from .macrokitignore", () => {
    const pkgDir = join(SANDBOX, "pkg-denyterm");
    // A neutral, made-up token the adopter declares private in their config.
    // No real domain phrase — proves the configurable gate works generically.
    authorMinimalValid(
      pkgDir,
      "macrokit-macros-denyterm",
      `# denyterm\nMacros for the zorplex internal system.\n- \`m\` — m.\n`,
    );
    writeFileSync(join(pkgDir, ".macrokitignore"), "# adopter's private terms\nzorplex\n");
    expect(() => buildPack(pkgDir)).toThrow(/leakage/);
  });

  it("packs clean content with an empty deny-list (secrets-only)", () => {
    const pkgDir = join(SANDBOX, "pkg-clean");
    authorMinimalValid(
      pkgDir,
      "macrokit-macros-clean",
      `# clean\nMacros for arithmetic. No surface. No credentials.\n- \`m\` — m.\n`,
    );
    expect(() => buildPack(pkgDir)).not.toThrow();
  });
});

describe("semver", () => {
  it("satisfies caret/tilde/exact ranges", () => {
    expect(satisfies("1.2.3", "^1")).toBe(true);
    expect(satisfies("1.2.3", "^1.2")).toBe(true);
    expect(satisfies("2.0.0", "^1")).toBe(false);
    expect(satisfies("1.2.9", "~1.2")).toBe(true);
    expect(satisfies("1.3.0", "~1.2")).toBe(false);
    expect(satisfies("1.0.0", "*")).toBe(true);
    expect(satisfies("1.0.0", "1.0.0")).toBe(true);
    expect(satisfies("1.0.1", "1.0.0")).toBe(false);
  });
  it("maxSatisfying picks the highest match deterministically", () => {
    expect(maxSatisfying(["1.0.0", "1.5.0", "2.0.0"], "^1")).toBe("1.5.0");
    expect(maxSatisfying(["1.0.0", "1.5.0", "2.0.0"], undefined)).toBe("2.0.0");
    expect(maxSatisfying(["1.0.0"], "^2")).toBe(undefined);
  });
});
