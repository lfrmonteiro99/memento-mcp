/**
 * Reciprocal Rank Fusion — merges multiple ranked lists into a single fused ranking.
 *
 * Formula: rrf_score(item) = Σ 1/(k + rank_i)  across all rankers where item appears.
 * Each rank is 1-based. Standard default k=60 (from Cormack et al. 2009).
 *
 * Robust to score-distribution skew between rankers (FTS5 bm25 vs cosine sim).
 * Parameter-free in practice: k=60 is the de-facto standard.
 */

export interface RankedItem {
  id: string;
  score: number; // raw score; not used in fusion math, only for debugging
}

export interface FusedItem {
  id: string;
  rrf_score: number;
  ranks: number[]; // rank in each input list (1-based; -1 if absent)
}

export interface RRFOptions {
  k?: number;
}

const DEFAULT_K = 60;

export function reciprocalRankFusion(
  rankings: RankedItem[][],
  opts: RRFOptions = {},
): FusedItem[] {
  const k = opts.k ?? DEFAULT_K;
  const numRankers = rankings.length;

  if (numRankers === 0) return [];

  const accum = new Map<string, { rrf: number; ranks: number[] }>();

  rankings.forEach((ranking, rankerIdx) => {
    ranking.forEach((item, i) => {
      const rank = i + 1; // 1-based
      const contribution = 1 / (k + rank);
      let entry = accum.get(item.id);
      if (!entry) {
        entry = { rrf: 0, ranks: new Array(numRankers).fill(-1) };
        accum.set(item.id, entry);
      }
      entry.rrf += contribution;
      entry.ranks[rankerIdx] = rank;
    });
  });

  return Array.from(accum.entries())
    .map(([id, v]) => ({ id, rrf_score: v.rrf, ranks: v.ranks }))
    .sort((a, b) => b.rrf_score - a.rrf_score);
}
