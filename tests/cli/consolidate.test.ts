import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";

describe("memento-mcp consolidate --now (P3 Task 5)", () => {
  let tmpHome: string;
  let dbPath: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "memento-cli-"));
    dbPath = join(tmpHome, "memory.sqlite");

    // Seed a project with old memories so consolidation has work.
    const db = createDatabase(dbPath);
    const memRepo = new MemoriesRepo(db);
    const projectId = memRepo.ensureProject("/tmp/cli-cons-proj");
    for (let i = 0; i < 4; i++) {
      memRepo.store({
        title: `Edit: payments.ts step ${i}`,
        body: `Refactored payments.ts handler ${i} for retry semantics`,
        memoryType: "fact",
        scope: "project",
        projectId,
        tags: ["edit", "payments"],
      });
    }
    db.prepare(
      `UPDATE memories
       SET created_at = '2026-03-04T12:00:00Z',
           last_accessed_at = '2026-03-04T12:00:00Z'
       WHERE project_id = ?`,
    ).run(projectId);
    db.close();
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("exits 0 and writes a finished consolidation_runs row", () => {
    const repoRoot = new URL("../../", import.meta.url).pathname;
    const entry = join(repoRoot, "src", "cli", "main.ts");
    const result = spawnSync(
      "npx",
      ["tsx", entry, "consolidate", "--now"],
      {
        cwd: tmpHome,
        encoding: "utf-8",
        timeout: 60_000,
        env: {
          ...process.env,
          MEMENTO_DB_PATH: dbPath,
          MEMENTO_CONFIG_PATH: join(tmpHome, "no-such-config.toml"),
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/consolidation/i);

    const db = createDatabase(dbPath);
    const runs = db.prepare(
      "SELECT status, merged_count FROM consolidation_runs WHERE status = 'finished'",
    ).all() as Array<{ status: string; merged_count: number }>;
    db.close();
    expect(runs.length).toBeGreaterThanOrEqual(1);
  });
});
