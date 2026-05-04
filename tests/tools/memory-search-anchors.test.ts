import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { AnchorsRepo } from "../../src/db/anchors.js";
import { handleMemorySearch } from "../../src/tools/memory-search.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";

describe("memory_search annotates results with anchor_status (P4 Task 7)", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let anchorRepo: AnchorsRepo;
  const dbPath = join(tmpdir(), `memento-search-anc-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    anchorRepo = new AnchorsRepo(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("renders [stale] marker on result whose anchor is stale", async () => {
    const id = memRepo.store({
      title: "ADR-401 OAuth2",
      body: "Use OAuth2 for service-to-service auth",
      memoryType: "decision",
      scope: "global",
    });
    const a = anchorRepo.attach({ memory_id: id, file_path: "src/auth.ts" });
    anchorRepo.markStale(a.id, "10/10 lines modified (100%)");

    const out = await handleMemorySearch(
      memRepo,
      DEFAULT_CONFIG,
      { query: "OAuth2", detail: "index" },
      db,
    );
    expect(out).toMatch(/ADR-401 OAuth2.*\[stale\]|\[stale\].*ADR-401/);
  });

  it("renders [anchor-deleted] when any anchor is anchor-deleted (precedence over stale)", async () => {
    const id = memRepo.store({
      title: "Pitfall: missing null check",
      body: "Always check user.email is non-null before parsing",
      memoryType: "pitfall",
      scope: "global",
    });
    const a1 = anchorRepo.attach({ memory_id: id, file_path: "src/old.ts" });
    const a2 = anchorRepo.attach({ memory_id: id, file_path: "src/new.ts" });
    anchorRepo.markStale(a1.id, "stale");
    anchorRepo.markAnchorDeleted(a2.id, "file removed");

    const out = await handleMemorySearch(
      memRepo,
      DEFAULT_CONFIG,
      { query: "null check", detail: "index" },
      db,
    );
    expect(out).toContain("[anchor-deleted]");
    expect(out).not.toContain("[stale]");
  });

  it("P3 Task 6: include_deleted_neighbours surfaces soft-deleted derives_from sources", async () => {
    // Stand up a compressed memory with derives_from edges to soft-deleted sources.
    const projectId = memRepo.ensureProject("/tmp/p3-derives-proj");

    const sourceA = memRepo.store({
      title: "Edit: payments.ts step A", body: "deadlock pattern in payments",
      memoryType: "fact", scope: "project", projectId,
    });
    const sourceB = memRepo.store({
      title: "Edit: payments.ts step B", body: "deadlock pattern reappears",
      memoryType: "fact", scope: "project", projectId,
    });
    const compressedId = memRepo.store({
      title: "Cluster: payments.ts deadlock pattern",
      body: "Rolled-up summary of the recurring deadlock pattern in payments",
      memoryType: "fact", scope: "project", projectId,
      source: "compression",
    });
    db.prepare(
      "INSERT INTO memory_edges(from_memory_id, to_memory_id, edge_type, weight) VALUES (?, ?, 'derives_from', 1.0)",
    ).run(compressedId, sourceA);
    db.prepare(
      "INSERT INTO memory_edges(from_memory_id, to_memory_id, edge_type, weight) VALUES (?, ?, 'derives_from', 1.0)",
    ).run(compressedId, sourceB);
    db.prepare("UPDATE memories SET deleted_at = datetime('now') WHERE id IN (?, ?)").run(sourceA, sourceB);

    const out = await handleMemorySearch(
      memRepo,
      DEFAULT_CONFIG,
      {
        query: "deadlock",
        detail: "index",
        include_edges: true,
        edge_types: ["derives_from"],
        edge_direction: "outgoing",
        include_deleted_neighbours: true,
      },
      db,
    );
    // Both source titles surface as edge neighbours of the compressed hit.
    expect(out).toContain("step A");
    expect(out).toContain("step B");
    expect(out).toContain("derives_from");
    // [archived] marker disambiguates them from live neighbours.
    expect(out).toContain("[archived]");
  });

  it("P3 Task 6: include_deleted_neighbours=false hides soft-deleted neighbours (default)", async () => {
    const projectId = memRepo.ensureProject("/tmp/p3-derives-proj-default");
    const sourceA = memRepo.store({
      title: "Edit: payments.ts step A default", body: "default-deadlock pattern",
      memoryType: "fact", scope: "project", projectId,
    });
    const compressedId = memRepo.store({
      title: "Cluster: default-deadlock pattern summary",
      body: "Rolled-up summary about default-deadlock occurrences",
      memoryType: "fact", scope: "project", projectId,
      source: "compression",
    });
    db.prepare(
      "INSERT INTO memory_edges(from_memory_id, to_memory_id, edge_type, weight) VALUES (?, ?, 'derives_from', 1.0)",
    ).run(compressedId, sourceA);
    db.prepare("UPDATE memories SET deleted_at = datetime('now') WHERE id = ?").run(sourceA);

    const out = await handleMemorySearch(
      memRepo,
      DEFAULT_CONFIG,
      {
        query: "default-deadlock",
        detail: "index",
        include_edges: true,
        edge_types: ["derives_from"],
        edge_direction: "outgoing",
      },
      db,
    );
    expect(out).not.toContain("step A default");
  });

  it("does not annotate memories without anchors", async () => {
    memRepo.store({
      title: "plain note",
      body: "no anchor on this one",
      memoryType: "fact",
      scope: "global",
    });
    const out = await handleMemorySearch(
      memRepo,
      DEFAULT_CONFIG,
      { query: "plain", detail: "index" },
      db,
    );
    expect(out).not.toMatch(/\[(stale|anchor-deleted|fresh)\]/);
  });
});
