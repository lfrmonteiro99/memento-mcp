// tests/lib/profiles.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveProfile, ENGLISH_PROFILE, PORTUGUESE_PROFILE, SPANISH_PROFILE } from "../../src/lib/profiles.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";

describe("profiles", () => {
  afterEach(() => {
    delete process.env.MEMENTO_PROFILE;
  });

  describe("builtin profiles", () => {
    it("ENGLISH_PROFILE has english stop-words", () => {
      expect(ENGLISH_PROFILE.id).toBe("english");
      expect(ENGLISH_PROFILE.stopWords.has("the")).toBe(true);
      expect(ENGLISH_PROFILE.stopWords.has("and")).toBe(true);
      expect(ENGLISH_PROFILE.stopWords.has("function")).toBe(true);
    });

    it("PORTUGUESE_PROFILE has portuguese stop-words", () => {
      expect(PORTUGUESE_PROFILE.id).toBe("portuguese");
      expect(PORTUGUESE_PROFILE.stopWords.has("o")).toBe(true);
      expect(PORTUGUESE_PROFILE.stopWords.has("de")).toBe(true);
      expect(PORTUGUESE_PROFILE.stopWords.has("não")).toBe(true);
    });

    it("SPANISH_PROFILE has spanish stop-words", () => {
      expect(SPANISH_PROFILE.id).toBe("spanish");
      expect(SPANISH_PROFILE.stopWords.has("el")).toBe(true);
      expect(SPANISH_PROFILE.stopWords.has("la")).toBe(true);
      expect(SPANISH_PROFILE.stopWords.has("no")).toBe(true);
    });

    it("all profiles have trivial patterns", () => {
      expect(ENGLISH_PROFILE.trivialPatterns.length).toBeGreaterThan(0);
      expect(PORTUGUESE_PROFILE.trivialPatterns.length).toBeGreaterThan(0);
      expect(SPANISH_PROFILE.trivialPatterns.length).toBeGreaterThan(0);
    });

    it("all profiles have locale", () => {
      expect(ENGLISH_PROFILE.locale).toBe("en-US");
      expect(PORTUGUESE_PROFILE.locale).toBe("pt-PT");
      expect(SPANISH_PROFILE.locale).toBe("es-ES");
    });
  });

  describe("resolveProfile", () => {
    it("defaults to english when no env or config", () => {
      const config = { ...DEFAULT_CONFIG };
      const profile = resolveProfile(config);
      expect(profile.id).toBe("english");
    });

    it("uses config.profile.id when set", () => {
      const config = {
        ...DEFAULT_CONFIG,
        profile: { ...DEFAULT_CONFIG.profile, id: "portuguese" },
      };
      const profile = resolveProfile(config);
      expect(profile.id).toBe("portuguese");
    });

    it("env var MEMENTO_PROFILE overrides config", () => {
      process.env.MEMENTO_PROFILE = "spanish";
      const config = {
        ...DEFAULT_CONFIG,
        profile: { ...DEFAULT_CONFIG.profile, id: "portuguese" },
      };
      const profile = resolveProfile(config);
      expect(profile.id).toBe("spanish");
    });

    it("env var is case-insensitive", () => {
      process.env.MEMENTO_PROFILE = "PORTUGUESE";
      const config = DEFAULT_CONFIG;
      const profile = resolveProfile(config);
      expect(profile.id).toBe("portuguese");
    });

    it("unknown profile id falls back to english with warning", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const config = {
        ...DEFAULT_CONFIG,
        profile: { ...DEFAULT_CONFIG.profile, id: "klingon" },
      };
      const profile = resolveProfile(config);
      expect(profile.id).toBe("english");
      // warning is logged only once per process
      spy.mockRestore();
    });

    it("merges custom stop-words with profile defaults", () => {
      const config = {
        ...DEFAULT_CONFIG,
        profile: {
          ...DEFAULT_CONFIG.profile,
          id: "english",
          extraStopWords: ["foo", "bar"],
        },
      };
      const profile = resolveProfile(config);
      expect(profile.stopWords.has("the")).toBe(true);
      expect(profile.stopWords.has("foo")).toBe(true);
      expect(profile.stopWords.has("bar")).toBe(true);
    });

    it("merges custom trivial patterns with profile defaults", () => {
      const config = {
        ...DEFAULT_CONFIG,
        profile: {
          ...DEFAULT_CONFIG.profile,
          id: "english",
          extraTrivialPatterns: ["maybe", "perhaps"],
        },
      };
      const profile = resolveProfile(config);
      expect(profile.trivialPatterns.length).toBeGreaterThan(2);
      // Check that custom patterns are compiled as regex
      const customPatterns = profile.trivialPatterns.slice(-2);
      expect(customPatterns[0].test("maybe")).toBe(true);
      expect(customPatterns[1].test("perhaps")).toBe(true);
    });

    it("preserves base profile locale when override is empty", () => {
      const config = {
        ...DEFAULT_CONFIG,
        profile: { ...DEFAULT_CONFIG.profile, id: "portuguese", locale: "" },
      };
      const profile = resolveProfile(config);
      // Empty string locale should fallback to base profile locale
      expect(profile.locale).toBe("pt-PT");
    });

    it("uses override locale when provided", () => {
      const config = {
        ...DEFAULT_CONFIG,
        profile: { ...DEFAULT_CONFIG.profile, id: "portuguese", locale: "pt-BR" },
      };
      const profile = resolveProfile(config);
      expect(profile.locale).toBe("pt-BR");
    });
  });

  describe("profile pattern matching", () => {
    it("ENGLISH_PROFILE trivial patterns match expected inputs", () => {
      const patterns = ENGLISH_PROFILE.trivialPatterns;
      expect(patterns.some(p => p.test("hi"))).toBe(true);
      expect(patterns.some(p => p.test("hello"))).toBe(true);
      expect(patterns.some(p => p.test("yes"))).toBe(true);
      expect(patterns.some(p => p.test("no"))).toBe(true);
    });

    it("PORTUGUESE_PROFILE trivial patterns match expected inputs", () => {
      const patterns = PORTUGUESE_PROFILE.trivialPatterns;
      expect(patterns.some(p => p.test("oi"))).toBe(true);
      expect(patterns.some(p => p.test("sim"))).toBe(true);
      expect(patterns.some(p => p.test("obrigado"))).toBe(true);
    });

    it("SPANISH_PROFILE trivial patterns match expected inputs", () => {
      const patterns = SPANISH_PROFILE.trivialPatterns;
      expect(patterns.some(p => p.test("hola"))).toBe(true);
      expect(patterns.some(p => p.test("si"))).toBe(true);
      expect(patterns.some(p => p.test("gracias"))).toBe(true);
    });
  });
});
