// tests/tools/memory-link.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { EdgesRepo } from "../../src/db/edges.js";
import { handleMemoryLink } from "../../src/tools/memory-link.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("handleMemoryLink", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let edgesRepo: EdgesRepo;
  const dbPath = join(tmpdir(), `memento-link-${process.pid}-${randomUUID()}.sqlite`);

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

  it("rejects unknown from_id", async () => {
    const b = storeMemory("B");
    const result = await handleMemoryLink(memRepo, edgesRepo, {
      from_id: "nonexistent-id",
      to_id: b,
      edge_type: "relates_to",
    });
    expect(result).toMatch(/Error/);
    expect(result).toContain("nonexistent-id");
  });

  it("rejects unknown to_id", async () => {
    const a = storeMemory("A");
    const result = await handleMemoryLink(memRepo, edgesRepo, {
      from_id: a,
      to_id: "nonexistent-id",
      edge_type: "relates_to",
    });
    expect(result).toMatch(/Error/);
    expect(result).toContain("nonexistent-id");
  });

  it("rejects soft-deleted memory", async () => {
    const a = storeMemory("A");
    const b = storeMemory("B");
    memRepo.delete(b);

    const result = await handleMemoryLink(memRepo, edgesRepo, {
      from_id: a,
      to_id: b,
      edge_type: "relates_to",
    });
    expect(result).toMatch(/Error/);
  });

  it("returns success string on happy path", async () => {
    const a = storeMemory("A");
    const b = storeMemory("B");
    const result = await handleMemoryLink(memRepo, edgesRepo, {
      from_id: a,
      to_id: b,
      edge_type: "relates_to",
    });
    expect(result).toContain("Linked");
    expect(result).toContain(a);
    expect(result).toContain(b);
    expect(result).toContain("relates_to");
  });
});
