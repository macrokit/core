import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintFile } from "../src/lint.js";

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
