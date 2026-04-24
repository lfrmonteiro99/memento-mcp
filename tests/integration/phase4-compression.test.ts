import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  clusterMemories,
  mergeCluster,
  applyCompression,
  runCompressionCycle,
  shouldCompress,
  DEFAULT_COMPRESSION_CONFIG,
  type MemoryRecord,
} from "../../src/engine/compressor.js";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";

describe("Phase 4 integration: full compression pipeline", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  const dbPath = join(tmpdir(), `memento-p4-integration-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("cluster -> merge -> applyCompression reduces active memory count", () => {
    const projectPath = "/e2e-compress-proj";
    memRepo.ensureProject(projectPath);

    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(
        memRepo.store({
          title: `Edit: UserService.ts - change ${i}`,
          body: `Modified UserService.ts method ${i} for authentication improvement. Fixed validate logic.`,
          memoryType: "fact",
          scope: "project",
          projectPath,
          tags: ["edit", "code-change", "auto-captured"],
        }),
      );
    }

    const memories = ids
      .map(id => db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRecord)
      .filter(Boolean);
    const clusters = clusterMemories(memories, DEFAULT_COMPRESSION_CONFIG);
    expect(clusters.length).toBeGreaterThanOrEqual(1);

    const result = mergeCluster(clusters[0]);
    expect(result.compression_ratio).toBeLessThan(1.0);

    applyCompression(db, result);

    for (const srcId of result.source_memory_ids) {
      expect(memRepo.getById(srcId)).toBeNull();
    }

    const active = db
      .prepare("SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NULL")
      .get() as any;
    expect(active.c).toBeGreaterThan(0);
    expect(active.c).toBeLessThan(ids.length);
  });

  it("shouldCompress -> runCompressionCycle end-to-end", () => {
    const projectPath = "/trigger-proj";
    const projectId = memRepo.ensureProject(projectPath);

    for (let i = 0; i < 6; i++) {
      memRepo.store({
        title: `Edit: config.ts - tweak ${i}`,
        body: `Adjusted config.ts option ${i} for performance tuning`,
        memoryType: "fact",
        scope: "project",
        projectPath,
        tags: ["edit", "config"],
        source: "auto-capture",
      });
    }

    expect(
      shouldCompress(db, projectId, {
        memory_count_threshold: 3,
        auto_capture_batch: 3,
        staleness_days: 7,
      }),
    ).toBe(true);

    const results = runCompressionCycle(db, projectId, DEFAULT_COMPRESSION_CONFIG);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].compression_ratio).toBeLessThanOrEqual(1.0);

    const compressedRow = db
      .prepare("SELECT source FROM memories WHERE deleted_at IS NULL AND source = 'compression'")
      .get() as any;
    expect(compressedRow).toBeDefined();
  });

  it("compression_log records every compressed memory created by the cycle", () => {
    const projectPath = "/log-proj";
    const projectId = memRepo.ensureProject(projectPath);

    for (let i = 0; i < 4; i++) {
      memRepo.store({
        title: `Edit: api.ts - change ${i}`,
        body: `Updated api.ts endpoint ${i} with cleaner error handling`,
        memoryType: "fact",
        scope: "project",
        projectPath,
        tags: ["edit", "api"],
      });
    }

    const results = runCompressionCycle(db, projectId, DEFAULT_COMPRESSION_CONFIG);
    const logRows = db.prepare("SELECT * FROM compression_log").all() as any[];
    expect(logRows.length).toBe(results.length);
    for (const log of logRows) {
      expect(typeof log.compressed_memory_id).toBe("string");
      const sourceIds = JSON.parse(log.source_memory_ids);
      expect(Array.isArray(sourceIds)).toBe(true);
      expect(sourceIds.length).toBeGreaterThanOrEqual(2);
    }
  });
});
