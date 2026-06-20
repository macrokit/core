import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  MacroRegistry,
  Runtime,
  type Macro,
  type MacroError,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const echo: Macro<{ text: string; shout: boolean }, { text: string }> = {
  name: "echo",
  intent: "echo back whatever the user said, optionally shouting",
  schema: z.object({ text: z.string(), shout: z.boolean().default(false) }),
  handler: async ({ text, shout }) => ({ text: shout ? text.toUpperCase() : text }),
};

const explodes: Macro<Record<string, never>, never> = {
  name: "explodes",
  intent: "always throws — exercises the handler_threw failure shape",
  schema: z.object({}),
  handler: async () => {
    throw new Error("kaboom");
  },
};

function newRuntime(): Runtime {
  return new Runtime({
    registry: new MacroRegistry().register(echo).register(explodes),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MacroRegistry", () => {
  it("registers and looks up macros", () => {
    const r = new MacroRegistry().register(echo);
    expect(r.has("echo")).toBe(true);
    expect(r.lookup("echo")?.name).toBe("echo");
    expect(r.size).toBe(1);
  });

  it("rejects duplicate registrations", () => {
    const r = new MacroRegistry().register(echo);
    expect(() => r.register(echo)).toThrow(/already registered/);
  });

  it("rejects illegal macro names", () => {
    const r = new MacroRegistry();
    expect(() =>
      r.register({ ...echo, name: "Echo-Macro" } as Macro),
    ).toThrow(/Invalid macro name/);
  });
});

describe("Runtime.dispatch — happy path", () => {
  it("dispatches a macro and returns its value", async () => {
    const rt = newRuntime();
    const result = await rt.dispatch({
      tool: "echo",
      args: { text: "hello", shout: true },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ text: "HELLO" });
  });

  it("applies schema defaults", async () => {
    const rt = newRuntime();
    const result = await rt.dispatch({
      tool: "echo",
      args: { text: "hello" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ text: "hello" });
  });

  it("writes tool_call and tool_result entries to the session log", async () => {
    const rt = newRuntime();
    await rt.dispatch({ tool: "echo", args: { text: "x" } });
    // `echo` declares no capabilities, so a legacy-permissive `system`
    // advisory is logged alongside the tool_call/tool_result pair (D-017).
    const types = rt.log.entries
      .map((e) => e.type)
      .filter((t) => t !== "system");
    expect(types).toEqual(["tool_call", "tool_result"]);
  });
});

describe("Runtime.dispatch — failure shapes", () => {
  it("returns macro_not_found for unknown macros", async () => {
    const rt = newRuntime();
    const result = await rt.dispatch({ tool: "nonexistent", args: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("macro_not_found");
      expect(result.error.hint).toMatch(/router prompt/);
    }
  });

  it("returns schema_validation_failed for bad args", async () => {
    const rt = newRuntime();
    const result = await rt.dispatch({ tool: "echo", args: { text: 42 } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.error as MacroError;
      expect(err.code).toBe("schema_validation_failed");
      expect(err.step).toBe("schema");
      expect(err.hint).toMatch(/Do not retry/);
    }
  });

  it("returns handler_threw when the handler raises", async () => {
    const rt = newRuntime();
    const result = await rt.dispatch({ tool: "explodes", args: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("handler_threw");
      expect(result.error.message).toContain("kaboom");
      expect(result.error.step).toBe("handler");
    }
  });
});

describe("MacroContext", () => {
  it("exposes tool surfaces and an abort signal to handlers", async () => {
    let observedTools: unknown = null;
    let observedSignal: AbortSignal | null = null;
    const probe: Macro<Record<string, never>, void> = {
      name: "probe",
      intent: "introspect MacroContext",
      schema: z.object({}),
      handler: async (_args, ctx) => {
        observedTools = ctx.tools;
        observedSignal = ctx.signal;
      },
    };
    const rt = new Runtime({
      registry: new MacroRegistry().register(probe),
      toolSurfaces: { http: { fetch: () => null } },
    });
    await rt.dispatch({ tool: "probe", args: {} });
    expect(observedTools).toEqual({ http: { fetch: expect.any(Function) } });
    expect(observedSignal).toBeInstanceOf(AbortSignal);
  });
});
