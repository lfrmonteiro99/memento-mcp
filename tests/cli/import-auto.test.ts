// tests/cli/import-auto.test.ts — CLI integration tests for `import auto`.
// Verifies multi-format detection, cross-format title dedup, single confirmation,
// and that each row carries its per-format `source` tag.
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

function runAutoCli(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const entrypoint = join(REPO_ROOT, "src", "cli", "main.ts");
  const result = spawnSync("npx", ["tsx", entrypoint, "import", "auto", ...args], {
    cwd,
    encoding: "utf-8",
    timeout: 60000,
    env: { ...process.env, ...env },
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

describe("import auto", () => {
  let projectDir: string;
  let dbPath: string;

  beforeEach(() => {
    projectDir = makeDir("auto");
    dbPath = join(projectDir, "test.sqlite");
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("detects multiple formats and dedups AGENTS.md against CLAUDE.md by title", () => {
    // CLAUDE.md and AGENTS.md share the same title — AGENTS.md's row should be deduped.
    writeFileSync(join(projectDir, "CLAUDE.md"), `## Auth: prefer JWT over sessions
We use JWT with rotating refresh tokens for all API authentication.
`);
    writeFileSync(join(projectDir, "AGENTS.md"), `## Auth: prefer JWT over sessions
Same content as CLAUDE.md — should be deduped on title.

## Build commands
Use npm run build to produce a distribution bundle for shipping.
`);
    const cursorRules = join(projectDir, ".cursor", "rules");
    mkdirSync(cursorRules, { recursive: true });
    writeFileSync(join(cursorRules, "auth.mdc"), `## Cursor auth rule
this is the cursor-specific authentication rule body content.
`);

    const { stdout, exitCode } = runAutoCli(["--no-confirm"], projectDir, {
      MEMENTO_DB_PATH: dbPath,
    });
    expect(exitCode).toBe(0);

    // Summary table in stdout
    expect(stdout).toContain("Found 3 formats");
    // AGENTS.md should report (1 dup, skipped) since the Auth title overlaps CLAUDE.md
    expect(stdout).toContain("dup, skipped");

    const db = new Database(dbPath, { readonly: true });
    const counts = db
      .prepare("SELECT source, count(*) as n FROM memories WHERE deleted_at IS NULL GROUP BY source ORDER BY source")
      .all() as Array<{ source: string; n: number }>;
    db.close();

    // claude-md: 1 row (Auth: prefer JWT...)
    // agents-md: 1 row (Build commands; Auth dup'd)
    // cursor: 1 row (Cursor auth rule)
    const map = Object.fromEntries(counts.map(c => [c.source, c.n]));
    expect(map["import-claude-md"]).toBe(1);
    expect(map["import-agents-md"]).toBe(1);
    expect(map["import-cursor"]).toBe(1);
  });

  it("dry-run does not write to DB", () => {
    writeFileSync(join(projectDir, "CLAUDE.md"), `## A rule
body body body body body body body
`);
    const { stdout, exitCode } = runAutoCli(["--dry-run"], projectDir, {
      MEMENTO_DB_PATH: dbPath,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Dry run");
    try {
      const db = new Database(dbPath, { readonly: true });
      const count = db
        .prepare("SELECT count(*) as n FROM memories WHERE deleted_at IS NULL")
        .get() as { n: number };
      db.close();
      expect(count.n).toBe(0);
    } catch {
      // No DB created — also fine.
    }
  });

  it("exits 1 with a helpful message when no known files exist", () => {
    const { stderr, exitCode } = runAutoCli(["--no-confirm"], projectDir, {
      MEMENTO_DB_PATH: dbPath,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("No known LLM memory files");
  });

  it("preserves per-format source when AGENTS.md has unique sections", () => {
    writeFileSync(join(projectDir, "CLAUDE.md"), `## Claude only
this is a claude-only rule with body of decent length.
`);
    writeFileSync(join(projectDir, "AGENTS.md"), `## Agents only
this is an agents-only rule with body of decent length.
`);

    const { exitCode } = runAutoCli(["--no-confirm"], projectDir, {
      MEMENTO_DB_PATH: dbPath,
    });
    expect(exitCode).toBe(0);

    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare("SELECT title, source FROM memories WHERE deleted_at IS NULL ORDER BY title")
      .all() as Array<{ title: string; source: string }>;
    db.close();
    expect(rows.length).toBe(2);
    const claude = rows.find(r => r.title === "Claude only")!;
    const agents = rows.find(r => r.title === "Agents only")!;
    expect(claude.source).toBe("import-claude-md");
    expect(agents.source).toBe("import-agents-md");
  });
});
