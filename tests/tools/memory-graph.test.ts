// tests/tools/memory-graph.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { EdgesRepo } from "../../src/db/edges.js";
import { handleMemoryGraph } from "../../src/tools/memory-graph.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("handleMemoryGraph", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let edgesRepo: EdgesRepo;
  const dbPath = join(tmpdir(), `memento-graph-${process.pid}-${randomUUID()}.sqlite`);

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

  it("output starts with Memory: and title in quotes", async () => {
    const a = storeMemory("Root Memory");
    const result = await handleMemoryGraph(memRepo, edgesRepo, { id: a });
    expect(result).toMatch(/^Memory: "Root Memory"/);
  });

  it("output contains [Nt] token markers for neighbor lines", async () => {
    const a = storeMemory("Root");
    const b = storeMemory("Neighbor");
    edgesRepo.link(a, b, "relates_to");

    const result = await handleMemoryGraph(memRepo, edgesRepo, { id: a });
    expect(result).toContain("[");
    expect(result).toMatch(/\[\d+t\]/);
  });

  it("depth=0 emits zero neighbor lines (only root header)", async () => {
    const a = storeMemory("Root");
    const b = storeMemory("Neighbor");
    edgesRepo.link(a, b, "relates_to");

    const result = await handleMemoryGraph(memRepo, edgesRepo, { id: a, depth: 0 });
    const lines = result.split("\n").filter(l => l.trim().length > 0);
    // Only the header line should be present
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Memory:/);
  });

  it("returns not found for unknown memory id", async () => {
    const result = await handleMemoryGraph(memRepo, edgesRepo, { id: "no-such-id" });
    expect(result).toContain("not found");
  });

  it("includes edge direction markers in output", async () => {
    const a = storeMemory("Root");
    const b = storeMemory("Child");
    edgesRepo.link(a, b, "implements");

    const result = await handleMemoryGraph(memRepo, edgesRepo, { id: a });
    // Should contain direction + edge_type marker
    expect(result).toContain("implements");
  });
});
