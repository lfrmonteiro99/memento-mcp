import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { AnchorsRepo } from "../../src/db/anchors.js";
import { handleMemoryStore } from "../../src/tools/memory-store.js";
import { handleMemoryUpdate } from "../../src/tools/memory-update.js";

describe("memory_store / memory_update with anchors (P4 Task 5)", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let anchorRepo: AnchorsRepo;
  let dbPath: string;
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "p4-store-"));
    execSync("git init -q", { cwd: repoDir });
    execSync('git config user.email "t@t.com"', { cwd: repoDir });
    execSync('git config user.name "t"', { cwd: repoDir });
    execSync("git config commit.gpgsign false", { cwd: repoDir });
    writeFileSync(join(repoDir, "src", "..", "seed.txt"), "x\n", { flag: "w" });
    execSync("git add seed.txt && git commit -q -m initial", { cwd: repoDir });

    dbPath = join(tmpdir(), `memento-anchors-store-${Date.now()}.sqlite`);
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    anchorRepo = new AnchorsRepo(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("memory_store with anchors persists rows in memory_anchors and auto-populates commit_sha in a git repo", async () => {
    const result = await handleMemoryStore(memRepo, {
      title: "ADR: use OAuth2",
      content: "decision body",
      memory_type: "decision",
      project_path: repoDir,
      anchors: [
        { file_path: "src/auth.ts", line_start: 10, line_end: 25 },
        { file_path: "src/middleware/auth.ts" },
      ],
    }, db);

    const idMatch = result.match(/ID:\s+([a-f0-9-]{36})/);
    expect(idMatch).toBeTruthy();
    const memId = idMatch![1];

    const list = anchorRepo.listForMemory(memId);
    expect(list).toHaveLength(2);
    expect(list[0].file_path).toBe("src/auth.ts");
    expect(list[0].line_start).toBe(10);
    expect(list[0].commit_sha).toMatch(/^[a-f0-9]{40}$/);
    expect(list[1].file_path).toBe("src/middleware/auth.ts");
    expect(list[1].commit_sha).toMatch(/^[a-f0-9]{40}$/);
  });

  it("memory_store skips commit_sha when project_path is not a git repo", async () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), "p4-nogit-"));
    try {
      const result = await handleMemoryStore(memRepo, {
        title: "x",
        content: "y",
        project_path: nonGitDir,
        anchors: [{ file_path: "foo.ts" }],
      }, db);
      const memId = result.match(/ID:\s+([a-f0-9-]{36})/)![1];
      const list = anchorRepo.listForMemory(memId);
      expect(list).toHaveLength(1);
      expect(list[0].commit_sha).toBeNull();
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it("memory_update add_anchors appends anchors", async () => {
    const stored = await handleMemoryStore(memRepo, {
      title: "original", content: "body", project_path: repoDir,
    }, db);
    const memId = stored.match(/ID:\s+([a-f0-9-]{36})/)![1];

    await handleMemoryUpdate(memRepo, {
      memory_id: memId,
      add_anchors: [{ file_path: "src/added.ts", line_start: 1, line_end: 5 }],
      project_path: repoDir,
    }, undefined, undefined, db);

    const list = anchorRepo.listForMemory(memId);
    expect(list).toHaveLength(1);
    expect(list[0].file_path).toBe("src/added.ts");
  });

  it("memory_update remove_anchors detaches by id", async () => {
    const stored = await handleMemoryStore(memRepo, {
      title: "x", content: "y", project_path: repoDir,
      anchors: [
        { file_path: "src/a.ts" },
        { file_path: "src/b.ts" },
      ],
    }, db);
    const memId = stored.match(/ID:\s+([a-f0-9-]{36})/)![1];
    const before = anchorRepo.listForMemory(memId);
    expect(before).toHaveLength(2);

    await handleMemoryUpdate(memRepo, {
      memory_id: memId,
      remove_anchor_ids: [before[0].id],
    }, undefined, undefined, db);

    const after = anchorRepo.listForMemory(memId);
    expect(after).toHaveLength(1);
    expect(after[0].file_path).toBe("src/b.ts");
  });
});
