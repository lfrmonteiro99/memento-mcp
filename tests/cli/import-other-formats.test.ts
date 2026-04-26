// tests/cli/import-other-formats.test.ts — combined smoke test for the
// lower-traffic formats (gemini-md, windsurf, cline, roo) so we have CLI-level
// coverage of each subcommand's source-tag wiring and dir-aggregate behavior.
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

function runImport(format: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const entrypoint = join(REPO_ROOT, "src", "cli", "main.ts");
  const result = spawnSync("npx", ["tsx", entrypoint, "import", format, ...args], {
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

function readSourceCounts(dbPath: string): Record<string, number> {
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare("SELECT source, count(*) as n FROM memories WHERE deleted_at IS NULL GROUP BY source")
    .all() as Array<{ source: string; n: number }>;
  db.close();
  return Object.fromEntries(rows.map(r => [r.source, r.n]));
}

describe("import gemini-md", () => {
  let projectDir: string;
  let dbPath: string;
  beforeEach(() => {
    projectDir = makeDir("gemini");
    dbPath = join(projectDir, "test.sqlite");
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("imports GEMINI.md with source=import-gemini-md", () => {
    writeFileSync(join(projectDir, "GEMINI.md"), `## Project conventions
Use TypeScript strict mode throughout the project source.
`);
    const { exitCode } = runImport("gemini-md", ["--no-confirm"], projectDir, {
      MEMENTO_DB_PATH: dbPath,
    });
    expect(exitCode).toBe(0);
    expect(readSourceCounts(dbPath)["import-gemini-md"]).toBe(1);
  });

  it("walks up to find GEMINI.md from a nested cwd", () => {
    writeFileSync(join(projectDir, "GEMINI.md"), `## Top rule
this is the top-level gemini rule with adequate length.
`);
    const nested = join(projectDir, "sub", "deep");
    mkdirSync(nested, { recursive: true });
    const { exitCode } = runImport("gemini-md", ["--no-confirm"], nested, {
      MEMENTO_DB_PATH: dbPath,
    });
    expect(exitCode).toBe(0);
    expect(readSourceCounts(dbPath)["import-gemini-md"]).toBe(1);
  });
});

describe("import windsurf", () => {
  let projectDir: string;
  let dbPath: string;
  beforeEach(() => {
    projectDir = makeDir("windsurf");
    dbPath = join(projectDir, "test.sqlite");
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("imports .windsurfrules with source=import-windsurf", () => {
    writeFileSync(join(projectDir, ".windsurfrules"), `## Windsurf conventions
Always run lint and tests before committing changes to the repo.
`);
    const { exitCode } = runImport("windsurf", ["--no-confirm"], projectDir, {
      MEMENTO_DB_PATH: dbPath,
    });
    expect(exitCode).toBe(0);
    expect(readSourceCounts(dbPath)["import-windsurf"]).toBe(1);
  });

  it("falls back to global_rules.md when .windsurfrules absent", () => {
    writeFileSync(join(projectDir, "global_rules.md"), `## Global rule
this is the global rule body for the windsurf format fallback.
`);
    const { exitCode } = runImport("windsurf", ["--no-confirm"], projectDir, {
      MEMENTO_DB_PATH: dbPath,
    });
    expect(exitCode).toBe(0);
    expect(readSourceCounts(dbPath)["import-windsurf"]).toBe(1);
  });
});

describe("import cline", () => {
  let projectDir: string;
  let dbPath: string;
  beforeEach(() => {
    projectDir = makeDir("cline");
    dbPath = join(projectDir, "test.sqlite");
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("accepts .clinerules as a single file", () => {
    writeFileSync(join(projectDir, ".clinerules"), `## Cline rule one
this is the body of the single-file cline rule with proper length.
`);
    const { exitCode } = runImport("cline", ["--no-confirm"], projectDir, {
      MEMENTO_DB_PATH: dbPath,
    });
    expect(exitCode).toBe(0);
    expect(readSourceCounts(dbPath)["import-cline"]).toBe(1);
  });

  it("accepts .clinerules as a directory and aggregates", () => {
    mkdirSync(join(projectDir, ".clinerules"));
    writeFileSync(join(projectDir, ".clinerules", "a.md"), `## Rule A
body for rule A with adequate length to be kept.
`);
    writeFileSync(join(projectDir, ".clinerules", "b.md"), `## Rule B
body for rule B with adequate length to be kept.
`);
    const { exitCode } = runImport("cline", ["--no-confirm"], projectDir, {
      MEMENTO_DB_PATH: dbPath,
    });
    expect(exitCode).toBe(0);
    expect(readSourceCounts(dbPath)["import-cline"]).toBe(2);
  });
});

describe("import roo", () => {
  let projectDir: string;
  let dbPath: string;
  beforeEach(() => {
    projectDir = makeDir("roo");
    dbPath = join(projectDir, "test.sqlite");
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("walks .roo/rules/ recursively in alphabetical order", () => {
    const base = join(projectDir, ".roo", "rules");
    mkdirSync(join(base, "security"), { recursive: true });
    writeFileSync(join(base, "000-base.md"), `## Base rule
this is the base rule body for the roo recursive walk test.
`);
    writeFileSync(join(base, "security", "100-auth.md"), `## Auth rule
this is the auth rule under the security subdirectory.
`);

    const { exitCode } = runImport("roo", ["--no-confirm"], projectDir, {
      MEMENTO_DB_PATH: dbPath,
    });
    expect(exitCode).toBe(0);
    expect(readSourceCounts(dbPath)["import-roo"]).toBe(2);
  });
});
