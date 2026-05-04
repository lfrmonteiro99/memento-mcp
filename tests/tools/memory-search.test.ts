import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { EdgesRepo } from "../../src/db/edges.js";
import { handleMemorySearch } from "../../src/tools/memory-search.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";

function tmpDbPath(): string {
  return join(tmpdir(), `memento-search-test-${randomUUID()}.db`);
}

interface SearchCtx {
  db: ReturnType<typeof createDatabase>;
  memRepo: MemoriesRepo;
  edgeRepo: EdgesRepo;
  config: typeof DEFAULT_CONFIG;
  projectPath: string;
  store(params: { title: string; body: string }): string;
}

function setupSearchableCtx(): SearchCtx {
  const db = createDatabase(tmpDbPath());
  const memRepo = new MemoriesRepo(db);
  const edgeRepo = new EdgesRepo(db);
  const config = { ...DEFAULT_CONFIG, vault: { ...DEFAULT_CONFIG.vault, enabled: false } };
  const projectPath = "/tmp/test-project-" + randomUUID();

  function store(params: { title: string; body: string }): string {
    return memRepo.store({
      title: params.title,
      body: params.body,
      memoryType: "fact",
      scope: "project",
      projectPath,
    });
  }

  return { db, memRepo, edgeRepo, config, projectPath, store };
}

describe("memory_search", () => {
  it("basic search returns matching memories", async () => {
    const ctx = setupSearchableCtx();
    ctx.store({ title: "deadlock howto", body: "How to handle Postgres deadlocks" });
    const result = await handleMemorySearch(
      ctx.memRepo, ctx.config,
      { query: "deadlock", project_path: ctx.projectPath, detail: "index" },
      ctx.db,
    );
    expect(result).toMatch(/deadlock howto/i);
    ctx.db.close();
  });

  it("include_edges=true appends 1-hop neighbours to results", async () => {
    const ctx = setupSearchableCtx();
    const mA = ctx.store({ title: "deadlock howto", body: "How to handle Postgres deadlocks" });
    const mB = ctx.store({ title: "lock contention fix", body: "Resolves database locks" });
    ctx.edgeRepo.create({ from: mB, to: mA, edge_type: "fixes", weight: 1.0 });

    const result = await handleMemorySearch(
      ctx.memRepo, ctx.config,
      { query: "deadlock", include_edges: true, project_path: ctx.projectPath, detail: "summary" },
      ctx.db,
    );

    // mA matches FTS; mB surfaces as edge neighbour
    expect(result).toMatch(/deadlock howto/i);
    expect(result).toMatch(/lock contention fix/i);
    // The edge neighbour section is annotated with the relationship
    expect(result).toMatch(/edge neighbour|via fixes|--\[fixes\]--|\[fixes\]/i);
    ctx.db.close();
  });

  it("backwards compat: omitting include_edges returns same shape as before", async () => {
    const ctx = setupSearchableCtx();
    ctx.store({ title: "deadlock howto", body: "How to handle Postgres deadlocks" });
    const result = await handleMemorySearch(
      ctx.memRepo, ctx.config,
      { query: "deadlock", project_path: ctx.projectPath },
      ctx.db,
    );
    // The section header "Edge neighbours" must not appear without include_edges.
    expect(result).not.toMatch(/edge neighbour/i);
    ctx.db.close();
  });

  it("edge_types filter narrows neighbour set", async () => {
    const ctx = setupSearchableCtx();
    const mA = ctx.store({ title: "deadlock howto", body: "deadlock body" });
    const mB = ctx.store({ title: "NodeB causes result", body: "b body" });
    const mC = ctx.store({ title: "NodeC relates result", body: "c body" });
    ctx.edgeRepo.create({ from: mA, to: mB, edge_type: "causes", weight: 1.0 });
    ctx.edgeRepo.create({ from: mA, to: mC, edge_type: "relates_to", weight: 1.0 });

    const result = await handleMemorySearch(
      ctx.memRepo, ctx.config,
      { query: "deadlock", include_edges: true, edge_types: ["causes"], project_path: ctx.projectPath },
      ctx.db,
    );
    // mB (causes-linked) appears; mC (relates_to) does not
    expect(result).toMatch(/NodeB causes result/);
    expect(result).not.toMatch(/NodeC relates result/);
    ctx.db.close();
  });

  it("dedups: a memory that is BOTH an FTS hit and an edge neighbour appears only once", async () => {
    const ctx = setupSearchableCtx();
    const mA = ctx.store({ title: "deadlock alpha", body: "deadlock body alpha" });
    const mB = ctx.store({ title: "deadlock beta", body: "deadlock body beta" });
    // mA → mB via causes; both will hit FTS for "deadlock"
    ctx.edgeRepo.create({ from: mA, to: mB, edge_type: "causes", weight: 1.0 });

    const result = await handleMemorySearch(
      ctx.memRepo, ctx.config,
      { query: "deadlock", include_edges: true, project_path: ctx.projectPath },
      ctx.db,
    );
    // count occurrences of "deadlock beta"
    const occurrences = (result.match(/deadlock beta/gi) ?? []).length;
    expect(occurrences).toBe(1);
    ctx.db.close();
  });

  it("skips soft-deleted neighbours", async () => {
    const ctx = setupSearchableCtx();
    const mA = ctx.store({ title: "deadlock howto", body: "deadlock body" });
    const mB = ctx.store({ title: "soft deleted ghost", body: "ghost" });
    ctx.edgeRepo.create({ from: mA, to: mB, edge_type: "causes", weight: 1.0 });
    ctx.db.prepare(`UPDATE memories SET deleted_at = datetime('now') WHERE id = ?`).run(mB);

    const result = await handleMemorySearch(
      ctx.memRepo, ctx.config,
      { query: "deadlock", include_edges: true, project_path: ctx.projectPath },
      ctx.db,
    );
    expect(result).not.toMatch(/soft deleted ghost/i);
    ctx.db.close();
  });
});
