import { describe, it, expect, beforeEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { EdgesRepo, type EdgeType } from "../../src/db/edges.js";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
function tmpDbPath(): string {
  return join(tmpdir(), `memento-test-${randomUUID()}.db`);
}

describe("EdgesRepo", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let edgeRepo: EdgesRepo;
  let mA: string;
  let mB: string;

  beforeEach(() => {
    db = createDatabase(tmpDbPath());
    memRepo = new MemoriesRepo(db);
    edgeRepo = new EdgesRepo(db);
    // Use the same insert pattern that exists in MemoriesRepo today.
    // If MemoriesRepo doesn't have a simple insert helper, fall back to raw SQL using the test pattern from database.test.ts.
    mA = "test-A";
    mB = "test-B";
    db.prepare(`INSERT INTO memories(id, project_id, title, body) VALUES (?, NULL, ?, ?)`).run(mA, "A", "a");
    db.prepare(`INSERT INTO memories(id, project_id, title, body) VALUES (?, NULL, ?, ?)`).run(mB, "B", "b");
  });

  it("creates a typed edge", () => {
    edgeRepo.create({ from: mA, to: mB, edge_type: "causes", weight: 0.8 });
    const edges = edgeRepo.outgoing(mA);
    expect(edges).toHaveLength(1);
    expect(edges[0].edge_type).toBe("causes");
    expect(edges[0].weight).toBeCloseTo(0.8);
  });

  it("rejects invalid edge_type", () => {
    expect(() =>
      edgeRepo.create({ from: mA, to: mB, edge_type: "invalid" as EdgeType, weight: 1 })
    ).toThrow();
  });

  it("rejects self-loop", () => {
    expect(() =>
      edgeRepo.create({ from: mA, to: mA, edge_type: "causes", weight: 1 })
    ).toThrow(/self-loop/);
  });

  it("upsert is idempotent on PK conflict (latest weight wins)", () => {
    edgeRepo.create({ from: mA, to: mB, edge_type: "causes", weight: 0.5 });
    edgeRepo.create({ from: mA, to: mB, edge_type: "causes", weight: 0.9 });
    const edges = edgeRepo.outgoing(mA);
    expect(edges).toHaveLength(1);
    expect(edges[0].weight).toBeCloseTo(0.9);
  });

  it("incoming returns edges where this memory is the target", () => {
    edgeRepo.create({ from: mA, to: mB, edge_type: "fixes", weight: 1.0 });
    const incoming = edgeRepo.incoming(mB);
    expect(incoming).toHaveLength(1);
    expect(incoming[0].from_memory_id).toBe(mA);
  });

  it("filtering by edge_type narrows results", () => {
    edgeRepo.create({ from: mA, to: mB, edge_type: "causes", weight: 1.0 });
    edgeRepo.create({ from: mA, to: mB, edge_type: "relates_to", weight: 1.0 });
    expect(edgeRepo.outgoing(mA, "causes")).toHaveLength(1);
    expect(edgeRepo.outgoing(mA, "relates_to")).toHaveLength(1);
    expect(edgeRepo.outgoing(mA)).toHaveLength(2);
  });

  it("delete removes a specific edge", () => {
    edgeRepo.create({ from: mA, to: mB, edge_type: "causes", weight: 1.0 });
    edgeRepo.delete(mA, mB, "causes");
    expect(edgeRepo.outgoing(mA)).toHaveLength(0);
  });

  it("default weight is 1.0 when omitted", () => {
    edgeRepo.create({ from: mA, to: mB, edge_type: "causes" });
    expect(edgeRepo.outgoing(mA)[0].weight).toBeCloseTo(1.0);
  });
});
