import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { AnchorsRepo } from "../../src/db/anchors.js";
import { handleMemoryStore } from "../../src/tools/memory-store.js";
import { runAnchorsCheck } from "../../src/cli/anchors.js";

describe("runAnchorsCheck (P4 Task 6)", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let anchorRepo: AnchorsRepo;
  let dbPath: string;
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "p4-cli-"));
    execSync("git init -q", { cwd: repoDir });
    execSync('git config user.email "t@t.com"', { cwd: repoDir });
    execSync('git config user.name "t"', { cwd: repoDir });
    execSync("git config commit.gpgsign false", { cwd: repoDir });
    mkdirSync(join(repoDir, "src"));
    writeFileSync(
      join(repoDir, "src", "foo.ts"),
      "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n",
    );
    execSync("git add . && git commit -q -m initial", { cwd: repoDir });

    dbPath = join(tmpdir(), `memento-anchors-cli-${Date.now()}.sqlite`);
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    anchorRepo = new AnchorsRepo(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("marks stale when ≥30% of anchored range is modified", async () => {
    await handleMemoryStore(memRepo, {
      title: "x", content: "y",
      project_path: repoDir,
      anchors: [{ file_path: "src/foo.ts", line_start: 1, line_end: 10 }],
    }, db);

    // Modify lines 1..6 (60% of range)
    writeFileSync(
      join(repoDir, "src", "foo.ts"),
      "L1\nL2\nL3\nL4\nL5\nL6\nline7\nline8\nline9\nline10\n",
    );
    execSync("git add . && git commit -q -m modify", { cwd: repoDir });

    const summary = runAnchorsCheck({ db, projectPath: repoDir });
    expect(summary.scanned).toBe(1);
    expect(summary.stale).toBe(1);
    expect(summary.deleted).toBe(0);
    expect(summary.fresh).toBe(0);

    const anchors = anchorRepo.listByFile("src/foo.ts");
    expect(anchors[0].status).toBe("stale");
    expect(anchors[0].stale_reason).toMatch(/lines modified/);
  });

  it("marks anchor-deleted when file is removed", async () => {
    await handleMemoryStore(memRepo, {
      title: "x", content: "y",
      project_path: repoDir,
      anchors: [{ file_path: "src/foo.ts", line_start: 1, line_end: 10 }],
    }, db);

    rmSync(join(repoDir, "src", "foo.ts"));
    execSync("git add -A && git commit -q -m remove", { cwd: repoDir });

    const summary = runAnchorsCheck({ db, projectPath: repoDir });
    expect(summary.deleted).toBe(1);
    expect(summary.stale).toBe(0);

    const anchors = anchorRepo.listByFile("src/foo.ts");
    expect(anchors[0].status).toBe("anchor-deleted");
  });

  it("keeps anchors fresh when range is untouched", async () => {
    await handleMemoryStore(memRepo, {
      title: "x", content: "y",
      project_path: repoDir,
      anchors: [{ file_path: "src/foo.ts", line_start: 8, line_end: 10 }],
    }, db);

    // Modify lines 1-3 only; range 8-10 untouched
    writeFileSync(
      join(repoDir, "src", "foo.ts"),
      "X1\nX2\nX3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n",
    );
    execSync("git add . && git commit -q -m partial", { cwd: repoDir });

    const summary = runAnchorsCheck({ db, projectPath: repoDir });
    expect(summary.fresh).toBe(1);
    expect(summary.stale).toBe(0);

    const anchors = anchorRepo.listByFile("src/foo.ts");
    expect(anchors[0].status).toBe("fresh");
  });

  it("file-only anchor (no line range) stays fresh while file exists", async () => {
    await handleMemoryStore(memRepo, {
      title: "x", content: "y",
      project_path: repoDir,
      anchors: [{ file_path: "src/foo.ts" }],
    }, db);

    const summary = runAnchorsCheck({ db, projectPath: repoDir });
    expect(summary.fresh).toBe(1);
  });

  it("returns zero counts and exits cleanly when project is not a git repo", () => {
    const nonGit = mkdtempSync(join(tmpdir(), "p4-nogit-"));
    try {
      const summary = runAnchorsCheck({ db, projectPath: nonGit });
      expect(summary.scanned).toBe(0);
      expect(summary.notGitRepo).toBe(true);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });
});
