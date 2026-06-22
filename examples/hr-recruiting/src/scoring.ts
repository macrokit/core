/**
 * Pure deterministic recruiter logic — the encoded part of every macro.
 *
 * No I/O, no LLM, no randomness. These are the units the tests pin down
 * (mirrors examples/paper-triage/src/classifiers.ts and
 * examples/github-maintainer/src/classifiers.ts). The macros are thin wrappers
 * that fetch fixtured data via the ATS surface and call into here.
 */
import type {
  Candidate,
  CandidateReference,
  InterviewInvite,
  OutreachMessage,
  ReferenceRequest,
  Requisition,
} from "./primitives/ats-client.js";

export function normalizeSkill(s: string): string {
  return s.trim().toLowerCase();
}

function skillSet(skills: string[]): Set<string> {
  return new Set(skills.map(normalizeSkill));
}

export type FitRecommendation = "advance" | "maybe" | "reject";

export interface ResumeFit {
  score: number;
  recommendation: FitRecommendation;
  matchedMustHave: string[];
  missingMustHave: string[];
  matchedNiceToHave: string[];
  meetsExperience: boolean;
  yearsGap: number;
  locationCompatible: boolean;
}

/**
 * Score a candidate against a requisition. Deterministic weighting:
 *   must-have skill coverage 70 · nice-to-have coverage 15 · experience 15.
 * Location incompatibility (on-site req, candidate elsewhere and not remote-ok)
 * caps the recommendation at "maybe".
 */
export function scoreResumeFit(candidate: Candidate, requisition: Requisition): ResumeFit {
  const cand = skillSet(candidate.skills);
  const must = requisition.mustHaveSkills.map(normalizeSkill);
  const nice = requisition.niceToHaveSkills.map(normalizeSkill);

  const matchedMustHave = must.filter((s) => cand.has(s));
  const missingMustHave = must.filter((s) => !cand.has(s));
  const matchedNiceToHave = nice.filter((s) => cand.has(s));

  const mustCoverage = must.length === 0 ? 1 : matchedMustHave.length / must.length;
  const niceCoverage = nice.length === 0 ? 1 : matchedNiceToHave.length / nice.length;
  const meetsExperience = candidate.yearsExperience >= requisition.minYearsExperience;
  const yearsGap = Math.max(0, requisition.minYearsExperience - candidate.yearsExperience);

  const locationCompatible =
    requisition.remote || candidate.remoteOk || sameLocation(candidate.location, requisition.location);

  let score = Math.round(mustCoverage * 70 + niceCoverage * 15 + (meetsExperience ? 15 : 0));
  if (!locationCompatible) score = Math.min(score, 55);

  let recommendation: FitRecommendation =
    score >= 70 ? "advance" : score >= 45 ? "maybe" : "reject";
  // A missing must-have skill or unmet experience floor should never read as a
  // clean "advance" — surface it as "maybe" for human judgment.
  if (recommendation === "advance" && (missingMustHave.length > 0 || !meetsExperience)) {
    recommendation = "maybe";
  }

  return {
    score,
    recommendation,
    matchedMustHave,
    missingMustHave,
    matchedNiceToHave,
    meetsExperience,
    yearsGap,
    locationCompatible,
  };
}

function sameLocation(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[()]/g, " ").split(/[\s,]+/).filter(Boolean);
  const ta = new Set(norm(a));
  for (const tok of norm(b)) if (ta.has(tok)) return true;
  return false;
}

export interface RankedCandidate {
  candidateId: string;
  name: string;
  fit: ResumeFit;
}

/** Rank candidates by fit score (desc), tie-broken by years of experience. */
export function rankCandidates(
  requisition: Requisition,
  candidates: Candidate[],
): RankedCandidate[] {
  return candidates
    .map((c) => ({ candidateId: c.id, name: c.name, fit: scoreResumeFit(c, requisition), years: c.yearsExperience }))
    .sort((a, b) => b.fit.score - a.fit.score || b.years - a.years)
    .map(({ candidateId, name, fit }) => ({ candidateId, name, fit }));
}

// ---------------------------------------------------------------------------
// Requisition text parsing
// ---------------------------------------------------------------------------

/** Skills the parser can recognize in free text. Deliberately generic/tech-neutral. */
const SKILL_LEXICON = [
  "typescript", "javascript", "node.js", "python", "go", "java", "rust",
  "postgresql", "mysql", "mongodb", "redis", "rest apis", "graphql",
  "kubernetes", "docker", "aws", "gcp", "azure",
  "figma", "design systems", "user research", "prototyping", "motion design",
  "html", "css", "react", "accessibility",
];

const LEVELS = ["intern", "junior", "entry", "mid", "senior", "staff", "principal", "lead"];

export interface ParsedRequisition {
  level: string;
  minYearsExperience: number;
  remote: boolean;
  mustHaveSkills: string[];
  niceToHaveSkills: string[];
}

/**
 * Extract structured fields from a free-text requisition. Skills mentioned
 * before a "nice to have" marker are must-haves; those after are nice-to-haves.
 */
export function parseRequisitionText(text: string): ParsedRequisition {
  const lower = text.toLowerCase();

  const level = LEVELS.find((l) => new RegExp(`\\b${l}\\b`).test(lower)) ?? "unspecified";

  const yearsMatch = lower.match(/(\d+)\s*\+?\s*years/);
  const minYearsExperience = yearsMatch ? Number(yearsMatch[1]) : 0;

  const remote = /\bremote\b/.test(lower) && !/on-?site/.test(lower.split(/\bremote\b/)[0] ?? "");

  // Split into "must have" vs "nice to have" regions.
  const niceMarker = lower.search(/nice to have|nice-to-have|bonus|plus/);
  const mustRegion = niceMarker >= 0 ? lower.slice(0, niceMarker) : lower;
  const niceRegion = niceMarker >= 0 ? lower.slice(niceMarker) : "";

  const found = (region: string) => SKILL_LEXICON.filter((s) => region.includes(s));
  const mustHaveSkills = found(mustRegion);
  const niceHaveRaw = found(niceRegion).filter((s) => !mustHaveSkills.includes(s));

  return { level, minYearsExperience, remote, mustHaveSkills, niceToHaveSkills: niceHaveRaw };
}

// ---------------------------------------------------------------------------
// Outreach / interview / reference builders (consequential macros call these,
// then decide whether to actually send based on an explicit flag)
// ---------------------------------------------------------------------------

export type OutreachTone = "warm" | "formal" | "brief";

export function draftOutreach(
  candidate: Candidate,
  requisition: Requisition,
  tone: OutreachTone = "warm",
): OutreachMessage {
  const first = candidate.name.split(/\s+/)[0] ?? candidate.name;
  const opener: Record<OutreachTone, string> = {
    warm: `Hi ${first}, I hope you're doing well! `,
    formal: `Dear ${first}, `,
    brief: `Hi ${first}, `,
  };
  const body =
    opener[tone] +
    `I'm reaching out about our ${requisition.title} (${requisition.level}) role` +
    `${requisition.remote ? ", which is remote-friendly" : ` based in ${requisition.location}`}. ` +
    `Your background as ${candidate.currentTitle} looks like a strong match for what the team is building. ` +
    `Would you be open to a short intro call to explore it? Happy to work around your schedule.`;
  return {
    candidateId: candidate.id,
    subject: `${requisition.title} opportunity — intro call?`,
    body,
  };
}

export function buildInterviewInvite(args: {
  candidate: Candidate;
  requisition: Requisition;
  interviewers: string[];
  proposedSlots: string[];
  stage: string;
  durationMinutes: number;
}): InterviewInvite {
  return {
    candidateId: args.candidate.id,
    requisitionId: args.requisition.id,
    interviewers: args.interviewers,
    proposedSlots: args.proposedSlots,
    stage: args.stage,
    durationMinutes: args.durationMinutes,
  };
}

export function buildReferenceRequests(
  candidate: Candidate,
  requisition: Requisition,
): ReferenceRequest[] {
  return candidate.references.map((reference: CandidateReference) => ({
    candidateId: candidate.id,
    reference,
    body:
      `Hello ${reference.name}, ${candidate.name} listed you as a reference ` +
      `(${reference.relationship}) for a ${requisition.title} role. Would you be ` +
      `willing to answer a few short questions about working with them? Thank you.`,
  }));
}
