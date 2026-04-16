// tests/lib/decay.test.ts
import { describe, it, expect } from "vitest";
import { daysSince, getDecayFactor, applyDecay } from "../../src/lib/decay.js";

describe("decay", () => {
  it("returns 1.0 for timestamps within 14 days", () => {
    const recent = new Date(Date.now() - 5 * 86400_000).toISOString();
    expect(getDecayFactor(daysSince(recent))).toBe(1.0);
  });

  it("returns 0.75 for timestamps 14-30 days old", () => {
    const mid = new Date(Date.now() - 20 * 86400_000).toISOString();
    expect(getDecayFactor(daysSince(mid))).toBe(0.75);
  });

  it("returns 0.5 for timestamps older than 30 days", () => {
    const old = new Date(Date.now() - 60 * 86400_000).toISOString();
    expect(getDecayFactor(daysSince(old))).toBe(0.5);
  });

  it("returns 0.5 for empty/missing timestamp", () => {
    expect(getDecayFactor(daysSince(""))).toBe(0.5);
    expect(getDecayFactor(daysSince(undefined as any))).toBe(0.5);
  });

  it("applyDecay multiplies base score by factor", () => {
    const recent = new Date().toISOString();
    expect(applyDecay(0.8, recent)).toBeCloseTo(0.8);
    const old = new Date(Date.now() - 60 * 86400_000).toISOString();
    expect(applyDecay(0.8, old)).toBeCloseTo(0.4);
  });
});
