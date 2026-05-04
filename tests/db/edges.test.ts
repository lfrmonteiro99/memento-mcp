// tests/db/edges.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { EdgesRepo, ALLOWED_EDGE_TYPES } from "../../src/db/edges.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("EdgesRepo", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let edgesRepo: EdgesRepo;
  const dbPath = join(tmpdir(), `memento-edges-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    edgesRepo = new EdgesRepo(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
  });

  function storeMemory(title: string): string {
    return memRepo.store({ title, body: `body of ${title}`, memoryType: "fact", scope: "global" });
  }

  it("link and unlink happy path", () => {
    const a = storeMemory("A");
    const b = storeMemory("B");
    edgesRepo.link(a, b, "relates_to");
    const edges = edgesRepo.outgoing(a);
    expect(edges).toHaveLength(1);
    expect(edges[0].from_id).toBe(a);
    expect(edges[0].to_id).toBe(b);
    expect(edges[0].edge_type).toBe("relates_to");
    expect(edges[0].weight).toBe(1.0);

    const removed = edgesRepo.unlink(a, b, "relates_to");
    expect(removed).toBe(true);
    expect(edgesRepo.outgoing(a)).toHaveLength(0);
  });

  it("unlink returns false when edge does not exist", () => {
    const a = storeMemory("A");
    const b = storeMemory("B");
    expect(edgesRepo.unlink(a, b, "relates_to")).toBe(false);
  });

  it("INSERT OR REPLACE updates weight on re-link", () => {
    const a = storeMemory("A");
    const b = storeMemory("B");
    edgesRepo.link(a, b, "relates_to", 0.5);
    edgesRepo.link(a, b, "relates_to", 0.9);
    const edges = edgesRepo.outgoing(a);
    expect(edges).toHaveLength(1);
    expect(edges[0].weight).toBeCloseTo(0.9);
  });

  it("rejects self-edges", () => {
    const a = storeMemory("A");
    expect(() => edgesRepo.link(a, a, "relates_to")).toThrow("Self-edges are not allowed");
  });

  it("rejects unknown edge_type", () => {
    const a = storeMemory("A");
    const b = storeMemory("B");
    // @ts-expect-error intentional bad type
    expect(() => edgesRepo.link(a, b, "bad_type")).toThrow("Unknown edge type");
  });

  it("outgoing filters by edge types", () => {
    const a = storeMemory("A");
    const b = storeMemory("B");
    const c = storeMemory("C");
    edgesRepo.link(a, b, "relates_to");
    edgesRepo.link(a, c, "supersedes");

    const relatesOnly = edgesRepo.outgoing(a, ["relates_to"]);
    expect(relatesOnly).toHaveLength(1);
    expect(relatesOnly[0].to_id).toBe(b);

    const both = edgesRepo.outgoing(a);
    expect(both).toHaveLength(2);
  });

  it("incoming filters by edge types", () => {
    const a = storeMemory("A");
    const b = storeMemory("B");
    const c = storeMemory("C");
    edgesRepo.link(b, a, "caused_by");
    edgesRepo.link(c, a, "references");

    const causedOnly = edgesRepo.incoming(a, ["caused_by"]);
    expect(causedOnly).toHaveLength(1);
    expect(causedOnly[0].from_id).toBe(b);

    const all = edgesRepo.incoming(a);
    expect(all).toHaveLength(2);
  });

  it("subgraph at depth 0 returns only root with no edges", () => {
    const a = storeMemory("A");
    const b = storeMemory("B");
    edgesRepo.link(a, b, "relates_to");

    const { nodes, edges } = edgesRepo.subgraph(a, 0);
    expect(nodes).toEqual([a]);
    expect(edges).toHaveLength(0);
  });

  it("subgraph at depth 1 returns direct neighbors", () => {
    const a = storeMemory("A");
    const b = storeMemory("B");
    const c = storeMemory("C");
    edgesRepo.link(a, b, "relates_to");
    edgesRepo.link(a, c, "supersedes");

    const { nodes, edges } = edgesRepo.subgraph(a, 1);
    expect(nodes).toContain(a);
    expect(nodes).toContain(b);
    expect(nodes).toContain(c);
    expect(edges).toHaveLength(2);
  });

  it("subgraph at depth 2 traverses two hops", () => {
    const a = storeMemory("A");
    const b = storeMemory("B");
    const c = storeMemory("C");
    edgesRepo.link(a, b, "relates_to");
    edgesRepo.link(b, c, "caused_by");

    // direction='out' so we only follow outgoing edges and avoid double-counting
    const { nodes, edges } = edgesRepo.subgraph(a, 2, undefined, "out");
    expect(nodes).toContain(a);
    expect(nodes).toContain(b);
    expect(nodes).toContain(c);
    expect(edges).toHaveLength(2);
  });

  it("subgraph respects direction=out (no incoming traversal)", () => {
    const a = storeMemory("A");
    const b = storeMemory("B");
    const c = storeMemory("C");
    edgesRepo.link(a, b, "relates_to");
    edgesRepo.link(c, a, "references");

    const { nodes } = edgesRepo.subgraph(a, 1, undefined, "out");
    expect(nodes).toContain(b);
    expect(nodes).not.toContain(c);
  });

  it("shortestPath finds shortest path between nodes", () => {
    const a = storeMemory("A");
    const b = storeMemory("B");
    const c = storeMemory("C");
    edgesRepo.link(a, b, "relates_to");
    edgesRepo.link(b, c, "caused_by");

    const path = edgesRepo.shortestPath(a, c, 4);
    expect(path).not.toBeNull();
    expect(path).toEqual([a, b, c]);
  });

  it("shortestPath returns null when unreachable", () => {
    const a = storeMemory("A");
    const b = storeMemory("B");

    const path = edgesRepo.shortestPath(a, b, 4);
    expect(path).toBeNull();
  });

  it("shortestPath returns [id] when from === to", () => {
    const a = storeMemory("A");
    const path = edgesRepo.shortestPath(a, a, 4);
    expect(path).toEqual([a]);
  });

  it("shortestPath returns null when path exceeds maxHops", () => {
    const a = storeMemory("A");
    const b = storeMemory("B");
    const c = storeMemory("C");
    edgesRepo.link(a, b, "relates_to");
    edgesRepo.link(b, c, "relates_to");

    // maxHops=1 cannot reach c (requires 2 hops)
    const path = edgesRepo.shortestPath(a, c, 1);
    expect(path).toBeNull();
  });

  it("cascade-delete: deleting a memory removes its edges", () => {
    const a = storeMemory("A");
    const b = storeMemory("B");
    edgesRepo.link(a, b, "relates_to");

    // Hard-delete memory A to trigger CASCADE
    db.prepare("DELETE FROM memories WHERE id = ?").run(a);

    const remaining = db.prepare("SELECT * FROM memory_edges WHERE from_id = ? OR to_id = ?").all(a, a);
    expect(remaining).toHaveLength(0);
  });
});
