import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let _tmpCounter = 0;
function tmpDbPath(): string {
  return join(tmpdir(), `memento-test-isolated-${Date.now()}-${++_tmpCounter}.sqlite`);
}
import type Database from "better-sqlite3";

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
    expect(version).toBeGreaterThanOrEqual(9);
  });

  it("is idempotent — calling createDatabase twice on same path doesn't error", () => {
    db.close();
    const db2 = createDatabase(dbPath);
    const version = db2.pragma("user_version", { simple: true });
    expect(version).toBeGreaterThanOrEqual(9);
    db2.close();
    db = createDatabase(dbPath); // re-open for afterEach
  });

  it("creates memory_edges table at v9 with composite PK and FKs", () => {
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(9);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.map(t => t.name)).toContain("memory_edges");
    const cols = db.pragma("table_info(memory_edges)") as Array<{ name: string }>;
    expect(cols.map(c => c.name).sort()).toEqual(["created_at", "edge_type", "from_memory_id", "to_memory_id", "weight"]);
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

  it("INSERT trigger mirrors supersedes_memory_id into memory_edges", () => {
    const path = tmpDbPath();
    const idb = createDatabase(path);
    try {
      idb.prepare(`INSERT INTO memories(id, project_id, title, body) VALUES ('A', NULL, 'A', 'a')`).run();
      idb.prepare(`INSERT INTO memories(id, project_id, title, body, supersedes_memory_id) VALUES ('B', NULL, 'B', 'b', 'A')`).run();

      const edges = idb.prepare("SELECT * FROM memory_edges").all() as Array<{ from_memory_id: string; to_memory_id: string; edge_type: string }>;
      expect(edges).toHaveLength(1);
      expect(edges[0]).toMatchObject({ from_memory_id: "B", to_memory_id: "A", edge_type: "supersedes" });
    } finally {
      idb.close();
      rmSync(path, { force: true });
    }
  });

  it("UPDATE trigger mirrors a newly-set supersedes_memory_id", () => {
    const path = tmpDbPath();
    const idb = createDatabase(path);
    try {
      idb.prepare(`INSERT INTO memories(id, project_id, title, body) VALUES ('A', NULL, 'A', 'a')`).run();
      idb.prepare(`INSERT INTO memories(id, project_id, title, body) VALUES ('B', NULL, 'B', 'b')`).run();

      expect(idb.prepare("SELECT COUNT(*) AS n FROM memory_edges").get()).toEqual({ n: 0 });

      idb.prepare(`UPDATE memories SET supersedes_memory_id = 'A' WHERE id = 'B'`).run();

      const edges = idb.prepare("SELECT * FROM memory_edges").all() as Array<{ from_memory_id: string; to_memory_id: string; edge_type: string }>;
      expect(edges).toHaveLength(1);
      expect(edges[0]).toMatchObject({ from_memory_id: "B", to_memory_id: "A", edge_type: "supersedes" });
    } finally {
      idb.close();
      rmSync(path, { force: true });
    }
  });

  it("UPDATE trigger does not duplicate when same value re-set", () => {
    const path = tmpDbPath();
    const idb = createDatabase(path);
    try {
      idb.prepare(`INSERT INTO memories(id, project_id, title, body) VALUES ('A', NULL, 'A', 'a')`).run();
      idb.prepare(`INSERT INTO memories(id, project_id, title, body, supersedes_memory_id) VALUES ('B', NULL, 'B', 'b', 'A')`).run();

      // Edge already exists from INSERT trigger; update with same value should be a no-op.
      idb.prepare(`UPDATE memories SET supersedes_memory_id = 'A' WHERE id = 'B'`).run();

      const edges = idb.prepare("SELECT * FROM memory_edges").all();
      expect(edges).toHaveLength(1);
    } finally {
      idb.close();
      rmSync(path, { force: true });
    }
  });

  it("backfill skips dangling supersedes pointers without crashing", () => {
    const path = tmpDbPath();
    const idb = createDatabase(path);
    try {
      // memory_edges already exists from migration. Wipe it to simulate pre-v9 state.
      idb.exec("DROP TABLE memory_edges");
      idb.exec("DROP TRIGGER IF EXISTS memories_supersedes_ai");
      idb.exec("DROP TRIGGER IF EXISTS memories_supersedes_au");

      // Insert a dangling pointer with FKs off.
      idb.pragma("foreign_keys = OFF");
      idb.prepare(`INSERT INTO memories(id, project_id, title, body) VALUES ('A', NULL, 'A', 'a')`).run();
      idb.prepare(`INSERT INTO memories(id, project_id, title, body, supersedes_memory_id) VALUES ('B', NULL, 'B', 'b', 'GHOST')`).run();
      idb.pragma("foreign_keys = ON");

      // Recreate memory_edges (mirrors migration DDL).
      idb.exec(`
        CREATE TABLE memory_edges (
          from_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          to_memory_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          edge_type      TEXT NOT NULL CHECK(edge_type IN ('causes','fixes','supersedes','contradicts','derives_from','relates_to')),
          weight         REAL NOT NULL DEFAULT 1.0,
          created_at     TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (from_memory_id, to_memory_id, edge_type)
        );
      `);

      // The corrected backfill must NOT throw on the GHOST pointer.
      expect(() => {
        idb.exec(`
          INSERT OR IGNORE INTO memory_edges(from_memory_id, to_memory_id, edge_type, weight)
          SELECT m.id, m.supersedes_memory_id, 'supersedes', 1.0
          FROM memories m
          INNER JOIN memories target ON target.id = m.supersedes_memory_id
          WHERE m.supersedes_memory_id IS NOT NULL
        `);
      }).not.toThrow();

      // No row was created — the only candidate had a dangling target.
      expect(idb.prepare("SELECT COUNT(*) AS n FROM memory_edges").get()).toEqual({ n: 0 });
    } finally {
      idb.close();
      rmSync(path, { force: true });
    }
  });

  it("memories table has quality_score column after v8", () => {
    const cols = db.pragma("table_info(memories)") as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain("quality_score");
  });

  it("user_version is at least 9 (v8 + v9 both applied)", () => {
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(9);
  });
});
