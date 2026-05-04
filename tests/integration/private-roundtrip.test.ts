// tests/integration/private-roundtrip.test.ts
// End-to-end test: store → search → get for <private> tag feature (issue #4).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { handleMemoryGet } from "../../src/tools/memory-get.js";
import { handleMemoryStore } from "../../src/tools/memory-store.js";
import { handleMemoryUpdate } from "../../src/tools/memory-update.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, getDefaultConfigPath } from "../../src/lib/config.js";
import BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const config = loadConfig(getDefaultConfigPath());

describe("private roundtrip: store → search → get", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: MemoriesRepo;
  const dbPath = join(tmpdir(), `memento-private-rt-${Date.now()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    repo = new MemoriesRepo(db);
  });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("stores body with private tags verbatim in DB", async () => {
    await handleMemoryStore(repo, { title: "secret mem", content: "foo <private>bar</private> baz" });
    const results = repo.list({});
    expect(results.length).toBe(1);
    expect(results[0].body).toBe("foo <private>bar</private> baz"); // stored verbatim
  });

  it("search for term inside private region returns 0 hits", async () => {
    await handleMemoryStore(repo, { title: "private mem", content: "foo <private>bar</private> baz" });
    const results = repo.search("bar");
    expect(results.length).toBe(0);
  });

  it("search for term outside private region returns 1 hit", async () => {
    await handleMemoryStore(repo, { title: "private mem", content: "foo <private>bar</private> baz" });
    const results = repo.search("foo");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe("private mem");
  });

  it("memory_get(id) default: body shows [REDACTED], not private content", async () => {
    await handleMemoryStore(repo, { title: "private mem", content: "foo <private>bar</private> baz" });
    const mem = repo.list({})[0];
    const result = await handleMemoryGet(repo, db, config, { memory_id: mem.id });
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("bar");
    expect(result).toContain("foo");
    expect(result).toContain("baz");
  });

  it("memory_get(id, reveal_private=true): returns full literal text", async () => {
    await handleMemoryStore(repo, { title: "private mem", content: "foo <private>bar</private> baz" });
    const mem = repo.list({})[0];
    const result = await handleMemoryGet(repo, db, config, { memory_id: mem.id, reveal_private: true });
    expect(result).toContain("foo <private>bar</private> baz");
    expect(result).toContain("Showing private content");
  });

  it("memory_get(id, reveal_private=true): emits private_revealed analytics event", async () => {
    await handleMemoryStore(repo, { title: "private mem", content: "foo <private>bar</private> baz" });
    const mem = repo.list({})[0];
    await handleMemoryGet(repo, db, config, { memory_id: mem.id, reveal_private: true });
    const event = db.prepare("SELECT * FROM analytics_events WHERE event_type = 'private_revealed'").get() as any;
    expect(event).toBeDefined();
    const data = JSON.parse(event.event_data);
    expect(data.memory_id).toBe(mem.id);
    expect(data.regions).toBe(1);
  });

  it("unbalanced private tags: memory_store returns error and does not persist", async () => {
    const result = await handleMemoryStore(repo, { title: "bad", content: "foo <private>unclosed" });
    expect(result).toContain("unbalanced <private> tags");
    expect(result).toContain("1 opening");
    expect(result).toContain("0 closing");
    const all = repo.list({});
    expect(all.length).toBe(0); // not persisted
  });

  it("unbalanced private tags in update: returns error and does not update", async () => {
    const id = repo.store({ title: "orig", body: "original body", memoryType: "fact", scope: "global" });
    const result = await handleMemoryUpdate(repo, { memory_id: id, content: "bad <private>unclosed" });
    expect(result).toContain("unbalanced <private> tags");
    // body should still be original
    const mem = repo.getById(id);
    expect(mem.body).toBe("original body");
  });
});

describe("migration v5→v6: existing rows backfill", () => {
  const dbPath = join(tmpdir(), `memento-v5-to-v6-${randomUUID()}.sqlite`);
  let db: ReturnType<typeof createDatabase>;

  afterEach(() => {
    if (db) db.close();
    rmSync(dbPath, { force: true });
  });

  it("backfills has_private=1 for existing rows containing private tags after migration", () => {
    // Create a v5-style DB manually (without has_private column).
    mkdirSync(dirname(dbPath), { recursive: true });
    const rawDb = new BetterSqlite3(dbPath);
    rawDb.pragma("journal_mode = WAL");
    rawDb.pragma("foreign_keys = ON");

    // Simplified v5 schema: memories without has_private.
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, project_id TEXT, memory_type TEXT NOT NULL DEFAULT 'fact',
        scope TEXT NOT NULL DEFAULT 'project', title TEXT NOT NULL, body TEXT,
        tags TEXT, importance_score REAL DEFAULT 0.5, confidence_score REAL DEFAULT 0.5,
        access_count INTEGER NOT NULL DEFAULT 0, last_accessed_at TEXT,
        is_pinned INTEGER NOT NULL DEFAULT 0, supersedes_memory_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        deleted_at TEXT, source TEXT DEFAULT 'user', adaptive_score REAL DEFAULT 0.5,
        claude_session_id TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(title, body, content='memories', content_rowid='rowid');
      CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'general', importance_score REAL NOT NULL DEFAULT 0.5, supersedes_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT);
      CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(title, body, content='decisions', content_rowid='rowid');
      CREATE TABLE IF NOT EXISTS pitfalls (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, occurrence_count INTEGER NOT NULL DEFAULT 1, importance_score REAL NOT NULL DEFAULT 0.5, last_seen_at TEXT NOT NULL DEFAULT (datetime('now')), resolved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, budget INTEGER NOT NULL DEFAULT 8000, spent INTEGER NOT NULL DEFAULT 0, floor INTEGER NOT NULL DEFAULT 500, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_active TEXT NOT NULL DEFAULT (datetime('now')), claude_session_id TEXT);
      CREATE TABLE IF NOT EXISTS analytics_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, project_id TEXT, memory_id TEXT, event_type TEXT NOT NULL, event_data TEXT, tokens_cost INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS compression_log (id INTEGER PRIMARY KEY AUTOINCREMENT, compressed_memory_id TEXT NOT NULL, source_memory_ids TEXT NOT NULL, tokens_before INTEGER NOT NULL, tokens_after INTEGER NOT NULL, compression_ratio REAL NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    `);
    rawDb.prepare("INSERT INTO projects (id, name, root_path) VALUES ('p1', 'test', '/test')").run();
    rawDb.prepare("INSERT INTO memories (id, project_id, title, body, memory_type, scope, created_at, updated_at) VALUES ('m1', 'p1', 'private mem', 'foo <private>bar</private> baz', 'fact', 'global', datetime('now'), datetime('now'))").run();
    rawDb.prepare("INSERT INTO memories (id, project_id, title, body, memory_type, scope, created_at, updated_at) VALUES ('m2', 'p1', 'public mem', 'just public text', 'fact', 'global', datetime('now'), datetime('now'))").run();
    rawDb.pragma("user_version = 5");
    rawDb.close();

    // Now open with createDatabase — should apply all v6+ migrations.
    db = createDatabase(dbPath);
    const version = db.pragma("user_version", { simple: true });
    expect(version).toBeGreaterThanOrEqual(11);

    // m1 should have has_private=1 (backfilled).
    const m1 = db.prepare("SELECT has_private FROM memories WHERE id = 'm1'").get() as any;
    expect(m1.has_private).toBe(1);

    // m2 should have has_private=0.
    const m2 = db.prepare("SELECT has_private FROM memories WHERE id = 'm2'").get() as any;
    expect(m2.has_private).toBe(0);

    // Data integrity: original bodies preserved.
    const m1full = db.prepare("SELECT body FROM memories WHERE id = 'm1'").get() as any;
    expect(m1full.body).toBe("foo <private>bar</private> baz");
  });

  it("migration v5→v6 does not lose existing data", () => {
    mkdirSync(dirname(dbPath + "2"), { recursive: true });
    // Use a separate path so it doesn't conflict.
    const path2 = dbPath + "2.sqlite";
    const rawDb2 = new BetterSqlite3(path2);
    rawDb2.pragma("journal_mode = WAL");
    rawDb2.exec(`
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, project_id TEXT, memory_type TEXT NOT NULL DEFAULT 'fact',
        scope TEXT NOT NULL DEFAULT 'project', title TEXT NOT NULL, body TEXT,
        tags TEXT, importance_score REAL DEFAULT 0.5, confidence_score REAL DEFAULT 0.5,
        access_count INTEGER NOT NULL DEFAULT 0, last_accessed_at TEXT,
        is_pinned INTEGER NOT NULL DEFAULT 0, supersedes_memory_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        deleted_at TEXT, source TEXT DEFAULT 'user', adaptive_score REAL DEFAULT 0.5, claude_session_id TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(title, body, content='memories', content_rowid='rowid');
      CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'general', importance_score REAL NOT NULL DEFAULT 0.5, supersedes_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT);
      CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(title, body, content='decisions', content_rowid='rowid');
      CREATE TABLE IF NOT EXISTS pitfalls (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, occurrence_count INTEGER NOT NULL DEFAULT 1, importance_score REAL NOT NULL DEFAULT 0.5, last_seen_at TEXT NOT NULL DEFAULT (datetime('now')), resolved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, budget INTEGER NOT NULL DEFAULT 8000, spent INTEGER NOT NULL DEFAULT 0, floor INTEGER NOT NULL DEFAULT 500, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_active TEXT NOT NULL DEFAULT (datetime('now')), claude_session_id TEXT);
      CREATE TABLE IF NOT EXISTS analytics_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, project_id TEXT, memory_id TEXT, event_type TEXT NOT NULL, event_data TEXT, tokens_cost INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    `);
    rawDb2.prepare("INSERT INTO projects (id, name, root_path) VALUES ('p1', 'test2', '/test2')").run();
    rawDb2.prepare("INSERT INTO memories (id, project_id, title, body, memory_type, scope, created_at, updated_at) VALUES ('mx', 'p1', 'preserved', 'preserved body', 'fact', 'global', datetime('now'), datetime('now'))").run();
    rawDb2.pragma("user_version = 5");
    rawDb2.close();

    const db2 = createDatabase(path2);
    try {
      const mx = db2.prepare("SELECT * FROM memories WHERE id = 'mx'").get() as any;
      expect(mx).toBeDefined();
      expect(mx.title).toBe("preserved");
      expect(mx.body).toBe("preserved body");
    } finally {
      db2.close();
      rmSync(path2, { force: true });
    }
  });
});
