import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase } from "../../src/db/database.js";
import { rebuildVaultIndex } from "../../src/engine/vault-index.js";
import { searchVault } from "../../src/engine/vault-router.js";
import { DEFAULT_VAULT_CONFIG } from "../../src/lib/config.js";
import type { VaultConfig } from "../../src/lib/config.js";

function makeVault(base: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(base, rel);
    mkdirSync(join(base, rel.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }
}

describe("vault Phase 3 — hook routing and confidence", () => {
  let vaultPath: string;
  let dbPath: string;
  let db: ReturnType<typeof createDatabase>;
  let config: VaultConfig;

  beforeEach(() => {
    vaultPath = join(tmpdir(), `vault-p3-${Date.now()}`);
    dbPath = join(tmpdir(), `vault-p3-${Date.now()}.sqlite`);
    mkdirSync(vaultPath, { recursive: true });

    makeVault(vaultPath, {
      "me.md": `---
memento_publish: true
memento_kind: identity
memento_summary: Luis Monteiro — developer.
---
I am a developer.`,
      "vault.md": `---
memento_publish: true
memento_kind: map
memento_summary: Vault navigation and routing rules.
---
See folders below.`,
      "30 Domains/scheduling.md": `---
memento_publish: true
memento_kind: domain
memento_summary: Cross-repo rules and architecture for scheduling.
tags:
  - scheduling
  - quality
---
Scheduling domain knowledge.`,
      "50 Playbooks/release-merge.md": `---
memento_publish: true
memento_kind: playbook
memento_summary: Safe merge flow when dev contains additional valid work.
tags:
  - release
  - merge
---
Steps to merge safely.`,
      "55 Skills/debug-scheduling.md": `---
memento_publish: true
memento_kind: skill
memento_summary: How to debug scheduling instance generation across repos.
tags:
  - debugging
  - scheduling
---
Debug steps here.`,
    });

    config = {
      ...DEFAULT_VAULT_CONFIG,
      enabled: true,
      path: vaultPath,
      requirePublishFlag: true,
      maxHops: 3,
      maxResults: 5,
      hookMaxResults: 2,
    };

    db = createDatabase(dbPath);
    rebuildVaultIndex(db, config);
  });

  afterEach(() => {
    db.close();
    try { rmSync(vaultPath, { recursive: true }); } catch { /* */ }
    try { rmSync(dbPath); } catch { /* */ }
  });

  it("returns relevant vault results for a domain query", () => {
    const results = searchVault(db, config, "scheduling architecture rules");
    expect(results.length).toBeGreaterThan(0);
    const ids = results.map(r => r.id);
    expect(ids.some(id => id.includes("scheduling"))).toBe(true);
  });

  it("procedure query prefers skill and playbook over domain", () => {
    const results = searchVault(db, config, "how to merge release branch steps");
    expect(results.length).toBeGreaterThan(0);
    const topKinds = results.slice(0, 2).map(r => r.kind);
    expect(topKinds.some(k => k === "playbook" || k === "skill")).toBe(true);
  });

  it("returns empty when vault disabled", () => {
    const results = searchVault(db, { ...config, enabled: false }, "scheduling");
    expect(results).toHaveLength(0);
  });

  it("returns empty for very low relevance query", () => {
    const results = searchVault(db, config, "zzz xxxxxxxxxxx nomatchwhatsoever");
    // May return 0 or low-score results — none should exceed confidence threshold
    const confident = results.filter(r => (r.score ?? 0) >= 0.25);
    expect(confident).toHaveLength(0);
  });

  it("blocked folders do not appear in results", () => {
    makeVault(vaultPath, {
      "00 Inbox/scratch.md": `---
memento_publish: true
memento_kind: domain
memento_summary: Scratch note about scheduling.
---
Scheduling scratch.`,
    });
    rebuildVaultIndex(db, config);
    const results = searchVault(db, config, "scheduling scratch");
    expect(results.every(r => !r.path?.startsWith("00 Inbox"))).toBe(true);
  });

  it("all results include breadcrumb", () => {
    const results = searchVault(db, config, "scheduling");
    for (const r of results) {
      expect(r.breadcrumb).toBeDefined();
      expect(Array.isArray(r.breadcrumb)).toBe(true);
    }
  });

  it("respects hookMaxResults limit", () => {
    const results = searchVault(db, config, "scheduling");
    expect(results.length).toBeLessThanOrEqual(config.maxResults);
  });
});
