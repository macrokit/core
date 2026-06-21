import { defineConfig } from "tsup";

// The MCP SDK stays external (resolved from node_modules at runtime).
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  external: ["@modelcontextprotocol/sdk"],
});
