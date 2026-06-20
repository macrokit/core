import { describe, it, expect } from "vitest";
import { z } from "zod";
import { MacroRegistry, Runtime, type Macro } from "../src/index.js";

// ---------------------------------------------------------------------------
// Capability manifest enforcement (D-017)
//
// A macro is unsandboxed code with the user's credentials. The capability
// manifest lets a macro DECLARE the tool-surface keys it may touch, and the
// dispatcher ENFORCES it via a capability-scoped Proxy over ctx.tools.
// ---------------------------------------------------------------------------

function makeRuntime(macro: Macro): Runtime {
  return new Runtime({
    registry: new MacroRegistry().register(macro),
    toolSurfaces: {
      github: { openPR: () => "pr-1" },
      fs: { read: () => "secret" },
    },
  });
}

describe("capability manifest — declared + only-declared access", () => {
  it("runs the handler and returns ok when it touches only declared surfaces", async () => {
    let observed: unknown;
    const macro: Macro = {
      name: "gh_only",
      intent: "touches only github",
      capabilities: ["github"],
      schema: z.object({}),
      handler: async (_args, ctx) => {
        const gh = ctx.tools.github as { openPR: () => string };
        observed = gh.openPR();
        return { observed };
      },
    };
    const rt = makeRuntime(macro);
    const result = await rt.dispatch({ tool: "gh_only", args: {} });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ observed: "pr-1" });
  });
});

describe("capability manifest — declared + undeclared access", () => {
  it("throws capability_violation and logs it when touching an undeclared surface", async () => {
    const macro: Macro = {
      name: "sneaky",
      intent: "declares github but reaches for fs",
      capabilities: ["github"],
      schema: z.object({}),
      handler: async (_args, ctx) => {
        // would-be exfiltration: access undeclared fs surface
        const fs = ctx.tools.fs as { read: () => string };
        return { leaked: fs.read() };
      },
    };
    const rt = makeRuntime(macro);
    const result = await rt.dispatch({ tool: "sneaky", args: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("capability_violation");
      expect(result.error.step).toBe("capability_check");
      expect(result.error.message).toContain("sneaky");
      expect(result.error.message).toContain("fs");
      expect(result.error.hint).toMatch(/capabilities array/);
    }
    // The violation must be recorded in the session log.
    const logged = rt.log.entries.some(
      (e) =>
        e.type === "tool_result" &&
        (e.error as { code?: string } | undefined)?.code === "capability_violation",
    );
    expect(logged).toBe(true);
  });
});

describe("capability manifest — legacy-permissive (no field)", () => {
  it("runs unrestricted and emits an advisory when capabilities is undefined", async () => {
    let reachedFs: unknown;
    const macro: Macro = {
      name: "legacy",
      intent: "no capabilities field — legacy permissive",
      schema: z.object({}),
      handler: async (_args, ctx) => {
        const fs = ctx.tools.fs as { read: () => string };
        reachedFs = fs.read();
        return { reachedFs };
      },
    };
    const rt = makeRuntime(macro);
    const result = await rt.dispatch({ tool: "legacy", args: {} });
    expect(result.ok).toBe(true);
    expect(reachedFs).toBe("secret");
    // One-line advisory in the log.
    const advisory = rt.log.entries.some(
      (e) =>
        e.type === "system" &&
        typeof e.message === "string" &&
        /declares no capabilities/.test(e.message as string),
    );
    expect(advisory).toBe(true);
  });
});

describe("capability manifest — empty array denies everything", () => {
  it("throws capability_violation on any ctx.tools access when capabilities is []", async () => {
    const macro: Macro = {
      name: "locked",
      intent: "declares an empty capability set",
      capabilities: [],
      schema: z.object({}),
      handler: async (_args, ctx) => {
        const gh = ctx.tools.github as { openPR: () => string };
        return { v: gh.openPR() };
      },
    };
    const rt = makeRuntime(macro);
    const result = await rt.dispatch({ tool: "locked", args: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("capability_violation");
      expect(result.error.message).toContain("github");
    }
  });
});

describe("capability manifest — enumeration must not leak an undeclared surface", () => {
  it("`in`, Object.keys, and Reflect.ownKeys hide undeclared surfaces; declared stays usable", async () => {
    const seen: Record<string, unknown> = {};
    const macro: Macro = {
      name: "enum_probe",
      intent: "probe enumeration leak vectors",
      capabilities: ["github"],
      schema: z.object({}),
      handler: async (_a, ctx) => {
        seen.fsIn = "fs" in ctx.tools; // has trap
        seen.keys = Object.keys(ctx.tools); // ownKeys + getOwnPropertyDescriptor
        seen.ownKeys = Reflect.ownKeys(ctx.tools);
        seen.githubUsable = !!(ctx.tools.github as { openPR?: unknown })?.openPR;
        return {};
      },
    };
    const result = await makeRuntime(macro).dispatch({ tool: "enum_probe", args: {} });
    expect(result.ok).toBe(true); // none of the above throws
    expect(seen.fsIn).toBe(false);
    expect(seen.keys).toEqual(["github"]);
    expect(seen.ownKeys).toEqual(["github"]);
    expect(seen.githubUsable).toBe(true);
  });
});

describe("capability manifest — robustness with a frozen toolSurfaces (membrane)", () => {
  it("enumerating ctx.tools over a frozen surfaces object scopes cleanly, no invariant crash", async () => {
    const macro: Macro = {
      name: "frozen",
      intent: "frozen surfaces",
      capabilities: ["github"],
      schema: z.object({}),
      handler: async (_a, ctx) => ({ keys: Object.keys(ctx.tools) }),
    };
    const rt = new Runtime({
      registry: new MacroRegistry().register(macro),
      toolSurfaces: Object.freeze({
        github: { openPR: () => "pr-1" },
        fs: { read: () => "secret" },
      }),
    });
    const result = await rt.dispatch({ tool: "frozen", args: {} });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ keys: ["github"] });
  });

  it("still denies the undeclared surface even when surfaces are frozen", async () => {
    const macro: Macro = {
      name: "frozen_deny",
      intent: "frozen, reaches undeclared",
      capabilities: ["github"],
      schema: z.object({}),
      handler: async (_a, ctx) => ({ v: (ctx.tools.fs as { read: () => string }).read() }),
    };
    const rt = new Runtime({
      registry: new MacroRegistry().register(macro),
      toolSurfaces: Object.freeze({
        github: { openPR: () => "pr-1" },
        fs: { read: () => "secret" },
      }),
    });
    const result = await rt.dispatch({ tool: "frozen_deny", args: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("capability_violation");
  });
});
