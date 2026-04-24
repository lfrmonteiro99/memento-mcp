import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { handleMemoryUpdate } from "../../src/tools/memory-update.js";

describe("memory_update tool", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  const dbPath = join(tmpdir(), `memento-mu-tool-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("updates title + body", async () => {
    const id = memRepo.store({ title: "old", body: "old body", memoryType: "fact", scope: "global" });
    const out = await handleMemoryUpdate(memRepo, {
      memory_id: id,
      title: "new title",
      content: "new body",
    });
    expect(out.toLowerCase()).toContain("updated");
    const row = memRepo.getById(id);
    expect(row.title).toBe("new title");
    expect(row.body).toBe("new body");
  });

  it("updates tags (JSON) and importance", async () => {
    const id = memRepo.store({ title: "t", body: "b", memoryType: "fact", scope: "global", tags: ["a"] });
    await handleMemoryUpdate(memRepo, { memory_id: id, tags: ["x", "y"], importance: 0.9 });
    const row = memRepo.getById(id);
    expect(JSON.parse(row.tags)).toEqual(["x", "y"]);
    expect(row.importance_score).toBeCloseTo(0.9);
  });

  it("leaves unchanged fields alone", async () => {
    const id = memRepo.store({ title: "t", body: "b", memoryType: "fact", scope: "global", importance: 0.7 });
    await handleMemoryUpdate(memRepo, { memory_id: id, title: "renamed" });
    const row = memRepo.getById(id);
    expect(row.title).toBe("renamed");
    expect(row.body).toBe("b");
    expect(row.importance_score).toBeCloseTo(0.7);
  });

  it("returns not-found for unknown id", async () => {
    const out = await handleMemoryUpdate(memRepo, { memory_id: "no-such-id", title: "x" });
    expect(out.toLowerCase()).toMatch(/not found/);
  });

  it("rejects update on deleted memory", async () => {
    const id = memRepo.store({ title: "t", body: "b", memoryType: "fact", scope: "global" });
    memRepo.delete(id);
    const out = await handleMemoryUpdate(memRepo, { memory_id: id, title: "nope" });
    expect(out.toLowerCase()).toMatch(/not found/);
  });

  it("refuses empty patch", async () => {
    const id = memRepo.store({ title: "t", body: "b", memoryType: "fact", scope: "global" });
    const out = await handleMemoryUpdate(memRepo, { memory_id: id });
    expect(out.toLowerCase()).toMatch(/no fields/);
  });

  it("bumps updated_at", async () => {
    const id = memRepo.store({ title: "t", body: "b", memoryType: "fact", scope: "global" });
    const before = memRepo.getById(id).updated_at;
    await new Promise(r => setTimeout(r, 1100));
    await handleMemoryUpdate(memRepo, { memory_id: id, title: "later" });
    const after = memRepo.getById(id).updated_at;
    expect(after).not.toBe(before);
  });
});
