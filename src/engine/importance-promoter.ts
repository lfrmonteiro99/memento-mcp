import type Database from "better-sqlite3";
import { computeUtilityScore } from "./adaptive-ranker.js";

export interface PromoteOptions {
  minInjections: number;
  neutralUtility: number;
  maxDelta: number; // absolute clamp per pass — avoid runaway inflation
}

export interface PromoteResult {
  considered: number;
  adjusted: number;
  promoted: number;
  demoted: number;
}

/**
 * Nudges importance_score up (or down) for memories with enough usage
 * signal to trust the utility computation. Pinned memories are skipped —
 * the user set their importance intentionally.
 *
 * Per pass the change is small: delta = (utility - neutralUtility) * 0.2,
 * clamped to [-maxDelta, +maxDelta]. The point is gradual convergence,
 * not a one-shot rewrite.
 */
export function promoteImportanceFromUtility(
  db: Database.Database,
  options: PromoteOptions,
): PromoteResult {
  const candidates = db
    .prepare(
      `
      SELECT m.id, m.importance_score, COUNT(ae.id) as injection_count
      FROM memories m
      JOIN analytics_events ae
        ON ae.memory_id = m.id AND ae.event_type = 'injection'
       AND ae.created_at > datetime('now', '-30 days')
      WHERE m.deleted_at IS NULL AND m.is_pinned = 0
      GROUP BY m.id
      HAVING injection_count >= ?
      `,
    )
    .all(options.minInjections) as Array<{
    id: string;
    importance_score: number;
    injection_count: number;
  }>;

  let adjusted = 0;
  let promoted = 0;
  let demoted = 0;

  const update = db.prepare(
    "UPDATE memories SET importance_score = ?, updated_at = ? WHERE id = ? AND is_pinned = 0 AND deleted_at IS NULL",
  );
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    for (const row of candidates) {
      const utility = computeUtilityScore(db, row.id);
      const rawDelta = (utility - options.neutralUtility) * 0.2;
      const delta = Math.max(-options.maxDelta, Math.min(options.maxDelta, rawDelta));
      if (Math.abs(delta) < 0.01) continue;
      const next = Math.min(1, Math.max(0, row.importance_score + delta));
      if (Math.abs(next - row.importance_score) < 0.005) continue;
      update.run(next, now, row.id);
      adjusted++;
      if (delta > 0) promoted++;
      else demoted++;
    }
  });

  tx();

  return { considered: candidates.length, adjusted, promoted, demoted };
}
