import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Exclude fixture packages — they contain *.test.ts files that act as
    // data for the `macrokit lint --pkg` checker (the linter looks for
    // "any test file"), not as Vitest specs to execute. Loading them would
    // resolve workspace imports they don't have access to.
    exclude: ["**/node_modules/**", "**/dist/**", "test/fixtures/**"],
  },
});
