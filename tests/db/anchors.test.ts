import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { AnchorsRepo } from "../../src/db/anchors.js";

describe("AnchorsRepo", () => {
  let db: ReturnType<typeof createDatabase>;
  let memId: string;
  const dbPath = join(tmpdir(), `memento-anchors-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    const memRepo = new MemoriesRepo(db);
    memId = memRepo.store({
      title: "ADR sample",
      body: "body",
      memoryType: "decision",
      scope: "project",
      projectPath: "/tmp/p-anchor",
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("attaches an anchor with file + line range + commit", () => {
    const repo = new AnchorsRepo(db);
    const inserted = repo.attach({
      memory_id: memId,
      file_path: "src/foo.ts",
      line_start: 10,
      line_end: 20,
      commit_sha: "abc123",
    });
    expect(inserted.status).toBe("fresh");

    const list = repo.listForMemory(memId);
    expect(list).toHaveLength(1);
    expect(list[0].file_path).toBe("src/foo.ts");
    expect(list[0].line_start).toBe(10);
    expect(list[0].commit_sha).toBe("abc123");
  });

  it("rejects anchor with line_end < line_start", () => {
    const repo = new AnchorsRepo(db);
    expect(() =>
      repo.attach({ memory_id: memId, file_path: "x", line_start: 20, line_end: 10 }),
    ).toThrow(/line range/i);
  });

  it("listByFile filters by file_path", () => {
    const repo = new AnchorsRepo(db);
    repo.attach({ memory_id: memId, file_path: "src/a.ts" });
    repo.attach({ memory_id: memId, file_path: "src/b.ts" });
    expect(repo.listByFile("src/a.ts")).toHaveLength(1);
    expect(repo.listByFile("src/missing.ts")).toHaveLength(0);
  });

  it("markStale updates status, stale_since, stale_reason", () => {
    const repo = new AnchorsRepo(db);
    repo.attach({ memory_id: memId, file_path: "src/foo.ts", line_start: 1, line_end: 5 });
    const id = repo.listForMemory(memId)[0].id;
    repo.markStale(id, "5 lines modified since commit abc123");
    const after = repo.listForMemory(memId)[0];
    expect(after.status).toBe("stale");
    expect(after.stale_reason).toMatch(/5 lines/);
    expect(after.stale_since).toBeTruthy();
  });

  it("markStale only updates fresh anchors (no-op on already stale)", () => {
    const repo = new AnchorsRepo(db);
    repo.attach({ memory_id: memId, file_path: "src/foo.ts" });
    const id = repo.listForMemory(memId)[0].id;
    repo.markStale(id, "first reason");
    repo.markStale(id, "second reason");
    const after = repo.listForMemory(memId)[0];
    expect(after.stale_reason).toBe("first reason");
  });

  it("markAnchorDeleted overrides any prior status", () => {
    const repo = new AnchorsRepo(db);
    repo.attach({ memory_id: memId, file_path: "src/gone.ts" });
    const id = repo.listForMemory(memId)[0].id;
    repo.markAnchorDeleted(id, "file removed");
    const after = repo.listForMemory(memId)[0];
    expect(after.status).toBe("anchor-deleted");
    expect(after.stale_reason).toMatch(/removed/);
  });

  it("detach removes the anchor row", () => {
    const repo = new AnchorsRepo(db);
    repo.attach({ memory_id: memId, file_path: "src/foo.ts" });
    const id = repo.listForMemory(memId)[0].id;
    repo.detach(id);
    expect(repo.listForMemory(memId)).toHaveLength(0);
  });

  it("ON DELETE CASCADE: deleting parent memory removes anchors", () => {
    const repo = new AnchorsRepo(db);
    repo.attach({ memory_id: memId, file_path: "src/foo.ts" });
    db.prepare("DELETE FROM memories WHERE id = ?").run(memId);
    expect(repo.listForMemory(memId)).toHaveLength(0);
  });
});
