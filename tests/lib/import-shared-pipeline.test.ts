// tests/lib/import-shared-pipeline.test.ts
// Coverage for runImportPipeline — the policy/dedup/store loop.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { runImportPipeline } from "../../src/lib/import-shared.js";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";

describe("runImportPipeline", () => {
  let dbPath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `pipeline-${process.pid}-${randomUUID()}.sqlite`);
    process.env.MEMENTO_DB_PATH = dbPath;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    delete process.env.MEMENTO_DB_PATH;
    rmSync(dbPath, { force: true });
  });

  it("dry-run prints summary and writes nothing", async () => {
    const counts = await runImportPipeline({
      sections: [
        { title: "Test A", body: "body A", inferredType: "fact", inferredTags: ["t1"] },
        { title: "Test B", body: "body B", inferredType: "fact", inferredTags: [] },
      ],
      skipped: [{ reason: "too-short", preview: "skip preview" }],
      scope: "global",
      source: "import-test",
      dryRun: true,
      noConfirm: true,
      sourceLabel: "fixture.md",
    });
    expect(counts).toEqual({ created: 0, dupes: 0, policyBlocked: 0 });
    // No DB should have been opened in dry-run mode.
    expect(logSpy).toHaveBeenCalled();
    const printed = logSpy.mock.calls.map(c => c.join(" ")).join("\n");
    expect(printed).toContain("Found 2 sections");
    expect(printed).toContain("Dry run");
  });

  it("stores sections and reports created count", async () => {
    const counts = await runImportPipeline({
      sections: [
        { title: "First", body: "body 1", inferredType: "fact", inferredTags: [] },
        { title: "Second", body: "body 2", inferredType: "preference", inferredTags: ["a"] },
      ],
      skipped: [],
      scope: "global",
      source: "import-pipeline-test",
      dryRun: false,
      noConfirm: true,
      sourceLabel: "fixtures/",
    });
    expect(counts.created).toBe(2);
    expect(counts.dupes).toBe(0);

    const db = createDatabase(dbPath);
    try {
      const repo = new MemoriesRepo(db);
      const list = repo.list({});
      const titles = list.map(m => m.title).sort();
      expect(titles).toContain("First");
      expect(titles).toContain("Second");
    } finally {
      db.close();
    }
  });

  it("skips duplicate titles already in scope", async () => {
    // Pre-seed an existing memory that should cause the next import to dedup.
    const db = createDatabase(dbPath);
    try {
      const repo = new MemoriesRepo(db);
      repo.store({ title: "First", body: "existing", memoryType: "fact", scope: "global" });
    } finally {
      db.close();
    }

    const counts = await runImportPipeline({
      sections: [
        { title: "First", body: "imported", inferredType: "fact", inferredTags: [] },
        { title: "Second", body: "imported", inferredType: "fact", inferredTags: [] },
      ],
      skipped: [],
      scope: "global",
      source: "import-pipeline-test",
      dryRun: false,
      noConfirm: true,
      sourceLabel: "src",
    });
    expect(counts.created).toBe(1);
    expect(counts.dupes).toBe(1);
  });
});
