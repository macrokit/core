import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineMacro, testMacro, FixtureRecorder } from "../src/index.js";

describe("defineMacro", () => {
  it("returns a Macro-shaped object with sensible defaults", () => {
    const m = defineMacro({
      name: "echo",
      intent: "echo the input",
      schema: z.object({ text: z.string() }),
      handler: async ({ text }) => ({ text }),
    });
    expect(m.name).toBe("echo");
    expect(m.category).toBe("domain");
    expect(m.fixtures).toEqual([]);
  });

  it("rejects illegal names eagerly", () => {
    expect(() =>
      defineMacro({
        name: "Echo-Macro",
        intent: "x",
        schema: z.object({}),
        handler: async () => undefined,
      }),
    ).toThrow(/invalid name/);
  });

  it("rejects empty intent", () => {
    expect(() =>
      defineMacro({
        name: "echo",
        intent: "  ",
        schema: z.object({}),
        handler: async () => undefined,
      }),
    ).toThrow(/intent/);
  });

  it("preserves the utility category tag", () => {
    const bash = defineMacro({
      name: "bash",
      intent: "run a shell command",
      schema: z.object({ cmd: z.string() }),
      handler: async () => ({ stdout: "" }),
      category: "utility",
    });
    expect(bash.category).toBe("utility");
  });
});

describe("testMacro", () => {
  const echo = defineMacro({
    name: "echo",
    intent: "echo the input, optionally shouting",
    schema: z.object({ text: z.string(), shout: z.boolean().default(false) }),
    handler: async ({ text, shout }) => ({ text: shout ? text.toUpperCase() : text }),
    fixtures: [
      { name: "plain", args: { text: "hi", shout: false }, expected: { text: "hi" } },
      { name: "shout", args: { text: "hi", shout: true }, expected: { text: "HI" } },
    ],
  });

  it("replays attached fixtures", async () => {
    const results = await testMacro(echo);
    expect(results.map((r) => r.passed)).toEqual([true, true]);
  });

  it("applies schema defaults before invoking the handler", async () => {
    const m = defineMacro({
      name: "echo2",
      intent: "echo with defaults",
      schema: z.object({ text: z.string(), shout: z.boolean().default(false) }),
      handler: async ({ text, shout }) => ({ text: shout ? text.toUpperCase() : text }),
      fixtures: [
        // `shout` omitted; schema fills it in as false.
        { args: { text: "default" }, expected: { text: "default" } },
      ],
    });
    const [r] = await testMacro(m);
    expect(r?.passed).toBe(true);
  });

  it("reports failures without throwing", async () => {
    const wrong = defineMacro({
      name: "wrong",
      intent: "always wrong",
      schema: z.object({}),
      handler: async () => ({ value: 1 }),
      fixtures: [{ args: {}, expected: { value: 2 } }],
    });
    const [r] = await testMacro(wrong);
    expect(r?.passed).toBe(false);
    expect(r?.actual).toEqual({ value: 1 });
  });

  it("captures handler exceptions as errored fixtures", async () => {
    const explodes = defineMacro({
      name: "explodes",
      intent: "throws",
      schema: z.object({}),
      handler: async () => {
        throw new Error("boom");
      },
      fixtures: [{ args: {}, expected: undefined as unknown }],
    });
    const [r] = await testMacro(explodes as any);
    expect(r?.passed).toBe(false);
    expect(r?.error).toContain("boom");
  });

  it("injects per-fixture tool surfaces into MacroContext", async () => {
    const m = defineMacro({
      name: "uses_tools",
      intent: "exercises ctx.tools",
      schema: z.object({}),
      handler: async (_args, ctx) => {
        const fn = (ctx.tools.adder as (a: number, b: number) => number) ?? (() => 0);
        return { sum: fn(2, 3) };
      },
      fixtures: [
        {
          args: {},
          expected: { sum: 5 },
          tools: { adder: (a: number, b: number) => a + b },
        },
      ],
    });
    const [r] = await testMacro(m);
    expect(r?.passed).toBe(true);
  });
});

describe("FixtureRecorder", () => {
  it("appends recorded calls and persists to disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "macrokit-rec-"));
    const path = join(dir, "echo.jsonl");
    const r1 = new FixtureRecorder(path);
    r1.record({ ts: "2026-05-27T00:00:00Z", args: { text: "hi" }, result: { text: "HI" } });
    r1.record({ ts: "2026-05-27T00:00:01Z", args: { text: "ya" }, result: { text: "YA" } });
    // Re-open and verify persistence.
    const r2 = new FixtureRecorder(path);
    expect(r2.load()).toHaveLength(2);
    expect(r2.load()[1]?.args).toEqual({ text: "ya" });
  });
});
