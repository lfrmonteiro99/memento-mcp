import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { handleMemoryCompress } from "../../src/tools/memory-compress.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";

describe("memory_compress tool", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  const dbPath = join(tmpdir(), `memento-mc-tool-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("compresses clusters for a specific project and reports counts", async () => {
    const projectPath = "/mc-proj";
    memRepo.ensureProject(projectPath);
    for (let i = 0; i < 4; i++) {
      memRepo.store({
        title: `Edit: api.ts - change ${i}`,
        body: `Adjusted api.ts endpoint ${i} with improved error handling logic`,
        memoryType: "fact",
        scope: "project",
        projectPath,
        tags: ["edit", "api"],
      });
    }

    const out = await handleMemoryCompress(db, DEFAULT_CONFIG, { project_path: projectPath });
    expect(out).toMatch(/compress/i);
    expect(out).toMatch(/\d+ cluster/);
  });

  it("returns a friendly message when nothing to compress", async () => {
    const projectPath = "/empty-proj";
    memRepo.ensureProject(projectPath);
    const out = await handleMemoryCompress(db, DEFAULT_CONFIG, { project_path: projectPath });
    expect(out.toLowerCase()).toContain("no");
  });

  it("iterates every project when project_path is empty", async () => {
    memRepo.ensureProject("/p-a");
    memRepo.ensureProject("/p-b");
    for (let i = 0; i < 3; i++) {
      memRepo.store({
        title: `Edit: shared.ts - A${i}`,
        body: `shared.ts change A${i} for feature work`,
        memoryType: "fact",
        scope: "project",
        projectPath: "/p-a",
        tags: ["edit"],
      });
      memRepo.store({
        title: `Edit: shared.ts - B${i}`,
        body: `shared.ts change B${i} for refactor work`,
        memoryType: "fact",
        scope: "project",
        projectPath: "/p-b",
        tags: ["edit"],
      });
    }

    const out = await handleMemoryCompress(db, DEFAULT_CONFIG, {});
    expect(out).toMatch(/project/);
  });

  it("respects config.compression.enabled=false", async () => {
    const disabled = structuredClone(DEFAULT_CONFIG);
    disabled.compression.enabled = false;
    const out = await handleMemoryCompress(db, disabled, {});
    expect(out.toLowerCase()).toContain("disabled");
  });
});
