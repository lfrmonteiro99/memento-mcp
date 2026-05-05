import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  applyCompression,
  runCompressionCycle,
  DEFAULT_COMPRESSION_CONFIG,
  type CompressionResult,
} from "../../src/engine/compressor.js";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";

describe("applyCompression", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  const dbPath = join(tmpdir(), `memento-compress-storage-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("inserts compressed memory and soft-deletes sources", () => {
    const id1 = memRepo.store({ title: "source 1", body: "body 1", memoryType: "fact", scope: "global" });
    const id2 = memRepo.store({ title: "source 2", body: "body 2", memoryType: "fact", scope: "global" });

    const result: CompressionResult = {
      compressed_memory: {
        title: "Compressed: test",
        body: "merged body",
        memory_type: "fact",
        tags: ["compressed"],
        importance_score: 0.6,
      },
      source_memory_ids: [id1, id2],
      tokens_before: 100,
      tokens_after: 40,
      compression_ratio: 0.4,
    };

    applyCompression(db, result);

    expect(memRepo.getById(id1)).toBeNull();
    expect(memRepo.getById(id2)).toBeNull();

    const compressed = db
      .prepare("SELECT * FROM memories WHERE title = 'Compressed: test' AND deleted_at IS NULL")
      .get() as any;
    expect(compressed).toBeDefined();
    expect(compressed.source).toBe("compression");
  });

  it("R6: compression_log.compressed_memory_id is a TEXT UUID referencing memories.id", () => {
    const id1 = memRepo.store({ title: "s1", body: "b1", memoryType: "fact", scope: "global" });

    const result: CompressionResult = {
      compressed_memory: {
        title: "Compressed",
        body: "merged",
        memory_type: "fact",
        tags: ["compressed"],
        importance_score: 0.5,
      },
      source_memory_ids: [id1],
      tokens_before: 50,
      tokens_after: 20,
      compression_ratio: 0.4,
    };

    applyCompression(db, result);

    const log = db.prepare("SELECT * FROM compression_log").get() as any;
    expect(log).toBeDefined();
    expect(log.tokens_before).toBe(50);
    expect(log.tokens_after).toBe(20);
    expect(log.compression_ratio).toBeCloseTo(0.4);

    expect(typeof log.compressed_memory_id).toBe("string");
    expect(log.compressed_memory_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const joined = db
      .prepare(
        `SELECT m.id as memory_id, cl.compression_ratio
         FROM compression_log cl JOIN memories m ON m.id = cl.compressed_memory_id`,
      )
      .get() as any;
    expect(joined).toBeDefined();
    expect(joined.memory_id).toBe(log.compressed_memory_id);
  });

  it("M4: compressed memory inherits project_id from source memories", () => {
    const id1 = memRepo.store({
      title: "scoped source",
      body: "body",
      memoryType: "fact",
      scope: "project",
      projectPath: "/example-proj",
    });
    const sourceRow = db.prepare("SELECT project_id FROM memories WHERE id = ?").get(id1) as any;
    expect(sourceRow.project_id).toBeTruthy();

    applyCompression(db, {
      compressed_memory: {
        title: "Compressed proj",
        body: "merged",
        memory_type: "fact",
        tags: ["compressed"],
        importance_score: 0.5,
      },
      source_memory_ids: [id1],
      tokens_before: 30,
      tokens_after: 10,
      compression_ratio: 0.33,
    });

    const compressed = db
      .prepare("SELECT project_id FROM memories WHERE title = 'Compressed proj'")
      .get() as any;
    expect(compressed.project_id).toBe(sourceRow.project_id);
  });

  it("FTS sync triggers fire on compressed row (no duplicate FTS entry)", () => {
    const id1 = memRepo.store({ title: "s1", body: "fts body", memoryType: "fact", scope: "global" });

    applyCompression(db, {
      compressed_memory: {
        title: "Unique compressed title xyz",
        body: "distinctive compressed body payload",
        memory_type: "fact",
        tags: ["compressed"],
        importance_score: 0.5,
      },
      source_memory_ids: [id1],
      tokens_before: 30,
      tokens_after: 10,
      compression_ratio: 0.33,
    });

    const count = db
      .prepare("SELECT COUNT(*) as c FROM memory_fts WHERE title MATCH 'compressed AND xyz'")
      .get() as any;
    expect(count.c).toBe(1);
  });
});

describe("runCompressionCycle (R5 atomic pipeline)", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  const dbPath = join(tmpdir(), `memento-compress-cycle-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("clusters, merges, and soft-deletes in a single transaction", () => {
    const projectPath = "/cycle-proj";
    const projectId = memRepo.ensureProject(projectPath);

    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(
        memRepo.store({
          title: `Edit: UserService.ts - change ${i}`,
          body: `Modified UserService.ts method ${i} for authentication improvement`,
          memoryType: "fact",
          scope: "project",
          projectPath,
          tags: ["edit", "code-change"],
        }),
      );
    }

    const { compressed } = runCompressionCycle(db, projectId, DEFAULT_COMPRESSION_CONFIG);
    expect(compressed.length).toBeGreaterThanOrEqual(1);

    const active = db
      .prepare(
        "SELECT COUNT(*) as c FROM memories WHERE project_id = ? AND deleted_at IS NULL",
      )
      .get(projectId) as any;
    expect(active.c).toBeGreaterThan(0);
    expect(active.c).toBeLessThan(ids.length);

    const logCount = db.prepare("SELECT COUNT(*) as c FROM compression_log").get() as any;
    expect(logCount.c).toBe(compressed.length);
  });

  it("P3 Task 3: applyCompression emits derives_from edges to each source memory", () => {
    const projectPath = "/edges-proj";
    const projectId = memRepo.ensureProject(projectPath);

    const sourceIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      sourceIds.push(memRepo.store({
        title: `Edit: payments.ts step ${i}`,
        body: `Refactored payments.ts handler ${i} for retry semantics`,
        memoryType: "fact",
        scope: "project",
        projectPath,
        tags: ["edit", "payments"],
      }));
    }

    const { compressed } = runCompressionCycle(db, projectId, DEFAULT_COMPRESSION_CONFIG);
    expect(compressed.length).toBeGreaterThanOrEqual(1);

    // Find the new compression memory.
    const newMem = db.prepare(
      "SELECT id FROM memories WHERE source = 'compression' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
    ).get() as { id: string };
    expect(newMem).toBeDefined();

    const edges = db.prepare(
      "SELECT to_id FROM memory_edges WHERE from_id = ? AND edge_type = 'derives_from'",
    ).all(newMem.id) as Array<{ to_id: string }>;
    const edgeTargets = edges.map(e => e.to_id).sort();
    const sourcesInResult = compressed[0].source_memory_ids.sort();
    expect(edgeTargets).toEqual(sourcesInResult);
  });

  it("P0 Task 6: prunes auto-capture clusters whose median quality_score is below qualityFloor", () => {
    const projectPath = "/lowq-proj";
    const projectId = memRepo.ensureProject(projectPath);

    // 5 near-duplicate auto-capture rows with low quality_score (0.1) — should cluster and prune.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        memRepo.store({
          title: `Auto: shell ran ls - ${i}`,
          body: `Ran ls in /tmp/foo on iteration ${i}; nothing notable`,
          memoryType: "fact",
          scope: "project",
          projectPath,
          tags: ["auto-capture"],
          source: "auto-capture",
          qualityScore: 0.1,
        }),
      );
    }

    const cfg = { ...DEFAULT_COMPRESSION_CONFIG, qualityFloor: 0.25 };
    const { compressed, pruned } = runCompressionCycle(db, projectId, cfg);

    // Low-quality cluster pruned, not merged: no compression result references its ids.
    const compressedSourceIds = new Set(compressed.flatMap(r => r.source_memory_ids));
    for (const id of ids) {
      expect(compressedSourceIds.has(id)).toBe(false);
    }

    // Pruned counts surfaced in the cycle summary.
    expect(pruned.clusterCount).toBeGreaterThanOrEqual(1);
    expect(pruned.memoryCount).toBe(5);

    // All 5 low-quality memories soft-deleted.
    const deleted = db
      .prepare(
        "SELECT COUNT(*) as c FROM memories WHERE project_id = ? AND deleted_at IS NOT NULL",
      )
      .get(projectId) as { c: number };
    expect(deleted.c).toBe(5);
  });

  it("skips memories already marked source='compression' (idempotent)", () => {
    const projectPath = "/idemp-proj";
    const projectId = memRepo.ensureProject(projectPath);

    for (let i = 0; i < 3; i++) {
      memRepo.store({
        title: `Edit: file.ts - ${i}`,
        body: `Edited file.ts to add feature ${i}`,
        memoryType: "fact",
        scope: "project",
        projectPath,
        tags: ["edit"],
      });
    }

    const first = runCompressionCycle(db, projectId, DEFAULT_COMPRESSION_CONFIG);
    const second = runCompressionCycle(db, projectId, DEFAULT_COMPRESSION_CONFIG);
    expect(first.compressed.length).toBeGreaterThanOrEqual(1);
    expect(second.compressed.length).toBe(0);
  });
});
