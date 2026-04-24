// tests/lib/budget.test.ts
import { describe, it, expect } from "vitest";
import { estimateTokens, checkBudget, computeRefill } from "../../src/lib/budget.js";

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

describe("checkBudget (v2)", () => {
  it("returns true when remaining budget exceeds cost + floor", () => {
    expect(checkBudget({ budget: 8000, spent: 0, floor: 500 }, 100)).toBe(true);
  });

  it("returns false when remaining is less than floor", () => {
    expect(checkBudget({ budget: 8000, spent: 7600, floor: 500 }, 100)).toBe(false);
    // remaining = 400, floor = 500 -> false
  });

  it("returns false when remaining minus cost goes below floor", () => {
    expect(checkBudget({ budget: 8000, spent: 7400, floor: 500 }, 200)).toBe(false);
    // remaining = 600, cost=200, remaining after = 400 < floor(500)
  });

  it("returns true when remaining equals cost + floor exactly", () => {
    expect(checkBudget({ budget: 8000, spent: 7300, floor: 500 }, 200)).toBe(true);
    // remaining = 700, cost=200, remaining after = 500 = floor
  });
});

describe("computeRefill (v2)", () => {
  it("returns refilled spent value (never below 0)", () => {
    expect(computeRefill(1000, 200)).toBe(800);
  });

  it("floors at 0 (no negative spent)", () => {
    expect(computeRefill(100, 500)).toBe(0);
  });

  it("handles zero refill", () => {
    expect(computeRefill(1000, 0)).toBe(1000);
  });
});
