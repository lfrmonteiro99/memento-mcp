import { describe, it, expect } from "vitest";
import { reciprocalRankFusion } from "../../src/engine/rrf.js";

describe("reciprocalRankFusion", () => {
  it("merges two ranked lists with default k=60", () => {
    const ftsRanking = [
      { id: "a", score: 10.0 },
      { id: "b", score: 8.0 },
      { id: "c", score: 5.0 },
    ];
    const vecRanking = [
      { id: "b", score: 0.9 },
      { id: "a", score: 0.85 },
      { id: "d", score: 0.8 },
    ];

    const fused = reciprocalRankFusion([ftsRanking, vecRanking]);
    const ids = fused.map(r => r.id);
    // 'a' and 'b' both appear in both rankings near the top → highest fused
    expect(ids[0]).toMatch(/^[ab]$/);
    expect(ids[1]).toMatch(/^[ab]$/);
    // 'c' (only in fts at rank 3) and 'd' (only in vec at rank 3) appear later
    expect(ids).toContain("c");
    expect(ids).toContain("d");
    expect(fused).toHaveLength(4);
  });

  it("custom k changes ranking sensitivity", () => {
    // Item 'a' ranks #1 in r1 and #5 in r2
    // Item 'b' ranks #2 in r1 and #2 in r2
    const r1 = [{ id: "a", score: 1 }, { id: "b", score: 1 }, { id: "c", score: 1 }, { id: "d", score: 1 }];
    const r2 = [{ id: "x", score: 1 }, { id: "x", score: 1 }, { id: "x", score: 1 }, { id: "x", score: 1 }, { id: "a", score: 1 }, { id: "b", score: 1 }];
    // With k=1: contribution gap between rank 1 (1/2=0.5) and rank 5 (1/6≈0.167) is large
    // With k=1000: gap between rank 1 (1/1001) and rank 5 (1/1005) is tiny
    const fusedSmallK = reciprocalRankFusion([r1, r2], { k: 1 });
    const fusedLargeK = reciprocalRankFusion([r1, r2], { k: 1000 });
    const aSmall = fusedSmallK.find(x => x.id === "a")!.rrf_score;
    const bSmall = fusedSmallK.find(x => x.id === "b")!.rrf_score;
    const aLarge = fusedLargeK.find(x => x.id === "a")!.rrf_score;
    const bLarge = fusedLargeK.find(x => x.id === "b")!.rrf_score;
    const gapSmall = Math.abs(aSmall - bSmall);
    const gapLarge = Math.abs(aLarge - bLarge);
    expect(gapSmall).toBeGreaterThan(gapLarge);
  });

  it("populates ranks array correctly: index per ranker, -1 if absent", () => {
    const r1 = [{ id: "a", score: 1 }, { id: "b", score: 1 }];
    const r2 = [{ id: "b", score: 1 }];
    const fused = reciprocalRankFusion([r1, r2]);
    const a = fused.find(r => r.id === "a")!;
    const b = fused.find(r => r.id === "b")!;
    expect(a.ranks).toEqual([1, -1]); // rank 1 in r1, absent in r2
    expect(b.ranks).toEqual([2, 1]);  // rank 2 in r1, rank 1 in r2
  });

  it("handles empty rankings array", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
  });

  it("handles single empty list", () => {
    expect(reciprocalRankFusion([[]])).toEqual([]);
  });

  it("handles single non-empty list (passthrough order preserved)", () => {
    const r1 = [{ id: "a", score: 1 }, { id: "b", score: 1 }, { id: "c", score: 1 }];
    const fused = reciprocalRankFusion([r1]);
    expect(fused.map(r => r.id)).toEqual(["a", "b", "c"]);
  });

  it("dedup: same id in same ranker contributes once", () => {
    // Edge case — pathological caller passing duplicates within a single ranker.
    // Document expected behaviour: latest rank wins (Map semantics).
    // This isn't a hot bug path; just defining behaviour.
    const r1 = [
      { id: "a", score: 1 },
      { id: "a", score: 1 },
    ];
    const fused = reciprocalRankFusion([r1]);
    expect(fused).toHaveLength(1);
    expect(fused[0].id).toBe("a");
    // 'a' appears at ranks 1 AND 2 in r1; since contributions are summed by id,
    // a's rrf_score = 1/(60+1) + 1/(60+2) = ~0.0325
    // ranks[0] is the LAST seen rank (2)
    expect(fused[0].ranks[0]).toBe(2);
  });
});
