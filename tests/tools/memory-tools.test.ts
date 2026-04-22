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
import { rmSync } from "node:fs";
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
