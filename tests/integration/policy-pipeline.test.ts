// tests/integration/policy-pipeline.test.ts
// End-to-end: tmp dir with .memento/policy.toml, store memory, verify enforcement
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { handleMemoryStore } from "../../src/tools/memory-store.js";
import { clearPolicyCache } from "../../src/lib/policy.js";

const TMP = tmpdir();

function makeDir(name: string): string {
  const dir = join(TMP, `policy-pipeline-${name}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writePrimaryPolicy(dir: string, content: string): void {
  mkdirSync(join(dir, ".memento"), { recursive: true });
  writeFileSync(join(dir, ".memento", "policy.toml"), content, "utf-8");
}

function writeFallbackPolicy(dir: string, content: string): void {
  writeFileSync(join(dir, ".memento.toml"), content, "utf-8");
}

describe("policy pipeline integration", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: MemoriesRepo;
  let policyDir: string;
  let siblingDir: string;
  const dbPath = join(TMP, `policy-pipeline-db-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    repo = new MemoriesRepo(db);
    policyDir = makeDir("policy");
    siblingDir = makeDir("sibling");
    clearPolicyCache();
  });

  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
    rmSync(policyDir, { recursive: true, force: true });
    rmSync(siblingDir, { recursive: true, force: true });
    clearPolicyCache();
  });

  it("enforces policy in project dir with .memento/policy.toml", async () => {
    writePrimaryPolicy(policyDir, `
[required_tags]
any_of = ["area:auth"]
    `);
    clearPolicyCache();

    // Without required tag — should be blocked
    const blocked = await handleMemoryStore(repo, {
      title: "test",
      content: "body",
      memory_type: "fact",
      project_path: policyDir,
    });
    expect(blocked).toContain("Memory not stored");

    // With required tag — should succeed
    const ok = await handleMemoryStore(repo, {
      title: "test",
      content: "body",
      memory_type: "fact",
      project_path: policyDir,
      tags: ["area:auth"],
    });
    expect(ok).toContain("Memory stored with ID:");
  });

  it("sibling dir without policy is unconstrained", async () => {
    writePrimaryPolicy(policyDir, `
[required_tags]
any_of = ["area:auth"]
    `);
    clearPolicyCache();

    // Same params to sibling dir — should be allowed (no policy)
    const result = await handleMemoryStore(repo, {
      title: "test",
      content: "body",
      memory_type: "fact",
      project_path: siblingDir,
    });
    expect(result).toContain("Memory stored with ID:");
  });

  it("back-compat: .memento.toml fallback works", async () => {
    writeFallbackPolicy(policyDir, `
[required_tags]
any_of = ["fallback-tag"]
    `);
    clearPolicyCache();

    // Without fallback tag — should be blocked
    const blocked = await handleMemoryStore(repo, {
      title: "test",
      content: "body",
      memory_type: "fact",
      project_path: policyDir,
    });
    expect(blocked).toContain("Memory not stored");

    // With fallback tag — should succeed
    const ok = await handleMemoryStore(repo, {
      title: "test",
      content: "body",
      memory_type: "fact",
      project_path: policyDir,
      tags: ["fallback-tag"],
    });
    expect(ok).toContain("Memory stored with ID:");
  });

  it("discovers policy from subdirectory (walks up)", async () => {
    writePrimaryPolicy(policyDir, `
[banned_content]
patterns = ['forbidden-word-xyz']
    `);
    const subdir = join(policyDir, "src", "lib");
    mkdirSync(subdir, { recursive: true });
    clearPolicyCache();

    const result = await handleMemoryStore(repo, {
      title: "test",
      content: "this is forbidden-word-xyz content",
      memory_type: "fact",
      project_path: subdir, // subdir should walk up and find the policy
    });
    expect(result).toContain("Memory not stored");
    expect(result).toContain("forbidden-word-xyz");
  });

  it("policy retention: pruneStaleByProject method exists and prunes correctly", async () => {
    // Store a memory and manually backdate its last_accessed_at so it qualifies
    const id = repo.store({
      title: "old memory",
      body: "old",
      memoryType: "fact",
      scope: "global",
      importance: 0.1,
      projectPath: policyDir,
    });
    const mem = repo.getById(id);
    expect(mem).not.toBeNull();

    // Manually set last_accessed_at to 100 days ago
    db.prepare("UPDATE memories SET last_accessed_at = datetime('now', '-100 days') WHERE id = ?").run(id);

    // pruneStaleByProject with 30 days max age and 0.9 min importance
    // Memory is 100 days old with importance 0.1 < 0.9 → should be pruned
    const pruned = repo.pruneStaleByProject(mem.project_id, 30, 0.9);
    expect(pruned).toBe(1);
    expect(repo.getById(id)).toBeNull();
  });
});
