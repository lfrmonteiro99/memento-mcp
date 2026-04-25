// src/server/web.ts — memento-mcp web inspector server
// Single-file implementation; all handlers here to stay under ~600 lines.
// No Express, no frameworks — pure node:http.

import * as http from "node:http";
import { URL } from "node:url";
import type Database from "better-sqlite3";
import type { Config } from "../lib/config.js";
import { MemoriesRepo } from "../db/memories.js";
import { scrubSecrets } from "../engine/text-utils.js";
import { redactPrivate } from "../engine/privacy.js";
import { generateReport } from "../analytics/reporter.js";
import indexHtml from "./web-ui.html";

export interface WebServerOptions {
  port: number;
  host: string;
  enableEdit: boolean;
  db: Database.Database;
  config: Config;
}

const VERSION = "2.0.1";
const LIMIT_CAP = 200;
const ID_PATTERN = /^[a-zA-Z0-9-]+$/;

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(data);
}

function err(res: http.ServerResponse, status: number, message: string): void {
  json(res, status, { error: message });
}

function parseIntParam(val: string | null, def: number, cap?: number): number {
  if (val === null) return def;
  const n = parseInt(val, 10);
  if (isNaN(n) || n < 0) return def;
  if (cap !== undefined) return Math.min(n, cap);
  return n;
}

function validateId(id: string | undefined): id is string {
  return typeof id === "string" && ID_PATTERN.test(id);
}

function applyPrivacy(body: string, showPrivate: boolean): string {
  if (showPrivate) return body;
  return redactPrivate(body);
}

function requiresEdit(res: http.ServerResponse, opts: WebServerOptions, req: http.IncomingMessage): boolean {
  if (!opts.enableEdit) {
    err(res, 403, "read-only mode; pass --enable-edit");
    return true;
  }
  if (req.headers["x-memento-ui"] !== "1") {
    err(res, 403, "missing X-Memento-UI header");
    return true;
  }
  const ct = req.headers["content-type"] ?? "";
  if (!ct.includes("application/json")) {
    err(res, 400, "Content-Type must be application/json");
    return true;
  }
  return false;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function route(req: http.IncomingMessage, res: http.ServerResponse, opts: WebServerOptions): Promise<void> {
  const rawUrl = req.url ?? "/";
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, `http://${req.headers.host ?? "localhost"}`);
  } catch {
    return err(res, 400, "invalid URL");
  }

  const path = parsed.pathname;
  const q = parsed.searchParams;
  const method = req.method?.toUpperCase() ?? "GET";

  // Serve the HTML UI for non-API routes
  if (!path.startsWith("/api/")) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    res.end(indexHtml);
    return;
  }

  const db = opts.db;
  const showPrivate = q.get("show_private") === "1" && opts.enableEdit;

  if (showPrivate) {
    process.stderr.write(`[memento-mcp ui] WARNING: private content revealed via API (show_private=1)\n`);
  }

  try {
    // GET /api/health
    if (path === "/api/health" && method === "GET") {
      return json(res, 200, { ok: true, version: VERSION, enableEdit: opts.enableEdit });
    }

    // GET /api/projects
    if (path === "/api/projects" && method === "GET") {
      const rows = db.prepare(`
        SELECT p.id, p.name, p.root_path, p.created_at,
               COUNT(m.id) as memory_count
        FROM projects p
        LEFT JOIN memories m ON m.project_id = p.id AND m.deleted_at IS NULL
        GROUP BY p.id
        ORDER BY p.name ASC
      `).all() as any[];
      return json(res, 200, rows);
    }

    // GET /api/memories
    if (path === "/api/memories" && method === "GET") {
      const limit = parseIntParam(q.get("limit"), 50, LIMIT_CAP);
      const offset = parseIntParam(q.get("offset"), 0);
      const project = q.get("project") ?? null;
      const type = q.get("type") ?? null;
      const pinned = q.get("pinned");
      const ftsQ = q.get("q") ?? null;

      const params: any[] = [];
      const where: string[] = ["m.deleted_at IS NULL"];

      if (project) {
        const proj = db.prepare("SELECT id FROM projects WHERE id = ? OR root_path = ?").get(project, project) as any;
        if (proj) { where.push("m.project_id = ?"); params.push(proj.id); }
      }
      if (type) { where.push("m.memory_type = ?"); params.push(type); }
      if (pinned === "1") { where.push("m.is_pinned = 1"); }
      if (pinned === "0") { where.push("m.is_pinned = 0"); }

      let rows: any[];
      let total: number;

      if (ftsQ) {
        // FTS search
        const repo = new MemoriesRepo(db);
        const opts2: any = {};
        if (type) opts2.memoryType = type;
        const searchLimit = Math.min(limit + offset + 100, LIMIT_CAP);
        const allMatches = repo.search(ftsQ, { ...opts2, limit: searchLimit });
        // Apply remaining filters post-FTS
        let filtered = allMatches;
        if (project) {
          const proj = db.prepare("SELECT id FROM projects WHERE id = ? OR root_path = ?").get(project, project) as any;
          if (proj) filtered = filtered.filter((r: any) => r.project_id === proj.id || r.scope === "global");
        }
        if (pinned === "1") filtered = filtered.filter((r: any) => r.is_pinned === 1);
        if (pinned === "0") filtered = filtered.filter((r: any) => r.is_pinned === 0);
        total = filtered.length;
        rows = filtered.slice(offset, offset + limit);
      } else {
        // Count query
        const countParams = [...params];
        const countWhere = [...where];
        const countSql = `SELECT COUNT(*) as cnt FROM memories m WHERE ${countWhere.join(" AND ")}`;
        const countRow = db.prepare(countSql).get(...countParams) as { cnt: number };
        total = countRow.cnt;

        const dataParams = [...params, limit, offset];
        rows = db.prepare(`
          SELECT m.*, p.name as project_name, p.root_path as project_root
          FROM memories m
          LEFT JOIN projects p ON p.id = m.project_id
          WHERE ${where.join(" AND ")}
          ORDER BY m.is_pinned DESC, m.importance_score DESC, m.updated_at DESC
          LIMIT ? OFFSET ?
        `).all(...dataParams) as any[];
      }

      const items = rows.map(r => ({
        ...r,
        body: applyPrivacy(r.body ?? "", showPrivate),
      }));

      return json(res, 200, { items, total, offset, limit });
    }

    // GET /api/memories/:id
    const memDetailMatch = path.match(/^\/api\/memories\/([^/]+)$/);
    if (memDetailMatch && method === "GET") {
      const id = memDetailMatch[1];
      if (!validateId(id)) return err(res, 400, "invalid id");

      const repo = new MemoriesRepo(db);
      const mem = repo.getById(id);
      if (!mem) return err(res, 404, "not found");

      // Linked decisions and pitfalls
      const decisions = db.prepare(`
        SELECT id, title, category, importance_score, created_at
        FROM decisions WHERE project_id = ? AND deleted_at IS NULL
        ORDER BY importance_score DESC LIMIT 5
      `).all(mem.project_id) as any[];

      const pitfalls = db.prepare(`
        SELECT id, title, occurrence_count, importance_score, resolved, last_seen_at
        FROM pitfalls WHERE project_id = ? AND deleted_at IS NULL AND resolved = 0
        ORDER BY occurrence_count DESC LIMIT 5
      `).all(mem.project_id) as any[];

      // Neighbors (#6 — getNeighbors)
      const neighbors = repo.getNeighbors(mem, 3, false);

      return json(res, 200, {
        ...mem,
        body: applyPrivacy(mem.body ?? "", showPrivate),
        linked_decisions: decisions,
        linked_pitfalls: pitfalls,
        neighbors: neighbors.map(n => ({
          id: n.id,
          title: n.title,
          memory_type: n.memory_type,
          created_at: n.created_at,
        })),
      });
    }

    // GET /api/decisions
    if (path === "/api/decisions" && method === "GET") {
      const limit = parseIntParam(q.get("limit"), 50, LIMIT_CAP);
      const offset = parseIntParam(q.get("offset"), 0);
      const project = q.get("project") ?? null;
      const category = q.get("category") ?? null;

      const where: string[] = ["d.deleted_at IS NULL"];
      const params: any[] = [];

      if (project) {
        const proj = db.prepare("SELECT id FROM projects WHERE id = ? OR root_path = ?").get(project, project) as any;
        if (proj) { where.push("d.project_id = ?"); params.push(proj.id); }
      }
      if (category) { where.push("d.category = ?"); params.push(category); }

      const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM decisions d WHERE ${where.join(" AND ")}`).get(...params) as { cnt: number };
      const total = countRow.cnt;

      const rows = db.prepare(`
        SELECT d.*, p.name as project_name
        FROM decisions d
        LEFT JOIN projects p ON p.id = d.project_id
        WHERE ${where.join(" AND ")}
        ORDER BY d.importance_score DESC, d.created_at DESC
        LIMIT ? OFFSET ?
      `).all(...params, limit, offset) as any[];

      const items = rows.map(r => ({
        ...r,
        body: applyPrivacy(r.body ?? "", showPrivate),
      }));

      return json(res, 200, { items, total, offset, limit });
    }

    // GET /api/pitfalls
    if (path === "/api/pitfalls" && method === "GET") {
      const limit = parseIntParam(q.get("limit"), 50, LIMIT_CAP);
      const offset = parseIntParam(q.get("offset"), 0);
      const project = q.get("project") ?? null;
      const includeResolved = q.get("resolved") === "1";

      const where: string[] = ["p.deleted_at IS NULL"];
      const params: any[] = [];

      if (!includeResolved) { where.push("p.resolved = 0"); }
      if (project) {
        const proj = db.prepare("SELECT id FROM projects WHERE id = ? OR root_path = ?").get(project, project) as any;
        if (proj) { where.push("p.project_id = ?"); params.push(proj.id); }
      }

      const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM pitfalls p WHERE ${where.join(" AND ")}`).get(...params) as { cnt: number };
      const total = countRow.cnt;

      const rows = db.prepare(`
        SELECT p.*, pr.name as project_name
        FROM pitfalls p
        LEFT JOIN projects pr ON pr.id = p.project_id
        WHERE ${where.join(" AND ")}
        ORDER BY p.occurrence_count DESC, p.importance_score DESC
        LIMIT ? OFFSET ?
      `).all(...params, limit, offset) as any[];

      const items = rows.map(r => ({
        ...r,
        body: applyPrivacy(r.body ?? "", showPrivate),
      }));

      return json(res, 200, { items, total, offset, limit });
    }

    // GET /api/sessions
    if (path === "/api/sessions" && method === "GET") {
      const limit = parseIntParam(q.get("limit"), 20, LIMIT_CAP);
      const offset = parseIntParam(q.get("offset"), 0);

      const countRow = db.prepare("SELECT COUNT(*) as cnt FROM sessions").get() as { cnt: number };
      const total = countRow.cnt;

      const rows = db.prepare(`
        SELECT s.*,
          (SELECT id FROM memories WHERE claude_session_id = s.claude_session_id
           AND memory_type = 'session_summary' AND deleted_at IS NULL LIMIT 1) as summary_memory_id
        FROM sessions s
        ORDER BY s.last_active DESC
        LIMIT ? OFFSET ?
      `).all(limit, offset) as any[];

      return json(res, 200, { items: rows, total, offset, limit });
    }

    // GET /api/analytics/summary
    if (path === "/api/analytics/summary" && method === "GET") {
      const days = parseIntParam(q.get("days"), 7);
      const period = days <= 1 ? "last_24h" : days <= 7 ? "last_7d" : "last_30d";
      const report = generateReport(db, null, period);
      return json(res, 200, { ...report, days });
    }

    // GET /api/analytics/events
    if (path === "/api/analytics/events" && method === "GET") {
      const limit = parseIntParam(q.get("limit"), 50, LIMIT_CAP);
      const offset = parseIntParam(q.get("offset"), 0);
      const sessionId = q.get("session") ?? null;
      const eventType = q.get("type") ?? null;

      const where: string[] = [];
      const params: any[] = [];
      if (sessionId) { where.push("session_id = ?"); params.push(sessionId); }
      if (eventType) { where.push("event_type = ?"); params.push(eventType); }

      const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM analytics_events ${whereClause}`).get(...params) as { cnt: number };
      const total = countRow.cnt;

      const rows = db.prepare(`
        SELECT * FROM analytics_events
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `).all(...params, limit, offset) as any[];

      const items = rows.map(r => {
        let eventData = r.event_data;
        if (typeof eventData === "string") {
          try {
            const parsed = JSON.parse(eventData);
            if (typeof parsed === "object" && parsed !== null) {
              // Scrub secrets from tool_response fields
              if (typeof parsed.tool_response === "string") {
                parsed.tool_response = scrubSecrets(parsed.tool_response);
              }
              eventData = JSON.stringify(parsed);
            }
          } catch {
            // Keep as-is
          }
        }
        return { ...r, event_data: eventData };
      });

      return json(res, 200, { items, total, offset, limit });
    }

    // POST /api/memories/:id/pin
    const pinMatch = path.match(/^\/api\/memories\/([^/]+)\/pin$/);
    if (pinMatch && method === "POST") {
      if (requiresEdit(res, opts, req)) return;
      const id = pinMatch[1];
      if (!validateId(id)) return err(res, 400, "invalid id");

      const bodyStr = await readBody(req);
      let bodyData: any = {};
      try { bodyData = JSON.parse(bodyStr); } catch { /* default */ }

      const repo = new MemoriesRepo(db);
      const mem = repo.getById(id);
      if (!mem) return err(res, 404, "not found");

      const newPinned = bodyData.pinned !== undefined ? Boolean(bodyData.pinned) : !mem.is_pinned;
      repo.setPinned(id, newPinned);
      return json(res, 200, { id, pinned: newPinned });
    }

    // DELETE /api/memories/:id
    const deleteMatch = path.match(/^\/api\/memories\/([^/]+)$/);
    if (deleteMatch && method === "DELETE") {
      if (requiresEdit(res, opts, req)) return;
      const id = deleteMatch[1];
      if (!validateId(id)) return err(res, 400, "invalid id");

      const repo = new MemoriesRepo(db);
      const deleted = repo.delete(id);
      if (!deleted) return err(res, 404, "not found");
      return json(res, 200, { id, deleted: true });
    }

    return err(res, 404, "not found");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[memento-mcp ui] ERROR: ${msg}\n`);
    return err(res, 500, "internal server error");
  }
}

export function startWebServer(opts: WebServerOptions): http.Server {
  if (opts.host !== "127.0.0.1" && opts.host !== "localhost") {
    process.stderr.write(
      `WARNING: binding to ${opts.host} exposes memory contents on the network\n`
    );
  }

  const server = http.createServer((req, res) => {
    route(req, res, opts).catch(e => {
      process.stderr.write(`[memento-mcp ui] Unhandled: ${e}\n`);
      if (!res.headersSent) {
        err(res, 500, "internal server error");
      }
    });
  });

  server.listen(opts.port, opts.host);
  return server;
}
