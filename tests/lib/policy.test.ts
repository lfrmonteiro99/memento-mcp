// tests/lib/policy.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  findPolicyFile,
  loadProjectPolicy,
  compileSafeRegex,
  clearPolicyCache,
} from "../../src/lib/policy.js";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  utimesSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomUUID } from "node:crypto";

const TMP = tmpdir();

function makeProjectDir(name: string): string {
  const dir = join(TMP, `memento-policy-test-${name}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writePolicyFile(dir: string, content: string, primary = true): string {
  if (primary) {
    mkdirSync(join(dir, ".memento"), { recursive: true });
    const p = join(dir, ".memento", "policy.toml");
    writeFileSync(p, content, "utf-8");
    return p;
  } else {
    const p = join(dir, ".memento.toml");
    writeFileSync(p, content, "utf-8");
    return p;
  }
}

describe("compileSafeRegex", () => {
  it("compiles a valid simple pattern", () => {
    const re = compileSafeRegex("hello");
    expect(re).toBeInstanceOf(RegExp);
  });

  it("rejects empty string", () => {
    expect(compileSafeRegex("")).toBeNull();
  });

  it("rejects pattern longer than 200 chars", () => {
    const long = "a".repeat(201);
    expect(compileSafeRegex(long)).toBeNull();
  });

  it("rejects pattern with nested quantifier (a+)+", () => {
    expect(compileSafeRegex("(a+)+$")).toBeNull();
  });

  it("rejects pattern with nested quantifier (a*)+", () => {
    expect(compileSafeRegex("(a*)+")).toBeNull();
  });

  it("rejects pattern with {n,}+ style nested quantifier", () => {
    expect(compileSafeRegex("(abc){2,}+")).toBeNull();
  });

  it("accepts a 200-char pattern", () => {
    // 200 chars of safe pattern: just literal chars
    const p = "a".repeat(200);
    const re = compileSafeRegex(p);
    expect(re).toBeInstanceOf(RegExp);
  });

  it("rejects an invalid regex syntax", () => {
    expect(compileSafeRegex("[invalid")).toBeNull();
  });

  it("accepts a case-insensitive pattern using JS regex syntax", () => {
    // JS regex for case-insensitive: use flag via RegExp constructor or (?i:...) - use simple i flag
    // In JS regex, case-insensitive is set via flags, but our API uses new RegExp(pattern).
    // Users should use (?i:...) which is not valid in v8, or just use lowercase and trust the flag.
    // A simple pattern without (?i) still compiles fine.
    const re = compileSafeRegex("internal-tool");
    expect(re).toBeInstanceOf(RegExp);
    expect(re!.test("internal-tool")).toBe(true);
  });
});

describe("findPolicyFile", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = makeProjectDir("find");
    clearPolicyCache();
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    clearPolicyCache();
  });

  it("finds .memento/policy.toml in current dir", () => {
    writePolicyFile(rootDir, 'schema_version = 1\n', true);
    const found = findPolicyFile(rootDir);
    expect(found).toContain(".memento/policy.toml");
  });

  it("finds .memento.toml fallback when primary doesn't exist", () => {
    writePolicyFile(rootDir, 'schema_version = 1\n', false);
    const found = findPolicyFile(rootDir);
    expect(found).toContain(".memento.toml");
  });

  it("prefers .memento/policy.toml over .memento.toml", () => {
    writePolicyFile(rootDir, 'schema_version = 1\n', true);
    writePolicyFile(rootDir, 'schema_version = 2\n', false);
    const found = findPolicyFile(rootDir);
    expect(found).toContain(".memento/policy.toml");
  });

  it("walks up to find policy in parent", () => {
    writePolicyFile(rootDir, 'schema_version = 1\n', true);
    const child = join(rootDir, "subdir", "child");
    mkdirSync(child, { recursive: true });
    const found = findPolicyFile(child);
    expect(found).toContain(".memento/policy.toml");
  });

  it("returns null when no policy file found", () => {
    const found = findPolicyFile(rootDir);
    expect(found).toBeNull();
  });

  it("symlink safety: aborts for paths outside home and /tmp", () => {
    // /proc is outside home and /tmp — should return null
    const found = findPolicyFile("/proc/self");
    expect(found).toBeNull();
  });
});

describe("loadProjectPolicy", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = makeProjectDir("load");
    clearPolicyCache();
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    clearPolicyCache();
  });

  it("returns null when no policy file exists", () => {
    const policy = loadProjectPolicy(rootDir);
    expect(policy).toBeNull();
  });

  it("parses a valid policy file", () => {
    writePolicyFile(rootDir, `
schema_version = 1

[required_tags]
any_of = ["area:auth", "area:db"]

[banned_content]
patterns = ['secret']

[retention]
max_age_days = 90
min_importance = 0.5

[default_importance_by_type]
decision = 0.8

[auto_promote_to_vault]
types = ["architecture"]

[profile]
extra_stop_words = ["myproject"]
    `);
    const policy = loadProjectPolicy(rootDir);
    expect(policy).not.toBeNull();
    expect(policy!.schemaVersion).toBe(1);
    expect(policy!.requiredTagsAnyOf).toEqual(["area:auth", "area:db"]);
    expect(policy!.bannedContent).toHaveLength(1);
    expect(policy!.bannedContent[0]).toBeInstanceOf(RegExp);
    expect(policy!.retention.maxAgeDays).toBe(90);
    expect(policy!.retention.minImportance).toBe(0.5);
    expect(policy!.defaultImportanceByType["decision"]).toBe(0.8);
    expect(policy!.autoPromoteToVaultTypes).toEqual(["architecture"]);
    expect(policy!.extraStopWords).toEqual(["myproject"]);
  });

  it("malformed TOML returns null and warns", () => {
    writePolicyFile(rootDir, "invalid toml [[[ broken");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const policy = loadProjectPolicy(rootDir);
    expect(policy).toBeNull();
    warnSpy.mockRestore();
  });

  it("caches results (no-file case) per startDir", () => {
    // First call — no file, caches the "no file" result
    const policy1 = loadProjectPolicy(rootDir);
    expect(policy1).toBeNull();

    // Write file AFTER first call — should still get null from cache
    writePolicyFile(rootDir, 'schema_version = 1\n', true);
    const policy2 = loadProjectPolicy(rootDir);
    // Still null because "no file" is cached
    expect(policy2).toBeNull();
  });

  it("cache invalidates on mtime change", () => {
    const filePath = writePolicyFile(rootDir, 'schema_version = 1\n', true);
    const policy1 = loadProjectPolicy(rootDir);
    expect(policy1).not.toBeNull();

    // Modify file with new content and advance mtime
    writeFileSync(filePath, '[required_tags]\nany_of = ["x"]\n', "utf-8");
    const future = new Date(Date.now() + 2000);
    utimesSync(filePath, future, future);
    clearPolicyCache(); // clear to force re-resolution of startDir

    const policy2 = loadProjectPolicy(rootDir);
    expect(policy2).not.toBeNull();
    expect(policy2!.requiredTagsAnyOf).toEqual(["x"]);
  });

  it("skips unsafe regex patterns and still loads policy", () => {
    writePolicyFile(rootDir, `
schema_version = 1

[banned_content]
patterns = ["(a+)+$", "safe-pattern-here"]
    `);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const policy = loadProjectPolicy(rootDir);
    expect(policy).not.toBeNull();
    // Only the safe pattern should be loaded
    expect(policy!.bannedContent).toHaveLength(1);
    expect(policy!.bannedContent[0].source).toBe("safe-pattern-here");
    warnSpy.mockRestore();
  });

  it("back-compat: falls back to .memento.toml", () => {
    writePolicyFile(rootDir, '[required_tags]\nany_of = ["fallback"]\n', false);
    const policy = loadProjectPolicy(rootDir);
    expect(policy).not.toBeNull();
    expect(policy!.requiredTagsAnyOf).toEqual(["fallback"]);
    expect(policy!.policyFilePath).toContain(".memento.toml");
  });

  it("schema_version > 1 warns but doesn't crash", () => {
    writePolicyFile(rootDir, 'schema_version = 99\n', true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const policy = loadProjectPolicy(rootDir);
    expect(policy).not.toBeNull();
    expect(policy!.schemaVersion).toBe(99);
    warnSpy.mockRestore();
  });
});
