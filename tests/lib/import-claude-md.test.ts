// tests/lib/import-claude-md.test.ts — unit tests for parseClaudeMd and splitIntoBlocks
import { describe, it, expect } from "vitest";
import { parseClaudeMd, splitIntoBlocks } from "../../src/lib/import-claude-md.js";

// ---------------------------------------------------------------------------
// splitIntoBlocks
// ---------------------------------------------------------------------------
describe("splitIntoBlocks", () => {
  it("splits on ## headings when present", () => {
    const content = `## First section\nsome text\n\n## Second section\nmore text`;
    const blocks = splitIntoBlocks(content);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("First section");
    expect(blocks[1]).toContain("Second section");
  });

  it("splits on blank lines when no ## headings", () => {
    const content = `First paragraph here.\n\nSecond paragraph here.`;
    const blocks = splitIntoBlocks(content);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe("First paragraph here.");
    expect(blocks[1]).toBe("Second paragraph here.");
  });

  it("uses heading split even when blank lines exist", () => {
    const content = `Intro paragraph\n\n## Heading One\nbody one\n\n## Heading Two\nbody two`;
    const blocks = splitIntoBlocks(content);
    // Should split on ## headings only (2 blocks starting with ##)
    expect(blocks.some(b => b.startsWith("## Heading One"))).toBe(true);
    expect(blocks.some(b => b.startsWith("## Heading Two"))).toBe(true);
  });

  it("filters empty blocks", () => {
    const content = `\n\n\nParagraph only\n\n\n`;
    const blocks = splitIntoBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toBe("Paragraph only");
  });
});

// ---------------------------------------------------------------------------
// parseClaudeMd — heading-based file
// ---------------------------------------------------------------------------
describe("parseClaudeMd — heading-based file", () => {
  const headingFile = `## Decision: Use PostgreSQL for analytics
We chose PostgreSQL because it supports JSONB and window functions natively.

## Pattern: Always use prepared statements
Prefer prepared statements to build SQL queries safely. area:security

## Architecture: Microservice split
The system is split into area:backend and area:frontend services.

## Just a fact about the project
This project uses TypeScript throughout.
`;

  it("produces one section per ## heading", () => {
    const { sections, skipped } = parseClaudeMd(headingFile, "fact");
    expect(sections).toHaveLength(4);
    expect(skipped).toHaveLength(0);
  });

  it("uses heading text as title", () => {
    const { sections } = parseClaudeMd(headingFile, "fact");
    expect(sections[0].title).toBe("Decision: Use PostgreSQL for analytics");
  });

  it("body excludes the heading line", () => {
    const { sections } = parseClaudeMd(headingFile, "fact");
    expect(sections[0].body).not.toContain("## Decision");
    expect(sections[0].body).toContain("We chose PostgreSQL");
  });

  it('infers type "decision" from heading containing "Decision"', () => {
    const { sections } = parseClaudeMd(headingFile, "fact");
    expect(sections[0].inferredType).toBe("decision");
  });

  it('infers type "pattern" from heading containing "Pattern"', () => {
    const { sections } = parseClaudeMd(headingFile, "fact");
    expect(sections[1].inferredType).toBe("pattern");
  });

  it('infers type "architecture" from heading containing "Architecture"', () => {
    const { sections } = parseClaudeMd(headingFile, "fact");
    expect(sections[2].inferredType).toBe("architecture");
  });

  it("falls back to defaultType when no keyword matches", () => {
    const { sections } = parseClaudeMd(headingFile, "fact");
    expect(sections[3].inferredType).toBe("fact");
  });

  it("extracts area: tags from body", () => {
    const { sections } = parseClaudeMd(headingFile, "fact");
    // Pattern section has area:security
    expect(sections[1].inferredTags).toContain("area:security");
    // Architecture section has area:backend and area:frontend
    expect(sections[2].inferredTags).toContain("area:backend");
    expect(sections[2].inferredTags).toContain("area:frontend");
  });
});

// ---------------------------------------------------------------------------
// parseClaudeMd — no-headings file (paragraph-based)
// ---------------------------------------------------------------------------
describe("parseClaudeMd — no-headings file (paragraph blocks)", () => {
  const noHeadingFile = `We decided to use **TypeScript** for all services. This was a long deliberation.

Always prefer async/await over raw Promise chains for readability. area:patterns

Pitfall: never call .sync() in production code — it blocks the event loop.
`;

  it("splits into paragraphs", () => {
    const { sections } = parseClaudeMd(noHeadingFile, "fact");
    expect(sections).toHaveLength(3);
  });

  it("uses first sentence as title when no heading", () => {
    const { sections } = parseClaudeMd(noHeadingFile, "fact");
    // First sentence split on ". "
    expect(sections[0].title).toContain("We decided to use");
  });

  it("title is capped at 80 chars", () => {
    const long = "A".repeat(100) + " rest of sentence.";
    const { sections } = parseClaudeMd(long, "fact");
    expect(sections[0].title.length).toBeLessThanOrEqual(80);
  });

  it("infers decision type from body keyword", () => {
    const { sections } = parseClaudeMd(noHeadingFile, "fact");
    expect(sections[0].inferredType).toBe("decision");
  });

  it("infers pitfall type from body keyword", () => {
    const { sections } = parseClaudeMd(noHeadingFile, "fact");
    expect(sections[2].inferredType).toBe("pitfall");
  });
});

// ---------------------------------------------------------------------------
// parseClaudeMd — skip rules
// ---------------------------------------------------------------------------
describe("parseClaudeMd — skip rules", () => {
  it("skips empty sections", () => {
    const content = `## My heading\n\n## Another\nThis has content with sufficient length to pass.`;
    const { sections, skipped } = parseClaudeMd(content, "fact");
    // "My heading" has no body — should be skipped
    expect(skipped.some(s => s.reason === "empty")).toBe(true);
    expect(sections).toHaveLength(1);
  });

  it("skips body under 20 chars without heading", () => {
    const content = `Normal long paragraph with enough content to be meaningful.\n\nToo short.`;
    const { sections, skipped } = parseClaudeMd(content, "fact");
    expect(skipped.some(s => s.reason === "too short")).toBe(true);
    expect(sections).toHaveLength(1);
  });

  it("skips code-fence-only blocks", () => {
    const content = `Normal paragraph with enough words to make it past the 20 char limit.\n\n\`\`\`\nconst x = 1;\n\`\`\``;
    const { sections, skipped } = parseClaudeMd(content, "fact");
    expect(skipped.some(s => s.reason === "code fence only")).toBe(true);
    expect(sections).toHaveLength(1);
  });

  it("does NOT skip a section that has a heading but empty body (just skipped as 'empty')", () => {
    const content = `## Heading with no body`;
    const { sections, skipped } = parseClaudeMd(content, "fact");
    expect(sections).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe("empty");
  });
});

// ---------------------------------------------------------------------------
// parseClaudeMd — tag extraction
// ---------------------------------------------------------------------------
describe("parseClaudeMd — tag extraction", () => {
  it("extracts **BoldedProperNoun** (5+ chars) as tags from body", () => {
    const content = `## My section\nWe use **PostgreSQL** and **Redis** for data storage in production.`;
    const { sections } = parseClaudeMd(content, "fact");
    expect(sections[0].inferredTags).toContain("postgresql");
    expect(sections[0].inferredTags).toContain("redis");
  });

  it("does NOT extract bold words shorter than 5 chars", () => {
    const content = `## Section\nUse **Go** and **Rust** for systems programming.`;
    const { sections } = parseClaudeMd(content, "fact");
    // "Go" = 2 chars, "Rust" = 4 chars — both under 5
    expect(sections[0].inferredTags).not.toContain("go");
    expect(sections[0].inferredTags).not.toContain("rust");
  });

  it("extracts area:foo and env:bar tags", () => {
    const content = `## Section\nThis applies to area:auth and area:billing in env:production.`;
    const { sections } = parseClaudeMd(content, "fact");
    expect(sections[0].inferredTags).toContain("area:auth");
    expect(sections[0].inferredTags).toContain("area:billing");
    expect(sections[0].inferredTags).toContain("env:production");
  });

  it("tags are lowercased", () => {
    const content = `## Section\nWe use **PostgreSQL** and area:Auth in this project.`;
    const { sections } = parseClaudeMd(content, "fact");
    expect(sections[0].inferredTags).toContain("postgresql");
    expect(sections[0].inferredTags).toContain("area:auth");
  });

  it("does not extract bold tokens from heading text", () => {
    const content = `## **MyHeading** section\nNormal body text that is long enough to pass.`;
    const { sections } = parseClaudeMd(content, "fact");
    // Bold in heading should not be in tags
    expect(sections[0].inferredTags).not.toContain("myheading");
  });

  it("deduplicates tags", () => {
    const content = `## Section\nUse area:auth in the area:auth module. Really area:auth is important.`;
    const { sections } = parseClaudeMd(content, "fact");
    const authCount = sections[0].inferredTags.filter(t => t === "area:auth").length;
    expect(authCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// parseClaudeMd — type inference precedence
// ---------------------------------------------------------------------------
describe("parseClaudeMd — type inference", () => {
  it('uses defaultType when no TYPE_HINT matches', () => {
    const content = `## Random note\nThis is just a regular note about the weather.`;
    const { sections } = parseClaudeMd(content, "preference");
    expect(sections[0].inferredType).toBe("preference");
  });

  it('infers "pitfall" from body keyword "never"', () => {
    const content = `## Warning\nNever commit credentials to the repository.`;
    const { sections } = parseClaudeMd(content, "fact");
    expect(sections[0].inferredType).toBe("pitfall");
  });

  it('infers "pitfall" from body keyword "avoid"', () => {
    const content = `## Important\nAvoid using eval() in production code since it is dangerous.`;
    const { sections } = parseClaudeMd(content, "fact");
    expect(sections[0].inferredType).toBe("pitfall");
  });

  it('infers "pattern" from body keyword "always"', () => {
    const content = `## Style guide\nAlways use named exports rather than default exports.`;
    const { sections } = parseClaudeMd(content, "fact");
    expect(sections[0].inferredType).toBe("pattern");
  });

  it('infers "decision" from heading keyword "chose"', () => {
    const content = `## We chose Vitest for testing\nIt is faster than Jest and works well with ESM.`;
    const { sections } = parseClaudeMd(content, "fact");
    expect(sections[0].inferredType).toBe("decision");
  });
});

// ---------------------------------------------------------------------------
// parseClaudeMd — title fallback when no sentence boundary
// ---------------------------------------------------------------------------
describe("parseClaudeMd — title fallback edge cases", () => {
  it("uses first line when no sentence boundary exists", () => {
    const content = `A paragraph with no sentence boundary at all just a stream of words that never ends`;
    const { sections } = parseClaudeMd(content, "fact");
    // Should use up to 80 chars of the first (only) sentence
    expect(sections[0].title.length).toBeLessThanOrEqual(80);
    expect(sections[0].title).toContain("A paragraph with no sentence boundary");
  });

  it("title is first 80 chars of first sentence when very long", () => {
    const veryLong = `${"word ".repeat(30)}done.`;
    const { sections } = parseClaudeMd(veryLong, "fact");
    expect(sections[0].title.length).toBeLessThanOrEqual(80);
  });
});
