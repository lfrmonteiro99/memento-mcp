// tests/lib/decay.test.ts
import { describe, it, expect, afterEach } from "vitest";
import {
  daysSince,
  getDecayFactor,
  applyDecay,
  computeExponentialDecay,
  applyDecayV2,
  setClock,
  resetClock,
} from "../../src/lib/decay.js";

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

describe("exponential decay (v2)", () => {
  it("returns 1.0 for 0 days", () => {
    expect(computeExponentialDecay(0)).toBeCloseTo(1.0, 3);
  });

  it("returns 0.5 at half-life (14 days)", () => {
    expect(computeExponentialDecay(14)).toBeCloseTo(0.5, 2);
  });

  it("returns ~0.707 at 7 days (half of half-life)", () => {
    expect(computeExponentialDecay(7)).toBeCloseTo(0.707, 2);
  });

  it("returns ~0.25 at 2x half-life (28 days)", () => {
    expect(computeExponentialDecay(28)).toBeCloseTo(0.25, 2);
  });

  it("returns ~0.125 at 3x half-life (42 days)", () => {
    expect(computeExponentialDecay(42)).toBeCloseTo(0.125, 2);
  });

  it("approaches 0 but never reaches it", () => {
    const val = computeExponentialDecay(365);
    expect(val).toBeGreaterThan(0);
    expect(val).toBeLessThan(0.001);
  });

  it("uses custom half-life", () => {
    expect(computeExponentialDecay(7, 7)).toBeCloseTo(0.5, 2);
    expect(computeExponentialDecay(30, 30)).toBeCloseTo(0.5, 2);
  });

  it("handles negative days (future timestamp) by returning 1.0+", () => {
    const val = computeExponentialDecay(-5);
    expect(val).toBeGreaterThan(1.0);
  });
});

describe("applyDecayV2", () => {
  it("applies exponential decay to base score", () => {
    const recent = new Date().toISOString();
    expect(applyDecayV2(0.8, recent)).toBeCloseTo(0.8, 1);

    const weekOld = new Date(Date.now() - 7 * 86400_000).toISOString();
    expect(applyDecayV2(0.8, weekOld)).toBeCloseTo(0.8 * 0.707, 1);

    const monthOld = new Date(Date.now() - 28 * 86400_000).toISOString();
    expect(applyDecayV2(0.8, monthOld)).toBeCloseTo(0.8 * 0.25, 1);
  });

  it("returns low score for undefined timestamp", () => {
    const val = applyDecayV2(0.8, undefined);
    expect(val).toBeLessThan(0.01); // 999 days -> essentially 0
  });
});

describe("injectable clock (R10)", () => {
  afterEach(() => resetClock());

  it("daysSince honors the injected clock", () => {
    setClock(() => new Date("2026-04-17T12:00:00Z").getTime());
    // 2026-04-10T12:00Z is 7 days before the frozen clock
    expect(daysSince("2026-04-10T12:00:00Z")).toBeCloseTo(7, 2);
  });

  it("resetClock restores Date.now", () => {
    setClock(() => 0);
    expect(Math.abs(daysSince(new Date().toISOString()))).toBeGreaterThan(10000);
    resetClock();
    expect(daysSince(new Date().toISOString())).toBeCloseTo(0, 1);
  });
});
