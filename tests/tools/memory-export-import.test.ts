import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { handleMemoryExport, handleMemoryImport } from "../../src/tools/memory-transfer.js";

describe("memory_export / memory_import", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  const dbPath = join(tmpdir(), `memento-transfer-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("export: produces JSON with schema_version and memories array", async () => {
    memRepo.store({ title: "m1", body: "b1", memoryType: "fact", scope: "global" });
    memRepo.store({ title: "m2", body: "b2", memoryType: "decision", scope: "global" });

    const out = await handleMemoryExport(db, {});
    const parsed = JSON.parse(out);
    expect(parsed.schema_version).toBeGreaterThanOrEqual(2);
    expect(parsed.exported_at).toBeDefined();
    expect(parsed.memories.length).toBe(2);
    expect(parsed.projects).toBeDefined();
    expect(parsed.decisions).toBeDefined();
    expect(parsed.pitfalls).toBeDefined();
  });

  it("export: filters by project_path when provided", async () => {
    memRepo.store({ title: "scoped", body: "b", memoryType: "fact", scope: "project", projectPath: "/p-a" });
    memRepo.store({ title: "global", body: "b", memoryType: "fact", scope: "global" });
    memRepo.store({ title: "other", body: "b", memoryType: "fact", scope: "project", projectPath: "/p-b" });

    const out = await handleMemoryExport(db, { project_path: "/p-a" });
    const parsed = JSON.parse(out);
    const titles = parsed.memories.map((m: any) => m.title).sort();
    expect(titles).toEqual(["global", "scoped"]); // includes globals, excludes /p-b
  });

  it("import: creates new memories with preserved ids", async () => {
    const payload = JSON.stringify({
      schema_version: 2,
      exported_at: new Date().toISOString(),
      projects: [],
      memories: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          project_id: null,
          memory_type: "fact",
          scope: "global",
          title: "imported",
          body: "imported body",
          tags: '["t1"]',
          importance_score: 0.5,
          confidence_score: 1.0,
          access_count: 0,
          last_accessed_at: null,
          is_pinned: 0,
          supersedes_memory_id: null,
          source: "user",
          adaptive_score: 0.5,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          deleted_at: null,
        },
      ],
      decisions: [],
      pitfalls: [],
    });

    const path = join(tmpdir(), `memento-import-${process.pid}-${randomUUID()}.json`);
    writeFileSync(path, payload);

    const out = await handleMemoryImport(db, { path });
    expect(out.toLowerCase()).toContain("imported");

    const row = memRepo.getById("11111111-1111-1111-1111-111111111111");
    expect(row).toBeTruthy();
    expect(row.title).toBe("imported");

    rmSync(path, { force: true });
  });

  it("import: skips duplicates with strategy='skip'", async () => {
    const id = memRepo.store({ title: "already", body: "here", memoryType: "fact", scope: "global" });
    const payload = JSON.stringify({
      schema_version: 2,
      exported_at: new Date().toISOString(),
      projects: [],
      memories: [
        {
          id,
          project_id: null,
          memory_type: "fact",
          scope: "global",
          title: "should-be-skipped",
          body: "ignored",
          tags: null,
          importance_score: 0.5,
          confidence_score: 1.0,
          access_count: 0,
          last_accessed_at: null,
          is_pinned: 0,
          supersedes_memory_id: null,
          source: "user",
          adaptive_score: 0.5,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          deleted_at: null,
        },
      ],
      decisions: [],
      pitfalls: [],
    });

    const path = join(tmpdir(), `memento-import-${process.pid}-${randomUUID()}.json`);
    writeFileSync(path, payload);

    const out = await handleMemoryImport(db, { path, strategy: "skip" });
    expect(out).toMatch(/skip/i);
    const row = memRepo.getById(id);
    expect(row.title).toBe("already");
    rmSync(path, { force: true });
  });

  it("import: overwrites duplicates with strategy='overwrite'", async () => {
    const id = memRepo.store({ title: "original", body: "old", memoryType: "fact", scope: "global" });
    const payload = JSON.stringify({
      schema_version: 2,
      exported_at: new Date().toISOString(),
      projects: [],
      memories: [
        {
          id,
          project_id: null,
          memory_type: "fact",
          scope: "global",
          title: "overwritten",
          body: "new",
          tags: null,
          importance_score: 0.7,
          confidence_score: 1.0,
          access_count: 0,
          last_accessed_at: null,
          is_pinned: 0,
          supersedes_memory_id: null,
          source: "user",
          adaptive_score: 0.5,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          deleted_at: null,
        },
      ],
      decisions: [],
      pitfalls: [],
    });

    const path = join(tmpdir(), `memento-import-${process.pid}-${randomUUID()}.json`);
    writeFileSync(path, payload);

    await handleMemoryImport(db, { path, strategy: "overwrite" });
    const row = memRepo.getById(id);
    expect(row.title).toBe("overwritten");
    expect(row.importance_score).toBeCloseTo(0.7);
    rmSync(path, { force: true });
  });

  it("import: rejects incompatible schema_version", async () => {
    const payload = JSON.stringify({ schema_version: 99, memories: [] });
    const path = join(tmpdir(), `memento-bad-${process.pid}-${randomUUID()}.json`);
    writeFileSync(path, payload);
    const out = await handleMemoryImport(db, { path });
    expect(out.toLowerCase()).toMatch(/unsupported|incompatible|schema/);
    rmSync(path, { force: true });
  });

  it("export -> import round-trip preserves data", async () => {
    const id = memRepo.store({
      title: "roundtrip",
      body: "trip body",
      memoryType: "fact",
      scope: "global",
      tags: ["x", "y"],
      importance: 0.6,
    });

    const exported = await handleMemoryExport(db, {});
    const path = join(tmpdir(), `memento-roundtrip-${process.pid}-${randomUUID()}.json`);
    writeFileSync(path, exported);

    // Wipe and reimport
    memRepo.delete(id);
    db.prepare("DELETE FROM memories WHERE id = ?").run(id);

    await handleMemoryImport(db, { path, strategy: "overwrite" });
    const row = memRepo.getById(id);
    expect(row).toBeTruthy();
    expect(row.title).toBe("roundtrip");
    expect(JSON.parse(row.tags)).toEqual(["x", "y"]);
    rmSync(path, { force: true });
  });
});
