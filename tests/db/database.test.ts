import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let _tmpCounter = 0;
function tmpDbPath(): string {
  return join(tmpdir(), `memento-test-isolated-${Date.now()}-${++_tmpCounter}.sqlite`);
}
import Database from "better-sqlite3";

describe("database", () => {
  let db: Database.Database;
  const dbPath = join(tmpdir(), `memento-test-${Date.now()}.sqlite`);

  beforeEach(() => { db = createDatabase(dbPath); });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("creates all tables", () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map((r: any) => r.name);
    expect(tables).toContain("projects");
    expect(tables).toContain("memories");
    expect(tables).toContain("decisions");
    expect(tables).toContain("pitfalls");
    expect(tables).toContain("sessions");
  });

  it("creates FTS5 virtual tables", () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'"
    ).all().map((r: any) => r.name);
    expect(tables).toContain("memory_fts");
    expect(tables).toContain("decisions_fts");
  });

  it("sets WAL journal mode", () => {
    const mode = db.pragma("journal_mode", { simple: true });
    expect(mode).toBe("wal");
  });

  it("tracks schema version via user_version", () => {
    const version = db.pragma("user_version", { simple: true });
    expect(version).toBeGreaterThanOrEqual(11);
  });

  it("is idempotent — calling createDatabase twice on same path doesn't error", () => {
    db.close();
    const db2 = createDatabase(dbPath);
    const version = db2.pragma("user_version", { simple: true });
    expect(version).toBeGreaterThanOrEqual(11);
    db2.close();
    db = createDatabase(dbPath); // re-open for afterEach
  });

  it("creates memory_edges table at v8 with master's column shape", () => {
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(8);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.map(t => t.name)).toContain("memory_edges");
    const cols = db.pragma("table_info(memory_edges)") as Array<{ name: string }>;
    expect(cols.map(c => c.name).sort()).toEqual(["created_at", "edge_type", "from_id", "to_id", "weight"]);
  });

  it("creates FTS sync triggers", () => {
    const triggers = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger'"
    ).all().map((r: any) => r.name);
    expect(triggers).toContain("memories_ai");
    expect(triggers).toContain("memories_au");
    expect(triggers).toContain("memories_ad");
    expect(triggers).toContain("decisions_ai");
    expect(triggers).toContain("decisions_au");
    expect(triggers).toContain("decisions_ad");
  });

  it("v8 supersedes backfill: memories with supersedes_memory_id get a 'supersedes' edge", () => {
    const path = tmpDbPath();
    // Pre-create a v7-state DB so the v8 migration has data to backfill.
    const raw = new Database(path);
    raw.pragma("journal_mode = WAL");
    raw.pragma("foreign_keys = ON");
    raw.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, root_path TEXT UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id),
        memory_type TEXT NOT NULL DEFAULT 'fact', scope TEXT NOT NULL DEFAULT 'project',
        title TEXT NOT NULL, body TEXT, tags TEXT,
        importance_score REAL DEFAULT 0.5, confidence_score REAL DEFAULT 0.5,
        access_count INTEGER NOT NULL DEFAULT 0, last_accessed_at TEXT,
        is_pinned INTEGER NOT NULL DEFAULT 0, supersedes_memory_id TEXT,
        source TEXT DEFAULT 'user', adaptive_score REAL DEFAULT 0.5,
        claude_session_id TEXT, has_private INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        deleted_at TEXT);
    `);
    raw.prepare(`INSERT INTO memories(id, title, body, supersedes_memory_id) VALUES ('A', 'A', 'a', NULL)`).run();
    raw.prepare(`INSERT INTO memories(id, title, body, supersedes_memory_id) VALUES ('B', 'B', 'b', 'A')`).run();
    raw.pragma("user_version = 7");
    raw.close();

    const idb = createDatabase(path);
    try {
      const edges = idb.prepare("SELECT * FROM memory_edges").all() as Array<{ from_id: string; to_id: string; edge_type: string }>;
      expect(edges).toHaveLength(1);
      expect(edges[0]).toMatchObject({ from_id: "B", to_id: "A", edge_type: "supersedes" });
    } finally {
      idb.close();
      rmSync(path, { force: true });
    }
  });

  it("v9 quality_score column on memories", () => {
    const cols = db.pragma("table_info(memories)") as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain("quality_score");
  });

  it("creates memory_anchors table at v10", () => {
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(10);
    const cols = db.pragma("table_info(memory_anchors)") as Array<{ name: string }>;
    expect(cols.map(c => c.name).sort()).toEqual([
      "anchored_at", "commit_sha", "file_path", "id", "line_end", "line_start",
      "memory_id", "stale_reason", "stale_since", "status",
    ]);
  });

  it("creates consolidation_runs table at v11 with leader-election columns", () => {
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(11);
    const cols = db.pragma("table_info(consolidation_runs)") as Array<{ name: string }>;
    expect(cols.map(c => c.name).sort()).toEqual([
      "clusters_seen", "finished_at", "hostname", "id",
      "merged_count", "pid", "project_id", "pruned_count",
      "started_at", "status",
    ]);
  });

  it("memory_anchors enforces status check constraint", () => {
    expect(() => {
      // Need a real memory id (FK)
      const projectId = db.prepare("SELECT id FROM projects LIMIT 1").get() as { id: string } | undefined;
      const pid = projectId?.id ?? (() => {
        db.prepare("INSERT INTO projects (id, name, root_path) VALUES ('p-anc', 'p', '/tmp/anc')").run();
        return "p-anc";
      })();
      db.prepare("INSERT INTO memories (id, project_id, title, body) VALUES ('m-anc', ?, 't', 'b')").run(pid);
      db.prepare("INSERT INTO memory_anchors (memory_id, file_path, status) VALUES (?, ?, ?)")
        .run("m-anc", "x.ts", "bogus");
    }).toThrow();
  });
});
