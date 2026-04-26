// tests/tools/memory-path.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { EdgesRepo } from "../../src/db/edges.js";
import { handleMemoryPath } from "../../src/tools/memory-path.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("handleMemoryPath", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let edgesRepo: EdgesRepo;
  const dbPath = join(tmpdir(), `memento-path-${process.pid}-${randomUUID()}.sqlite`);

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

  it("reports no path when nodes are unconnected", async () => {
    const a = store("A");
    const b = store("B");
    const result = await handleMemoryPath(memRepo, edgesRepo, {
      from_id: a,
      to_id: b,
    });
    expect(result).toContain("No path");
    expect(result).toContain(a);
    expect(result).toContain(b);
    expect(result).toContain("4 hops");
  });

  it("uses custom max_hops in the no-path message", async () => {
    const a = store("A");
    const b = store("B");
    const result = await handleMemoryPath(memRepo, edgesRepo, {
      from_id: a,
      to_id: b,
      max_hops: 2,
    });
    expect(result).toContain("2 hops");
  });

  it("returns single-node path when from_id === to_id", async () => {
    const a = store("Alpha");
    const result = await handleMemoryPath(memRepo, edgesRepo, {
      from_id: a,
      to_id: a,
    });
    expect(result).toContain(a);
    expect(result).toContain("Alpha");
  });

  it("uses raw id when memory missing on single-node path", async () => {
    const result = await handleMemoryPath(memRepo, edgesRepo, {
      from_id: "ghost-id",
      to_id: "ghost-id",
    });
    expect(result).toContain("ghost-id");
  });

  it("describes a multi-hop outgoing path with edge types", async () => {
    const a = store("A");
    const b = store("B");
    const c = store("C");
    edgesRepo.link(a, b, "relates_to");
    edgesRepo.link(b, c, "references");

    const result = await handleMemoryPath(memRepo, edgesRepo, {
      from_id: a,
      to_id: c,
    });
    expect(result).toContain(a);
    expect(result).toContain(b);
    expect(result).toContain(c);
    expect(result).toContain("→ relates_to →");
    expect(result).toContain("→ references →");
  });

  it("describes a path traversed via incoming edge", async () => {
    const a = store("A");
    const b = store("B");
    edgesRepo.link(b, a, "caused_by"); // b -> a, but we want path a -> b

    const result = await handleMemoryPath(memRepo, edgesRepo, {
      from_id: a,
      to_id: b,
    });
    expect(result).toContain("→ caused_by →");
  });

  it("filters by edge_types and returns no path when none match", async () => {
    const a = store("A");
    const b = store("B");
    edgesRepo.link(a, b, "relates_to");

    const result = await handleMemoryPath(memRepo, edgesRepo, {
      from_id: a,
      to_id: b,
      edge_types: ["supersedes"],
    });
    expect(result).toContain("No path");
  });
});
