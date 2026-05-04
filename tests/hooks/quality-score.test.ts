import { describe, it, expect } from "vitest";
import { computeQualityScore } from "../../src/hooks/quality-score.js";

describe("computeQualityScore", () => {
  it("returns >0.7 for long output with multiple signal lines", () => {
    const score = computeQualityScore({
      text: "Error: TypeError on line 42\nStack: ...\nFix: cast to string\n".repeat(10),
      classifierConfidence: 0.85,
      signalCount: 3,
    });
    expect(score).toBeGreaterThan(0.7);
  });

  it("returns <0.3 for tiny low-signal output", () => {
    const score = computeQualityScore({
      text: "ok",
      classifierConfidence: 0.2,
      signalCount: 0,
    });
    expect(score).toBeLessThan(0.3);
  });

  it("clamps classifierConfidence to [0,1]", () => {
    const high = computeQualityScore({ text: "x".repeat(500), classifierConfidence: 5, signalCount: 3 });
    const low = computeQualityScore({ text: "", classifierConfidence: -1, signalCount: 0 });
    expect(high).toBeLessThanOrEqual(1);
    expect(low).toBeGreaterThanOrEqual(0);
  });
});
