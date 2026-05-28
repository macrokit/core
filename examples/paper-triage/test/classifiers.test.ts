import { describe, it, expect } from "vitest";
import {
  buildBibtex,
  classifyPaper,
  rankByQuery,
  suggestTags,
  toComparisonRow,
} from "../src/classifiers.js";
import { normalizePaperId, openAlexIdentifier } from "../src/api-client.js";

// ---------------------------------------------------------------------------
// normalizePaperId / openAlexIdentifier
// ---------------------------------------------------------------------------

describe("normalizePaperId", () => {
  it("passes prefix-aware IDs through", () => {
    expect(normalizePaperId("arXiv:2401.12345")).toBe("arXiv:2401.12345");
    expect(normalizePaperId("DOI:10.1145/12345")).toBe("DOI:10.1145/12345");
    expect(normalizePaperId("MAG:12345")).toBe("MAG:12345");
  });

  it("auto-prefixes bare arXiv IDs", () => {
    expect(normalizePaperId("2401.12345")).toBe("arXiv:2401.12345");
    expect(normalizePaperId("1706.03762")).toBe("arXiv:1706.03762");
    expect(normalizePaperId("2401.12345v3")).toBe("arXiv:2401.12345v3");
  });

  it("auto-prefixes bare DOIs", () => {
    expect(normalizePaperId("10.1145/12345")).toBe("DOI:10.1145/12345");
    expect(normalizePaperId("10.18653/v1/2024.acl-long.500")).toBe(
      "DOI:10.18653/v1/2024.acl-long.500",
    );
  });

  it("trims whitespace", () => {
    expect(normalizePaperId("  2401.12345  ")).toBe("arXiv:2401.12345");
  });

  it("passes unrecognized identifiers through unchanged", () => {
    expect(normalizePaperId("some-internal-id")).toBe("some-internal-id");
  });
});

describe("openAlexIdentifier", () => {
  it("converts DOI: prefix to lowercase doi:", () => {
    expect(openAlexIdentifier("DOI:10.1145/12345")).toBe("doi:10.1145/12345");
  });
  it("prefixes a bare DOI with doi:", () => {
    expect(openAlexIdentifier("10.1145/12345")).toBe("doi:10.1145/12345");
  });
  it("passes OpenAlex IDs through", () => {
    expect(openAlexIdentifier("W2741809807")).toBe("W2741809807");
  });
});

// ---------------------------------------------------------------------------
// classifyPaper
// ---------------------------------------------------------------------------

describe("classifyPaper", () => {
  it("uses s2FieldsOfStudy when present (CS + ML keyword → machine-learning)", () => {
    const subject = classifyPaper({
      title: "Attention Is All You Need",
      abstract: "We propose a new simple network architecture, the Transformer.",
      s2FieldsOfStudy: [{ category: "Computer Science" }],
    });
    expect(subject).toBe("machine-learning");
  });

  it("returns computer-science for CS papers without ML keywords", () => {
    expect(
      classifyPaper({
        title: "A new compiler optimization for register allocation",
        abstract: "We present a graph-coloring approach to register allocation.",
        s2FieldsOfStudy: [{ category: "Computer Science" }],
      }),
    ).toBe("computer-science");
  });

  it("uses fieldsOfStudy when s2 fields absent", () => {
    expect(
      classifyPaper({
        title: "On knot invariants of three-manifolds",
        abstract: "We extend the Alexander polynomial...",
        fieldsOfStudy: ["Mathematics"],
      }),
    ).toBe("mathematics");
  });

  it("falls back to keyword detection when no fields-of-study", () => {
    expect(
      classifyPaper({
        title: "BERT: Pre-training of Deep Bidirectional Transformers",
        abstract: "We introduce a new language representation model.",
      }),
    ).toBe("machine-learning");

    expect(
      classifyPaper({
        title: "A proof of the Kepler conjecture",
        abstract: "We present a formal proof...",
      }),
    ).toBe("mathematics");

    expect(
      classifyPaper({
        title: "Quantum entanglement at high temperatures",
        abstract: "We study quantum systems...",
      }),
    ).toBe("physics");
  });

  it("returns 'other' when nothing matches", () => {
    expect(classifyPaper({ title: "On the aesthetics of bread", abstract: null })).toBe("other");
  });
});

// ---------------------------------------------------------------------------
// suggestTags
// ---------------------------------------------------------------------------

describe("suggestTags", () => {
  const now = new Date("2026-06-01T00:00:00Z");

  it("tags recent papers", () => {
    expect(
      suggestTags({ primarySubject: "machine-learning", year: 2026, citationCount: 0, now }),
    ).toContain("recent");
  });

  it("tags highly-cited papers", () => {
    expect(
      suggestTags({ primarySubject: "machine-learning", year: 2017, citationCount: 50000, now }),
    ).toContain("highly-cited");
  });

  it("tags well-cited papers", () => {
    expect(
      suggestTags({ primarySubject: "biology", year: 2020, citationCount: 200, now }),
    ).toContain("well-cited");
  });

  it("tags low-citation old papers", () => {
    expect(
      suggestTags({ primarySubject: "biology", year: 2020, citationCount: 2, now }),
    ).toContain("low-citation");
  });

  it("does NOT tag a young low-citation paper as low-citation", () => {
    expect(
      suggestTags({ primarySubject: "machine-learning", year: 2026, citationCount: 0, now }),
    ).not.toContain("low-citation");
  });

  it("flags seminal-era papers (10+ years old)", () => {
    expect(
      suggestTags({ primarySubject: "physics", year: 2010, citationCount: 50, now }),
    ).toContain("seminal-era");
  });

  it("flags influential papers (50+ influential citations)", () => {
    expect(
      suggestTags({
        primarySubject: "machine-learning",
        year: 2020,
        citationCount: 500,
        influentialCitationCount: 80,
        now,
      }),
    ).toContain("influential");
  });
});

// ---------------------------------------------------------------------------
// buildBibtex
// ---------------------------------------------------------------------------

describe("buildBibtex", () => {
  it("produces a stable citation key (lastname + year + first-significant-word)", () => {
    const bib = buildBibtex({
      paperId: "x",
      title: "Attention Is All You Need",
      authors: [{ name: "Ashish Vaswani" }, { name: "Noam Shazeer" }],
      year: 2017,
    });
    expect(bib).toMatch(/^@article\{vaswani2017attention,/);
  });

  it("normalizes author names to 'Last, First' form", () => {
    const bib = buildBibtex({
      paperId: "x",
      title: "Some paper",
      authors: [{ name: "Jane M. Doe" }, { name: "Bob Smith" }],
      year: 2024,
    });
    expect(bib).toContain("author = {Doe, Jane M. and Smith, Bob}");
  });

  it("preserves already-normalized 'Last, First' form", () => {
    const bib = buildBibtex({
      paperId: "x",
      title: "Some paper",
      authors: [{ name: "Doe, Jane" }],
      year: 2024,
    });
    expect(bib).toContain("author = {Doe, Jane}");
  });

  it("emits archivePrefix for arXiv-tagged papers", () => {
    const bib = buildBibtex({
      paperId: "x",
      title: "On gradient descent",
      authors: [{ name: "Alice Author" }],
      year: 2024,
      externalIds: { ArXiv: "2401.12345" },
    });
    expect(bib).toContain("eprint = {2401.12345}");
    expect(bib).toContain("archivePrefix = {arXiv}");
  });

  it("includes DOI when present", () => {
    const bib = buildBibtex({
      paperId: "x",
      title: "Some paper",
      authors: [{ name: "Alice Author" }],
      year: 2024,
      externalIds: { DOI: "10.1145/12345" },
    });
    expect(bib).toContain("doi = {10.1145/12345}");
  });

  it("falls back to 'paper' when no significant title word", () => {
    const bib = buildBibtex({
      paperId: "x",
      title: "The And",
      authors: [{ name: "Alice Author" }],
      year: 2024,
    });
    expect(bib).toMatch(/^@article\{author2024paper,/);
  });

  it("uses 'anon' when no authors", () => {
    const bib = buildBibtex({
      paperId: "x",
      title: "Mysterious paper",
      authors: [],
      year: 2024,
    });
    expect(bib).toMatch(/^@article\{anon2024mysterious,/);
  });

  it("escapes BibTeX special characters in titles", () => {
    const bib = buildBibtex({
      paperId: "x",
      title: "Notes on {set theory} and \\reals",
      authors: [{ name: "Alice Author" }],
      year: 2024,
    });
    expect(bib).toContain("\\{set theory\\}");
    expect(bib).toContain("\\\\reals");
  });
});

// ---------------------------------------------------------------------------
// rankByQuery
// ---------------------------------------------------------------------------

describe("rankByQuery", () => {
  const recommendations = [
    { paperId: "a", title: "Training stability of large language models", year: 2024, citationCount: 50, authors: [{ name: "A" }] },
    { paperId: "b", title: "On the aesthetics of bread", year: 2023, citationCount: 200, authors: [{ name: "B" }] },
    { paperId: "c", title: "Stability properties of optimizers", year: 2022, citationCount: 30, authors: [{ name: "C" }] },
  ];

  it("ranks query-overlapping titles higher", () => {
    const ranked = rankByQuery({ recommendations, query: "training stability" });
    expect(ranked[0]?.paperId).toBe("a");
  });

  it("returns recommendations with score 0 when no query", () => {
    const ranked = rankByQuery({ recommendations });
    expect(ranked.every((r) => r.score === 0)).toBe(true);
  });

  it("includes a light citation prior alongside title overlap", () => {
    // 'b' has higher citations but zero token overlap with "stability";
    // 'a' should still rank above 'b'.
    const ranked = rankByQuery({ recommendations, query: "stability" });
    expect(ranked[0]?.paperId).not.toBe("b");
  });
});

// ---------------------------------------------------------------------------
// toComparisonRow
// ---------------------------------------------------------------------------

describe("toComparisonRow", () => {
  it("derives the comparison-row fields from S2 paper metadata", () => {
    const row = toComparisonRow({
      paperId: "abc123",
      externalIds: null,
      title: "Attention Is All You Need",
      abstract: "We propose a new architecture, the Transformer.",
      year: 2017,
      authors: [{ authorId: "1", name: "Ashish Vaswani" }],
      citationCount: 50000,
      influentialCitationCount: 8000,
      fieldsOfStudy: ["Computer Science"],
      s2FieldsOfStudy: [{ category: "Computer Science", source: "external" }],
      openAccessPdf: { url: "https://arxiv.org/pdf/1706.03762", status: "GREEN" },
      publicationVenue: { name: "NeurIPS", type: "conference" },
      publicationDate: "2017-12-04",
    });
    expect(row.primarySubject).toBe("machine-learning");
    expect(row.firstAuthor).toBe("Ashish Vaswani");
    expect(row.isOpenAccess).toBe(true);
    expect(row.year).toBe(2017);
    expect(row.citationCount).toBe(50000);
  });
});
