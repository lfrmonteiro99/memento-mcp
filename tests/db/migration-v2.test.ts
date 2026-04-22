// tests/db/migration-v2.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("database migration v2", () => {
  let db: ReturnType<typeof createDatabase>;
  const dbPath = join(tmpdir(), `memento-migration-v2-${process.pid}-${randomUUID()}.sqlite`);

  afterEach(() => {
    if (db) db.close();
    rmSync(dbPath, { force: true });
  });

  it("creates analytics_events table", () => {
    db = createDatabase(dbPath);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = 'analytics_events'"
    ).all();
    expect(tables.length).toBe(1);
  });

  it("creates compression_log table", () => {
    db = createDatabase(dbPath);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = 'compression_log'"
    ).all();
    expect(tables.length).toBe(1);
  });

  it("adds source column to memories with default 'user'", () => {
    db = createDatabase(dbPath);
    const columns = db.pragma("table_info(memories)") as Array<{ name: string; dflt_value: string | null }>;
    const sourceCol = columns.find(c => c.name === "source");
    expect(sourceCol).toBeDefined();
    expect(sourceCol!.dflt_value).toContain("user");
  });

  it("adds adaptive_score column to memories with default 0.5", () => {
    db = createDatabase(dbPath);
    const columns = db.pragma("table_info(memories)") as Array<{ name: string; dflt_value: string | null }>;
    const col = columns.find(c => c.name === "adaptive_score");
    expect(col).toBeDefined();
    expect(col!.dflt_value).toContain("0.5");
  });

  it("sets schema version to 3", () => {
    db = createDatabase(dbPath);
    const version = db.pragma("user_version", { simple: true });
    expect(version).toBe(3);
  });

  it("is idempotent - running createDatabase twice does not error", () => {
    db = createDatabase(dbPath);
    db.close();
    db = createDatabase(dbPath);
    const version = db.pragma("user_version", { simple: true });
    expect(version).toBe(3);
  });

  it("migrates existing v1 database without data loss", () => {
    // Create a v1-only database by manually using only v1 SQL
    const BetterSqlite3 = require("better-sqlite3");
    const { mkdirSync } = require("node:fs");
    const { dirname } = require("node:path");
    mkdirSync(dirname(dbPath), { recursive: true });
    const rawDb = new BetterSqlite3(dbPath);
    rawDb.pragma("journal_mode = WAL");
    rawDb.pragma("foreign_keys = ON");

    // Create v1 schema manually (simplified from database.ts v1 migration)
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id),
        memory_type TEXT NOT NULL DEFAULT 'fact', scope TEXT NOT NULL DEFAULT 'project',
        title TEXT NOT NULL, body TEXT, tags TEXT,
        importance_score REAL DEFAULT 0.5, confidence_score REAL DEFAULT 0.5,
        access_count INTEGER NOT NULL DEFAULT 0, last_accessed_at TEXT,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        supersedes_memory_id TEXT REFERENCES memories(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        deleted_at TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(title, body, content='memories', content_rowid='rowid');
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL, body TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        importance_score REAL NOT NULL DEFAULT 0.5,
        supersedes_id TEXT REFERENCES decisions(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(title, body, content='decisions', content_rowid='rowid');
      CREATE TABLE IF NOT EXISTS pitfalls (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL, body TEXT NOT NULL,
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        importance_score REAL NOT NULL DEFAULT 0.5,
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, budget INTEGER NOT NULL DEFAULT 8000,
        spent INTEGER NOT NULL DEFAULT 0, floor INTEGER NOT NULL DEFAULT 500,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_active TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    rawDb.pragma("user_version = 1");

    // Insert a v1 memory
    rawDb.prepare(`
      INSERT INTO projects (id, name, root_path) VALUES ('p1', 'test', '/test')
    `).run();
    rawDb.prepare(`
      INSERT INTO memories (id, project_id, title, body, memory_type, scope, created_at, updated_at)
      VALUES ('m1', 'p1', 'v1 memory', 'v1 body', 'fact', 'global', datetime('now'), datetime('now'))
    `).run();
    rawDb.close();

    // Now open with createDatabase (should migrate)
    db = createDatabase(dbPath);

    // v1 data should still be there
    const mem = db.prepare("SELECT * FROM memories WHERE id = 'm1'").get() as any;
    expect(mem).toBeDefined();
    expect(mem.title).toBe("v1 memory");
    expect(mem.source).toBe("user"); // default for migrated rows

    // v2 tables should exist
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all().map((r: any) => r.name);
    expect(tables).toContain("analytics_events");
    expect(tables).toContain("compression_log");
  });

  it("creates analytics indexes", () => {
    db = createDatabase(dbPath);
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_analytics%'"
    ).all().map((r: any) => r.name);
    expect(indexes).toContain("idx_analytics_session");
    expect(indexes).toContain("idx_analytics_memory");
    expect(indexes).toContain("idx_analytics_type");
    expect(indexes).toContain("idx_analytics_created");
  });

  it("creates compression indexes", () => {
    db = createDatabase(dbPath);
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_compression_memory'"
    ).all();
    expect(indexes.length).toBe(1);
  });

  it("creates memories adaptive score index", () => {
    db = createDatabase(dbPath);
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_memories_project_active_score'"
    ).all();
    expect(indexes.length).toBe(1);
  });

  it("analytics_events table can insert and query", () => {
    db = createDatabase(dbPath);
    db.prepare(`
      INSERT INTO analytics_events (session_id, event_type, event_data, created_at)
      VALUES ('s1', 'injection', '{}', datetime('now'))
    `).run();
    const row = db.prepare("SELECT * FROM analytics_events WHERE session_id = 's1'").get() as any;
    expect(row).toBeDefined();
    expect(row.event_type).toBe("injection");
  });

  it("compression_log table can insert and query (R6: TEXT FK to memories.id)", () => {
    db = createDatabase(dbPath);
    // Need a memory first for FK
    db.prepare("INSERT INTO projects (id, name, root_path) VALUES ('p1', 'test', '/test')").run();
    db.prepare(`
      INSERT INTO memories (id, project_id, title, body, memory_type, scope, created_at, updated_at)
      VALUES ('m1', 'p1', 'compressed', 'body', 'fact', 'global', datetime('now'), datetime('now'))
    `).run();
    // R6: compression_log.compressed_memory_id is TEXT and stores memories.id (UUID),
    // not the rowid. This avoids rowid-renumbering risk under VACUUM.
    db.prepare(`
      INSERT INTO compression_log (compressed_memory_id, source_memory_ids, tokens_before, tokens_after, compression_ratio, created_at)
      VALUES ('m1', '["m2","m3"]', 100, 40, 0.4, datetime('now'))
    `).run();
    const row = db.prepare("SELECT * FROM compression_log").get() as any;
    expect(row).toBeDefined();
    expect(row.compressed_memory_id).toBe("m1"); // TEXT, not INTEGER
    expect(row.compression_ratio).toBeCloseTo(0.4);
  });

  it("compression_log FK type is TEXT (R6)", () => {
    db = createDatabase(dbPath);
    const cols = db.pragma("table_info(compression_log)") as Array<{ name: string; type: string }>;
    const fk = cols.find(c => c.name === "compressed_memory_id");
    expect(fk).toBeDefined();
    expect(fk!.type.toUpperCase()).toBe("TEXT");
  });

  it("K5: migrates v1 CSV-format tags to JSON on upgrade", () => {
    // Create a fresh v1-only DB (user_version=1), seed a CSV-tagged memory, then migrate.
    const BetterSqlite3 = require("better-sqlite3");
    const raw = new BetterSqlite3(dbPath);
    raw.exec(`
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, project_id TEXT, memory_type TEXT NOT NULL DEFAULT 'fact',
        scope TEXT NOT NULL DEFAULT 'project', title TEXT NOT NULL, body TEXT, tags TEXT,
        importance_score REAL DEFAULT 0.5, confidence_score REAL DEFAULT 0.5,
        access_count INTEGER NOT NULL DEFAULT 0, last_accessed_at TEXT,
        is_pinned INTEGER NOT NULL DEFAULT 0, supersedes_memory_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        deleted_at TEXT
      );
    `);
    raw.prepare("INSERT INTO projects (id, name, root_path) VALUES ('p1','t','/t')").run();
    raw.prepare("INSERT INTO memories (id, project_id, title, body, tags) VALUES ('csv1','p1','csv test','body','foo,bar,baz')").run();
    raw.pragma("user_version = 1");
    raw.close();

    // Trigger migration
    db = createDatabase(dbPath);
    const row = db.prepare("SELECT tags FROM memories WHERE id = 'csv1'").get() as any;
    expect(row.tags).toBe('["foo","bar","baz"]'); // now JSON
    // parseTags should parse both formats
    const parsed = JSON.parse(row.tags);
    expect(parsed).toEqual(["foo", "bar", "baz"]);
  });
});
