import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { handleMemoryPin } from "../../src/tools/memory-pin.js";

describe("memory_pin tool", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  const dbPath = join(tmpdir(), `memento-pin-tool-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("pins a memory", async () => {
    const id = memRepo.store({ title: "t", body: "b", memoryType: "fact", scope: "global" });
    const out = await handleMemoryPin(memRepo, { memory_id: id, pinned: true });
    expect(out.toLowerCase()).toContain("pinned");
    const row = memRepo.getById(id);
    expect(row.is_pinned).toBe(1);
  });

  it("unpins a memory", async () => {
    const id = memRepo.store({ title: "t", body: "b", memoryType: "fact", scope: "global", pin: true });
    expect(memRepo.getById(id).is_pinned).toBe(1);
    const out = await handleMemoryPin(memRepo, { memory_id: id, pinned: false });
    expect(out.toLowerCase()).toContain("unpinned");
    expect(memRepo.getById(id).is_pinned).toBe(0);
  });

  it("returns not-found for unknown id", async () => {
    const out = await handleMemoryPin(memRepo, { memory_id: "missing", pinned: true });
    expect(out.toLowerCase()).toContain("not found");
  });
});
