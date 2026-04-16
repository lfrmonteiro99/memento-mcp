import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { nowIso } from "./database.js";

function buildFtsQuery(query: string): string {
  const tokens = query.split(/\s+/).filter(t => t.length > 0);
  if (!tokens.length) return "";
  return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

export class DecisionsRepo {
  constructor(private db: Database.Database) {}

  private getOrCreateProject(rootPath: string): string {
    const row = this.db.prepare("SELECT id FROM projects WHERE root_path = ?").get(rootPath) as any;
    if (row) return row.id;
    const id = randomUUID();
    this.db.prepare("INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)").run(id, rootPath.split("/").pop() ?? rootPath, rootPath);
    return id;
  }

  store(projectPath: string, title: string, body: string, category = "general", importance = 0.7, supersedesId?: string): string {
    const projectId = this.getOrCreateProject(projectPath);
    const id = randomUUID();
    const now = nowIso();
    if (supersedesId) {
      this.db.prepare("UPDATE decisions SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(now, supersedesId);
    }
    this.db.prepare(`
      INSERT INTO decisions (id, project_id, title, body, category, importance_score, supersedes_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, title, body, category, importance, supersedesId ?? null, now);
    return id;
  }

  list(projectPath: string, limit = 10): any[] {
    const projectId = this.getOrCreateProject(projectPath);
    return this.db.prepare(`
      SELECT * FROM decisions WHERE project_id = ? AND deleted_at IS NULL
      ORDER BY importance_score DESC, created_at DESC LIMIT ?
    `).all(projectId, limit) as any[];
  }

  search(query: string, projectPath: string, limit = 10): any[] {
    const projectId = this.getOrCreateProject(projectPath);
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];
    return this.db.prepare(`
      SELECT d.*, rank FROM decisions_fts fts
      JOIN decisions d ON d.rowid = fts.rowid
      WHERE decisions_fts MATCH ? AND d.project_id = ? AND d.deleted_at IS NULL
      ORDER BY rank LIMIT ?
    `).all(ftsQuery, projectId, limit) as any[];
  }
}
