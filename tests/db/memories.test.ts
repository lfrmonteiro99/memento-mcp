// tests/db/memories.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase, nowIso } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("MemoriesRepo", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: MemoriesRepo;
  const dbPath = join(tmpdir(), `memento-mem-test-${Date.now()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    repo = new MemoriesRepo(db);
  });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("stores and retrieves a memory", () => {
    const id = repo.store({
      title: "test memory",
      body: "test body content",
      memoryType: "fact",
      scope: "global",
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const mem = repo.getById(id);
    expect(mem).not.toBeNull();
    expect(mem!.title).toBe("test memory");
    expect(mem!.body).toBe("test body content");
  });

  it("searches via FTS5", () => {
    repo.store({ title: "React hooks guide", body: "useState and useEffect patterns", memoryType: "fact", scope: "global" });
    repo.store({ title: "Python decorators", body: "function wrapping patterns", memoryType: "fact", scope: "global" });
    const results = repo.search("React hooks");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toContain("React");
  });

  it("sanitizes FTS5 query tokens (double quotes)", () => {
    repo.store({ title: 'He said "hello"', body: "greeting test", memoryType: "fact", scope: "global" });
    // Should not crash
    const results = repo.search('"hello"');
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  it("soft-deletes a memory", () => {
    const id = repo.store({ title: "to delete", body: "x", memoryType: "fact", scope: "global" });
    expect(repo.delete(id)).toBe(true);
    expect(repo.getById(id)).toBeNull(); // hidden from reads
    expect(repo.delete(id)).toBe(false); // already deleted
  });

  it("supersedes a previous memory", () => {
    const id1 = repo.store({ title: "v1", body: "first", memoryType: "fact", scope: "global" });
    const id2 = repo.store({ title: "v2", body: "second", memoryType: "fact", scope: "global", supersedesId: id1 });
    expect(repo.getById(id1)).toBeNull(); // superseded = soft-deleted
    expect(repo.getById(id2)!.title).toBe("v2");
  });

  it("filters by project scope (includes global)", () => {
    repo.store({ title: "global mem", body: "g", memoryType: "fact", scope: "global" });
    repo.store({ title: "project mem", body: "p", memoryType: "fact", scope: "project", projectPath: "/home/user/proj" });
    repo.store({ title: "other proj", body: "o", memoryType: "fact", scope: "project", projectPath: "/home/user/other" });
    const results = repo.search("mem", { projectPath: "/home/user/proj" });
    const titles = results.map(r => r.title);
    expect(titles).toContain("global mem");
    expect(titles).toContain("project mem");
    expect(titles).not.toContain("other proj");
  });

  it("updates access tracking on search", () => {
    const id = repo.store({ title: "tracked", body: "content", memoryType: "fact", scope: "global" });
    repo.search("tracked");
    const mem = db.prepare("SELECT access_count FROM memories WHERE id = ?").get(id) as any;
    expect(mem.access_count).toBe(1);
  });

  it("lists memories with filters", () => {
    repo.store({ title: "a fact", body: "x", memoryType: "fact", scope: "global" });
    repo.store({ title: "a decision", body: "x", memoryType: "decision", scope: "global" });
    const facts = repo.list({ memoryType: "fact" });
    expect(facts.every(m => m.memory_type === "fact")).toBe(true);
  });

  it("prunes stale memories", () => {
    const id = repo.store({ title: "old", body: "x", memoryType: "fact", scope: "global", importance: 0.1 });
    // Manually set last_accessed_at to 90 days ago
    db.prepare("UPDATE memories SET last_accessed_at = datetime('now', '-90 days') WHERE id = ?").run(id);
    const count = repo.pruneStale(60, 0.3);
    expect(count).toBe(1);
    expect(repo.getById(id)).toBeNull();
  });

  it("does NOT prune pinned memories", () => {
    const id = repo.store({ title: "pinned", body: "x", memoryType: "fact", scope: "global", importance: 0.1, pin: true });
    db.prepare("UPDATE memories SET last_accessed_at = datetime('now', '-90 days') WHERE id = ?").run(id);
    const count = repo.pruneStale(60, 0.3);
    expect(count).toBe(0);
  });
});
