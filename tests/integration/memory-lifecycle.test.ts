// tests/integration/memory-lifecycle.test.ts
// End-to-end test of the core memory lifecycle, exercising the full chain of
// public tool handlers in the order a user would actually use them. Catches
// regressions where individual unit tests pass but the chained behavior breaks.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { EdgesRepo } from "../../src/db/edges.js";
import { handleMemoryStore } from "../../src/tools/memory-store.js";
import { handleMemorySearch } from "../../src/tools/memory-search.js";
import { handleMemoryGet } from "../../src/tools/memory-get.js";
import { handleMemoryList } from "../../src/tools/memory-list.js";
import { handleMemoryUpdate } from "../../src/tools/memory-update.js";
import { handleMemoryDelete } from "../../src/tools/memory-delete.js";
import { handleMemoryLink } from "../../src/tools/memory-link.js";
import { handleMemoryUnlink } from "../../src/tools/memory-unlink.js";
import { handleMemoryGraph } from "../../src/tools/memory-graph.js";
import { handleMemoryPath } from "../../src/tools/memory-path.js";
import { handleMemoryPin } from "../../src/tools/memory-pin.js";
import { handleMemoryTimeline } from "../../src/tools/memory-timeline.js";
import { handleMemoryExport, handleMemoryImport } from "../../src/tools/memory-transfer.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";
import { writeFileSync } from "node:fs";

function extractId(storeResult: string): string {
  const m = storeResult.match(/ID:\s*(\S+)/);
  if (!m) throw new Error(`could not extract id from: ${storeResult}`);
  return m[1];
}

describe("memory lifecycle — end-to-end through tool handlers", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: MemoriesRepo;
  let edges: EdgesRepo;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `lifecycle-${process.pid}-${randomUUID()}.sqlite`);
    db = createDatabase(dbPath);
    repo = new MemoriesRepo(db);
    edges = new EdgesRepo(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("store → search → get → update → search-after-update reflects changes", async () => {
    const stored = await handleMemoryStore(repo, {
      title: "Adopt TypeScript",
      content: "Use TypeScript for new packages.",
      memory_type: "decision",
      scope: "global",
      tags: ["arch", "stack"],
      importance: 0.8,
    });
    const id = extractId(stored);

    // Search by query — must surface the new memory.
    const found = await handleMemorySearch(repo, DEFAULT_CONFIG, { query: "TypeScript" });
    expect(found).toContain("Adopt TypeScript");

    // Get full body.
    const got = await handleMemoryGet(repo, db, DEFAULT_CONFIG, { memory_id: id });
    expect(got).toContain("Use TypeScript for new packages.");

    // Update title and importance.
    const updated = await handleMemoryUpdate(repo, {
      memory_id: id,
      title: "Adopt TypeScript everywhere",
      importance: 0.95,
    });
    expect(updated).toContain("Memory updated");

    // Search now finds the new title.
    const after = await handleMemorySearch(repo, DEFAULT_CONFIG, { query: "everywhere" });
    expect(after).toContain("Adopt TypeScript everywhere");

    // Persisted importance reflected in DB.
    expect(repo.getById(id)?.importance_score).toBeCloseTo(0.95);
  });

  it("link → graph → path → unlink updates the edge graph end-to-end", async () => {
    const a = extractId(await handleMemoryStore(repo, {
      title: "Component A", content: "a body", memory_type: "fact", scope: "global",
    }));
    const b = extractId(await handleMemoryStore(repo, {
      title: "Component B", content: "b body", memory_type: "fact", scope: "global",
    }));
    const c = extractId(await handleMemoryStore(repo, {
      title: "Component C", content: "c body", memory_type: "fact", scope: "global",
    }));

    await handleMemoryLink(repo, edges, { from_id: a, to_id: b, edge_type: "relates_to" });
    await handleMemoryLink(repo, edges, { from_id: b, to_id: c, edge_type: "references" });

    const graphAtA = await handleMemoryGraph(repo, edges, { id: a, depth: 2 });
    expect(graphAtA).toContain("Component A");
    expect(graphAtA).toContain("Component B");

    const path = await handleMemoryPath(repo, edges, { from_id: a, to_id: c });
    expect(path).toContain(a);
    expect(path).toContain(c);
    expect(path).toContain("relates_to");
    expect(path).toContain("references");

    // Unlink the middle edge — path should now break.
    const unlinked = await handleMemoryUnlink(edges, { from_id: b, to_id: c, edge_type: "references" });
    expect(unlinked).toContain("Unlinked");

    const noPath = await handleMemoryPath(repo, edges, { from_id: a, to_id: c });
    expect(noPath).toContain("No path");
  });

  it("pin → list pinned_only → unpin flow", async () => {
    const id = extractId(await handleMemoryStore(repo, {
      title: "Critical note", content: "do not lose", memory_type: "fact", scope: "global",
    }));

    await handleMemoryPin(repo, { memory_id: id, pinned: true });

    const pinnedList = await handleMemoryList(repo, DEFAULT_CONFIG, { pinned_only: true });
    expect(pinnedList).toContain("Critical note");

    await handleMemoryPin(repo, { memory_id: id, pinned: false });
    const empty = await handleMemoryList(repo, DEFAULT_CONFIG, { pinned_only: true });
    expect(empty).not.toContain("Critical note");
  });

  it("timeline reveals neighboring memories within the session window", async () => {
    const a = extractId(await handleMemoryStore(repo, {
      title: "First", content: "x", memory_type: "fact", scope: "global",
    }));
    await handleMemoryStore(repo, {
      title: "Second", content: "y", memory_type: "fact", scope: "global",
    });
    const out = await handleMemoryTimeline(repo, { id: a, detail: "index" });
    expect(out).toContain("First");
  });

  it("delete soft-deletes and removes the memory from search/list", async () => {
    const id = extractId(await handleMemoryStore(repo, {
      title: "Throwaway", content: "tmp body", memory_type: "fact", scope: "global",
    }));
    expect((await handleMemorySearch(repo, DEFAULT_CONFIG, { query: "Throwaway" }))).toContain("Throwaway");

    const del = await handleMemoryDelete(repo, { memory_id: id });
    expect(del).toContain("deleted");

    expect(await handleMemorySearch(repo, DEFAULT_CONFIG, { query: "Throwaway" })).not.toContain("Throwaway");
    expect(await handleMemoryList(repo, DEFAULT_CONFIG, {})).not.toContain("Throwaway");
  });

  it("export → import round-trips memories across databases", async () => {
    await handleMemoryStore(repo, {
      title: "Round trip A", content: "exported body A",
      memory_type: "fact", scope: "global",
    });
    await handleMemoryStore(repo, {
      title: "Round trip B", content: "exported body B",
      memory_type: "preference", scope: "global",
    });

    const exported = await handleMemoryExport(db, {});
    expect(JSON.parse(exported).memories.length).toBeGreaterThanOrEqual(2);

    const exportPath = join(tmpdir(), `export-${process.pid}-${randomUUID()}.json`);
    writeFileSync(exportPath, exported);

    const otherDbPath = join(tmpdir(), `other-${process.pid}-${randomUUID()}.sqlite`);
    const otherDb = createDatabase(otherDbPath);
    try {
      const result = await handleMemoryImport(otherDb, { path: exportPath });
      expect(result).toContain("imported");

      const otherRepo = new MemoriesRepo(otherDb);
      const list = otherRepo.list({});
      const titles = list.map(m => m.title);
      expect(titles).toContain("Round trip A");
      expect(titles).toContain("Round trip B");
    } finally {
      otherDb.close();
      rmSync(otherDbPath, { force: true });
      rmSync(exportPath, { force: true });
    }
  });
});
