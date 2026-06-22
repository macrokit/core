/**
 * Reference-library packaging round-trip — the first real-content dogfood of
 * the Phase-4 pack/publish/install flow (item 2-C).
 *
 * Unlike pack-publish-install.test.ts (synthetic author-on-the-fly package),
 * this packs the REAL examples/hr-recruiting vertical, publishes it to a temp
 * registry, installs it into a fresh project with capability approval, and then
 * loads + registers + RUNS the installed macros against their vendored fixtures
 * through the runtime dispatcher (incl. the D-017 capability membrane).
 *
 * The sandbox lives under packages/cli so the vendored TS source resolves
 * @macrokit/authoring + zod from the workspace node_modules when imported, and
 * relative ./*.js imports resolve to their .ts sources under vitest (the same
 * resolution the example's own tests rely on).
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MacroRegistry, Dispatcher, SessionLog, type Macro } from "@macrokit/runtime";
import { buildPack } from "../src/pack.js";
import { publishPack, installPack, listVersions, type CapabilityDisclosure } from "../src/registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HR_DIR = join(HERE, "..", "..", "..", "examples", "hr-recruiting");
const SANDBOX = mkdtempSync(join(HERE, ".reflib-"));

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

describe("reference-library packaging round-trip (real hr-recruiting content)", () => {
  it("packs the real vertical: lint + leakage pass, capabilities + source captured", () => {
    const built = buildPack(HR_DIR);
    expect(built.manifest.name).toBe("@macrokit-example/hr-recruiting");
    expect(built.manifest.version).toBe("1.0.0");
    // Every HR macro declares the `ats` surface — manifest carries the union.
    expect(built.manifest.capabilities).toEqual(["ats"]);
    expect(built.manifest.hasUndeclaredCapabilities).toBe(false);
    const names = built.manifest.macros.map((m) => m.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "screen_resume", "rank_candidates", "parse_requisition",
        "draft_candidate_outreach", "schedule_interview", "check_references_dryrun",
      ]),
    );
    for (const m of built.manifest.macros) expect(m.capabilities).toEqual(["ats"]);
    // Source-available: verbatim source embedded (pure logic + fixtures).
    expect(built.manifest.files["src/scoring.ts"]).toContain("scoreResumeFit");
    expect(built.manifest.files["src/fixtures/dataset.ts"]).toContain("SAMPLE_DATASET");
    expect(built.manifest.integrity).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it("publishes, installs with capability disclosure, and the installed macros RUN against fixtures", async () => {
    const registry = join(SANDBOX, "seed-registry");
    const projectDir = join(SANDBOX, "fresh-project");
    mkdirSync(projectDir, { recursive: true });

    // --- pack + publish ---
    const built = buildPack(HR_DIR);
    const packFile = join(SANDBOX, built.filename);
    writeFileSync(packFile, built.json);
    const pub = publishPack(packFile, { registry });
    expect(pub.version).toBe("1.0.0");
    expect(listVersions(registry, "@macrokit-example/hr-recruiting")).toEqual(["1.0.0"]);

    // --- install: capability approval surfaces BEFORE any source is written (D-017) ---
    let disclosed: CapabilityDisclosure | undefined;
    const res = await installPack("@macrokit-example/hr-recruiting@^1", {
      registry,
      projectDir,
      approve: (d) => {
        disclosed = d;
        return true;
      },
    });
    expect(disclosed?.capabilities).toEqual(["ats"]);
    // every macro's capability is disclosed for the trust decision
    expect(disclosed?.macros.every((m) => Array.isArray(m.capabilities) && m.capabilities[0] === "ats")).toBe(true);
    expect(res.approved).toBe(true);
    expect(res.macros).toContain("screen_resume");

    // --- load + register the INSTALLED (vendored) macros ---
    const macrosMod = (await import(/* @vite-ignore */ join(res.vendorDir, "src/macros/index.ts"))) as Record<string, Macro>;
    const atsMod = (await import(/* @vite-ignore */ join(res.vendorDir, "src/primitives/ats-client.ts"))) as {
      InMemoryAtsClient: new (d: unknown) => { mutations: { referenceRequests: unknown[] } };
    };
    const fxMod = (await import(/* @vite-ignore */ join(res.vendorDir, "src/fixtures/dataset.ts"))) as { SAMPLE_DATASET: unknown };

    const registryObj = new MacroRegistry();
    const macroList = [
      "screenResume", "rankCandidates", "parseRequisition",
      "draftCandidateOutreach", "scheduleInterview", "checkReferencesDryRun",
    ].map((k) => macrosMod[k]!);
    for (const m of macroList) registryObj.register(m);
    expect(registryObj.list()).toHaveLength(6);

    const ats = new atsMod.InMemoryAtsClient(fxMod.SAMPLE_DATASET);
    const dispatcher = new Dispatcher({
      registry: registryObj,
      log: new SessionLog(),
      toolSurfaces: { ats },
    });

    // --- RUN against fixtures, through the capability membrane (macros declare ["ats"]) ---
    const screen = await dispatcher.dispatch({ tool: "screen_resume", args: { candidateId: "CAND-2003" } });
    expect(screen.ok).toBe(true);
    if (screen.ok) expect((screen.value as { recommendation: string }).recommendation).toBe("advance");

    const rank = await dispatcher.dispatch({ tool: "rank_candidates", args: { requisitionId: "REQ-1001", top: 2 } });
    expect(rank.ok).toBe(true);
    if (rank.ok) {
      const ranked = (rank.value as { ranked: Array<{ candidateId: string }> }).ranked;
      expect(ranked[0]!.candidateId).toBe("CAND-2003");
    }

    // safety default carried into the installed pack: dry-run, nothing sent
    const refs = await dispatcher.dispatch({ tool: "check_references_dryrun", args: { candidateId: "CAND-2001" } });
    expect(refs.ok).toBe(true);
    if (refs.ok) expect((refs.value as { dryRun: boolean }).dryRun).toBe(true);
    expect(ats.mutations.referenceRequests).toHaveLength(0);
  });
});
