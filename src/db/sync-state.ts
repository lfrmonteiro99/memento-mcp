// src/db/sync-state.ts — thin repository for sync_state and sync_file_hashes tables.
import type Database from "better-sqlite3";
import { nowIso } from "./database.js";

export interface SyncStateRow {
  project_id: string;
  last_pull_at: string | null;
  last_push_at: string | null;
}

export interface SyncFileHashRow {
  project_id: string;
  memory_id: string;
  hash: string;
  checked_at: string;
}

export class SyncStateRepo {
  constructor(private db: Database.Database) {}

  /** Returns the sync_state row for project, creating it if absent. */
  getOrCreate(projectId: string): SyncStateRow {
    const existing = this.db
      .prepare("SELECT * FROM sync_state WHERE project_id = ?")
      .get(projectId) as SyncStateRow | undefined;
    if (existing) return existing;

    this.db
      .prepare("INSERT INTO sync_state (project_id, last_pull_at, last_push_at) VALUES (?, NULL, NULL)")
      .run(projectId);

    return { project_id: projectId, last_pull_at: null, last_push_at: null };
  }

  setLastPull(projectId: string, ts: string): void {
    this.getOrCreate(projectId);
    this.db
      .prepare("UPDATE sync_state SET last_pull_at = ? WHERE project_id = ?")
      .run(ts, projectId);
  }

  setLastPush(projectId: string, ts: string): void {
    this.getOrCreate(projectId);
    this.db
      .prepare("UPDATE sync_state SET last_push_at = ? WHERE project_id = ?")
      .run(ts, projectId);
  }

  getFileHash(projectId: string, memoryId: string): string | null {
    const row = this.db
      .prepare("SELECT hash FROM sync_file_hashes WHERE project_id = ? AND memory_id = ?")
      .get(projectId, memoryId) as { hash: string } | undefined;
    return row?.hash ?? null;
  }

  setFileHash(projectId: string, memoryId: string, hash: string): void {
    this.db
      .prepare(`
        INSERT INTO sync_file_hashes (project_id, memory_id, hash, checked_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(project_id, memory_id) DO UPDATE SET hash = excluded.hash, checked_at = excluded.checked_at
      `)
      .run(projectId, memoryId, hash, nowIso());
  }

  deleteFileHash(projectId: string, memoryId: string): void {
    this.db
      .prepare("DELETE FROM sync_file_hashes WHERE project_id = ? AND memory_id = ?")
      .run(projectId, memoryId);
  }

  getAllFileHashes(projectId: string): SyncFileHashRow[] {
    return this.db
      .prepare("SELECT * FROM sync_file_hashes WHERE project_id = ?")
      .all(projectId) as SyncFileHashRow[];
  }
}
