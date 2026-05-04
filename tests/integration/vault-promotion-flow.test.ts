// tests/integration/vault-promotion-flow.test.ts
// End-to-end vault promotion: memory_store with persist_to_vault=true must:
//   1. Write a published .md file to disk in the chosen folder.
//   2. Re-index the vault so the new note is routable.
//   3. Surface in vault search via the routing pipeline.
//   4. Be readable via memory_get with a vault: prefix.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { handleMemoryStore } from "../../src/tools/memory-store.js";
import { handleMemoryGet } from "../../src/tools/memory-get.js";
import { handleMemorySearch } from "../../src/tools/memory-search.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";

function seedRootNotes(vaultPath: string): void {
  mkdirSync(vaultPath, { recursive: true });
  writeFileSync(join(vaultPath, "me.md"),
    `---\nmemento_publish: true\nmemento_kind: identity\nmemento_summary: identity placeholder\n---\nbody`);
  writeFileSync(join(vaultPath, "vault.md"),
    `---\nmemento_publish: true\nmemento_kind: map\nmemento_summary: vault map\n---\n` +
    `# Map\n\n[[55 Skills/promoted]]\n[[30 Domains/promoted]]\n`);
}

describe("vault promotion — store → index → search → get round-trip", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: MemoriesRepo;
  let dbPath: string;
  let vaultPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `vault-flow-${process.pid}-${randomUUID()}.sqlite`);
    vaultPath = join(tmpdir(), `vault-flow-${process.pid}-${randomUUID()}`);
    db = createDatabase(dbPath);
    repo = new MemoriesRepo(db);
    seedRootNotes(vaultPath);
  });

  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it("memory_store with persist_to_vault=true writes the note and reports the path", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      vault: {
        ...DEFAULT_CONFIG.vault,
        enabled: true,
        path: vaultPath,
      },
    };

    const result = await handleMemoryStore(repo, {
      title: "Promoted skill",
      content: "Do thing X by step 1, step 2, step 3.",
      memory_type: "skill",
      scope: "global",
      tags: ["promotion"],
      persist_to_vault: true,
      vault_kind: "skill",
      vault_folder: "55 Skills",
      vault_note_title: "promoted",
    }, db, config);

    expect(result).toMatch(/Vault note (created|updated): /);
    const relativeMatch = result.match(/Vault note .*?: (.*)$/m);
    expect(relativeMatch).toBeTruthy();
    const relPath = relativeMatch![1].trim();
    const fullPath = join(vaultPath, relPath);
    expect(existsSync(fullPath)).toBe(true);

    // Note content includes the body and is published.
    const file = readFileSync(fullPath, "utf-8");
    expect(file).toContain("memento_publish: true");
    expect(file).toContain("step 1");
  });

  it("vault note becomes searchable via memory_search after promotion", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      vault: {
        ...DEFAULT_CONFIG.vault,
        enabled: true,
        path: vaultPath,
      },
    };

    await handleMemoryStore(repo, {
      title: "Domain knowledge",
      content: "Cross-repo invoicing rules and architectural notes.",
      memory_type: "fact",
      scope: "global",
      persist_to_vault: true,
      vault_kind: "domain",
      vault_folder: "30 Domains",
      vault_note_title: "promoted",
    }, db, config);

    const out = await handleMemorySearch(repo, config, {
      query: "Cross-repo invoicing rules architectural",
      detail: "index",
    }, db);

    // The vault hit should appear as either a [vault:domain] entry or a
    // - [vault:...] line. Either way the title flows through.
    expect(out).toContain("promoted");
  });

  it("memory_get with vault: prefix returns the promoted note's body", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      vault: {
        ...DEFAULT_CONFIG.vault,
        enabled: true,
        path: vaultPath,
      },
    };

    await handleMemoryStore(repo, {
      title: "Skill that gets fetched",
      content: "Important skill body to be retrieved.",
      memory_type: "skill",
      scope: "global",
      persist_to_vault: true,
      vault_kind: "skill",
      vault_folder: "55 Skills",
      vault_note_title: "promoted",
    }, db, config);

    const noteRow = db.prepare(
      "SELECT id, relative_path FROM vault_notes WHERE vault_path = ? AND relative_path LIKE '55 Skills/%' LIMIT 1",
    ).get(vaultPath) as any;
    expect(noteRow).toBeTruthy();

    const out = await handleMemoryGet(repo, db, config, { memory_id: noteRow.id });
    // The promoted vault note title is the slugified vault_note_title; the
    // original memory title appears in the body of the note via the markdown.
    expect(out).toContain("[vault:skill]");
    expect(out).toContain("Important skill body to be retrieved.");
  });

  it("returns explanatory text when persist_to_vault=true but vault is disabled", async () => {
    const config = { ...DEFAULT_CONFIG }; // vault disabled by default
    const result = await handleMemoryStore(repo, {
      title: "No vault here",
      content: "body",
      memory_type: "fact",
      scope: "global",
      persist_to_vault: true,
    }, db, config);
    expect(result).toContain("Memory stored with ID:");
    expect(result).toContain("Vault persistence skipped");
  });
});
