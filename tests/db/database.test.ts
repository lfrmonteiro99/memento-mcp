import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
    expect(version).toBe(1);
  });

  it("is idempotent — calling createDatabase twice on same path doesn't error", () => {
    db.close();
    const db2 = createDatabase(dbPath);
    const version = db2.pragma("user_version", { simple: true });
    expect(version).toBe(1);
    db2.close();
    db = createDatabase(dbPath); // re-open for afterEach
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
});
