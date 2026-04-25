// tests/engine/privacy.test.ts
import { describe, it, expect } from "vitest";
import {
  redactPrivate,
  stripPrivate,
  hasPrivate,
  validateTags,
} from "../../src/engine/privacy.js";

describe("redactPrivate", () => {
  it("redacts a single private region", () => {
    expect(redactPrivate("foo <private>bar</private> baz")).toBe("foo [REDACTED] baz");
  });

  it("redacts multiple private regions", () => {
    expect(redactPrivate("a <private>secret1</private> b <private>secret2</private> c"))
      .toBe("a [REDACTED] b [REDACTED] c");
  });

  it("leaves text without private tags unchanged", () => {
    expect(redactPrivate("no private content here")).toBe("no private content here");
  });

  it("handles multiline private content", () => {
    const input = "before\n<private>\nline1\nline2\n</private>\nafter";
    expect(redactPrivate(input)).toBe("before\n[REDACTED]\nafter");
  });

  it("uses custom replacement string", () => {
    expect(redactPrivate("x <private>y</private> z", "***")).toBe("x *** z");
  });

  it("is callable multiple times without state pollution (global regex guard)", () => {
    const input = "foo <private>bar</private> baz";
    expect(redactPrivate(input)).toBe("foo [REDACTED] baz");
    expect(redactPrivate(input)).toBe("foo [REDACTED] baz");
    expect(redactPrivate(input)).toBe("foo [REDACTED] baz");
  });

  it("handles empty string", () => {
    expect(redactPrivate("")).toBe("");
  });

  it("handles text with only private tags", () => {
    expect(redactPrivate("<private>secret</private>")).toBe("[REDACTED]");
  });
});

describe("stripPrivate", () => {
  it("replaces private region with a space (for FTS indexing)", () => {
    expect(stripPrivate("foo <private>bar</private> baz")).toBe("foo   baz");
  });

  it("handles multiple regions", () => {
    const result = stripPrivate("a <private>s1</private> b <private>s2</private> c");
    expect(result).toBe("a   b   c");
  });

  it("leaves text without private tags unchanged", () => {
    expect(stripPrivate("hello world")).toBe("hello world");
  });

  it("handles multiline content", () => {
    const input = "start <private>\nmultiline\nsecret\n</private> end";
    expect(stripPrivate(input)).toBe("start   end");
  });

  it("is callable multiple times without state pollution", () => {
    const input = "a <private>b</private> c";
    expect(stripPrivate(input)).toBe("a   c");
    expect(stripPrivate(input)).toBe("a   c");
  });
});

describe("hasPrivate", () => {
  it("returns true when private tags are present", () => {
    expect(hasPrivate("foo <private>bar</private> baz")).toBe(true);
  });

  it("returns false when no private tags", () => {
    expect(hasPrivate("plain text")).toBe(false);
  });

  it("returns false for unbalanced opening tag only", () => {
    // Only a <private> open tag, no close — hasPrivate uses the full pattern
    expect(hasPrivate("<private>unclosed")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(hasPrivate("")).toBe(false);
  });

  it("is callable multiple times without state pollution", () => {
    expect(hasPrivate("x <private>y</private> z")).toBe(true);
    expect(hasPrivate("plain")).toBe(false);
    expect(hasPrivate("x <private>y</private> z")).toBe(true);
  });
});

describe("validateTags", () => {
  it("returns valid=true for balanced tags", () => {
    const result = validateTags("foo <private>bar</private> baz");
    expect(result.valid).toBe(true);
    expect(result.opens).toBe(1);
    expect(result.closes).toBe(1);
  });

  it("returns valid=true for text with no tags", () => {
    const result = validateTags("no tags here");
    expect(result.valid).toBe(true);
    expect(result.opens).toBe(0);
    expect(result.closes).toBe(0);
  });

  it("returns valid=false for unbalanced open tag", () => {
    const result = validateTags("foo <private>bar baz");
    expect(result.valid).toBe(false);
    expect(result.opens).toBe(1);
    expect(result.closes).toBe(0);
  });

  it("returns valid=false for unbalanced close tag", () => {
    const result = validateTags("foo bar</private> baz");
    expect(result.valid).toBe(false);
    expect(result.opens).toBe(0);
    expect(result.closes).toBe(1);
  });

  it("returns valid=true for multiple balanced pairs", () => {
    const result = validateTags("a <private>s1</private> b <private>s2</private> c");
    expect(result.valid).toBe(true);
    expect(result.opens).toBe(2);
    expect(result.closes).toBe(2);
  });

  it("returns valid=false for mismatched counts (2 opens, 1 close)", () => {
    const result = validateTags("<private>a</private> <private>b");
    expect(result.valid).toBe(false);
    expect(result.opens).toBe(2);
    expect(result.closes).toBe(1);
  });

  it("handles empty string", () => {
    const result = validateTags("");
    expect(result.valid).toBe(true);
    expect(result.opens).toBe(0);
    expect(result.closes).toBe(0);
  });
});
