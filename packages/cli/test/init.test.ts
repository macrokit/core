import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../src/init.js";

function scaffold(vertical: "github" | "starter") {
  const dir = mkdtempSync(join(tmpdir(), `macrokit-init-${vertical}-`));
  const result = initProject({ dir, name: "demo-proj", vertical });
  return { dir, result };
}

describe("init --vertical github", () => {
  it("scaffolds the by-product project layout", () => {
    const { dir, result } = scaffold("github");
    expect(result.vertical).toBe("github");
    for (const f of [
      "macrokit.json",
      "package.json",
      "tsconfig.json",
      "macros/summarize-open-issues.ts",
      "macros/triage-newest-pull.ts",
      "primitives/github-client.ts",
      "fixtures/example-repo.json",
    ]) {
      expect(existsSync(join(dir, f)), `${f} should exist`).toBe(true);
    }
  });

  it("writes a valid manifest naming the project + vertical + runtime model", () => {
    const { dir } = scaffold("github");
    const manifest = JSON.parse(readFileSync(join(dir, "macrokit.json"), "utf8"));
    expect(manifest.name).toBe("demo-proj");
    expect(manifest.vertical).toBe("github");
    expect(manifest.model.runtime.provider).toBe("ollama");
    expect(manifest.paths.macros).toBe("macros");
  });

  it("seeds a macro authored via defineMacro", () => {
    const { dir } = scaffold("github");
    const src = readFileSync(join(dir, "macros/summarize-open-issues.ts"), "utf8");
    expect(src).toContain("defineMacro");
    expect(src).toContain('name: "summarize_open_issues"');
    expect(src).toContain("@macrokit/authoring");
  });

  it("does not leak banned domain terms (Sacred Rule #1)", () => {
    const { dir } = scaffold("github");
    const banned = /1688|aliexpress|ebay|etsy|amazon|shopify|autostore|deakee/i;
    for (const f of [
      "macros/summarize-open-issues.ts",
      "macros/triage-newest-pull.ts",
      "primitives/github-client.ts",
      "macrokit.json",
      "README.md",
    ]) {
      expect(banned.test(readFileSync(join(dir, f), "utf8")), `${f} clean`).toBe(false);
    }
  });
});

describe("init (starter, default)", () => {
  it("scaffolds the minimal seed without touching the github layout", () => {
    const { dir, result } = scaffold("starter");
    expect(result.vertical).toBe("starter");
    expect(existsSync(join(dir, "macros/echo.ts"))).toBe(true);
    expect(existsSync(join(dir, "src/main.ts"))).toBe(true);
    expect(existsSync(join(dir, "primitives/github-client.ts"))).toBe(false);
  });
});
