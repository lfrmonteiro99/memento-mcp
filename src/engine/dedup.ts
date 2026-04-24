// src/engine/dedup.ts
import type Database from "better-sqlite3";
import { trigramSimilarity, jaccardSimilarity } from "./similarity.js";

export function isDuplicate(
  db: Database.Database,
  candidate: { title: string; body: string; projectId?: string },
  threshold: number
): { duplicate: boolean; mergeTargetId?: string } {
  // I3: Filter by project_id to prevent cross-project deduplication.
  // projectId may be undefined for global-scope memories (no project filter needed).
  const recent = candidate.projectId
    ? db.prepare(`
        SELECT id, title, body FROM memories
        WHERE project_id = ? AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 50
      `).all(candidate.projectId) as Array<{ id: string; title: string; body: string }>
    : db.prepare(`
        SELECT id, title, body FROM memories
        WHERE project_id IS NULL AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 50
      `).all() as Array<{ id: string; title: string; body: string }>;

  for (const mem of recent) {
    const titleSim = trigramSimilarity(candidate.title, mem.title);
    const bodySim = jaccardSimilarity(candidate.body, mem.body || "");
    const combined = titleSim * 0.4 + bodySim * 0.6;

    if (combined > threshold) {
      return { duplicate: true, mergeTargetId: mem.id };
    }
  }

  return { duplicate: false };
}

export class CooldownTracker {
  private timestamps = new Map<string, number>();
  private captureCount = 0;

  constructor(
    private cooldownSeconds: number,
    private maxCaptures: number = 20
  ) {}

  isOnCooldown(key: string): boolean {
    const last = this.timestamps.get(key);
    if (!last) return false;
    return (Date.now() - last) < this.cooldownSeconds * 1000;
  }

  record(key: string): void {
    this.timestamps.set(key, Date.now());
    this.captureCount++;
  }

  hasReachedMaxCaptures(): boolean {
    return this.captureCount >= this.maxCaptures;
  }
}
