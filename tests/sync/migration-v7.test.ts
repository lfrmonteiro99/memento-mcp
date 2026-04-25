// tests/sync/migration-v7.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase } from "../../src/db/database.js";

describe("migration v7: sync_state + sync_file_hashes tables", () => {
  let db: ReturnType<typeof createDatabase>;
  const dbPath = join(tmpdir(), `memento-mig-v7-${Date.now()}-${Math.random()}.sqlite`);

  beforeEach(() => { db = createDatabase(dbPath); });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("sets user_version to 7", () => {
    expect(db.pragma("user_version", { simple: true })).toBe(7);
  });

  it("creates sync_state table with correct columns", () => {
    const cols = db.prepare("PRAGMA table_info(sync_state)").all() as any[];
    const names = cols.map(c => c.name);
    expect(names).toContain("project_id");
    expect(names).toContain("last_pull_at");
    expect(names).toContain("last_push_at");
    expect(names).not.toContain("file_hashes"); // intentionally removed (triage update)
  });

  it("creates sync_file_hashes table with PK on (project_id, memory_id)", () => {
    const cols = db.prepare("PRAGMA table_info(sync_file_hashes)").all() as any[];
    const names = cols.map(c => c.name);
    expect(names).toContain("project_id");
    expect(names).toContain("memory_id");
    expect(names).toContain("hash");
    expect(names).toContain("checked_at");

    // Composite PK
    const pkCols = cols.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
    expect(pkCols).toEqual(["project_id", "memory_id"]);
  });

  it("creates idx_sync_file_hashes_project index", () => {
    const indexes = db.prepare("PRAGMA index_list(sync_file_hashes)").all() as any[];
    const names = indexes.map(i => i.name);
    expect(names).toContain("idx_sync_file_hashes_project");
  });

  it("is idempotent: re-opening doesn't error", () => {
    db.close();
    db = createDatabase(dbPath);
    expect(db.pragma("user_version", { simple: true })).toBe(7);
  });
});
