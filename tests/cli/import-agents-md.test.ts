// tests/cli/import-agents-md.test.ts — CLI integration tests for `import agents-md`.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";

const TMP = tmpdir();
const REPO_ROOT = new URL("../../", import.meta.url).pathname;

function makeDir(name: string): string {
  const dir = join(TMP, `import-${name}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runImportCli(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const entrypoint = join(REPO_ROOT, "src", "cli", "main.ts");
  const result = spawnSync("npx", ["tsx", entrypoint, "import", "agents-md", ...args], {
    cwd,
    encoding: "utf-8",
    timeout: 30000,
    env: { ...process.env, ...env },
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

describe("import agents-md", () => {
  let projectDir: string;
  let dbPath: string;

  beforeEach(() => {
    projectDir = makeDir("agents");
    dbPath = join(projectDir, "test.sqlite");
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("imports AGENTS.md at the project root with source=import-agents-md", () => {
    writeFileSync(join(projectDir, "AGENTS.md"), `## Coding guidelines
Always use 2-space indentation throughout the project source files.

## Build commands
Use npm run build to produce a distribution bundle from source.
`);

    const { stdout, exitCode } = runImportCli(["--no-confirm"], projectDir, {
      MEMENTO_DB_PATH: dbPath,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Imported 2 memories");

    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare("SELECT source FROM memories WHERE deleted_at IS NULL")
      .all() as Array<{ source: string }>;
    db.close();
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.source).toBe("import-agents-md");
  });

  it("walks up to find AGENTS.md from a nested cwd", () => {
    writeFileSync(join(projectDir, "AGENTS.md"), `## A rule
this is the body of the rule that has plenty of length.
`);
    const nested = join(projectDir, "sub", "deeper");
    mkdirSync(nested, { recursive: true });

    const { stdout, exitCode } = runImportCli(["--no-confirm"], nested, {
      MEMENTO_DB_PATH: dbPath,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Imported 1 memories");
  });

  it("exits 1 when no AGENTS.md anywhere", () => {
    const { stderr, exitCode } = runImportCli(["--no-confirm"], projectDir, {
      MEMENTO_DB_PATH: dbPath,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("not found");
  });
});
