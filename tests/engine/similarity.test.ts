import { describe, it, expect } from "vitest";
import { jaccardSimilarity, trigramSimilarity, extractTrigrams, combinedSimilarity } from "../../src/engine/similarity.js";

describe("jaccardSimilarity", () => {
  it("returns 1.0 for identical strings", () => {
    expect(jaccardSimilarity("hello world foo", "hello world foo")).toBeCloseTo(1.0, 2);
  });

  it("returns 0.0 for completely different strings", () => {
    expect(jaccardSimilarity("alpha bravo charlie", "delta echo foxtrot")).toBeCloseTo(0.0, 2);
  });

  it("returns partial overlap", () => {
    const sim = jaccardSimilarity("hello world foo bar", "hello world baz qux");
    // words: {hello, world, foo, bar} vs {hello, world, baz, qux}
    // intersection: {hello, world} = 2, union: 6
    // 2/6 = 0.333
    expect(sim).toBeCloseTo(0.333, 1);
  });

  it("filters words <= 2 chars", () => {
    const sim = jaccardSimilarity("a b cd hello world", "a b cd hello world");
    // After filtering (>2): {hello, world} vs {hello, world}
    expect(sim).toBeCloseTo(1.0, 2);
  });

  it("returns 0 for empty strings", () => {
    expect(jaccardSimilarity("", "")).toBe(0);
    expect(jaccardSimilarity("hello", "")).toBe(0);
  });

  it("is case insensitive", () => {
    expect(jaccardSimilarity("Hello World", "hello world")).toBeCloseTo(1.0, 2);
  });
});

describe("extractTrigrams", () => {
  it("extracts correct trigrams", () => {
    // I2: extractTrigrams returns Set<string> to avoid duplicates (prevents similarity > 1.0)
    expect(extractTrigrams("hello")).toEqual(new Set(["hel", "ell", "llo"]));
  });

  it("returns empty set for short strings", () => {
    expect(extractTrigrams("hi")).toEqual(new Set());
    expect(extractTrigrams("")).toEqual(new Set());
  });

  it("deduplicates trigrams (prevents similarity > 1.0)", () => {
    // Repeated chars would produce duplicate trigrams — Set removes them
    const tris = extractTrigrams("aaaa");
    expect(tris instanceof Set).toBe(true);
    expect(tris.size).toBe(1); // only "aaa"
  });
});

describe("trigramSimilarity", () => {
  it("returns 1.0 for identical strings", () => {
    expect(trigramSimilarity("hello world", "hello world")).toBeCloseTo(1.0, 2);
  });

  it("returns 0.0 for completely different strings", () => {
    expect(trigramSimilarity("abc", "xyz")).toBeCloseTo(0.0, 2);
  });

  it("returns high similarity for similar strings", () => {
    const sim = trigramSimilarity("authentication flow", "authentication flows");
    expect(sim).toBeGreaterThan(0.8);
  });

  it("returns 0 for empty strings", () => {
    expect(trigramSimilarity("", "")).toBe(0);
  });
});

describe("combinedSimilarity", () => {
  it("weights title at 0.4 and body at 0.6", () => {
    const sim = combinedSimilarity(
      { title: "same title", body: "completely different body content here" },
      { title: "same title", body: "totally unrelated text words yeah" }
    );
    // Title: trigram ~1.0, Body: jaccard ~0.0
    // Combined: 1.0 * 0.4 + 0.0 * 0.6 = 0.4
    expect(sim).toBeGreaterThan(0.3);
    expect(sim).toBeLessThan(0.5);
  });

  it("returns high value for identical content", () => {
    const sim = combinedSimilarity(
      { title: "test title", body: "test body content here" },
      { title: "test title", body: "test body content here" }
    );
    expect(sim).toBeGreaterThan(0.9);
  });
});
