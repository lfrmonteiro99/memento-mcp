// src/db/memories.ts
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { nowIso } from "./database.js";

function sanitizeFtsToken(token: string): string {
  return token.replace(/"/g, '""');
}

function buildFtsQuery(query: string): string {
  const tokens = query.split(/\s+/).filter(t => t.length > 0);
  if (!tokens.length) return "";
  return tokens.map(t => `"${sanitizeFtsToken(t)}"`).join(" OR ");
}

export interface StoreParams {
  title: string;
  body: string;
  memoryType?: string;
  scope?: string;
  projectPath?: string;
  tags?: string[];
  importance?: number;
  supersedesId?: string;
  pin?: boolean;
}

export interface SearchOptions {
  projectPath?: string;
  memoryType?: string;
  limit?: number;
}

export class MemoriesRepo {
  constructor(private db: Database.Database) {}

  private getOrCreateProject(rootPath: string): string {
    const row = this.db.prepare("SELECT id FROM projects WHERE root_path = ?").get(rootPath) as any;
    if (row) return row.id;
    const id = randomUUID();
    const name = rootPath.split("/").pop() ?? rootPath;
    this.db.prepare("INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)").run(id, name, rootPath);
    return id;
  }

  store(params: StoreParams): string {
    const id = randomUUID();
    const now = nowIso();
    const projectId = params.projectPath ? this.getOrCreateProject(params.projectPath) : null;
    const tagsStr = params.tags?.join(",") ?? null;

    if (params.supersedesId) {
      this.db.prepare("UPDATE memories SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(now, params.supersedesId);
    }

    this.db.prepare(`
      INSERT INTO memories (id, project_id, memory_type, scope, title, body, tags,
                            importance_score, is_pinned, supersedes_memory_id,
                            created_at, updated_at, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, params.memoryType ?? "fact", params.scope ?? "project",
           params.title, params.body, tagsStr, params.importance ?? 0.5,
           params.pin ? 1 : 0, params.supersedesId || null, now, now, now);
    return id;
  }

  getById(id: string): any | null {
    return this.db.prepare("SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL").get(id) ?? null;
  }

  search(query: string, opts: SearchOptions = {}): any[] {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];

    const params: any[] = [ftsQuery];
    const whereClauses = ["m.deleted_at IS NULL"];

    if (opts.projectPath) {
      const projectId = this.getOrCreateProject(opts.projectPath);
      whereClauses.push("(m.project_id = ? OR m.scope = 'global')");
      params.push(projectId);
    }
    if (opts.memoryType) {
      whereClauses.push("m.memory_type = ?");
      params.push(opts.memoryType);
    }

    const limit = opts.limit ?? 10;
    params.push(limit);

    const rows = this.db.prepare(`
      SELECT m.*, rank FROM memory_fts fts
      JOIN memories m ON m.rowid = fts.rowid
      WHERE memory_fts MATCH ? AND ${whereClauses.join(" AND ")}
      ORDER BY rank LIMIT ?
    `).all(...params) as any[];

    // Update access tracking
    const now = nowIso();
    const updateStmt = this.db.prepare(
      "UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?"
    );
    for (const r of rows) {
      updateStmt.run(now, r.id);
    }

    return rows;
  }

  list(opts: { projectPath?: string; memoryType?: string; scope?: string; pinnedOnly?: boolean; limit?: number } = {}): any[] {
    const whereClauses = ["deleted_at IS NULL"];
    const params: any[] = [];

    if (opts.projectPath) {
      const projectId = this.getOrCreateProject(opts.projectPath);
      whereClauses.push("(project_id = ? OR scope = 'global')");
      params.push(projectId);
    }
    if (opts.memoryType) { whereClauses.push("memory_type = ?"); params.push(opts.memoryType); }
    if (opts.scope) { whereClauses.push("scope = ?"); params.push(opts.scope); }
    if (opts.pinnedOnly) { whereClauses.push("is_pinned = 1"); }

    params.push(opts.limit ?? 20);

    return this.db.prepare(`
      SELECT * FROM memories WHERE ${whereClauses.join(" AND ")}
      ORDER BY is_pinned DESC, importance_score DESC, updated_at DESC LIMIT ?
    `).all(...params) as any[];
  }

  delete(id: string): boolean {
    const result = this.db.prepare(
      "UPDATE memories SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL"
    ).run(nowIso(), id);
    return result.changes > 0;
  }

  pruneStale(maxAgeDays = 60, minImportance = 0.3): number {
    const result = this.db.prepare(`
      UPDATE memories SET deleted_at = ?
      WHERE deleted_at IS NULL AND is_pinned = 0
        AND importance_score < ? AND last_accessed_at < datetime('now', ? || ' days')
    `).run(nowIso(), minImportance, `-${maxAgeDays}`);
    return result.changes;
  }
}
