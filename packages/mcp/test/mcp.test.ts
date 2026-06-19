import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionLog } from "@macrokit/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadProject } from "../src/load-project.js";
import { buildMcpServer } from "../src/server.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(HERE, "fixtures", "proj");

function textOf(res: unknown): string {
  return (res as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";
}

describe("@macrokit/mcp — load a project from disk", () => {
  it("discovers domain macros and utility primitives", async () => {
    const project = await loadProject(PROJECT);
    expect(project.manifest.name).toBe("test-proj");
    expect(project.macros.map((m) => m.name)).toContain("greet");
    expect(project.primitives.map((m) => m.name)).toContain("ping");
    expect(project.registry.has("greet")).toBe(true);
    expect(project.registry.has("ping")).toBe(true);
  });
});

describe("@macrokit/mcp — the server exposes the right tools and runs them", () => {
  it("list_macros / run_macro / each primitive, over a real stdio-style round-trip", async () => {
    const project = await loadProject(PROJECT);
    const log = new SessionLog(); // in-memory for assertions
    log.append({ type: "user", text: "test session" } as never);
    const server = buildMcpServer({ project, log });

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientT);

    // tools/list round-trip
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["list_macros", "run_macro", "ping"]));

    // list_macros returns the seeded macro
    const listed = JSON.parse(textOf(await client.callTool({ name: "list_macros", arguments: {} })));
    expect(listed.map((m: { name: string }) => m.name)).toContain("greet");

    // run_macro dispatches and returns a result
    const ran = await client.callTool({ name: "run_macro", arguments: { name: "greet", args: { name: "ada" } } });
    expect(textOf(ran)).toContain("hello ada");

    // a primitive tool dispatches
    const pinged = await client.callTool({ name: "ping", arguments: { value: "x" } });
    expect(textOf(pinged)).toContain("x");

    // every tool call was recorded to the session log (so `macrokit gate` works)
    const calls = log.entries.filter((e) => e.type === "tool_call").map((e) => (e as { tool: string }).tool);
    expect(calls).toContain("greet");
    expect(calls).toContain("ping");

    await client.close();
  });

  it("writes the session log to .macrokit/sessions/ on disk", async () => {
    const project = await loadProject(PROJECT);
    const dir = mkdtempSync(join(tmpdir(), "mcp-iv-"));
    const logPath = join(dir, ".macrokit", "sessions", "s.jsonl");
    const log = new SessionLog({ path: logPath });
    log.append({ type: "user", text: "disk session" } as never);
    const server = buildMcpServer({ project, log });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(ct);
    await client.callTool({ name: "ping", arguments: {} });
    await client.close();

    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.some((e) => e.type === "tool_call" && e.tool === "ping")).toBe(true);
  });
});
