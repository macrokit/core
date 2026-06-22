/**
 * SYNTHETIC sample dataset for the HR/recruiting reference vertical.
 *
 * Every person, email, and resume here is INVENTED for documentation/testing.
 * No real individuals, no real PII. Emails use the reserved `example.test`
 * domain (RFC 6761) so nothing is deliverable. Do not replace with real
 * candidate data in this public repo.
 */
import type { AtsDataset } from "../primitives/ats-client.js";

export const SAMPLE_DATASET: AtsDataset = {
  requisitions: [
    {
      id: "REQ-1001",
      title: "Senior Backend Engineer",
      level: "senior",
      location: "Remote (US)",
      remote: true,
      employmentType: "full_time",
      mustHaveSkills: ["typescript", "node.js", "postgresql", "rest apis"],
      niceToHaveSkills: ["kubernetes", "graphql", "redis"],
      minYearsExperience: 5,
      description:
        "We are hiring a Senior Backend Engineer to own our core services. " +
        "Requirements: 5+ years building production backends with TypeScript " +
        "and Node.js, strong PostgreSQL, and REST API design. Nice to have: " +
        "Kubernetes, GraphQL, Redis. Location: Remote (US).",
      hiringManager: "Dana Okoro",
      status: "open",
    },
    {
      id: "REQ-1002",
      title: "Product Designer",
      level: "mid",
      location: "Berlin",
      remote: false,
      employmentType: "full_time",
      mustHaveSkills: ["figma", "design systems", "user research"],
      niceToHaveSkills: ["motion design", "html", "css"],
      minYearsExperience: 3,
      description:
        "Product Designer to shape our design system. Requirements: 3+ years " +
        "of product design, Figma, design systems, and user research. " +
        "Location: Berlin (on-site).",
      hiringManager: "Mateo Alvarez",
      status: "open",
    },
  ],
  candidates: [
    {
      id: "CAND-2001",
      requisitionId: "REQ-1001",
      name: "Priya Natarajan",
      headline: "Backend engineer, distributed systems",
      location: "Austin, US",
      remoteOk: true,
      yearsExperience: 7,
      currentTitle: "Senior Software Engineer",
      skills: ["typescript", "node.js", "postgresql", "rest apis", "redis", "aws"],
      resumeText:
        "Senior Software Engineer with 7 years building TypeScript/Node.js " +
        "backends. Designed PostgreSQL-backed REST APIs serving millions of " +
        "requests/day. Introduced Redis caching and AWS-based deployments.",
      references: [
        { name: "Lena Fischer", relationship: "former manager", email: "lena.fischer@example.test" },
        { name: "Omar Haddad", relationship: "tech lead", email: "omar.haddad@example.test" },
      ],
      stage: "screen",
      email: "priya.natarajan@example.test",
    },
    {
      id: "CAND-2002",
      requisitionId: "REQ-1001",
      name: "Jordan Rivera",
      headline: "Full-stack developer",
      location: "Remote",
      remoteOk: true,
      yearsExperience: 3,
      currentTitle: "Software Engineer",
      skills: ["javascript", "node.js", "mongodb", "rest apis"],
      resumeText:
        "Software Engineer, 3 years of full-stack work in JavaScript and " +
        "Node.js with MongoDB. Built several REST API services.",
      references: [
        { name: "Sam Whitfield", relationship: "colleague", email: "sam.whitfield@example.test" },
      ],
      stage: "applied",
      email: "jordan.rivera@example.test",
    },
    {
      id: "CAND-2003",
      requisitionId: "REQ-1001",
      name: "Wei Zhang",
      headline: "Platform engineer",
      location: "Vancouver, CA",
      remoteOk: true,
      yearsExperience: 9,
      currentTitle: "Staff Engineer",
      skills: ["typescript", "node.js", "postgresql", "rest apis", "kubernetes", "graphql"],
      resumeText:
        "Staff Engineer with 9 years of backend and platform experience. Deep " +
        "TypeScript/Node.js and PostgreSQL; ran Kubernetes clusters and built " +
        "GraphQL and REST APIs for internal platforms.",
      references: [
        { name: "Grace Mbeki", relationship: "director", email: "grace.mbeki@example.test" },
        { name: "Tomas Novak", relationship: "peer", email: "tomas.novak@example.test" },
      ],
      stage: "interview",
      email: "wei.zhang@example.test",
    },
    {
      id: "CAND-2004",
      requisitionId: "REQ-1002",
      name: "Aisha Bello",
      headline: "Product designer, design systems",
      location: "Berlin",
      remoteOk: false,
      yearsExperience: 5,
      currentTitle: "Product Designer",
      skills: ["figma", "design systems", "user research", "prototyping"],
      resumeText:
        "Product Designer with 5 years building and maintaining design systems " +
        "in Figma. Led user research rounds and high-fidelity prototyping.",
      references: [
        { name: "Henrik Sorensen", relationship: "design lead", email: "henrik.sorensen@example.test" },
      ],
      stage: "screen",
      email: "aisha.bello@example.test",
    },
  ],
};
