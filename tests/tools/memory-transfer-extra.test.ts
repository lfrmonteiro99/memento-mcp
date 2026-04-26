// tests/tools/memory-transfer-extra.test.ts
// Branch coverage for memory-transfer.ts: missing-project export branch,
// invalid file/JSON paths in import, all field-default fallbacks during import.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/db/database.js";
import { handleMemoryExport, handleMemoryImport } from "../../src/tools/memory-transfer.js";

describe("handleMemoryExport — branches", () => {
  let db: ReturnType<typeof createDatabase>;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `transfer-extra-${process.pid}-${randomUUID()}.sqlite`);
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("returns empty payload when project_path resolves to no project", async () => {
    const out = await handleMemoryExport(db, { project_path: "/no/such/project" });
    const parsed = JSON.parse(out);
    expect(parsed.schema_version).toBe(2);
    expect(parsed.projects).toEqual([]);
    expect(parsed.memories).toEqual([]);
  });
});

describe("handleMemoryImport — error branches", () => {
  let db: ReturnType<typeof createDatabase>;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `transfer-import-${process.pid}-${randomUUID()}.sqlite`);
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("returns a friendly error when file does not exist", async () => {
    const out = await handleMemoryImport(db, { path: "/no/such/file.json" });
    expect(out).toMatch(/Failed to read import file/);
  });

  it("returns a friendly error on invalid JSON", async () => {
    const path = join(tmpdir(), `bad-${process.pid}-${randomUUID()}.json`);
    writeFileSync(path, "{not valid");
    try {
      const out = await handleMemoryImport(db, { path });
      expect(out).toMatch(/Invalid JSON/);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("rejects unsupported schema_version", async () => {
    const path = join(tmpdir(), `bad-schema-${process.pid}-${randomUUID()}.json`);
    writeFileSync(path, JSON.stringify({
      schema_version: 999,
      exported_at: new Date().toISOString(),
      memories: [], decisions: [], pitfalls: [], projects: [],
    }));
    try {
      const out = await handleMemoryImport(db, { path });
      expect(out).toMatch(/Unsupported schema_version 999/);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("imports memories with default fallbacks for missing optional fields", async () => {
    const path = join(tmpdir(), `imp-defaults-${process.pid}-${randomUUID()}.json`);
    writeFileSync(path, JSON.stringify({
      schema_version: 2,
      exported_at: new Date().toISOString(),
      projects: [],
      memories: [{ id: "imp-1", title: "Import Defaults" }], // every other field absent
      decisions: [],
      pitfalls: [],
    }));
    try {
      const out = await handleMemoryImport(db, { path });
      expect(out).toContain("1 imported");

      const row = db.prepare("SELECT * FROM memories WHERE id = ?").get("imp-1") as any;
      expect(row).toBeDefined();
      expect(row.memory_type).toBe("fact");
      expect(row.scope).toBe("project");
      expect(row.body).toBe("");
      expect(row.importance_score).toBe(0.5);
      expect(row.confidence_score).toBe(1);
      expect(row.access_count).toBe(0);
      expect(row.is_pinned).toBe(0);
      expect(row.source).toBe("user");
    } finally {
      rmSync(path, { force: true });
    }
  });
});
