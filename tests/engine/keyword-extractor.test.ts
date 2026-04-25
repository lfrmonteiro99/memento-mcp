// tests/engine/keyword-extractor.test.ts
import { describe, it, expect } from "vitest";
import { extractKeywordsV2, buildFtsQueryV2 } from "../../src/engine/keyword-extractor.js";
import { ENGLISH_PROFILE, PORTUGUESE_PROFILE } from "../../src/lib/profiles.js";

describe("extractKeywordsV2", () => {
  it("removes stop words", () => {
    const kws = extractKeywordsV2("the quick brown fox is jumping over the lazy dog", {
      stopWords: ENGLISH_PROFILE.stopWords,
    });
    expect(kws).not.toContain("the");
    expect(kws).not.toContain("is");
    expect(kws).not.toContain("over");
    expect(kws).toContain("quick");
    expect(kws).toContain("brown");
  });

  it("removes dev-specific stop words", () => {
    const kws = extractKeywordsV2("function that returns a new class import", {
      stopWords: ENGLISH_PROFILE.stopWords,
    });
    expect(kws).not.toContain("function");
    expect(kws).not.toContain("class");
    expect(kws).not.toContain("import");
    expect(kws).not.toContain("return");
  });

  it("respects maxTokens limit (default 8)", () => {
    const kws = extractKeywordsV2("alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima", {
      stopWords: ENGLISH_PROFILE.stopWords,
    });
    expect(kws.length).toBeLessThanOrEqual(8);
  });

  it("filters words shorter than minWordLength (3)", () => {
    const kws = extractKeywordsV2("go do it now or be bad", {
      stopWords: ENGLISH_PROFILE.stopWords,
    });
    expect(kws.length).toBe(0);
  });

  it("preserves bigram phrases when preservePhrases is true", () => {
    const kws = extractKeywordsV2("authentication flow setup", {
      preservePhrases: true,
      stopWords: ENGLISH_PROFILE.stopWords,
    });
    expect(kws).toContain("authentication flow");
  });

  it("does not produce phrases when preservePhrases is false", () => {
    const kws = extractKeywordsV2("authentication flow setup", {
      preservePhrases: false,
      stopWords: ENGLISH_PROFILE.stopWords,
    });
    expect(kws.every(k => !k.includes(" "))).toBe(true);
  });

  it("ranks earlier words higher", () => {
    const kws = extractKeywordsV2("important crucial trivial negligible", {
      stopWords: ENGLISH_PROFILE.stopWords,
    });
    // "important" should appear before "negligible" since it's earlier
    expect(kws.indexOf("important")).toBeLessThan(kws.indexOf("negligible"));
  });

  it("ranks phrases higher than single words", () => {
    const kws = extractKeywordsV2("authentication flow process handler", {
      preservePhrases: true,
      stopWords: ENGLISH_PROFILE.stopWords,
    });
    // The phrase "authentication flow" should be ranked high
    const phraseIdx = kws.indexOf("authentication flow");
    expect(phraseIdx).toBeGreaterThanOrEqual(0);
    expect(phraseIdx).toBeLessThan(3);
  });

  it("handles empty input", () => {
    expect(extractKeywordsV2("", { stopWords: ENGLISH_PROFILE.stopWords })).toEqual([]);
  });

  it("handles input of only stop words", () => {
    expect(extractKeywordsV2("the is of in for", { stopWords: ENGLISH_PROFILE.stopWords })).toEqual([]);
  });

  it("normalizes case", () => {
    const kws = extractKeywordsV2("React Hooks and STATE management", {
      stopWords: ENGLISH_PROFILE.stopWords,
    });
    expect(kws).toContain("react");
    expect(kws).toContain("hooks");
    expect(kws).toContain("state");
  });
});

describe("buildFtsQueryV2", () => {
  it("wraps single words with prefix matching", () => {
    const query = buildFtsQueryV2(["react", "hooks"]);
    expect(query).toContain("react*");
    expect(query).toContain("hooks*");
  });

  it("wraps phrases in double quotes", () => {
    const query = buildFtsQueryV2(["react hooks", "state management"]);
    expect(query).toContain('"react hooks"');
    expect(query).toContain('"state management"');
  });

  it("joins with OR", () => {
    const query = buildFtsQueryV2(["react", "hooks"]);
    expect(query).toContain(" OR ");
  });

  it("returns empty string for empty input", () => {
    expect(buildFtsQueryV2([])).toBe("");
  });

  it("mixes phrases and single terms", () => {
    const query = buildFtsQueryV2(["react hooks", "component", "state management"]);
    expect(query).toBe('"react hooks" OR component* OR "state management"');
  });

  it("respects prefixMatching=false (N4)", () => {
    const q = buildFtsQueryV2(["react", "hooks"], false);
    expect(q).toBe("react OR hooks");
    expect(q).not.toContain("*");
  });

  it("respects prefixMatching=true (default) (N4)", () => {
    const q = buildFtsQueryV2(["react", "hooks"], true);
    expect(q).toBe("react* OR hooks*");
  });
});
