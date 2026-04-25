// src/engine/adaptive-ranker.ts
import type Database from "better-sqlite3";

export interface AdaptiveScoreFactors {
  fts_relevance: number;
  embedding_relevance: number;
  importance: number;
  decay: number;
  utility: number;
  recency_bonus: number;
}

// Weights when embeddings are disabled (FTS-only mode)
export const SCORE_WEIGHTS = {
  fts_relevance: 0.30,
  importance: 0.20,
  decay: 0.15,
  utility: 0.25,
  recency_bonus: 0.10,
};

// Weights when embeddings are enabled (hybrid FTS5 + vector mode)
export const SCORE_WEIGHTS_WITH_EMBEDDINGS = {
  fts_relevance: 0.20,
  embedding_relevance: 0.15,
  importance: 0.20,
  decay: 0.15,
  utility: 0.20,
  recency_bonus: 0.10,
};

export function computeAdaptiveScore(
  factors: AdaptiveScoreFactors,
  embeddingsEnabled = false,
): number {
  if (embeddingsEnabled) {
    const w = SCORE_WEIGHTS_WITH_EMBEDDINGS;
    return (
      factors.fts_relevance * w.fts_relevance +
      factors.embedding_relevance * w.embedding_relevance +
      factors.importance * w.importance +
      factors.decay * w.decay +
      factors.utility * w.utility +
      factors.recency_bonus * w.recency_bonus
    );
  }
  const w = SCORE_WEIGHTS;
  return (
    factors.fts_relevance * w.fts_relevance +
    factors.importance * w.importance +
    factors.decay * w.decay +
    factors.utility * w.utility +
    factors.recency_bonus * w.recency_bonus
  );
}

export function computeUtilityScore(db: Database.Database, memoryId: string): number {
  // I6: Count injection events and utility_signal events separately.
  // total_injections = times the memory was injected into context
  // used_count = times the memory was subsequently used (signal_type != 'ignored')
  // This gives a true (used / injected) ratio, not (used / signal_recorded).
  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM analytics_events
       WHERE memory_id = ? AND event_type = 'injection'
         AND created_at > datetime('now', '-30 days')) AS total_injections,
      (SELECT COUNT(*) FROM analytics_events
       WHERE memory_id = ? AND event_type = 'utility_signal'
         AND json_valid(event_data)
         AND json_extract(event_data, '$.signal_type') != 'ignored'
         AND created_at > datetime('now', '-30 days')) AS used_count,
      (SELECT AVG(CAST(json_extract(event_data, '$.signal_strength') AS REAL))
       FROM analytics_events
       WHERE memory_id = ? AND event_type = 'utility_signal'
         AND json_valid(event_data)
         AND json_extract(event_data, '$.signal_type') != 'ignored'
         AND created_at > datetime('now', '-30 days')) AS avg_strength
  `).get(memoryId, memoryId, memoryId) as { total_injections: number; used_count: number; avg_strength: number | null };

  if (!stats || stats.total_injections === 0) {
    return 0.5; // neutral for no data — don't penalize new memories
  }

  const usageRate = stats.used_count / stats.total_injections;
  const avgStrength = stats.avg_strength ?? 0;
  const confidence = Math.min(stats.total_injections / 5, 1.0);

  return usageRate * 0.6 + avgStrength * 0.2 + confidence * 0.2;
}
