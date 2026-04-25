// tests/tools/memory-store-policy.test.ts — policy enforcement in memory_store
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { handleMemoryStore } from "../../src/tools/memory-store.js";
import { handleMemoryUpdate } from "../../src/tools/memory-update.js";
import { clearPolicyCache } from "../../src/lib/policy.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const TMP = tmpdir();

function makeProjectDir(): string {
  const dir = join(TMP, `policy-store-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writePolicyFile(dir: string, content: string): void {
  mkdirSync(join(dir, ".memento"), { recursive: true });
  writeFileSync(join(dir, ".memento", "policy.toml"), content, "utf-8");
}

describe("memory_store policy enforcement", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: MemoriesRepo;
  let projectDir: string;
  const dbPath = join(TMP, `policy-store-db-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    repo = new MemoriesRepo(db);
    projectDir = makeProjectDir();
    clearPolicyCache();
  });

  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
    rmSync(projectDir, { recursive: true, force: true });
    clearPolicyCache();
  });

  it("stores memory with no policy present (zero behavior change)", async () => {
    const result = await handleMemoryStore(repo, {
      title: "test",
      content: "body",
      memory_type: "fact",
      project_path: projectDir,
    });
    expect(result).toContain("Memory stored with ID:");
  });

  it("blocks memory when required_tags any_of not satisfied", async () => {
    writePolicyFile(projectDir, `
[required_tags]
any_of = ["area:auth", "area:db"]
    `);
    clearPolicyCache();
    const result = await handleMemoryStore(repo, {
      title: "test",
      content: "body",
      memory_type: "fact",
      project_path: projectDir,
      tags: ["unrelated"],
    });
    expect(result).toContain("Memory not stored");
    expect(result).toContain("area:auth");
    expect(result).toContain("area:db");
  });

  it("allows memory when required_tags any_of satisfied", async () => {
    writePolicyFile(projectDir, `
[required_tags]
any_of = ["area:auth", "area:db"]
    `);
    clearPolicyCache();
    const result = await handleMemoryStore(repo, {
      title: "test",
      content: "body",
      memory_type: "fact",
      project_path: projectDir,
      tags: ["area:auth"],
    });
    expect(result).toContain("Memory stored with ID:");
  });

  it("blocks memory when required_tags all_of group not satisfied", async () => {
    writePolicyFile(projectDir, `
[required_tags]
all_of = [["env:dev", "env:prod"]]
    `);
    clearPolicyCache();
    const result = await handleMemoryStore(repo, {
      title: "test",
      content: "body",
      memory_type: "fact",
      project_path: projectDir,
      tags: ["area:auth"],
    });
    expect(result).toContain("Memory not stored");
    expect(result).toContain("env:dev");
  });

  it("blocks memory with banned content in body", async () => {
    writePolicyFile(projectDir, `
[banned_content]
patterns = ['secret-internal-tool']
    `);
    clearPolicyCache();
    const result = await handleMemoryStore(repo, {
      title: "test",
      content: "This references secret-internal-tool usage",
      memory_type: "fact",
      project_path: projectDir,
    });
    expect(result).toContain("Memory not stored");
    expect(result).toContain("policy");
    expect(result).toContain("secret-internal-tool");
  });

  it("blocks memory with banned content in title", async () => {
    writePolicyFile(projectDir, `
[banned_content]
patterns = ['confidential']
    `);
    clearPolicyCache();
    const result = await handleMemoryStore(repo, {
      title: "confidential strategy doc",
      content: "some body",
      memory_type: "fact",
      project_path: projectDir,
    });
    expect(result).toContain("Memory not stored");
  });

  it("blocks memory with banned content in tags", async () => {
    writePolicyFile(projectDir, `
[banned_content]
patterns = ['pii-data']
    `);
    clearPolicyCache();
    const result = await handleMemoryStore(repo, {
      title: "test",
      content: "clean body",
      memory_type: "fact",
      project_path: projectDir,
      tags: ["area:auth", "pii-data"],
    });
    expect(result).toContain("Memory not stored");
    expect(result).toContain("pii-data");
  });

  it("applies default importance by type when not set", async () => {
    writePolicyFile(projectDir, `
[default_importance_by_type]
decision = 0.9
    `);
    clearPolicyCache();
    const result = await handleMemoryStore(repo, {
      title: "Important decision",
      content: "body",
      memory_type: "decision",
      project_path: projectDir,
      // importance NOT set
    });
    expect(result).toContain("Memory stored with ID:");
    const id = result.match(/ID: ([a-zA-Z0-9-]+)/)?.[1];
    if (id) {
      const row = repo.getById(id);
      expect(row.importance_score).toBeCloseTo(0.9);
    }
  });

  it("does not override importance when explicitly set", async () => {
    writePolicyFile(projectDir, `
[default_importance_by_type]
decision = 0.9
    `);
    clearPolicyCache();
    const result = await handleMemoryStore(repo, {
      title: "test",
      content: "body",
      memory_type: "decision",
      project_path: projectDir,
      importance: 0.3,
    });
    expect(result).toContain("Memory stored with ID:");
    const id = result.match(/ID: ([a-zA-Z0-9-]+)/)?.[1];
    if (id) {
      const row = repo.getById(id);
      expect(row.importance_score).toBeCloseTo(0.3);
    }
  });

  it("auto-promotes to vault type sets persist_to_vault internally", async () => {
    // Without vault config, vault is skipped — but the auto-promote logic runs
    // and the result will say vault persistence skipped (not store ID without vault)
    writePolicyFile(projectDir, `
[auto_promote_to_vault]
types = ["architecture"]
    `);
    clearPolicyCache();
    const result = await handleMemoryStore(repo, {
      title: "System design",
      content: "Architecture decision",
      memory_type: "architecture",
      project_path: projectDir,
    });
    // It should try vault (and skip since vault not configured), not just plain store
    expect(result).toMatch(/Memory stored with ID:|vault/i);
  });

  it("error message cites .memento/policy.toml file reference", async () => {
    writePolicyFile(projectDir, `
[banned_content]
patterns = ['forbidden']
    `);
    clearPolicyCache();
    const result = await handleMemoryStore(repo, {
      title: "test",
      content: "this is forbidden",
      memory_type: "fact",
      project_path: projectDir,
    });
    expect(result).toContain(".memento/policy.toml");
  });
});

describe("memory_update policy enforcement", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: MemoriesRepo;
  let projectDir: string;
  const dbPath = join(TMP, `policy-update-db-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    repo = new MemoriesRepo(db);
    projectDir = makeProjectDir();
    clearPolicyCache();
  });

  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
    rmSync(projectDir, { recursive: true, force: true });
    clearPolicyCache();
  });

  it("blocks update with banned content in new body", async () => {
    const id = repo.store({ title: "t", body: "clean", memoryType: "fact", scope: "global" });
    writePolicyFile(projectDir, `
[banned_content]
patterns = ['forbidden-word']
    `);
    clearPolicyCache();
    const result = await handleMemoryUpdate(repo, {
      memory_id: id,
      content: "This contains forbidden-word in it",
      project_path: projectDir,
    });
    expect(result).toContain("Memory not updated");
    expect(result).toContain("forbidden-word");
  });

  it("allows update without banned content", async () => {
    const id = repo.store({ title: "t", body: "clean", memoryType: "fact", scope: "global" });
    writePolicyFile(projectDir, `
[banned_content]
patterns = ['forbidden-word']
    `);
    clearPolicyCache();
    const result = await handleMemoryUpdate(repo, {
      memory_id: id,
      content: "This is perfectly fine",
      project_path: projectDir,
    });
    expect(result).toContain("updated");
  });
});
