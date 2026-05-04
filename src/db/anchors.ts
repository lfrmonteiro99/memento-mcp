// src/db/anchors.ts
// AnchorsRepo: CRUD over memory_anchors (P4 Task 2).
// Anchors pin a memory to a file (and optionally a line range + commit_sha) so
// that a later staleness pass can flag the memory when the underlying code drifts.

import type Database from "better-sqlite3";

export type AnchorStatus = "fresh" | "stale" | "anchor-deleted";

export interface Anchor {
  id: number;
  memory_id: string;
  file_path: string;
  line_start: number | null;
  line_end: number | null;
  commit_sha: string | null;
  anchored_at: string;
  status: AnchorStatus;
  stale_since: string | null;
  stale_reason: string | null;
}

export interface AttachAnchorInput {
  memory_id: string;
  file_path: string;
  line_start?: number;
  line_end?: number;
  commit_sha?: string;
}

export class AnchorsRepo {
  constructor(private db: Database.Database) {}

  attach(input: AttachAnchorInput): Anchor {
    if (
      input.line_start != null &&
      input.line_end != null &&
      input.line_end < input.line_start
    ) {
      throw new Error(
        `invalid line range: line_end (${input.line_end}) < line_start (${input.line_start})`,
      );
    }
    const result = this.db
      .prepare(
        `INSERT INTO memory_anchors(memory_id, file_path, line_start, line_end, commit_sha)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.memory_id,
        input.file_path,
        input.line_start ?? null,
        input.line_end ?? null,
        input.commit_sha ?? null,
      );
    return this.db
      .prepare("SELECT * FROM memory_anchors WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as Anchor;
  }

  listForMemory(memoryId: string): Anchor[] {
    return this.db
      .prepare("SELECT * FROM memory_anchors WHERE memory_id = ? ORDER BY id")
      .all(memoryId) as Anchor[];
  }

  listByFile(filePath: string): Anchor[] {
    return this.db
      .prepare("SELECT * FROM memory_anchors WHERE file_path = ? ORDER BY id")
      .all(filePath) as Anchor[];
  }

  /** Mark anchor stale; only transitions from 'fresh'. No-op otherwise. */
  markStale(id: number, reason: string): void {
    this.db
      .prepare(
        `UPDATE memory_anchors
         SET status = 'stale', stale_since = datetime('now'), stale_reason = ?
         WHERE id = ? AND status = 'fresh'`,
      )
      .run(reason, id);
  }

  /** Anchor-deleted is terminal: applies regardless of prior status. */
  markAnchorDeleted(id: number, reason: string): void {
    this.db
      .prepare(
        `UPDATE memory_anchors
         SET status = 'anchor-deleted', stale_since = datetime('now'), stale_reason = ?
         WHERE id = ?`,
      )
      .run(reason, id);
  }

  detach(id: number): void {
    this.db.prepare("DELETE FROM memory_anchors WHERE id = ?").run(id);
  }
}
