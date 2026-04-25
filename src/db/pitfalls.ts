import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { nowIso } from "./database.js";
import { hasPrivate } from "../engine/privacy.js";

export class PitfallsRepo {
  constructor(private db: Database.Database) {}

  private getOrCreateProject(rootPath: string): string {
    const row = this.db.prepare("SELECT id FROM projects WHERE root_path = ?").get(rootPath) as any;
    if (row) return row.id;
    const id = randomUUID();
    this.db.prepare("INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)").run(id, rootPath.split("/").pop() ?? rootPath, rootPath);
    return id;
  }

  store(projectPath: string, title: string, body: string, importance = 0.6): string {
    const projectId = this.getOrCreateProject(projectPath);
    const now = nowIso();
    const existing = this.db.prepare(
      "SELECT id, occurrence_count FROM pitfalls WHERE project_id = ? AND title = ? AND deleted_at IS NULL AND resolved = 0"
    ).get(projectId, title) as any;

    // Issue #4: set has_private flag on store/update.
    const hasPrivateFlag = hasPrivate(body) ? 1 : 0;
    if (existing) {
      this.db.prepare("UPDATE pitfalls SET occurrence_count = occurrence_count + 1, last_seen_at = ?, body = ?, has_private = ? WHERE id = ?")
        .run(now, body, hasPrivateFlag, existing.id);
      return existing.id;
    }

    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO pitfalls (id, project_id, title, body, importance_score, last_seen_at, has_private, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, title, body, importance, now, hasPrivateFlag, now);
    return id;
  }

  list(projectPath: string, limit = 10, includeResolved = false): any[] {
    const projectId = this.getOrCreateProject(projectPath);
    const resolvedClause = includeResolved ? "" : "AND resolved = 0";
    return this.db.prepare(`
      SELECT * FROM pitfalls WHERE project_id = ? AND deleted_at IS NULL ${resolvedClause}
      ORDER BY occurrence_count DESC, importance_score DESC LIMIT ?
    `).all(projectId, limit) as any[];
  }

  listAll(limit = 10, includeResolved = false): any[] {
    const resolvedClause = includeResolved ? "" : "AND resolved = 0";
    return this.db.prepare(`
      SELECT * FROM pitfalls WHERE deleted_at IS NULL ${resolvedClause}
      ORDER BY occurrence_count DESC, importance_score DESC LIMIT ?
    `).all(limit) as any[];
  }

  resolve(pitfallId: string): boolean {
    return this.db.prepare("UPDATE pitfalls SET resolved = 1 WHERE id = ? AND deleted_at IS NULL").run(pitfallId).changes > 0;
  }
}
