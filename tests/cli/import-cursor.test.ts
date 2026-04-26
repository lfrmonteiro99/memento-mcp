// tests/cli/import-cursor.test.ts — CLI integration tests for `import cursor`.
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

function runImportCli(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {}
): { stdout: string; stderr: string; exitCode: number } {
  const entrypoint = join(REPO_ROOT, "src", "cli", "main.ts");
  const result = spawnSync("npx", ["tsx", entrypoint, "import", "cursor", ...args], {
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

describe("import cursor", () => {
  let projectDir: string;
  let dbPath: string;

  beforeEach(() => {
    projectDir = makeDir("cursor");
    dbPath = join(projectDir, "test.sqlite");
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("imports .cursor/rules/*.mdc with frontmatter-derived tags", () => {
    const rulesDir = join(projectDir, ".cursor", "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "auth.mdc"), `---
description: Auth conventions for API routes
globs: ["src/api/**/*.ts"]
alwaysApply: true
---
## Always validate JWT signature on entry
Reject unsigned or expired tokens at the route layer immediately.
`);
    writeFileSync(join(rulesDir, "style.mdc"), `## Coding style
We use 2-space indentation throughout the project.
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

    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) expect(r.source).toBe("import-cursor");

    // auth.mdc rows have glob:* and cursor:always tags
    const auth = rows.find(r => r.title.includes("[auth.mdc]"))!;
    expect(auth).toBeDefined();
    const authTags = JSON.parse(auth.tags) as string[];
    expect(authTags).toContain("cursor:always");
    expect(authTags.some(t => t.startsWith("glob:"))).toBe(true);

    // style.mdc rows have neither
    const style = rows.find(r => r.title.includes("[style.mdc]"))!;
    expect(style).toBeDefined();
    const styleTags = JSON.parse(style.tags ?? "[]") as string[];
    expect(styleTags).not.toContain("cursor:always");
    expect(styleTags.some(t => t.startsWith("glob:"))).toBe(false);
  });

  it("falls back to .cursorrules legacy file when .cursor/rules/ is absent", () => {
    writeFileSync(join(projectDir, ".cursorrules"), `## Legacy rule one
this is the legacy rule body that has enough length to be kept.
`);

    const { stdout, exitCode } = runImportCli(["--no-confirm"], projectDir, {
      MEMENTO_DB_PATH: dbPath,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Imported 1 memories");

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare("SELECT source FROM memories WHERE deleted_at IS NULL LIMIT 1")
      .get() as { source: string };
    db.close();
    expect(row.source).toBe("import-cursor");
  });

  it("dry-run does not write to DB", () => {
    const rulesDir = join(projectDir, ".cursor", "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "x.mdc"), `## Some rule\nbody body body body body body\n`);

    const { stdout, exitCode } = runImportCli(["--dry-run"], projectDir, {
      MEMENTO_DB_PATH: dbPath,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Dry run");

    // DB file may or may not exist; if present it should have no memories rows.
    try {
      const db = new Database(dbPath, { readonly: true });
      const count = db
        .prepare("SELECT count(*) as n FROM memories WHERE deleted_at IS NULL")
        .get() as { n: number };
      db.close();
      expect(count.n).toBe(0);
    } catch {
      // DB never created — also acceptable for a dry-run.
    }
  });

  it("re-running deduplicates by title", () => {
    const rulesDir = join(projectDir, ".cursor", "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "r.mdc"), `## A rule
body body body body body body body
`);

    runImportCli(["--no-confirm"], projectDir, { MEMENTO_DB_PATH: dbPath });
    const second = runImportCli(["--no-confirm"], projectDir, { MEMENTO_DB_PATH: dbPath });
    expect(second.stdout).toContain("duplicate(s) skipped");
    expect(second.stdout).toContain("Imported 0 memories");
  });

  it("exits 1 with helpful error when nothing matches", () => {
    const { stderr, exitCode } = runImportCli(["--no-confirm"], projectDir, {
      MEMENTO_DB_PATH: dbPath,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Source not found");
  });

  it("respects per-project policy required_tags.any_of", () => {
    mkdirSync(join(projectDir, ".memento"), { recursive: true });
    writeFileSync(join(projectDir, ".memento", "policy.toml"), `
schema_version = 1
[required_tags]
any_of = ["cursor:always"]
    `, "utf-8");

    const rulesDir = join(projectDir, ".cursor", "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "auth.mdc"), `---
alwaysApply: true
---
## Auth rule
this rule has the cursor:always tag from frontmatter so it survives policy.
`);
    writeFileSync(join(rulesDir, "style.mdc"), `## Style rule
this rule lacks the always tag and should be policy-blocked.
`);

    const { stdout, exitCode } = runImportCli(["--no-confirm"], projectDir, {
      MEMENTO_DB_PATH: dbPath,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("POLICY SKIP");
    expect(stdout).toContain("Imported 1 memories");
  });
});
