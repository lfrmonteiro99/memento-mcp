// tests/lib/budget.test.ts
import { describe, it, expect } from "vitest";
import { estimateTokens } from "../../src/lib/budget.js";

describe("estimateTokens", () => {
  it("estimates ~1 token per 4 chars", () => {
    expect(estimateTokens("hello world")).toBe(3); // 11 chars / 4 = 2.75 → ceil = 3
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("handles long text", () => {
    const text = "a".repeat(400);
    expect(estimateTokens(text)).toBe(100);
  });
});
