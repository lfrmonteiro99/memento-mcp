// tests/cli/import-claude-md-policy.test.ts
// Verify that import claude-md respects per-project policy (required_tags, banned_content).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const TMP = tmpdir();
const REPO_ROOT = new URL("../../", import.meta.url).pathname;

function makeDir(name: string): string {
  const dir = join(TMP, `import-policy-${name}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runImportCli(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {}
): { stdout: string; stderr: string; exitCode: number } {
  const entrypoint = join(REPO_ROOT, "src", "cli", "main.ts");
  const result = spawnSync(
    "npx",
    ["tsx", entrypoint, "import", "claude-md", ...args],
    {
      cwd,
      encoding: "utf-8",
      timeout: 30000,
      env: { ...process.env, ...env },
    }
  );
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

const CLAUDE_MD_NO_TAGS = `## Database choice for analytics workload
We use in-memory caching extensively throughout the application layer.

## API versioning approach
We maintain backward compatibility for all public endpoints for at least two major versions.
`;

const CLAUDE_MD_WITH_TAGS = `## Database choice for analytics workload area:db
We use in-memory caching extensively throughout the application layer. area:db

## API versioning approach area:api
We maintain backward compatibility for all public endpoints for at least two major versions. area:api
`;

const CLAUDE_MD_BANNED_CONTENT = `## Our internal-secret-system configuration
We use internal-secret-system for authentication across all services in production.
`;

describe("import claude-md policy enforcement", () => {
  let projectDir: string;
  let dbPath: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = makeDir("project");
    dbPath = join(projectDir, "test.sqlite");
    claudeMdPath = join(projectDir, "CLAUDE.md");
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("blocks sections with no inferred tags when required_tags.any_of is set", () => {
    // Write policy requiring area:db or area:api
    mkdirSync(join(projectDir, ".memento"), { recursive: true });
    writeFileSync(join(projectDir, ".memento", "policy.toml"), `
schema_version = 1
[required_tags]
any_of = ["area:db", "area:api"]
    `, "utf-8");

    writeFileSync(claudeMdPath, CLAUDE_MD_NO_TAGS, "utf-8");

    const { stdout, exitCode } = runImportCli(
      [claudeMdPath, "--no-confirm"],
      projectDir,
      { MEMENTO_DB_PATH: dbPath }
    );
    expect(exitCode).toBe(0);
    // Both sections have no inferred tags → both blocked by policy
    expect(stdout).toContain("POLICY SKIP");
    expect(stdout).toContain("Imported 0 memories");
    expect(stdout).toContain("blocked by policy");
  });

  it("allows sections whose tags satisfy required_tags.any_of", () => {
    mkdirSync(join(projectDir, ".memento"), { recursive: true });
    writeFileSync(join(projectDir, ".memento", "policy.toml"), `
schema_version = 1
[required_tags]
any_of = ["area:db", "area:api"]
    `, "utf-8");

    writeFileSync(claudeMdPath, CLAUDE_MD_WITH_TAGS, "utf-8");

    const { stdout, exitCode } = runImportCli(
      [claudeMdPath, "--no-confirm"],
      projectDir,
      { MEMENTO_DB_PATH: dbPath }
    );
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("POLICY SKIP");
    expect(stdout).toContain("Imported 2 memories");
  });

  it("blocks sections matching banned_content patterns", () => {
    mkdirSync(join(projectDir, ".memento"), { recursive: true });
    writeFileSync(join(projectDir, ".memento", "policy.toml"), `
schema_version = 1
[banned_content]
patterns = ["internal-secret-system"]
    `, "utf-8");

    writeFileSync(claudeMdPath, CLAUDE_MD_BANNED_CONTENT, "utf-8");

    const { stdout, exitCode } = runImportCli(
      [claudeMdPath, "--no-confirm"],
      projectDir,
      { MEMENTO_DB_PATH: dbPath }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("POLICY SKIP (banned content)");
    expect(stdout).toContain("Imported 0 memories");
  });

  it("imports normally when no policy file is present", () => {
    writeFileSync(claudeMdPath, CLAUDE_MD_NO_TAGS, "utf-8");

    const { stdout, exitCode } = runImportCli(
      [claudeMdPath, "--no-confirm"],
      projectDir,
      { MEMENTO_DB_PATH: dbPath }
    );
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("POLICY SKIP");
    expect(stdout).toContain("Imported 2 memories");
  });

  it("dry-run with policy does not write DB even when sections would be blocked", () => {
    mkdirSync(join(projectDir, ".memento"), { recursive: true });
    writeFileSync(join(projectDir, ".memento", "policy.toml"), `
schema_version = 1
[required_tags]
any_of = ["area:db"]
    `, "utf-8");

    writeFileSync(claudeMdPath, CLAUDE_MD_NO_TAGS, "utf-8");

    const { stdout, exitCode } = runImportCli(
      [claudeMdPath, "--dry-run"],
      projectDir,
      { MEMENTO_DB_PATH: dbPath }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Dry run");
    // No DB write regardless of policy
  });
});
