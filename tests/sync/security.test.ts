// tests/sync/security.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { assertSafeOutputPath, pushSingleMemory, pull } from "../../src/sync/git-sync.js";
import { DEFAULT_SYNC_CONFIG } from "../../src/lib/config.js";

describe("sync security", () => {
  let tmpRoot: string;
  let db: ReturnType<typeof createDatabase>;
  const dbPath = join(tmpdir(), `memento-sync-sec-${Date.now()}-${Math.random()}.sqlite`);

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "memento-sync-sec-"));
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe("assertSafeOutputPath", () => {
    it("accepts a clean uuid", () => {
      const p = assertSafeOutputPath(tmpRoot, ".memento", "abc-123");
      expect(p.startsWith(tmpRoot)).toBe(true);
      expect(p.endsWith("abc-123.json")).toBe(true);
    });

    it("rejects path traversal in memoryId", () => {
      expect(() => assertSafeOutputPath(tmpRoot, ".memento", "../../etc/passwd")).toThrow();
    });

    it("rejects absolute path in memoryId", () => {
      expect(() => assertSafeOutputPath(tmpRoot, ".memento", "/etc/passwd")).toThrow();
    });
  });

  describe("pushSingleMemory path traversal guard", () => {
    it("writes safely under the project root for a clean memory id", async () => {
      const repo = new MemoriesRepo(db);
      const projectId = repo.ensureProject(tmpRoot);
      const memId = repo.store({ title: "team mem", body: "x", scope: "team", projectId });
      await pushSingleMemory(db, tmpRoot, memId, DEFAULT_SYNC_CONFIG);
      // No throw == safe path resolved; assertSafeOutputPath unit tests cover the rejection cases.
    });

    it("returns silently when memory id is not found (no throw, no write)", async () => {
      // Forged ids that don't exist in DB return early via the "memory not found" branch.
      // The assertSafeOutputPath unit tests cover the actual traversal rejection at the path layer.
      await expect(
        pushSingleMemory(db, tmpRoot, "non-existent-id", DEFAULT_SYNC_CONFIG)
      ).resolves.toBeUndefined();
    });
  });

  describe("pull future-timestamp guard", () => {
    it("rejects files whose updated_at is more than maxFutureDriftHours in the future", async () => {
      const memoriesDir = join(tmpRoot, ".memento", "memories");
      mkdirSync(memoriesDir, { recursive: true });

      const futureTime = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(); // 48h
      const fileBody = JSON.stringify({
        schema_version: 1,
        id: "future-mem",
        memory_type: "fact",
        scope: "team",
        title: "future",
        body: "from the future",
        tags: [],
        importance_score: 0.5,
        created_at: futureTime,
        updated_at: futureTime,
        deleted_at: null,
        supersedes_memory_id: null,
        claude_session_id: null,
        has_private: 0,
      }, null, 2) + "\n";

      writeFileSync(join(memoriesDir, "future-mem.json"), fileBody, "utf-8");

      const result = await pull({
        db,
        projectRoot: tmpRoot,
        dryRun: false,
        config: { ...DEFAULT_SYNC_CONFIG, maxFutureDriftHours: 24 },
      });

      // Should have a warning, no creates
      expect(result.warnings.some(w => w.includes("future"))).toBe(true);
      expect(result.created).toBe(0);
    });
  });
});
