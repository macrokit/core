import { defineConfig } from "tsup";

// The runtime + SDK + zod stay external (resolved from node_modules at runtime).
// loader.mjs is NOT bundled — it is copied to dist/ by the build script and
// registered as an ESM module-customization hook at project-load time.
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  external: ["@macrokit/runtime", "@macrokit/authoring", "@modelcontextprotocol/sdk", "zod"],
});
