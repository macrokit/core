import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lintFile, lintPackage } from "../src/lint.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VALID_FIXTURE = resolve(HERE, "fixtures/valid-pkg");

function makeFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "macrokit-lint-"));
  const p = join(dir, "macros.ts");
  writeFileSync(p, content);
  return p;
}

describe("lint", () => {
  it("flags invalid macro names", () => {
    const f = makeFile(`
import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";
export const bad = defineMacro({
  name: "Bad-Name",
  intent: "x",
  schema: z.object({}),
  handler: async () => null,
});
`);
    const findings = lintFile(f);
    expect(findings.map((x) => x.rule)).toContain("macro_name_invalid");
  });

  it("flags empty intent", () => {
    const f = makeFile(`
import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";
export const blank = defineMacro({
  name: "blank",
  intent: "",
  schema: z.object({}),
  handler: async () => null,
});
`);
    const findings = lintFile(f);
    expect(findings.map((x) => x.rule)).toContain("intent_empty");
  });

  it("flags a handler that calls runtime.chat()", () => {
    const f = makeFile(`
import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";
export const recurses = defineMacro({
  name: "recurses",
  intent: "calls runtime.chat from inside its handler",
  schema: z.object({}),
  handler: async (args, ctx) => {
    const r = await ctx.tools.runtime.chat("subproblem");
    return r;
  },
});
`);
    const findings = lintFile(f);
    expect(findings.map((x) => x.rule)).toContain("handler_recurses_into_chat");
  });

  it("returns no findings on a clean macro", () => {
    const f = makeFile(`
import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";
export const echo = defineMacro({
  name: "echo",
  intent: "echo the input",
  schema: z.object({ text: z.string() }),
  handler: async ({ text }) => ({ text }),
});
`);
    expect(lintFile(f)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Package linter (--pkg) — community macro package conformance
// ---------------------------------------------------------------------------

/**
 * Build a synthetic package directory with selectable pieces missing/wrong.
 * Used to exercise each failure rule independently. The fixtures/valid-pkg
 * checked into the repo covers the success path.
 */
function makePkg(opts: {
  packageJson?: object | "missing" | "malformed";
  readme?: string | "missing";
  src?: string | "missing";
  tests?: "yes" | "missing" | "fixtures-json";
}): string {
  const dir = mkdtempSync(join(tmpdir(), "macrokit-pkg-"));

  if (opts.packageJson !== "missing") {
    const content =
      opts.packageJson === "malformed"
        ? "{ not valid json"
        : JSON.stringify(opts.packageJson ?? defaultPkgJson(), null, 2);
    writeFileSync(join(dir, "package.json"), content);
  }

  if (opts.readme !== "missing") {
    writeFileSync(join(dir, "README.md"), opts.readme ?? "# fixture\n");
  }

  if (opts.src !== "missing") {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "macros.ts"), opts.src ?? defaultMacroSource());
  }

  if (opts.tests === "yes") {
    mkdirSync(join(dir, "test"), { recursive: true });
    writeFileSync(join(dir, "test", "macros.test.ts"), "// test fixture\n");
  } else if (opts.tests === "fixtures-json") {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "echo.fixtures.json"), "[]\n");
  }

  return dir;
}

function defaultPkgJson(): object {
  return {
    name: "macrokit-macros-test",
    version: "0.1.0",
    license: "Apache-2.0",
    peerDependencies: {
      "@macrokit/authoring": "^0.0.1",
      zod: "^3.23.0",
    },
  };
}

function defaultMacroSource(): string {
  return `
import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";
export const echo = defineMacro({
  name: "echo",
  intent: "echo the input",
  schema: z.object({ text: z.string() }),
  handler: async ({ text }) => ({ text }),
});
`;
}

describe("lintPackage (--pkg)", () => {
  it("passes against the checked-in valid fixture", () => {
    const result = lintPackage(VALID_FIXTURE);
    expect(result.findings).toEqual([]);
    expect(result.checks.every((c) => c.ok)).toBe(true);
    const rules = result.checks.map((c) => c.rule);
    expect(rules).toEqual(
      expect.arrayContaining([
        "pkg_no_peer_dep_authoring",
        "pkg_no_readme",
        "pkg_no_macro_export",
        "pkg_no_tests",
      ]),
    );
  });

  it("fails when package.json is missing", () => {
    const dir = makePkg({ packageJson: "missing", tests: "yes" });
    const result = lintPackage(dir);
    const failed = result.findings.map((f) => f.rule);
    expect(failed).toContain("pkg_no_peer_dep_authoring");
  });

  it("fails when @macrokit/authoring is not a peerDependency", () => {
    const dir = makePkg({
      packageJson: {
        name: "macrokit-macros-test",
        version: "0.1.0",
        license: "Apache-2.0",
        dependencies: { "@macrokit/authoring": "^0.0.1" },
      },
      tests: "yes",
    });
    const result = lintPackage(dir);
    const failed = result.findings.map((f) => f.rule);
    expect(failed).toContain("pkg_no_peer_dep_authoring");
  });

  it("fails when README.md is missing", () => {
    const dir = makePkg({ readme: "missing", tests: "yes" });
    const result = lintPackage(dir);
    const failed = result.findings.map((f) => f.rule);
    expect(failed).toContain("pkg_no_readme");
  });

  it("fails when no defineMacro() export has all four required fields", () => {
    const dir = makePkg({
      src: `
import { defineMacro } from "@macrokit/authoring";
import { z } from "zod";
export const incomplete = defineMacro({
  name: "incomplete",
  intent: "missing schema and handler",
});
`,
      tests: "yes",
    });
    const result = lintPackage(dir);
    const failed = result.findings.map((f) => f.rule);
    expect(failed).toContain("pkg_no_macro_export");
  });

  it("fails when no test files exist", () => {
    const dir = makePkg({ tests: "missing" });
    const result = lintPackage(dir);
    const failed = result.findings.map((f) => f.rule);
    expect(failed).toContain("pkg_no_tests");
  });

  it("accepts *.fixtures.json as satisfying the tests check", () => {
    const dir = makePkg({ tests: "fixtures-json" });
    const result = lintPackage(dir);
    const failed = result.findings.map((f) => f.rule);
    expect(failed).not.toContain("pkg_no_tests");
  });

  it("reports specific failure messages, not generic ones", () => {
    const dir = makePkg({ readme: "missing", tests: "missing" });
    const result = lintPackage(dir);
    const readmeFinding = result.findings.find((f) => f.rule === "pkg_no_readme");
    expect(readmeFinding?.message).toContain("README.md");
    expect(readmeFinding?.message).toContain("CONTRIBUTING_MACROS.md");
    const testsFinding = result.findings.find((f) => f.rule === "pkg_no_tests");
    expect(testsFinding?.message).toMatch(/test|fixture/);
  });

  it("handles malformed package.json without crashing", () => {
    const dir = makePkg({ packageJson: "malformed", tests: "yes" });
    const result = lintPackage(dir);
    const peerCheck = result.checks.find(
      (c) => c.rule === "pkg_no_peer_dep_authoring",
    );
    expect(peerCheck?.ok).toBe(false);
    expect(peerCheck?.message).toMatch(/valid JSON|JSON/);
  });

  it("ignores node_modules when scanning sources", () => {
    const dir = makePkg({ tests: "yes" });
    mkdirSync(join(dir, "node_modules", "something"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules", "something", "macro.ts"),
      defaultMacroSource(),
    );
    const result = lintPackage(dir);
    expect(result.findings).toEqual([]);
  });
});
