import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { EdgesRepo } from "../../src/db/edges.js";
import { handleMemoryEdgeCreate } from "../../src/tools/memory-edge-create.js";

function tmpDbPath(): string {
  return join(tmpdir(), `memento-test-${randomUUID()}.db`);
}

describe("memory_edge_create", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let edgeRepo: EdgesRepo;
  let mA: string, mB: string;

  beforeEach(() => {
    db = createDatabase(tmpDbPath());
    memRepo = new MemoriesRepo(db);
    edgeRepo = new EdgesRepo(db);
    mA = "test-A";
    mB = "test-B";
    db.prepare(`INSERT INTO memories(id, project_id, title, body) VALUES (?, NULL, ?, ?)`).run(mA, "A", "a");
    db.prepare(`INSERT INTO memories(id, project_id, title, body) VALUES (?, NULL, ?, ?)`).run(mB, "B", "b");
  });

  it("creates a typed edge between two existing memories", async () => {
    const result = await handleMemoryEdgeCreate(memRepo, db, {
      from_memory_id: mA,
      to_memory_id: mB,
      edge_type: "causes",
      weight: 0.8,
    });
    expect(result).toMatch(/created/i);
    const edges = edgeRepo.outgoing(mA);
    expect(edges).toHaveLength(1);
    expect(edges[0].edge_type).toBe("causes");
    expect(edges[0].weight).toBeCloseTo(0.8);
  });

  it("returns an error string when from_memory_id is missing", async () => {
    const result = await handleMemoryEdgeCreate(memRepo, db, {
      from_memory_id: "nonexistent",
      to_memory_id: mB,
      edge_type: "causes",
    });
    expect(result).toMatch(/not found/i);
    expect(edgeRepo.outgoing("nonexistent")).toHaveLength(0);
  });

  it("returns an error string when to_memory_id is missing", async () => {
    const result = await handleMemoryEdgeCreate(memRepo, db, {
      from_memory_id: mA,
      to_memory_id: "nonexistent",
      edge_type: "causes",
    });
    expect(result).toMatch(/not found/i);
  });

  it("returns an error string for self-loop", async () => {
    const result = await handleMemoryEdgeCreate(memRepo, db, {
      from_memory_id: mA,
      to_memory_id: mA,
      edge_type: "causes",
    });
    expect(result).toMatch(/self-loop/i);
  });

  it("default weight is 1.0", async () => {
    await handleMemoryEdgeCreate(memRepo, db, {
      from_memory_id: mA,
      to_memory_id: mB,
      edge_type: "relates_to",
    });
    expect(edgeRepo.outgoing(mA)[0].weight).toBeCloseTo(1.0);
  });
});
