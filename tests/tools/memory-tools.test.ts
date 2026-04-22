// tests/tools/memory-tools.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { handleMemoryStore } from "../../src/tools/memory-store.js";
import { handleMemorySearch } from "../../src/tools/memory-search.js";
import { handleMemoryGet } from "../../src/tools/memory-get.js";
import { handleMemoryList } from "../../src/tools/memory-list.js";
import { handleMemoryDelete } from "../../src/tools/memory-delete.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("memory tools", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: MemoriesRepo;
  const dbPath = join(tmpdir(), `memento-tools-test-${Date.now()}.sqlite`);
  const config = DEFAULT_CONFIG;

  beforeEach(() => { db = createDatabase(dbPath); repo = new MemoriesRepo(db); });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("memory_store returns ID", async () => {
    const result = await handleMemoryStore(repo, { title: "test", content: "body", memory_type: "fact", scope: "global" });
    expect(result).toContain("Memory stored with ID:");
  });

  it("memory_store can persist to vault and rebuild index", async () => {
    const vaultPath = join(tmpdir(), `memento-vault-${Date.now()}`);
    const vaultConfig = {
      ...DEFAULT_CONFIG,
      vault: {
        ...DEFAULT_CONFIG.vault,
        enabled: true,
        path: vaultPath,
      },
    };

    try {
      const rootNote = [
        "---",
        "memento_publish: true",
        "memento_kind: map",
        'memento_summary: "Vault navigation and routing rules."',
        "---",
        "",
        "# Vault",
        "",
      ].join("\n");
      rmSync(vaultPath, { recursive: true, force: true });
      await handleMemoryStore(
        repo,
        {
          title: "Respond concisely",
          content: "Keep answers concise, truthful, and contextual.",
          memory_type: "preference",
          scope: "global",
          persist_to_vault: true,
        },
        db,
        vaultConfig,
      );

      const vaultMapPath = join(vaultPath, "vault.md");
      expect(existsSync(vaultMapPath)).toBe(false);
      rmSync(vaultPath, { recursive: true, force: true });

      // Create root notes so promoted notes become reachable in the index.
      const mePath = join(vaultPath, "me.md");
      const vaultRootPath = join(vaultPath, "vault.md");
      await import("node:fs").then(({ mkdirSync, writeFileSync }) => {
        mkdirSync(vaultPath, { recursive: true });
        writeFileSync(mePath, [
          "---",
          "memento_publish: true",
          "memento_kind: identity",
          'memento_summary: "Identity."',
          "---",
          "",
          "# Me",
          "",
        ].join("\n"), "utf-8");
        writeFileSync(vaultRootPath, rootNote, "utf-8");
      });

      const result = await handleMemoryStore(
        repo,
        {
          title: "Respond concisely",
          content: "Keep answers concise, truthful, and contextual.",
          memory_type: "preference",
          scope: "global",
          persist_to_vault: true,
        },
        db,
        vaultConfig,
      );

      expect(result).toContain("Vault note created:");
      const files = await import("node:fs").then(({ readdirSync }) =>
        readdirSync(join(vaultPath, "30 Domains", "Memento Preferences"))
      );
      expect(files.length).toBe(1);
      const notePath = join(vaultPath, "30 Domains", "Memento Preferences", files[0]);
      const noteContent = readFileSync(notePath, "utf-8");
      expect(noteContent).toContain("memento_memory_id:");
      expect(noteContent).toContain("Keep answers concise");
      expect(readFileSync(vaultRootPath, "utf-8")).toContain("[[10 Maps/memento-store-index]]");

      const listed = await handleMemoryList(repo, vaultConfig, { detail: "index", vault_kind: "domain" }, db);
      expect(listed).toContain("Respond concisely");
    } finally {
      rmSync(vaultPath, { recursive: true, force: true });
    }
  });

  it("memory_store can auto-promote by config when persist_to_vault is omitted", async () => {
    const vaultPath = join(tmpdir(), `memento-vault-autopromote-${Date.now()}`);
    const vaultConfig = {
      ...DEFAULT_CONFIG,
      vault: {
        ...DEFAULT_CONFIG.vault,
        enabled: true,
        path: vaultPath,
        autoPromoteTypes: ["preference"],
      },
    };

    try {
      await import("node:fs").then(({ mkdirSync, writeFileSync }) => {
        mkdirSync(vaultPath, { recursive: true });
        writeFileSync(join(vaultPath, "me.md"), [
          "---",
          "memento_publish: true",
          "memento_kind: identity",
          'memento_summary: "Identity."',
          "---",
          "",
          "# Me",
          "",
        ].join("\n"), "utf-8");
        writeFileSync(join(vaultPath, "vault.md"), [
          "---",
          "memento_publish: true",
          "memento_kind: map",
          'memento_summary: "Vault map."',
          "---",
          "",
          "# Vault",
          "",
        ].join("\n"), "utf-8");
      });

      const result = await handleMemoryStore(
        repo,
        {
          title: "Stable reply style",
          content: "Prefer concise and truthful answers.",
          memory_type: "preference",
          scope: "global",
        },
        db,
        vaultConfig,
      );

      expect(result).toContain("Vault note created:");
    } finally {
      rmSync(vaultPath, { recursive: true, force: true });
    }
  });

  it("memory_search detail=index returns compact format", async () => {
    repo.store({ title: "React hooks", body: "patterns guide", memoryType: "fact", scope: "global" });
    const result = await handleMemorySearch(repo, config, { query: "React", detail: "index" });
    expect(result).toContain("[fact]");
    expect(result).toContain("React hooks");
    expect(result).not.toContain("patterns guide"); // body not in index
  });

  it("memory_search detail=full includes body preview", async () => {
    repo.store({ title: "React hooks", body: "patterns guide with details", memoryType: "fact", scope: "global" });
    const result = await handleMemorySearch(repo, config, { query: "React", detail: "full" });
    expect(result).toContain("patterns guide");
  });

  it("memory_get returns full body", async () => {
    const longBody = "detailed content ".repeat(50);
    const id = repo.store({ title: "detailed", body: longBody, memoryType: "fact", scope: "global" });
    const result = await handleMemoryGet(repo, db, config, { memory_id: id });
    expect(result).toContain(longBody); // not truncated
  });

  it("memory_get returns error for missing ID", async () => {
    const result = await handleMemoryGet(repo, db, config, { memory_id: "nonexistent" });
    expect(result).toContain("not found");
  });

  it("memory_list returns memories", async () => {
    repo.store({ title: "item1", body: "b1", memoryType: "fact", scope: "global" });
    const result = await handleMemoryList(repo, config, {});
    expect(result).toContain("item1");
  });

  it("memory_delete soft-deletes", async () => {
    const id = repo.store({ title: "to remove", body: "x", memoryType: "fact", scope: "global" });
    const result = await handleMemoryDelete(repo, { memory_id: id });
    expect(result).toContain("deleted");
  });
});
