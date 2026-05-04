import { describe, it, expect } from "vitest";
import { computeStaleness, type StalenessVerdict } from "../../src/engine/staleness.js";

describe("computeStaleness", () => {
  it("returns 'fresh' when 0 lines changed in a multi-line range", () => {
    const v: StalenessVerdict = computeStaleness({ linesChanged: 0, rangeSize: 10, fileExists: true });
    expect(v.status).toBe("fresh");
    expect(v.changeFraction).toBe(0);
  });

  it("returns 'anchor-deleted' when fileExists=false", () => {
    const v = computeStaleness({ linesChanged: 0, rangeSize: 10, fileExists: false });
    expect(v.status).toBe("anchor-deleted");
    expect(v.reason).toMatch(/file removed/i);
  });

  it("returns 'stale' when ≥30% of range changed", () => {
    const v = computeStaleness({ linesChanged: 4, rangeSize: 10, fileExists: true });
    expect(v.status).toBe("stale");
    expect(v.reason).toMatch(/40%/);
  });

  it("stays 'fresh' when fraction below 30%", () => {
    const v = computeStaleness({ linesChanged: 2, rangeSize: 10, fileExists: true });
    expect(v.status).toBe("fresh");
  });

  it("treats single-line anchors with any change as stale", () => {
    const v = computeStaleness({ linesChanged: 1, rangeSize: 1, fileExists: true });
    expect(v.status).toBe("stale");
  });

  it("treats file-only anchor (rangeSize=0) as fresh by default", () => {
    const v = computeStaleness({ linesChanged: 0, rangeSize: 0, fileExists: true });
    expect(v.status).toBe("fresh");
  });

  it("anchor-deleted takes precedence over rangeSize=0", () => {
    const v = computeStaleness({ linesChanged: 0, rangeSize: 0, fileExists: false });
    expect(v.status).toBe("anchor-deleted");
  });
});
