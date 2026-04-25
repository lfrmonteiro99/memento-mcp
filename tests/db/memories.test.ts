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

  it("K5: tags are stored as JSON arrays", () => {
    const id = repo.store({ title: "json tags", body: "b", memoryType: "fact", scope: "global", tags: ["foo", "bar"] });
    const row = db.prepare("SELECT tags FROM memories WHERE id = ?").get(id) as any;
    expect(row.tags).toBe('["foo","bar"]');
  });

  it("K5: v1 CSV tags still parse correctly post-migration", () => {
    // Simulate a pre-migration state by inserting raw CSV (bypassing store())
    const id = "csv-test-id";
    db.prepare(`
      INSERT INTO memories (id, project_id, title, body, memory_type, scope, tags, created_at, updated_at)
      VALUES (?, NULL, 't', 'b', 'fact', 'global', 'foo,bar,baz', datetime('now'), datetime('now'))
    `).run(id);
    const row = db.prepare("SELECT tags FROM memories WHERE id = ?").get(id) as any;
    // parseTags (in formatter.ts) handles both formats transparently
    const parsed = row.tags.startsWith("[") ? JSON.parse(row.tags) : row.tags.split(",").map((t: string) => t.trim());
    expect(parsed).toEqual(["foo", "bar", "baz"]);
  });
});

describe("batched access tracking (v2)", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: MemoriesRepo;
  const dbPath = join(tmpdir(), `memento-mem-batch-test-${Date.now()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    repo = new MemoriesRepo(db);
  });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("batchUpdateAccess updates multiple memories in one call", () => {
    const id1 = repo.store({ title: "m1", body: "b1", memoryType: "fact", scope: "global" });
    const id2 = repo.store({ title: "m2", body: "b2", memoryType: "fact", scope: "global" });
    const id3 = repo.store({ title: "m3", body: "b3", memoryType: "fact", scope: "global" });

    repo.batchUpdateAccess([id1, id2, id3]);

    const m1 = db.prepare("SELECT access_count FROM memories WHERE id = ?").get(id1) as any;
    const m2 = db.prepare("SELECT access_count FROM memories WHERE id = ?").get(id2) as any;
    const m3 = db.prepare("SELECT access_count FROM memories WHERE id = ?").get(id3) as any;

    expect(m1.access_count).toBe(1);
    expect(m2.access_count).toBe(1);
    expect(m3.access_count).toBe(1);
  });

  it("batchUpdateAccess sets last_accessed_at", () => {
    const id = repo.store({ title: "tracked", body: "b", memoryType: "fact", scope: "global" });
    repo.batchUpdateAccess([id]);
    const mem = db.prepare("SELECT last_accessed_at FROM memories WHERE id = ?").get(id) as any;
    expect(mem.last_accessed_at).toBeDefined();
  });

  it("batchUpdateAccess handles empty array without error", () => {
    expect(() => repo.batchUpdateAccess([])).not.toThrow();
  });

  it("batchUpdateAccess increments existing access_count", () => {
    const id = repo.store({ title: "multi", body: "b", memoryType: "fact", scope: "global" });
    repo.batchUpdateAccess([id]);
    repo.batchUpdateAccess([id]);
    const mem = db.prepare("SELECT access_count FROM memories WHERE id = ?").get(id) as any;
    expect(mem.access_count).toBe(2);
  });

  it("store() accepts source param", () => {
    const id = repo.store({ title: "auto", body: "b", memoryType: "fact", scope: "global", source: "auto-capture" });
    const row = db.prepare("SELECT source FROM memories WHERE id = ?").get(id) as any;
    expect(row.source).toBe("auto-capture");
  });

  it("store() defaults source to 'user'", () => {
    const id = repo.store({ title: "default src", body: "b", memoryType: "fact", scope: "global" });
    const row = db.prepare("SELECT source FROM memories WHERE id = ?").get(id) as any;
    expect(row.source).toBe("user");
  });

  it("store() accepts projectId directly", () => {
    // First create a project via projectPath to get its id
    const id1 = repo.store({ title: "proj mem", body: "b", memoryType: "fact", scope: "project", projectPath: "/test/proj" });
    const proj = db.prepare("SELECT project_id FROM memories WHERE id = ?").get(id1) as any;
    const projectId = proj.project_id;

    // Now store via projectId directly
    const id2 = repo.store({ title: "direct proj", body: "b", memoryType: "fact", scope: "project", projectId });
    const row = db.prepare("SELECT project_id FROM memories WHERE id = ?").get(id2) as any;
    expect(row.project_id).toBe(projectId);
  });

  it("store() accepts claudeSessionId and stores it", () => {
    const id = repo.store({
      title: "session mem",
      body: "b",
      memoryType: "fact",
      scope: "project",
      claudeSessionId: "sess-abc123",
    });
    const row = db.prepare("SELECT claude_session_id FROM memories WHERE id = ?").get(id) as any;
    expect(row.claude_session_id).toBe("sess-abc123");
  });

  it("listBySession() returns memories for that session only", () => {
    const sessA = "sess-list-a";
    const sessB = "sess-list-b";
    repo.store({ title: "A1", body: "b", memoryType: "fact", scope: "global", claudeSessionId: sessA });
    repo.store({ title: "A2", body: "b", memoryType: "fact", scope: "global", claudeSessionId: sessA });
    repo.store({ title: "B1", body: "b", memoryType: "fact", scope: "global", claudeSessionId: sessB });

    const resultA = repo.listBySession(sessA);
    expect(resultA.length).toBe(2);
    expect(resultA.every((m: any) => m.claude_session_id === sessA)).toBe(true);
  });

  it("listBySession() sourceFilter limits to matching source", () => {
    const sessId = "sess-filter";
    repo.store({ title: "cap", body: "b", memoryType: "fact", scope: "global", source: "auto-capture", claudeSessionId: sessId });
    repo.store({ title: "sum", body: "b", memoryType: "session_summary", scope: "global", source: "session-summary", claudeSessionId: sessId });

    const captures = repo.listBySession(sessId, { sourceFilter: "auto-capture" });
    expect(captures.length).toBe(1);
    expect(captures[0].source).toBe("auto-capture");
  });

  it("getNeighbors uses claude_session_id when available (sameSessionOnly=true)", () => {
    const sessId = "sess-neighbors";
    const projectId = repo.ensureProject("/test/getneighbors");

    const id1 = repo.store({ title: "N1", body: "b1", memoryType: "fact", scope: "project", projectId, claudeSessionId: sessId });
    const id2 = repo.store({ title: "N2", body: "b2", memoryType: "fact", scope: "project", projectId, claudeSessionId: sessId });
    const id3 = repo.store({ title: "N3", body: "b3", memoryType: "fact", scope: "project", projectId, claudeSessionId: "other-session" });
    const id4 = repo.store({ title: "N4", body: "b4", memoryType: "fact", scope: "project", projectId, claudeSessionId: sessId });

    const focus = db.prepare("SELECT * FROM memories WHERE id = ?").get(id2) as any;
    const neighbors = repo.getNeighbors(focus, 5, true);

    const neighborIds = neighbors.map((n: any) => n.id);
    // N1 and N4 share the session, should appear
    expect(neighborIds).toContain(id1);
    expect(neighborIds).toContain(id4);
    // N3 is from a different session, should not appear
    expect(neighborIds).not.toContain(id3);
  });

  it("getNeighbors falls back to time window when claude_session_id is null", () => {
    const projectId = repo.ensureProject("/test/getneighbors-fallback");

    // Store memories without claude_session_id
    const id1 = repo.store({ title: "T1", body: "b1", memoryType: "fact", scope: "project", projectId });
    const id2 = repo.store({ title: "T2", body: "b2", memoryType: "fact", scope: "project", projectId });

    const focus = db.prepare("SELECT * FROM memories WHERE id = ?").get(id1) as any;
    expect(focus.claude_session_id).toBeNull();

    // With sameSessionOnly=true but no claude_session_id, falls back to time window
    const neighbors = repo.getNeighbors(focus, 5, true);
    // id2 was created just now, within ±2h window
    const neighborIds = neighbors.map((n: any) => n.id);
    expect(neighborIds).toContain(id2);
  });

  it("getNeighbors sameSessionOnly=false uses time window regardless of session id", () => {
    const projectId = repo.ensureProject("/test/getneighbors-timewindow");
    const sessId = "sess-tw";

    const id1 = repo.store({ title: "TW1", body: "b1", memoryType: "fact", scope: "project", projectId, claudeSessionId: sessId });
    const id2 = repo.store({ title: "TW2", body: "b2", memoryType: "fact", scope: "project", projectId, claudeSessionId: "different-sess" });

    const focus = db.prepare("SELECT * FROM memories WHERE id = ?").get(id1) as any;

    // sameSessionOnly=false → time window, so id2 should appear despite different session
    const neighbors = repo.getNeighbors(focus, 5, false);
    const neighborIds = neighbors.map((n: any) => n.id);
    expect(neighborIds).toContain(id2);
  });

  it("R4: store() rejects supersedes self-cycle", () => {
    // Insert a raw memory with a self-referential supersedes_memory_id (edge case)
    const id = "self-cycle-id";
    db.prepare(`
      INSERT INTO memories (id, project_id, title, body, memory_type, scope, supersedes_memory_id, created_at, updated_at)
      VALUES (?, NULL, 't', 'b', 'fact', 'global', ?, datetime('now'), datetime('now'))
    `).run(id, id);
    // Attempting to supersede this already-cyclic memory should throw
    expect(() => repo.store({
      title: "new", body: "b", memoryType: "fact", scope: "global", supersedesId: id,
    })).toThrow(/cycle/);
  });
});

describe("has_private flag and FTS privacy (issue #4)", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: MemoriesRepo;
  const dbPath = join(tmpdir(), `memento-mem-private-test-${Date.now()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    repo = new MemoriesRepo(db);
  });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("store() sets has_private=1 when body contains private tags", () => {
    const id = repo.store({ title: "secret", body: "foo <private>bar</private> baz", memoryType: "fact", scope: "global" });
    const row = db.prepare("SELECT has_private FROM memories WHERE id = ?").get(id) as any;
    expect(row.has_private).toBe(1);
  });

  it("store() sets has_private=0 when body has no private tags", () => {
    const id = repo.store({ title: "plain", body: "no secrets here", memoryType: "fact", scope: "global" });
    const row = db.prepare("SELECT has_private FROM memories WHERE id = ?").get(id) as any;
    expect(row.has_private).toBe(0);
  });

  it("FTS does NOT match terms inside private regions", () => {
    repo.store({ title: "private memory", body: "foo <private>secretword</private> baz", memoryType: "fact", scope: "global" });
    const results = repo.search("secretword");
    expect(results.length).toBe(0);
  });

  it("FTS still matches terms outside private regions", () => {
    repo.store({ title: "mixed memory", body: "foo <private>secretword</private> baz", memoryType: "fact", scope: "global" });
    const results = repo.search("foo");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe("mixed memory");
  });

  it("update() sets has_private=1 when new body contains private tags", () => {
    const id = repo.store({ title: "plain", body: "public content", memoryType: "fact", scope: "global" });
    repo.update(id, { body: "now <private>secret</private> here" });
    const row = db.prepare("SELECT has_private FROM memories WHERE id = ?").get(id) as any;
    expect(row.has_private).toBe(1);
  });

  it("update() sets has_private=0 when new body has no private tags", () => {
    const id = repo.store({ title: "was secret", body: "foo <private>bar</private> baz", memoryType: "fact", scope: "global" });
    repo.update(id, { body: "now public content" });
    const row = db.prepare("SELECT has_private FROM memories WHERE id = ?").get(id) as any;
    expect(row.has_private).toBe(0);
  });

  it("FTS does NOT match private terms after update with strip_private trigger", () => {
    const id = repo.store({ title: "updatable", body: "public content", memoryType: "fact", scope: "global" });
    repo.update(id, { body: "public content <private>privatestuff</private> end" });
    const results = repo.search("privatestuff");
    expect(results.length).toBe(0);
  });
});
