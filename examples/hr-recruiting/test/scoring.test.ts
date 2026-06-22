import { describe, it, expect } from "vitest";
import {
  buildReferenceRequests,
  draftOutreach,
  parseRequisitionText,
  rankCandidates,
  scoreResumeFit,
} from "../src/scoring.js";
import { SAMPLE_DATASET } from "../src/fixtures/dataset.js";
import type { Candidate, Requisition } from "../src/primitives/ats-client.js";

const REQ = SAMPLE_DATASET.requisitions.find((r) => r.id === "REQ-1001")!;
const byId = (id: string) => SAMPLE_DATASET.candidates.find((c) => c.id === id)!;

describe("scoreResumeFit", () => {
  it("advances a strong candidate who meets every must-have and the experience floor", () => {
    const fit = scoreResumeFit(byId("CAND-2003"), REQ); // staff eng, 9y, all must-haves
    expect(fit.missingMustHave).toEqual([]);
    expect(fit.meetsExperience).toBe(true);
    expect(fit.recommendation).toBe("advance");
    expect(fit.score).toBeGreaterThanOrEqual(70);
  });

  it("never returns a clean advance when a must-have skill is missing", () => {
    const fit = scoreResumeFit(byId("CAND-2002"), REQ); // 3y, no typescript/postgresql
    expect(fit.missingMustHave.length).toBeGreaterThan(0);
    expect(fit.recommendation).not.toBe("advance");
  });

  it("flags an unmet experience floor with a years gap", () => {
    const fit = scoreResumeFit(byId("CAND-2002"), REQ); // 3y vs 5y required
    expect(fit.meetsExperience).toBe(false);
    expect(fit.yearsGap).toBe(2);
  });

  it("caps recommendation at maybe when location is incompatible (on-site req)", () => {
    const onSite: Requisition = { ...REQ, remote: false, location: "Berlin" };
    const candElsewhere: Candidate = { ...byId("CAND-2001"), remoteOk: false, location: "Austin, US" };
    const fit = scoreResumeFit(candElsewhere, onSite);
    expect(fit.locationCompatible).toBe(false);
    expect(fit.recommendation).not.toBe("advance");
  });
});

describe("rankCandidates", () => {
  it("orders the pipeline best-fit first", () => {
    const pool = SAMPLE_DATASET.candidates.filter((c) => c.requisitionId === "REQ-1001");
    const ranked = rankCandidates(REQ, pool);
    expect(ranked.map((r) => r.candidateId)).toEqual(["CAND-2003", "CAND-2001", "CAND-2002"]);
    expect(ranked[0]!.fit.score).toBeGreaterThanOrEqual(ranked[1]!.fit.score);
  });
});

describe("parseRequisitionText", () => {
  it("extracts level, years, remote, and must-have vs nice-to-have skills", () => {
    const parsed = parseRequisitionText(REQ.description);
    expect(parsed.level).toBe("senior");
    expect(parsed.minYearsExperience).toBe(5);
    expect(parsed.remote).toBe(true);
    expect(parsed.mustHaveSkills).toEqual(expect.arrayContaining(["typescript", "node.js", "postgresql"]));
    expect(parsed.niceToHaveSkills).toEqual(expect.arrayContaining(["kubernetes", "graphql", "redis"]));
    // A nice-to-have must not also be counted as a must-have.
    for (const s of parsed.niceToHaveSkills) expect(parsed.mustHaveSkills).not.toContain(s);
  });

  it("handles an on-site requisition (remote=false)", () => {
    const parsed = parseRequisitionText(SAMPLE_DATASET.requisitions[1]!.description);
    expect(parsed.remote).toBe(false);
    expect(parsed.minYearsExperience).toBe(3);
  });
});

describe("draftOutreach / buildReferenceRequests", () => {
  it("personalizes outreach with the candidate's first name and the role", () => {
    const msg = draftOutreach(byId("CAND-2001"), REQ, "warm");
    expect(msg.body).toContain("Priya");
    expect(msg.body).toContain(REQ.title);
    expect(msg.subject).toContain(REQ.title);
  });

  it("builds one reference request per listed reference", () => {
    const reqs = buildReferenceRequests(byId("CAND-2001"), REQ);
    expect(reqs).toHaveLength(2);
    expect(reqs[0]!.body).toContain(reqs[0]!.reference.name);
  });
});
