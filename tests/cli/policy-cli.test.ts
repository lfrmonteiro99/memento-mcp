// tests/cli/policy-cli.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync, spawnSync } from "node:child_process";

const TMP = tmpdir();
const REPO_ROOT = new URL("../../", import.meta.url).pathname;

function makeDir(name: string): string {
  const dir = join(TMP, `policy-cli-${name}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Run a policy command in a given cwd using ts-node / node with tsx.
 * Returns { stdout, stderr, exitCode }.
 */
function runPolicyCli(args: string[], cwd: string): { stdout: string; stderr: string; exitCode: number } {
  // Use the built CLI if it exists, otherwise use tsx for speed
  const entrypoint = join(REPO_ROOT, "src", "cli", "main.ts");
  const result = spawnSync(
    "npx",
    ["tsx", entrypoint, "policy", ...args],
    {
      cwd,
      encoding: "utf-8",
      timeout: 30000,
      env: { ...process.env, HOME: process.env.HOME ?? TMP },
    }
  );
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

describe("policy CLI", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeDir("cli");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("policy show: reports no policy found when none exists", () => {
    const { stdout, exitCode } = runPolicyCli(["show"], testDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No policy found");
  });

  it("policy show: displays policy details when file exists", () => {
    mkdirSync(join(testDir, ".memento"), { recursive: true });
    writeFileSync(join(testDir, ".memento", "policy.toml"), `
schema_version = 1

[required_tags]
any_of = ["area:auth"]
    `);
    const { stdout, exitCode } = runPolicyCli(["show"], testDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("area:auth");
  });

  it("policy validate: exits 0 for a valid file", () => {
    mkdirSync(join(testDir, ".memento"), { recursive: true });
    const filePath = join(testDir, ".memento", "policy.toml");
    writeFileSync(filePath, `
schema_version = 1

[banned_content]
patterns = ['secret']
    `);
    const { exitCode, stdout } = runPolicyCli(["validate", filePath], testDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OK:");
  });

  it("policy validate: exits non-zero for malformed TOML", () => {
    const filePath = join(testDir, "bad.toml");
    writeFileSync(filePath, "[[[ not valid toml\n");
    const { exitCode, stderr } = runPolicyCli(["validate", filePath], testDir);
    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toMatch(/error|parse/i);
  });

  it("policy validate: warns about unsafe regex but exits 0", () => {
    mkdirSync(join(testDir, ".memento"), { recursive: true });
    const filePath = join(testDir, ".memento", "policy.toml");
    writeFileSync(filePath, `
schema_version = 1

[banned_content]
patterns = ["(a+)+$"]
    `);
    const { exitCode, stderr } = runPolicyCli(["validate", filePath], testDir);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("WARNING");
  });

  it("policy init: creates .memento/policy.toml with template", () => {
    const { exitCode, stdout } = runPolicyCli(["init"], testDir);
    expect(exitCode).toBe(0);
    const filePath = join(testDir, ".memento", "policy.toml");
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, "utf-8");
    // Template should have all sections commented out
    expect(content).toContain("schema_version = 1");
    expect(content).toContain("[required_tags]");
    expect(content).toContain("[banned_content]");
    expect(content).toContain("[retention]");
    expect(content).toContain("[default_importance_by_type]");
    expect(content).toContain("[auto_promote_to_vault]");
    expect(content).toContain("[profile]");
  });

  it("policy init: fails if file already exists", () => {
    mkdirSync(join(testDir, ".memento"), { recursive: true });
    writeFileSync(join(testDir, ".memento", "policy.toml"), "schema_version = 1\n");
    const { exitCode, stderr } = runPolicyCli(["init"], testDir);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("already exists");
  });

  it("policy init: template passes its own validate", () => {
    // Init first
    runPolicyCli(["init"], testDir);
    const filePath = join(testDir, ".memento", "policy.toml");
    // Then validate the generated template
    const { exitCode } = runPolicyCli(["validate", filePath], testDir);
    expect(exitCode).toBe(0);
  });
});
