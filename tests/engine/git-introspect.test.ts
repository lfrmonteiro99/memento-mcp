import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasGit,
  currentCommitSha,
  fileExistsAtCommit,
  linesChangedSince,
} from "../../src/engine/git-introspect.js";

let repoDir: string;
let initialSha: string;

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), "git-introspect-"));
  execSync("git init -q", { cwd: repoDir });
  execSync('git config user.email "t@t.com"', { cwd: repoDir });
  execSync('git config user.name "t"', { cwd: repoDir });
  execSync("git config commit.gpgsign false", { cwd: repoDir });
  writeFileSync(join(repoDir, "a.txt"), "line1\nline2\nline3\nline4\nline5\n");
  execSync("git add a.txt && git commit -q -m initial", { cwd: repoDir });
  initialSha = execSync("git rev-parse HEAD", { cwd: repoDir }).toString().trim();
});

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe("git-introspect", () => {
  it("hasGit returns true inside a git repo", () => {
    expect(hasGit(repoDir)).toBe(true);
  });

  it("hasGit returns false outside a git repo", () => {
    const outside = mkdtempSync(join(tmpdir(), "no-git-"));
    try {
      expect(hasGit(outside)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("currentCommitSha returns 40-char hex", () => {
    expect(currentCommitSha(repoDir)).toMatch(/^[a-f0-9]{40}$/);
  });

  it("fileExistsAtCommit returns true for tracked file", () => {
    expect(fileExistsAtCommit(repoDir, "a.txt", initialSha)).toBe(true);
  });

  it("fileExistsAtCommit returns false for missing file", () => {
    expect(fileExistsAtCommit(repoDir, "nope.txt", initialSha)).toBe(false);
  });

  it("linesChangedSince detects changes inside the requested range", () => {
    writeFileSync(join(repoDir, "a.txt"), "line1\nLINE2\nLINE3\nline4\nline5\n");
    execSync("git add a.txt && git commit -q -m mod", { cwd: repoDir });
    const changed = linesChangedSince(repoDir, "a.txt", initialSha, 2, 3);
    expect(changed).toBeGreaterThanOrEqual(2);
  });

  it("linesChangedSince returns 0 when range is unchanged", () => {
    // After previous test, lines 4-5 are unchanged from initial.
    const changed = linesChangedSince(repoDir, "a.txt", initialSha, 4, 5);
    expect(changed).toBe(0);
  });
});
