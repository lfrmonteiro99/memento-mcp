// src/db/memories.ts
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { nowIso } from "./database.js";
import { hasPrivate } from "../engine/privacy.js";
import { scrubSecrets } from "../engine/text-utils.js";
import { createLogger, logLevelFromEnv } from "../lib/logger.js";

const logger = createLogger(logLevelFromEnv());

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
  claudeSessionId?: string;  // Issue #3: Claude Code session ID for linking memories to sessions
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

    // Issue #12: scrub secrets from title and body before writing to DB.
    const cleanTitle = scrubSecrets(params.title);
    const cleanBody = scrubSecrets(params.body ?? "");
    if (cleanTitle !== params.title) {
      logger.warn(`Secret pattern detected and scrubbed in memory title (id=${id})`);
    }
    // Issue #4: warn if title contains private tags (tags don't redact in titles).
    if (hasPrivate(params.title)) {
      logger.warn(`Warning: <private> tags detected in memory title — tags do not redact in titles. Move sensitive content to body. (id=${id})`);
    }

    // M5: source column included in the INSERT. Defaults to 'user' if not provided.
    // Issue #3: claude_session_id column added in migration v5.
    // Issue #4: has_private column added in migration v6.
    const hasPrivateFlag = hasPrivate(cleanBody) ? 1 : 0;
    this.db.prepare(`
      INSERT INTO memories (id, project_id, memory_type, scope, title, body, tags,
                            importance_score, is_pinned, supersedes_memory_id, source,
                            claude_session_id, has_private,
                            created_at, updated_at, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, params.memoryType ?? "fact", params.scope ?? "project",
           cleanTitle, cleanBody, tagsStr, params.importance ?? 0.5,
           params.pin ? 1 : 0, params.supersedesId || null, params.source ?? "user",
           params.claudeSessionId ?? null, hasPrivateFlag,
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

  getMany(ids: string[]): any[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db.prepare(
      `SELECT * FROM memories WHERE id IN (${placeholders}) AND deleted_at IS NULL`
    ).all(...ids) as any[];
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
    // Issue #12: scrub secrets from title and body at write time.
    if (patch.title !== undefined) {
      const cleanTitle = scrubSecrets(patch.title);
      if (cleanTitle !== patch.title) {
        logger.warn(`Secret pattern detected and scrubbed in memory title during update (id=${id})`);
      }
      if (hasPrivate(patch.title)) {
        logger.warn(`Warning: <private> tags detected in memory title — tags do not redact in titles. Move sensitive content to body. (id=${id})`);
      }
      fields.push("title = ?");
      values.push(cleanTitle);
    }
    if (patch.body !== undefined) {
      const cleanBody = scrubSecrets(patch.body);
      fields.push("body = ?");
      values.push(cleanBody);
    }
    if (patch.tags !== undefined) { fields.push("tags = ?"); values.push(JSON.stringify(patch.tags)); }
    if (patch.importance !== undefined) {
      fields.push("importance_score = ?");
      values.push(Math.min(1, Math.max(0, patch.importance)));
    }
    if (patch.memoryType !== undefined) { fields.push("memory_type = ?"); values.push(patch.memoryType); }
    if (patch.pinned !== undefined) { fields.push("is_pinned = ?"); values.push(patch.pinned ? 1 : 0); }

    if (fields.length === 0) return false;
    // Issue #4: update has_private when body changes (use already-scrubbed value).
    if (patch.body !== undefined) {
      fields.push("has_private = ?");
      // Re-use the scrubbed body already pushed into values above (idempotent if scrubbed again).
      values.push(hasPrivate(scrubSecrets(patch.body)) ? 1 : 0);
    }
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

  /**
   * Issue #9: prune stale memories for a specific project.
   * Used by the per-project retention policy override in the maintenance loop.
   */
  pruneStaleByProject(projectId: string, maxAgeDays: number, minImportance: number): number {
    const result = this.db.prepare(`
      UPDATE memories SET deleted_at = ?
      WHERE deleted_at IS NULL AND is_pinned = 0
        AND project_id = ?
        AND importance_score < ? AND last_accessed_at < datetime('now', ? || ' days')
    `).run(nowIso(), projectId, minImportance, `-${maxAgeDays}`);
    return result.changes;
  }

  /**
   * Get memories created around a given memory (its chronological neighborhood).
   * If sameSessionOnly is true:
   *   - If focus.claude_session_id is set, prefer exact claude_session_id match.
   *   - Fall back to ±2h created_at window when claude_session_id is null.
   * If sameSessionOnly is false, return time-window-based neighbors regardless.
   *
   * @param focus - The memory to find neighbors for
   * @param window - Number of memories to return on each side (default 3, so ±3 = up to 6 neighbors)
   * @param sameSessionOnly - If true, filter to same session; if false, return time-window-based neighbors
   * @returns Array of neighbor memories in chronological order, excluding deleted_at entries
   */
  getNeighbors(focus: any, window: number = 3, sameSessionOnly: boolean = true): any[] {
    if (!focus || !focus.id || !focus.project_id) return [];

    const focusTime = focus.created_at ?? new Date().toISOString();
    const limit = window * 2 + 1;

    // Issue #3: When sameSessionOnly=true and claude_session_id is available on the focus memory,
    // use exact session match. Fall back to ±2h time window when claude_session_id is null.
    if (sameSessionOnly && focus.claude_session_id) {
      const rows = this.db.prepare(`
        SELECT * FROM memories
        WHERE project_id = ? AND deleted_at IS NULL
          AND id != ?
          AND claude_session_id = ?
        ORDER BY created_at ASC
        LIMIT ?
      `).all(
        focus.project_id,
        focus.id,
        focus.claude_session_id,
        limit
      ) as any[];
      return rows;
    }

    // Time-window fallback: ±2h from focus (used when sameSessionOnly=false or claude_session_id is null).
    // Use strftime('%s', ...) for epoch-based comparison to avoid T-vs-space format mismatch
    // between stored ISO 8601 timestamps (YYYY-MM-DDTHH:MM:SSZ) and SQLite's datetime() output.
    const rows = this.db.prepare(`
      SELECT * FROM memories
      WHERE project_id = ? AND deleted_at IS NULL
        AND id != ?
        AND strftime('%s', created_at) >= strftime('%s', datetime(?, '-2 hours'))
        AND strftime('%s', created_at) <= strftime('%s', datetime(?, '+2 hours'))
      ORDER BY created_at ASC
      LIMIT ?
    `).all(
      focus.project_id,
      focus.id,
      focusTime,
      focusTime,
      limit
    ) as any[];

    return rows;
  }

  /**
   * Issue #3: List all memories for a given Claude session ID.
   * Optionally filter by source (e.g. 'auto-capture').
   */
  listBySession(claudeSessionId: string, opts?: { sourceFilter?: string }): any[] {
    const params: any[] = [claudeSessionId];
    let sourceClause = "";
    if (opts?.sourceFilter) {
      sourceClause = "AND source = ?";
      params.push(opts.sourceFilter);
    }
    return this.db.prepare(`
      SELECT * FROM memories
      WHERE claude_session_id = ? AND deleted_at IS NULL
        ${sourceClause}
      ORDER BY created_at ASC
    `).all(...params) as any[];
  }
}
