import { describe, it, expect } from "vitest";
import { classify } from "../src/macros.js";

const f = (filename: string) => ({ filename });

describe("classify", () => {
  it("honors conventional-commit title prefixes", () => {
    expect(classify({ title: "fix: divide by zero", body: null }, [])).toBe("bug");
    expect(classify({ title: "feat(api): add /v2 endpoint", body: null }, [])).toBe("feature");
    expect(classify({ title: "docs: clarify quickstart", body: null }, [])).toBe("docs");
    expect(classify({ title: "test: cover edge case", body: null }, [])).toBe("test");
    expect(classify({ title: "chore(deps): bump zod", body: null }, [])).toBe("chore");
    expect(classify({ title: "ci: pin Node version", body: null }, [])).toBe("chore");
    expect(classify({ title: "refactor: extract Macro types", body: null }, [])).toBe("chore");
  });

  it("falls back to keyword signals in the title", () => {
    expect(classify({ title: "Crash on empty registry", body: null }, [])).toBe("bug");
    expect(classify({ title: "Add Ollama adapter", body: null }, [])).toBe("feature");
  });

  it("uses file shape when title is uninformative", () => {
    const docsOnly = [f("docs/quickstart.md"), f("README.md")];
    expect(classify({ title: "Update wording", body: null }, docsOnly)).toBe("docs");

    const testsOnly = [
      f("packages/runtime/test/runtime.test.ts"),
      f("packages/llm/test/openai-compatible.test.ts"),
    ];
    expect(classify({ title: "More coverage", body: null }, testsOnly)).toBe("test");

    const ciOnly = [f(".github/workflows/ci.yml"), f("pnpm-lock.yaml")];
    expect(classify({ title: "Bump pnpm", body: null }, ciOnly)).toBe("chore");

    const code = [f("packages/runtime/src/router.ts")];
    expect(classify({ title: "tweak things", body: null }, code)).toBe("feature");
  });
});
