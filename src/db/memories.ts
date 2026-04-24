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
  projectId?: string;        // M5: direct project id, used by auto-capture after it resolves cwd
  tags?: string[];
  importance?: number;
  supersedesId?: string;
  pin?: boolean;
  source?: string;           // M5: "user" (default) | "auto-capture" | "compression"
}

export interface SearchOptions {
  projectPath?: string;
  memoryType?: string;
  limit?: number;
}

export class MemoriesRepo {
  constructor(private db: Database.Database) {}

  /** K2/Task 13: public so the auto-capture bin can resolve cwd → project UUID. */
  ensureProject(rootPath: string): string {
    const row = this.db.prepare("SELECT id FROM projects WHERE root_path = ?").get(rootPath) as any;
    if (row) return row.id;
    const id = randomUUID();
    const name = rootPath.split("/").pop() ?? rootPath;
    this.db.prepare("INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)").run(id, name, rootPath);
    return id;
  }

  /** @deprecated Use ensureProject() — kept for backward compat inside this class. */
  private getOrCreateProject(rootPath: string): string {
    return this.ensureProject(rootPath);
  }

  store(params: StoreParams): string {
    const id = randomUUID();
    const now = nowIso();
    const projectId = params.projectId
      ?? (params.projectPath ? this.getOrCreateProject(params.projectPath) : null);

    // K5: JSON-encode tags (was: .join(",") in v1). parseTags() in formatter.ts
    // already tolerates both CSV and JSON, so reads stay compatible. The v2 migration
    // (Task 1) rewrites any v1 CSV rows to JSON.
    const tagsStr = params.tags ? JSON.stringify(params.tags) : null;

    // R4: supersedes cycle guard — walk the chain up to 10 steps. If we encounter
    // our own (soon-to-be-created) id, or a cycle, refuse the INSERT.
    if (params.supersedesId) {
      let cursor: string | null = params.supersedesId;
      const seen = new Set<string>();
      for (let step = 0; step < 10 && cursor; step++) {
        if (seen.has(cursor)) {
          throw new Error(`supersedes chain cycle detected at memory ${cursor}`);
        }
        seen.add(cursor);
        const row = this.db.prepare(
          "SELECT supersedes_memory_id FROM memories WHERE id = ?"
        ).get(cursor) as { supersedes_memory_id: string | null } | undefined;
        cursor = row?.supersedes_memory_id ?? null;
      }
      this.db.prepare("UPDATE memories SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
        .run(now, params.supersedesId);
    }

    // M5: source column included in the INSERT. Defaults to 'user' if not provided.
    this.db.prepare(`
      INSERT INTO memories (id, project_id, memory_type, scope, title, body, tags,
                            importance_score, is_pinned, supersedes_memory_id, source,
                            created_at, updated_at, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, params.memoryType ?? "fact", params.scope ?? "project",
           params.title, params.body, tagsStr, params.importance ?? 0.5,
           params.pin ? 1 : 0, params.supersedesId || null, params.source ?? "user",
           now, now, now);
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

    if (rows.length > 0) {
      this.batchUpdateAccess(rows.map(r => r.id));
    }

    return rows;
  }

  /**
   * K6: v2 search. Accepts a pre-built FTS5 query string (built via buildFtsQueryV2).
   * Returns raw rows WITHOUT running batchUpdateAccess — the caller (hook) decides
   * whether to debit access based on which memories actually get injected after
   * adaptive re-ranking.
   */
  searchV2(ftsQuery: string, opts: SearchOptions = {}): any[] {
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

    return this.db.prepare(`
      SELECT m.*, rank FROM memory_fts fts
      JOIN memories m ON m.rowid = fts.rowid
      WHERE memory_fts MATCH ? AND ${whereClauses.join(" AND ")}
      ORDER BY rank LIMIT ?
    `).all(...params) as any[];
  }

  batchUpdateAccess(ids: string[]): void {
    if (ids.length === 0) return;
    const now = nowIso();
    const placeholders = ids.map(() => "?").join(",");
    this.db.prepare(`
      UPDATE memories
      SET access_count = access_count + 1, last_accessed_at = ?
      WHERE id IN (${placeholders})
    `).run(now, ...ids);
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

  update(
    id: string,
    patch: {
      title?: string;
      body?: string;
      tags?: string[];
      importance?: number;
      memoryType?: string;
      pinned?: boolean;
    },
  ): boolean {
    const existing = this.getById(id);
    if (!existing) return false;

    const fields: string[] = [];
    const values: any[] = [];
    if (patch.title !== undefined) { fields.push("title = ?"); values.push(patch.title); }
    if (patch.body !== undefined) { fields.push("body = ?"); values.push(patch.body); }
    if (patch.tags !== undefined) { fields.push("tags = ?"); values.push(JSON.stringify(patch.tags)); }
    if (patch.importance !== undefined) {
      fields.push("importance_score = ?");
      values.push(Math.min(1, Math.max(0, patch.importance)));
    }
    if (patch.memoryType !== undefined) { fields.push("memory_type = ?"); values.push(patch.memoryType); }
    if (patch.pinned !== undefined) { fields.push("is_pinned = ?"); values.push(patch.pinned ? 1 : 0); }

    if (fields.length === 0) return false;
    fields.push("updated_at = ?");
    values.push(nowIso());
    values.push(id);

    const result = this.db
      .prepare(`UPDATE memories SET ${fields.join(", ")} WHERE id = ? AND deleted_at IS NULL`)
      .run(...values);
    return result.changes > 0;
  }

  setPinned(id: string, pinned: boolean): boolean {
    return this.update(id, { pinned });
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
