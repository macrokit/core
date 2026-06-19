import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2022",
    external: ["@macrokit/runtime", "@macrokit/mcp"],
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    sourcemap: true,
    target: "es2022",
    external: ["@macrokit/runtime", "@macrokit/mcp"],
    banner: { js: "#!/usr/bin/env node" },
  },
]);
