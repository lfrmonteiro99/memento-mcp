// tests/tools/memory-tools-branches.test.ts
// Branch coverage for memory-search, memory-graph, memory-list, memory-delete,
// memory-get and memory-update beyond the existing happy-path tests.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { EdgesRepo } from "../../src/db/edges.js";
import { handleMemorySearch } from "../../src/tools/memory-search.js";
import { handleMemoryGraph } from "../../src/tools/memory-graph.js";
import { handleMemoryList } from "../../src/tools/memory-list.js";
import { handleMemoryDelete } from "../../src/tools/memory-delete.js";
import { handleMemoryGet } from "../../src/tools/memory-get.js";
import { handleMemoryUpdate } from "../../src/tools/memory-update.js";
import { rebuildVaultIndex } from "../../src/engine/vault-index.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";
import { AnalyticsTracker } from "../../src/analytics/tracker.js";

function freshDb() {
  const path = join(tmpdir(), `branches-${process.pid}-${randomUUID()}.sqlite`);
  const db = createDatabase(path);
  return { db, path };
}

describe("handleMemorySearch — branch coverage", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: MemoriesRepo;
  let path: string;

  beforeEach(() => {
    ({ db, path } = freshDb());
    repo = new MemoriesRepo(db);
  });
  afterEach(() => { db.close(); rmSync(path, { force: true }); });

  it("returns 'No results found.' when nothing matches", async () => {
    const out = await handleMemorySearch(repo, DEFAULT_CONFIG, { query: "noooomatch-xyzzy" });
    expect(out).toContain("No results found");
  });

  it("renders summary detail when configured", async () => {
    repo.store({ title: "alpha summary", body: "first sentence. second sentence.", memoryType: "fact", scope: "global" });
    const out = await handleMemorySearch(repo, DEFAULT_CONFIG, { query: "alpha", detail: "summary" });
    expect(out).toContain("alpha summary");
  });

  it("filters by memory_type", async () => {
    repo.store({ title: "alpha typed", body: "x", memoryType: "decision", scope: "global" });
    repo.store({ title: "alpha note", body: "x", memoryType: "fact", scope: "global" });
    const out = await handleMemorySearch(repo, DEFAULT_CONFIG, { query: "alpha", memory_type: "decision" });
    expect(out).toContain("alpha typed");
    expect(out).not.toContain("alpha note");
  });

  it("emits a search_layer_used analytics event when tracker is provided", async () => {
    repo.store({ title: "tracked search", body: "abc", memoryType: "fact", scope: "global" });
    const tracker = new AnalyticsTracker(db, { flushThreshold: 1 });
    await handleMemorySearch(repo, DEFAULT_CONFIG, { query: "tracked search" }, db, tracker);
    tracker.flush();
    const ev = db.prepare("SELECT * FROM analytics_events WHERE event_type = 'search_layer_used'").get();
    expect(ev).toBeDefined();
  });

  it("appends vault entries when vault is enabled", async () => {
    const vaultPath = join(tmpdir(), `search-vault-${process.pid}-${randomUUID()}`);
    mkdirSync(join(vaultPath, "30 Domains"), { recursive: true });
    writeFileSync(join(vaultPath, "me.md"),
      `---\nmemento_publish: true\nmemento_kind: identity\nmemento_summary: id\n---\n`);
    writeFileSync(join(vaultPath, "vault.md"),
      `---\nmemento_publish: true\nmemento_kind: map\nmemento_summary: m\n---\nSee [[30 Domains/sched]].`);
    writeFileSync(join(vaultPath, "30 Domains/sched.md"),
      `---\nmemento_publish: true\nmemento_kind: domain\nmemento_summary: scheduling architecture rules\n---\nbody`);
    try {
      const config = {
        ...DEFAULT_CONFIG,
        vault: { ...DEFAULT_CONFIG.vault, enabled: true, path: vaultPath },
      };
      rebuildVaultIndex(db, config.vault);
      repo.store({ title: "Generic", body: "scheduling architecture rules", memoryType: "fact", scope: "global" });

      const out = await handleMemorySearch(repo, config, {
        query: "scheduling architecture rules",
        detail: "index",
      }, db);
      expect(out.length).toBeGreaterThan(0);
    } finally {
      rmSync(vaultPath, { recursive: true, force: true });
    }
  });
});

describe("handleMemoryGraph — branch coverage", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: MemoriesRepo;
  let edges: EdgesRepo;
  let path: string;

  beforeEach(() => {
    ({ db, path } = freshDb());
    repo = new MemoriesRepo(db);
    edges = new EdgesRepo(db);
  });
  afterEach(() => { db.close(); rmSync(path, { force: true }); });

  it("rejects unknown id", async () => {
    const out = await handleMemoryGraph(repo, edges, { id: "missing" });
    expect(out).toContain("not found");
  });

  it("returns header only when there are no edges", async () => {
    const a = repo.store({ title: "Alone", body: "x", memoryType: "fact", scope: "global" });
    const out = await handleMemoryGraph(repo, edges, { id: a });
    expect(out).toContain("Alone");
    expect(out).not.toContain("->");
    expect(out).not.toContain("<-");
  });

  it("renders both outgoing and incoming edges with the correct markers", async () => {
    const a = repo.store({ title: "Center", body: "x", memoryType: "fact", scope: "global" });
    const b = repo.store({ title: "Out", body: "x", memoryType: "fact", scope: "global" });
    const c = repo.store({ title: "In", body: "x", memoryType: "fact", scope: "global" });
    edges.link(a, b, "relates_to");
    edges.link(c, a, "references");

    const out = await handleMemoryGraph(repo, edges, { id: a });
    expect(out).toContain("->relates_to");
    expect(out).toContain('"Out"');
    expect(out).toContain("<-references");
    expect(out).toContain('"In"');
  });

  it("uses raw id when neighbor memory is missing", async () => {
    const a = repo.store({ title: "Has dangling edge", body: "x", memoryType: "fact", scope: "global" });
    const b = repo.store({ title: "Will be deleted", body: "x", memoryType: "fact", scope: "global" });
    edges.link(a, b, "relates_to");
    repo.delete(b);
    const out = await handleMemoryGraph(repo, edges, { id: a });
    expect(out).toContain("Has dangling edge");
    expect(out).toContain("(unknown)");
  });
});

describe("handleMemoryList — branch coverage", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: MemoriesRepo;
  let path: string;

  beforeEach(() => {
    ({ db, path } = freshDb());
    repo = new MemoriesRepo(db);
  });
  afterEach(() => { db.close(); rmSync(path, { force: true }); });

  it("renders summary detail when configured", async () => {
    repo.store({ title: "Alpha", body: "first. second.", memoryType: "fact", scope: "global" });
    const out = await handleMemoryList(repo, DEFAULT_CONFIG, { detail: "summary" });
    expect(out).toContain("Alpha");
  });

  it("returns vault entries when vault is enabled and SQLite list is empty", async () => {
    const vaultPath = join(tmpdir(), `list-vault-${process.pid}-${randomUUID()}`);
    mkdirSync(join(vaultPath, "30 Domains"), { recursive: true });
    writeFileSync(join(vaultPath, "me.md"),
      `---\nmemento_publish: true\nmemento_kind: identity\nmemento_summary: id\n---\n`);
    writeFileSync(join(vaultPath, "vault.md"),
      `---\nmemento_publish: true\nmemento_kind: map\nmemento_summary: m\n---\nSee [[30 Domains/note]].`);
    writeFileSync(join(vaultPath, "30 Domains/note.md"),
      `---\nmemento_publish: true\nmemento_kind: domain\nmemento_summary: domain summary\n---\nbody`);
    try {
      const config = {
        ...DEFAULT_CONFIG,
        vault: { ...DEFAULT_CONFIG.vault, enabled: true, path: vaultPath },
      };
      rebuildVaultIndex(db, config.vault);

      const out = await handleMemoryList(repo, config, { detail: "index" }, db);
      expect(out).toContain("[vault:domain]");
    } finally {
      rmSync(vaultPath, { recursive: true, force: true });
    }
  });
});

describe("handleMemoryDelete — branch coverage", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: MemoriesRepo;
  let path: string;

  beforeEach(() => {
    ({ db, path } = freshDb());
    repo = new MemoriesRepo(db);
  });
  afterEach(() => { db.close(); rmSync(path, { force: true }); });

  it("rejects file: prefixed ids", async () => {
    const out = await handleMemoryDelete(repo, { memory_id: "file:/tmp/foo.md" });
    expect(out).toContain("file-based");
  });

  it("returns 'not found' for missing id", async () => {
    const out = await handleMemoryDelete(repo, { memory_id: "missing" });
    expect(out).toContain("not found");
  });

  it("soft-deletes existing memory", async () => {
    const id = repo.store({ title: "del", body: "x", memoryType: "fact", scope: "global" });
    const out = await handleMemoryDelete(repo, { memory_id: id });
    expect(out).toContain("deleted");
  });
});

describe("handleMemoryGet — file: branch", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: MemoriesRepo;
  let path: string;

  beforeEach(() => {
    ({ db, path } = freshDb());
    repo = new MemoriesRepo(db);
  });
  afterEach(() => { db.close(); rmSync(path, { force: true }); });

  it("returns 'Memory not found.' for unknown file: id", async () => {
    const out = await handleMemoryGet(repo, db, DEFAULT_CONFIG, { memory_id: "file:/no/such.md" });
    expect(out).toBe("Memory not found.");
  });

  it("returns vault disabled message when vault flag off", async () => {
    const out = await handleMemoryGet(repo, db, DEFAULT_CONFIG, { memory_id: "vault:any.md" });
    expect(out).toMatch(/Vault support is not enabled/);
  });

  it("returns 'Vault note not found' when id has no row", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      vault: { ...DEFAULT_CONFIG.vault, enabled: true, path: "/tmp/x" },
    };
    const out = await handleMemoryGet(repo, db, config, { memory_id: "vault:nope.md" });
    expect(out).toContain("Vault note not found");
  });
});

describe("handleMemoryUpdate — branch coverage", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: MemoriesRepo;
  let path: string;

  beforeEach(() => {
    ({ db, path } = freshDb());
    repo = new MemoriesRepo(db);
  });
  afterEach(() => { db.close(); rmSync(path, { force: true }); });

  it("rejects unbalanced <private> tags in content", async () => {
    const id = repo.store({ title: "T", body: "x", memoryType: "fact", scope: "global" });
    const out = await handleMemoryUpdate(repo, { memory_id: id, content: "open <private> only" });
    expect(out).toMatch(/unbalanced/);
  });

  it("returns no-fields message when no patch fields are passed", async () => {
    const out = await handleMemoryUpdate(repo, { memory_id: "any" });
    expect(out).toMatch(/No fields to update/);
  });

  it("returns not found for unknown id", async () => {
    const out = await handleMemoryUpdate(repo, { memory_id: "missing", title: "new" });
    expect(out).toMatch(/Memory not found: missing/);
  });

  it("updates title and persists the change", async () => {
    const id = repo.store({ title: "Old", body: "x", memoryType: "fact", scope: "global" });
    const out = await handleMemoryUpdate(repo, { memory_id: id, title: "New" });
    expect(out).toContain(`Memory updated: ${id}`);
    expect(repo.getById(id)?.title).toBe("New");
  });
});
