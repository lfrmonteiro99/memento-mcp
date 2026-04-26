// tests/tools/memory-unlink.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { EdgesRepo } from "../../src/db/edges.js";
import { handleMemoryUnlink } from "../../src/tools/memory-unlink.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("handleMemoryUnlink", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let edgesRepo: EdgesRepo;
  const dbPath = join(tmpdir(), `memento-unlink-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    edgesRepo = new EdgesRepo(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
  });

  function store(title: string): string {
    return memRepo.store({ title, body: `body of ${title}`, memoryType: "fact", scope: "global" });
  }

  it("returns 'No edge found' when nothing to remove", async () => {
    const result = await handleMemoryUnlink(edgesRepo, {
      from_id: "missing-a",
      to_id: "missing-b",
      edge_type: "relates_to",
    });
    expect(result).toContain("No edge found");
    expect(result).toContain("relates_to");
  });

  it("removes the edge and reports success", async () => {
    const a = store("A");
    const b = store("B");
    edgesRepo.link(a, b, "relates_to");

    const result = await handleMemoryUnlink(edgesRepo, {
      from_id: a,
      to_id: b,
      edge_type: "relates_to",
    });
    expect(result).toContain("Unlinked");
    expect(result).toContain(a);
    expect(result).toContain(b);
    expect(edgesRepo.outgoing(a)).toHaveLength(0);
  });

  it("only removes the edge of the specified type", async () => {
    const a = store("A");
    const b = store("B");
    edgesRepo.link(a, b, "relates_to");
    edgesRepo.link(a, b, "references");

    const result = await handleMemoryUnlink(edgesRepo, {
      from_id: a,
      to_id: b,
      edge_type: "relates_to",
    });
    expect(result).toContain("Unlinked");
    const remaining = edgesRepo.outgoing(a);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].edge_type).toBe("references");
  });
});
