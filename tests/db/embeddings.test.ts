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

describe("EmbeddingsRepo project-scoped backfill queries", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let embRepo: EmbeddingsRepo;
  let projectA: string;
  let projectB: string;
  const dbPath = join(tmpdir(), `memento-proj-scoped-test-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    embRepo = new EmbeddingsRepo(db);
    projectA = memRepo.ensureProject("/tmp/projA");
    projectB = memRepo.ensureProject("/tmp/projB");

    memRepo.store({ title: "A1", body: "a1", memoryType: "fact", scope: "project", projectId: projectA });
    memRepo.store({ title: "A2", body: "a2", memoryType: "fact", scope: "project", projectId: projectA });
    memRepo.store({ title: "B1", body: "b1", memoryType: "fact", scope: "project", projectId: projectB });
  });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("countMissing without projectId counts all", () => {
    expect(embRepo.countMissing("test-model")).toBe(3);
  });

  it("countMissing with projectId scopes to that project", () => {
    expect(embRepo.countMissing("test-model", projectA)).toBe(2);
    expect(embRepo.countMissing("test-model", projectB)).toBe(1);
  });

  it("iterateMissing with projectId scopes to that project", () => {
    const ids = Array.from(embRepo.iterateMissing("test-model", 10, projectA)).map(m => m.id);
    expect(ids.length).toBe(2);
    expect(ids.sort()).toEqual(ids.sort());
  });

  it("countMissing with projectId still excludes already-embedded", () => {
    const id = memRepo.store({ title: "A3", body: "a3", memoryType: "fact", scope: "project", projectId: projectA });
    embRepo.upsert(id, "test-model", new Float32Array([1, 0, 0, 0]));
    expect(embRepo.countMissing("test-model", projectA)).toBe(2); // A1 and A2, not A3
  });
});

describe("EmbeddingsRepo.topKByCosine", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let embRepo: EmbeddingsRepo;
  let projectId: string;
  const dbPath = join(tmpdir(), `memento-topk-test-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath + "-" + randomUUID());
    memRepo = new MemoriesRepo(db);
    embRepo = new EmbeddingsRepo(db);
    projectId = memRepo.ensureProject("/tmp/p");
  });
  afterEach(() => { db.close(); });

  it("returns top-k candidates ranked by cosine similarity", () => {
    const id1 = memRepo.store({ title: "M1", body: "", memoryType: "fact", scope: "project", projectId });
    const id2 = memRepo.store({ title: "M2", body: "", memoryType: "fact", scope: "project", projectId });
    const id3 = memRepo.store({ title: "M3", body: "", memoryType: "fact", scope: "project", projectId });

    embRepo.upsert(id1, "test-model", new Float32Array([1, 0, 0, 0]));     // cos with query [1,0,0,0] = 1.0
    embRepo.upsert(id2, "test-model", new Float32Array([0.7, 0.7, 0, 0])); // cos ≈ 0.707
    embRepo.upsert(id3, "test-model", new Float32Array([0, 1, 0, 0]));     // cos = 0.0

    const query = new Float32Array([1, 0, 0, 0]);
    const top = embRepo.topKByCosine(query, projectId, "test-model", 2);
    expect(top).toHaveLength(2);
    expect(top[0].id).toBe(id1);
    expect(top[1].id).toBe(id2);
    expect(top[0].score).toBeCloseTo(1.0);
    expect(top[1].score).toBeCloseTo(0.707, 2);
  });

  it("respects model filter", () => {
    const id1 = memRepo.store({ title: "M1", body: "", memoryType: "fact", scope: "project", projectId });
    embRepo.upsert(id1, "model-A", new Float32Array([1, 0, 0, 0]));
    const id2 = memRepo.store({ title: "M2", body: "", memoryType: "fact", scope: "project", projectId });
    embRepo.upsert(id2, "model-B", new Float32Array([1, 0, 0, 0]));

    const top = embRepo.topKByCosine(new Float32Array([1, 0, 0, 0]), projectId, "model-A", 10);
    expect(top.map(r => r.id)).toEqual([id1]);
  });

  it("returns empty array when no embeddings exist", () => {
    const top = embRepo.topKByCosine(new Float32Array([1, 0, 0, 0]), projectId, "test-model", 10);
    expect(top).toEqual([]);
  });

  it("skips soft-deleted memories", () => {
    const id1 = memRepo.store({ title: "M1", body: "", memoryType: "fact", scope: "project", projectId });
    embRepo.upsert(id1, "test-model", new Float32Array([1, 0, 0, 0]));
    db.prepare(`UPDATE memories SET deleted_at = datetime('now') WHERE id = ?`).run(id1);

    const top = embRepo.topKByCosine(new Float32Array([1, 0, 0, 0]), projectId, "test-model", 10);
    expect(top).toEqual([]);
  });
});
