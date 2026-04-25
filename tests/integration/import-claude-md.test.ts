// tests/integration/import-claude-md.test.ts
// Full CLI flow: write a tmp CLAUDE.md, run import, assert memories created, duplicates skipped, dry-run safe.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";

const TMP = tmpdir();
const REPO_ROOT = new URL("../../", import.meta.url).pathname;

function makeDir(name: string): string {
  const dir = join(TMP, `import-claude-md-${name}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runImportCli(
  extraArgs: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): { stdout: string; stderr: string; exitCode: number } {
  const entrypoint = join(REPO_ROOT, "src", "cli", "main.ts");
  const result = spawnSync(
    "npx",
    ["tsx", entrypoint, "import", "claude-md", ...extraArgs],
    {
      cwd: opts.cwd ?? TMP,
      encoding: "utf-8",
      timeout: 30000,
      env: { ...process.env, ...opts.env },
    }
  );
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

const SAMPLE_CLAUDE_MD = `## Decision: Use TypeScript everywhere
We chose TypeScript because it provides strong typing and better tooling.

## Pattern: Always write tests first
Always write tests before implementing new features. area:testing

## Pitfall: Never use eval in production
Never use eval() because it is a security risk. env:prod
`;

const HEADINGLESS_CLAUDE_MD = `We decided to adopt **PostgreSQL** as our primary database for its JSONB support.

Always prefer async/await over callback-style code for readability and maintainability.

This is short.
`;

describe("import claude-md CLI integration", () => {
  let tmpDir: string;
  let dbPath: string;
  let claudeMdPath: string;

  beforeEach(() => {
    tmpDir = makeDir("test");
    dbPath = join(tmpDir, "test.sqlite");
    claudeMdPath = join(tmpDir, "CLAUDE.md");
    writeFileSync(claudeMdPath, SAMPLE_CLAUDE_MD, "utf-8");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("imports N memories with --no-confirm", () => {
    const { stdout, exitCode } = runImportCli(
      [claudeMdPath, "--no-confirm", "--scope", "project"],
      { env: { MEMENTO_DB_PATH: dbPath } }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Found 3 sections");
    expect(stdout).toContain("Imported 3 memories");
  });

  it("prints section list and inferred types", () => {
    const { stdout, exitCode } = runImportCli(
      [claudeMdPath, "--no-confirm"],
      { env: { MEMENTO_DB_PATH: dbPath } }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("[decision]");
    expect(stdout).toContain("[pattern]");
    expect(stdout).toContain("[pitfall]");
  });

  it("prints tags for sections that have them", () => {
    const { stdout, exitCode } = runImportCli(
      [claudeMdPath, "--no-confirm"],
      { env: { MEMENTO_DB_PATH: dbPath } }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("area:testing");
    expect(stdout).toContain("env:prod");
  });

  it("skips duplicates on re-run", () => {
    // First run
    runImportCli([claudeMdPath, "--no-confirm"], { env: { MEMENTO_DB_PATH: dbPath } });

    // Second run
    const { stdout, exitCode } = runImportCli(
      [claudeMdPath, "--no-confirm"],
      { env: { MEMENTO_DB_PATH: dbPath } }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Imported 0 memories");
    expect(stdout).toContain("3 duplicate(s) skipped");
  });

  it("--dry-run exits 0 without DB writes", () => {
    const { stdout, exitCode } = runImportCli(
      [claudeMdPath, "--dry-run"],
      { env: { MEMENTO_DB_PATH: dbPath } }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Dry run");
    expect(stdout).not.toContain("Imported");
    // DB should not exist (was never opened for writes)
    expect(existsSync(dbPath)).toBe(false);
  });

  it("--dry-run shows section list", () => {
    const { stdout, exitCode } = runImportCli(
      [claudeMdPath, "--dry-run"],
      { env: { MEMENTO_DB_PATH: dbPath } }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Found 3 sections");
    expect(stdout).toContain("[decision]");
  });

  it("exits 1 with error when source file not found", () => {
    const { stderr, exitCode } = runImportCli(
      [join(tmpDir, "nonexistent.md"), "--no-confirm"],
      { env: { MEMENTO_DB_PATH: dbPath } }
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("not found");
  });

  it("imports headingless file via paragraph splitting", () => {
    const headinglessPath = join(tmpDir, "HEADINGLESS.md");
    writeFileSync(headinglessPath, HEADINGLESS_CLAUDE_MD, "utf-8");

    const { stdout, exitCode } = runImportCli(
      [headinglessPath, "--no-confirm"],
      { env: { MEMENTO_DB_PATH: dbPath } }
    );
    expect(exitCode).toBe(0);
    // 3rd paragraph "This is short." is under 20 chars, should be skipped
    expect(stdout).toContain("Found 2 sections");
    expect(stdout).toContain("Skipped 1");
    expect(stdout).toContain("too short");
  });

  it("extracts **ProperNoun** tags from headingless file", () => {
    const headinglessPath = join(tmpDir, "HEADINGLESS.md");
    writeFileSync(headinglessPath, HEADINGLESS_CLAUDE_MD, "utf-8");

    const { stdout, exitCode } = runImportCli(
      [headinglessPath, "--no-confirm"],
      { env: { MEMENTO_DB_PATH: dbPath } }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("postgresql");
  });

  it("--scope global uses ~/.claude/CLAUDE.md as default path (error if absent)", () => {
    // Set a fake HOME where ~/.claude/CLAUDE.md doesn't exist
    const fakeHome = makeDir("fakehome");
    const { stderr, exitCode } = runImportCli(
      ["--scope", "global"],
      { env: { MEMENTO_DB_PATH: dbPath, HOME: fakeHome } }
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("not found");
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("--scope global uses ~/.claude/CLAUDE.md when it exists", () => {
    const fakeHome = makeDir("fakehome");
    const claudeDir = join(fakeHome, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "CLAUDE.md"), SAMPLE_CLAUDE_MD, "utf-8");

    const { stdout, exitCode } = runImportCli(
      ["--scope", "global", "--no-confirm"],
      { env: { MEMENTO_DB_PATH: dbPath, HOME: fakeHome } }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Found 3 sections");
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("--type overrides defaultType for sections without matching keywords", () => {
    const simpleFile = join(tmpDir, "simple.md");
    writeFileSync(simpleFile, `## Random note about the project\nThis is just a fact about how we structure code repositories.`, "utf-8");

    const { stdout, exitCode } = runImportCli(
      [simpleFile, "--no-confirm", "--type", "preference"],
      { env: { MEMENTO_DB_PATH: dbPath } }
    );
    expect(exitCode).toBe(0);
    // No type hint keyword matches "Random note about the project" → uses defaultType
    expect(stdout).toContain("[preference]");
  });
});
