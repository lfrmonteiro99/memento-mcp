import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { EdgesRepo } from "../../src/db/edges.js";
import { handleMemoryEdgeTraverse } from "../../src/tools/memory-edge-traverse.js";

function tmpDbPath(): string {
  return join(tmpdir(), `memento-test-${randomUUID()}.db`);
}

describe("memory_edge_traverse", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let edgeRepo: EdgesRepo;
  let mA: string, mB: string, mC: string;

  beforeEach(() => {
    db = createDatabase(tmpDbPath());
    memRepo = new MemoriesRepo(db);
    edgeRepo = new EdgesRepo(db);
    mA = "test-A";
    mB = "test-B";
    mC = "test-C";
    db.prepare(`INSERT INTO memories(id, project_id, title, body) VALUES (?, NULL, ?, ?)`).run(mA, "Title-A", "body-a");
    db.prepare(`INSERT INTO memories(id, project_id, title, body) VALUES (?, NULL, ?, ?)`).run(mB, "Title-B", "body-b");
    db.prepare(`INSERT INTO memories(id, project_id, title, body) VALUES (?, NULL, ?, ?)`).run(mC, "Title-C", "body-c");
  });

  it("returns 1-hop outgoing and incoming neighbours by default (direction='both')", async () => {
    edgeRepo.create({ from: mA, to: mB, edge_type: "causes", weight: 0.9 });
    edgeRepo.create({ from: mC, to: mA, edge_type: "fixes", weight: 1.0 });

    const result = await handleMemoryEdgeTraverse(memRepo, db, { memory_id: mA });
    expect(result).toMatch(/Title-B/);
    expect(result).toMatch(/Title-C/);
    expect(result).toMatch(/causes/);
    expect(result).toMatch(/fixes/);
  });

  it("filters by edge_types when provided", async () => {
    edgeRepo.create({ from: mA, to: mB, edge_type: "causes", weight: 1.0 });
    edgeRepo.create({ from: mA, to: mC, edge_type: "relates_to", weight: 1.0 });

    const result = await handleMemoryEdgeTraverse(memRepo, db, {
      memory_id: mA,
      edge_types: ["causes"],
      direction: "outgoing",
    });
    expect(result).toMatch(/Title-B/);
    expect(result).not.toMatch(/Title-C/);
  });

  it("direction='outgoing' excludes incoming edges", async () => {
    edgeRepo.create({ from: mA, to: mB, edge_type: "causes", weight: 1.0 });
    edgeRepo.create({ from: mC, to: mA, edge_type: "fixes", weight: 1.0 });

    const result = await handleMemoryEdgeTraverse(memRepo, db, {
      memory_id: mA,
      direction: "outgoing",
    });
    expect(result).toMatch(/Title-B/);
    expect(result).not.toMatch(/Title-C/);
  });

  it("direction='incoming' excludes outgoing edges", async () => {
    edgeRepo.create({ from: mA, to: mB, edge_type: "causes", weight: 1.0 });
    edgeRepo.create({ from: mC, to: mA, edge_type: "fixes", weight: 1.0 });

    const result = await handleMemoryEdgeTraverse(memRepo, db, {
      memory_id: mA,
      direction: "incoming",
    });
    expect(result).toMatch(/Title-C/);
    expect(result).not.toMatch(/Title-B/);
  });

  it("skips soft-deleted neighbours", async () => {
    edgeRepo.create({ from: mA, to: mB, edge_type: "causes", weight: 1.0 });
    db.prepare(`UPDATE memories SET deleted_at = datetime('now') WHERE id = ?`).run(mB);

    const result = await handleMemoryEdgeTraverse(memRepo, db, { memory_id: mA });
    expect(result).not.toMatch(/Title-B/);
  });

  it("returns a clear empty-state string when memory has no edges", async () => {
    const result = await handleMemoryEdgeTraverse(memRepo, db, { memory_id: mA });
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/no.*neighbours|no.*edges|empty/i);
  });

  it("returns error string when memory_id does not exist", async () => {
    const result = await handleMemoryEdgeTraverse(memRepo, db, { memory_id: "ghost" });
    expect(result).toMatch(/not found/i);
  });
});
