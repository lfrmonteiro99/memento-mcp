// tests/cli/import-copilot.test.ts — CLI integration tests for `import copilot`.
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
  const result = spawnSync("npx", ["tsx", entrypoint, "import", "copilot", ...args], {
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

describe("import copilot", () => {
  let projectDir: string;
  let dbPath: string;

  beforeEach(() => {
    projectDir = makeDir("copilot");
    dbPath = join(projectDir, "test.sqlite");
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("aggregates .github/copilot-instructions.md and .github/instructions/*.md", () => {
    const ghDir = join(projectDir, ".github");
    mkdirSync(join(ghDir, "instructions"), { recursive: true });
    writeFileSync(join(ghDir, "copilot-instructions.md"), `## Test naming
Test files live next to source as *.test.ts always for consistency.
`);
    writeFileSync(join(ghDir, "instructions", "api.instructions.md"), `---
applyTo: "src/api/**"
---
## API responses
Always return the {data, error} envelope from public endpoints.
`);

    const { stdout, exitCode } = runImportCli(["--no-confirm"], projectDir, {
      MEMENTO_DB_PATH: dbPath,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Imported");

    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare("SELECT title, source, tags FROM memories WHERE deleted_at IS NULL ORDER BY title")
      .all() as Array<{ title: string; source: string; tags: string }>;
    db.close();

    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.source).toBe("import-copilot");

    // The path-specific file's section gets a glob:* tag.
    const apiRow = rows.find(r => r.title.includes("API responses") || r.title.includes("api.instructions.md"))!;
    expect(apiRow).toBeDefined();
    const apiTags = JSON.parse(apiRow.tags ?? "[]") as string[];
    expect(apiTags.some(t => t.startsWith("glob:"))).toBe(true);

    // The repo-wide file has no glob tag.
    const topRow = rows.find(r => r.title.includes("Test naming"))!;
    expect(topRow).toBeDefined();
    const topTags = JSON.parse(topRow.tags ?? "[]") as string[];
    expect(topTags.some(t => t.startsWith("glob:"))).toBe(false);
  });

  it("works with only the repo-wide file (no instructions dir)", () => {
    const ghDir = join(projectDir, ".github");
    mkdirSync(ghDir, { recursive: true });
    writeFileSync(join(ghDir, "copilot-instructions.md"), `## A single rule
this rule lives only in the top-level copilot instructions file.
`);

    const { stdout, exitCode } = runImportCli(["--no-confirm"], projectDir, {
      MEMENTO_DB_PATH: dbPath,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Imported 1 memories");
  });

  it("exits 1 when neither file nor dir exists", () => {
    const { stderr, exitCode } = runImportCli(["--no-confirm"], projectDir, {
      MEMENTO_DB_PATH: dbPath,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("not found");
  });
});
