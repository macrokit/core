// Fixture test file — its existence satisfies the --pkg "tests required"
// check. Not executed by the @macrokit/cli test suite; it just needs to be
// here.
//
// A real community macro package's test file would import testMacro from
// @macrokit/authoring and exercise the handler against recorded fixtures.
import { describe, it, expect } from "vitest";
import { triagePaper } from "../src/macros.js";

describe("triage_paper", () => {
  it("returns a fixture score", async () => {
    const result = await triagePaper.handler(
      { paperId: "2401.12345", dimension: "novelty" },
      { log: { append: () => {}, entries: [] }, tools: {}, signal: new AbortController().signal },
    );
    expect(result.paperId).toBe("2401.12345");
  });
});
