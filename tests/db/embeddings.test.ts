// tests/db/embeddings.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { EmbeddingsRepo } from "../../src/db/embeddings.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("EmbeddingsRepo", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let embRepo: EmbeddingsRepo;
  const dbPath = join(tmpdir(), `memento-emb-test-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    embRepo = new EmbeddingsRepo(db);
  });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("upserts and retrieves an embedding", () => {
    const memId = memRepo.store({ title: "test", body: "body", memoryType: "fact", scope: "global" });
    const vec = new Float32Array([0.1, 0.2, 0.3]);
    embRepo.upsert(memId, "test-model", vec);
    const result = embRepo.get(memId);
    expect(result).not.toBeNull();
    expect(result!.model).toBe("test-model");
    expect(result!.dim).toBe(3);
    expect(result!.vector.length).toBe(3);
    expect(result!.vector[0]).toBeCloseTo(0.1, 4);
    expect(result!.vector[1]).toBeCloseTo(0.2, 4);
    expect(result!.vector[2]).toBeCloseTo(0.3, 4);
  });

  it("returns null for missing memory", () => {
    expect(embRepo.get("nonexistent")).toBeNull();
  });

  it("upsert replaces existing embedding (INSERT OR REPLACE)", () => {
    const memId = memRepo.store({ title: "test", body: "body", memoryType: "fact", scope: "global" });
    embRepo.upsert(memId, "model-a", new Float32Array([1.0, 0.0]));
    embRepo.upsert(memId, "model-a", new Float32Array([0.5, 0.5]));
    const result = embRepo.get(memId);
    expect(result!.vector[0]).toBeCloseTo(0.5, 4);
    expect(result!.vector[1]).toBeCloseTo(0.5, 4);
  });

  it("deleteByMemory removes the embedding", () => {
    const memId = memRepo.store({ title: "test", body: "body", memoryType: "fact", scope: "global" });
    embRepo.upsert(memId, "model", new Float32Array([1.0]));
    embRepo.deleteByMemory(memId);
    expect(embRepo.get(memId)).toBeNull();
  });

  it("getByProject returns embeddings for active memories in project", () => {
    const projId = memRepo.ensureProject("/test-proj");
    const id1 = memRepo.store({ title: "m1", body: "b1", memoryType: "fact", scope: "project", projectId: projId });
    const id2 = memRepo.store({ title: "m2", body: "b2", memoryType: "fact", scope: "project", projectId: projId });
    embRepo.upsert(id1, "model", new Float32Array([1.0, 0.0]));
    embRepo.upsert(id2, "model", new Float32Array([0.0, 1.0]));

    const results = embRepo.getByProject(projId, "model");
    expect(results.length).toBe(2);
    const ids = results.map(r => r.memoryId);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
  });

  it("getByProject excludes soft-deleted memories", () => {
    const projId = memRepo.ensureProject("/test-del");
    const id1 = memRepo.store({ title: "active", body: "b", memoryType: "fact", scope: "project", projectId: projId });
    const id2 = memRepo.store({ title: "deleted", body: "b", memoryType: "fact", scope: "project", projectId: projId });
    embRepo.upsert(id1, "model", new Float32Array([1.0]));
    embRepo.upsert(id2, "model", new Float32Array([0.5]));
    memRepo.delete(id2); // soft-delete

    const results = embRepo.getByProject(projId, "model");
    expect(results.length).toBe(1);
    expect(results[0].memoryId).toBe(id1);
  });

  it("cascade-delete: hard-deleting a memory row removes its embedding", () => {
    const projId = memRepo.ensureProject("/test-cascade");
    const id1 = memRepo.store({ title: "cascade", body: "b", memoryType: "fact", scope: "project", projectId: projId });
    embRepo.upsert(id1, "model", new Float32Array([1.0]));
    expect(embRepo.get(id1)).not.toBeNull();

    // Hard delete using raw SQL (foreign key ON DELETE CASCADE)
    db.prepare("DELETE FROM memories WHERE id = ?").run(id1);
    expect(embRepo.get(id1)).toBeNull();
  });

  it("countMissing returns count of memories without embeddings", () => {
    const projId = memRepo.ensureProject("/test-missing");
    const id1 = memRepo.store({ title: "m1", body: "b", memoryType: "fact", scope: "project", projectId: projId });
    const id2 = memRepo.store({ title: "m2", body: "b", memoryType: "fact", scope: "project", projectId: projId });
    embRepo.upsert(id1, "model", new Float32Array([1.0]));

    const missing = embRepo.countMissing("model");
    expect(missing).toBe(1); // only id2 is missing
  });

  it("iterateMissing yields memories without embeddings", () => {
    const projId = memRepo.ensureProject("/test-iter");
    const id1 = memRepo.store({ title: "has-emb", body: "b", memoryType: "fact", scope: "project", projectId: projId });
    const id2 = memRepo.store({ title: "no-emb", body: "b", memoryType: "fact", scope: "project", projectId: projId });
    embRepo.upsert(id1, "model", new Float32Array([1.0]));

    const results = [...embRepo.iterateMissing("model", 10)];
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(id2);
    expect(results[0].title).toBe("no-emb");
  });

  it("getByProject with null projectId returns global-scope memories", () => {
    const id1 = memRepo.store({ title: "global-mem", body: "b", memoryType: "fact", scope: "global" });
    embRepo.upsert(id1, "model", new Float32Array([1.0, 0.5]));

    const results = embRepo.getByProject(null, "model");
    const ids = results.map(r => r.memoryId);
    expect(ids).toContain(id1);
  });
});
