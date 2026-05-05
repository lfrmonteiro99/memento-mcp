import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { AnchorsRepo } from "../../src/db/anchors.js";
import { handleMemoryStore } from "../../src/tools/memory-store.js";
import { processAnchorStaleness } from "../../src/hooks/anchor-staleness.js";

describe("processAnchorStaleness (P4 Task 8)", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let anchorRepo: AnchorsRepo;
  let dbPath: string;
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "p4-hook-"));
    execSync("git init -q", { cwd: repoDir });
    execSync('git config user.email "t@t.com"', { cwd: repoDir });
    execSync('git config user.name "t"', { cwd: repoDir });
    execSync("git config commit.gpgsign false", { cwd: repoDir });
    mkdirSync(join(repoDir, "src"));
    writeFileSync(
      join(repoDir, "src", "foo.ts"),
      Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n") + "\n",
    );
    execSync("git add . && git commit -q -m initial", { cwd: repoDir });

    dbPath = join(tmpdir(), `memento-hook-anc-${Date.now()}.sqlite`);
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    anchorRepo = new AnchorsRepo(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("marks affected anchors stale when enabled=true and tool is Edit", async () => {
    await handleMemoryStore(memRepo, {
      title: "x", content: "y",
      project_path: repoDir,
      anchors: [{ file_path: "src/foo.ts", line_start: 5, line_end: 15 }],
    }, db);

    // Modify lines 5..12 (8 of 11 = 73% of range)
    const orig = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    for (let i = 4; i <= 11; i++) orig[i] = `MOD${i}`;
    writeFileSync(join(repoDir, "src", "foo.ts"), orig.join("\n") + "\n");
    execSync("git add . && git commit -q -m modify", { cwd: repoDir });

    processAnchorStaleness(db, {
      enabled: true,
      cwd: repoDir,
      toolName: "Edit",
      filePath: "src/foo.ts",
    });

    const anchors = anchorRepo.listByFile("src/foo.ts");
    expect(anchors[0].status).toBe("stale");
  });

  it("is a no-op when enabled=false", async () => {
    await handleMemoryStore(memRepo, {
      title: "x", content: "y",
      project_path: repoDir,
      anchors: [{ file_path: "src/foo.ts", line_start: 1, line_end: 20 }],
    }, db);

    const orig = Array.from({ length: 20 }, (_, i) => `MOD${i}`);
    writeFileSync(join(repoDir, "src", "foo.ts"), orig.join("\n") + "\n");
    execSync("git add . && git commit -q -m modify", { cwd: repoDir });

    processAnchorStaleness(db, {
      enabled: false,
      cwd: repoDir,
      toolName: "Edit",
      filePath: "src/foo.ts",
    });

    const anchors = anchorRepo.listByFile("src/foo.ts");
    expect(anchors[0].status).toBe("fresh");
  });

  it("is a no-op for non-Edit/Write tools (e.g. Bash)", async () => {
    await handleMemoryStore(memRepo, {
      title: "x", content: "y",
      project_path: repoDir,
      anchors: [{ file_path: "src/foo.ts", line_start: 1, line_end: 20 }],
    }, db);

    processAnchorStaleness(db, {
      enabled: true,
      cwd: repoDir,
      toolName: "Bash",
      filePath: undefined,
    });

    const anchors = anchorRepo.listByFile("src/foo.ts");
    expect(anchors[0].status).toBe("fresh");
  });

  it("matches anchors when hook receives an absolute path but anchor is stored as repo-relative", async () => {
    await handleMemoryStore(memRepo, {
      title: "x", content: "y",
      project_path: repoDir,
      anchors: [{ file_path: "src/foo.ts", line_start: 5, line_end: 15 }],
    }, db);

    const orig = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    for (let i = 4; i <= 11; i++) orig[i] = `MOD${i}`;
    writeFileSync(join(repoDir, "src", "foo.ts"), orig.join("\n") + "\n");
    execSync("git add . && git commit -q -m modify", { cwd: repoDir });

    processAnchorStaleness(db, {
      enabled: true,
      cwd: repoDir,
      toolName: "Edit",
      filePath: join(repoDir, "src", "foo.ts"), // absolute, like Claude Code's Edit tool sends
    });

    const anchors = anchorRepo.listByFile("src/foo.ts");
    expect(anchors[0].status).toBe("stale");
  });

  it("marks anchor-deleted when file removed", async () => {
    await handleMemoryStore(memRepo, {
      title: "x", content: "y",
      project_path: repoDir,
      anchors: [{ file_path: "src/foo.ts", line_start: 1, line_end: 5 }],
    }, db);

    rmSync(join(repoDir, "src", "foo.ts"));
    execSync("git add -A && git commit -q -m remove", { cwd: repoDir });

    processAnchorStaleness(db, {
      enabled: true,
      cwd: repoDir,
      toolName: "Write",
      filePath: "src/foo.ts",
    });

    const anchors = anchorRepo.listByFile("src/foo.ts");
    expect(anchors[0].status).toBe("anchor-deleted");
  });
});
