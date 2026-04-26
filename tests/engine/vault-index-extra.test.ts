// tests/engine/vault-index-extra.test.ts
// Coverage for runVaultDoctor, getVaultStats, readVaultNoteBody and the
// missing-link-resolution branches of rebuildVaultIndex.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/db/database.js";
import {
  rebuildVaultIndex,
  runVaultDoctor,
  getVaultStats,
  getVaultNoteById,
  readVaultNoteBody,
} from "../../src/engine/vault-index.js";
import { DEFAULT_VAULT_CONFIG } from "../../src/lib/config.js";
import type { VaultConfig } from "../../src/lib/config.js";

function makeVault(base: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const dir = join(base, rel.split("/").slice(0, -1).join("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(base, rel), content, "utf-8");
  }
}

const FRONTMATTER_IDENTITY = (summary: string) => `---
memento_publish: true
memento_kind: identity
memento_summary: ${summary}
---
`;

const FRONTMATTER_MAP = (summary: string) => `---
memento_publish: true
memento_kind: map
memento_summary: ${summary}
---
`;

const FRONTMATTER_DOMAIN = (summary: string) => `---
memento_publish: true
memento_kind: domain
memento_summary: ${summary}
---
`;

describe("vault-index — runVaultDoctor", () => {
  let vaultPath: string;
  let dbPath: string;
  let db: ReturnType<typeof createDatabase>;
  let config: VaultConfig;

  beforeEach(() => {
    const id = randomUUID();
    vaultPath = join(tmpdir(), `vault-doctor-${process.pid}-${id}`);
    dbPath = join(tmpdir(), `vault-doctor-${process.pid}-${id}.sqlite`);
    mkdirSync(vaultPath, { recursive: true });
    db = createDatabase(dbPath);
    config = { ...DEFAULT_VAULT_CONFIG, enabled: true, path: vaultPath };
  });

  afterEach(() => {
    db.close();
    try { rmSync(vaultPath, { recursive: true, force: true }); } catch { /* */ }
    try { rmSync(dbPath, { force: true }); } catch { /* */ }
  });

  it("returns empty issues when all roots present and reachable", () => {
    makeVault(vaultPath, {
      "me.md": FRONTMATTER_IDENTITY("Test identity") + "Body",
      "vault.md": FRONTMATTER_MAP("Vault map") + "Body",
    });
    rebuildVaultIndex(db, config);
    expect(runVaultDoctor(db, config)).toHaveLength(0);
  });

  it("flags missing root note when file does not exist", () => {
    makeVault(vaultPath, {
      "me.md": FRONTMATTER_IDENTITY("ident") + "Body",
      // no vault.md
    });
    rebuildVaultIndex(db, config);
    const issues = runVaultDoctor(db, config);
    const missing = issues.find(i => i.kind === "missing_root" && i.path === "vault.md");
    expect(missing).toBeDefined();
    expect(missing!.detail).toContain("does not exist");
  });

  it("flags missing root when file exists but lacks memento_publish", () => {
    makeVault(vaultPath, {
      "me.md": FRONTMATTER_IDENTITY("ident") + "Body",
      // vault.md exists but is not published
      "vault.md": "# Vault (unpublished)\n",
    });
    rebuildVaultIndex(db, config);
    const issues = runVaultDoctor(db, config);
    const missing = issues.find(i => i.kind === "missing_root" && i.path === "vault.md");
    expect(missing).toBeDefined();
    expect(missing!.detail).toContain("not indexed");
  });

  it("flags published-but-orphaned notes", () => {
    // The orphan note is published but has no parent linking it.
    makeVault(vaultPath, {
      "me.md": FRONTMATTER_IDENTITY("ident") + "Body",
      "vault.md": FRONTMATTER_MAP("map") + "Body",
      "30 Domains/orphan.md": FRONTMATTER_DOMAIN("orphaned domain") + "Body",
    });
    rebuildVaultIndex(db, config);
    const issues = runVaultDoctor(db, config);
    const orphan = issues.find(
      i => i.kind === "orphaned_published" && i.path === "30 Domains/orphan.md",
    );
    expect(orphan).toBeDefined();
  });
});

describe("vault-index — getVaultStats", () => {
  let vaultPath: string;
  let dbPath: string;
  let db: ReturnType<typeof createDatabase>;
  let config: VaultConfig;

  beforeEach(() => {
    const id = randomUUID();
    vaultPath = join(tmpdir(), `vault-stats-${process.pid}-${id}`);
    dbPath = join(tmpdir(), `vault-stats-${process.pid}-${id}.sqlite`);
    mkdirSync(vaultPath, { recursive: true });
    db = createDatabase(dbPath);
    config = { ...DEFAULT_VAULT_CONFIG, enabled: true, path: vaultPath };
  });

  afterEach(() => {
    db.close();
    try { rmSync(vaultPath, { recursive: true, force: true }); } catch { /* */ }
    try { rmSync(dbPath, { force: true }); } catch { /* */ }
  });

  it("aggregates totals, byKind, edge and root counts", () => {
    makeVault(vaultPath, {
      "me.md": FRONTMATTER_IDENTITY("ident") + "Body",
      "vault.md": FRONTMATTER_MAP("map") + "Body. See [[30 Domains/dom]].",
      "30 Domains/dom.md": FRONTMATTER_DOMAIN("domain") + "Body",
      "30 Domains/orphan.md": FRONTMATTER_DOMAIN("orphan") + "Body",
    });
    rebuildVaultIndex(db, config);
    const stats = getVaultStats(db, vaultPath);

    expect(stats.totals.total).toBeGreaterThanOrEqual(3);
    expect(stats.totals.reachable + stats.totals.orphaned).toBe(stats.totals.total);
    expect(stats.byKind.length).toBeGreaterThan(0);
    expect(stats.byKind.every(b => typeof b.count === "number")).toBe(true);
    expect(stats.rootCount).toBeGreaterThanOrEqual(1);
    expect(stats.edgeCount).toBeGreaterThanOrEqual(0);
  });

  it("returns zero totals for unknown vault path", () => {
    const stats = getVaultStats(db, "/nonexistent");
    expect(stats.totals.total).toBe(0);
    expect(stats.byKind).toEqual([]);
  });
});

describe("vault-index — readVaultNoteBody", () => {
  let vaultPath: string;
  let dbPath: string;
  let db: ReturnType<typeof createDatabase>;
  let config: VaultConfig;

  beforeEach(() => {
    const id = randomUUID();
    vaultPath = join(tmpdir(), `vault-body-${process.pid}-${id}`);
    dbPath = join(tmpdir(), `vault-body-${process.pid}-${id}.sqlite`);
    mkdirSync(vaultPath, { recursive: true });
    db = createDatabase(dbPath);
    config = { ...DEFAULT_VAULT_CONFIG, enabled: true, path: vaultPath };
  });

  afterEach(() => {
    db.close();
    try { rmSync(vaultPath, { recursive: true, force: true }); } catch { /* */ }
    try { rmSync(dbPath, { force: true }); } catch { /* */ }
  });

  it("returns body text without frontmatter", () => {
    const body = "Body of note here.";
    makeVault(vaultPath, {
      "me.md": FRONTMATTER_IDENTITY("ident") + "Body",
      "vault.md": FRONTMATTER_MAP("map") + "Body",
      "30 Domains/note.md": FRONTMATTER_DOMAIN("note") + body,
    });
    rebuildVaultIndex(db, config);
    const row = db.prepare(
      "SELECT * FROM vault_notes WHERE relative_path = ? AND vault_path = ?",
    ).get("30 Domains/note.md", vaultPath) as any;

    expect(row).toBeDefined();
    const text = readVaultNoteBody(row);
    expect(text).toBe(body);
  });

  it("returns null when the underlying file is missing", () => {
    makeVault(vaultPath, {
      "me.md": FRONTMATTER_IDENTITY("ident") + "Body",
      "vault.md": FRONTMATTER_MAP("map") + "Body",
      "30 Domains/ghost.md": FRONTMATTER_DOMAIN("ghost") + "Will be deleted",
    });
    rebuildVaultIndex(db, config);
    const row = db.prepare(
      "SELECT * FROM vault_notes WHERE relative_path = ? AND vault_path = ?",
    ).get("30 Domains/ghost.md", vaultPath) as any;
    rmSync(join(vaultPath, "30 Domains/ghost.md"));

    expect(readVaultNoteBody(row)).toBeNull();
  });
});

describe("vault-index — getVaultNoteById", () => {
  it("returns no row for unknown id", () => {
    const dbPath = join(tmpdir(), `vault-getbyid-${process.pid}-${randomUUID()}.sqlite`);
    const db = createDatabase(dbPath);
    try {
      // better-sqlite3.get() returns undefined on no-row; the function passes that through.
      expect(getVaultNoteById(db, "vault:nonexistent")).toBeFalsy();
    } finally {
      db.close();
      rmSync(dbPath, { force: true });
    }
  });
});
