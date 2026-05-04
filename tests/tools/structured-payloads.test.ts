// tests/tools/structured-payloads.test.ts
//
// Unit tests for the structured ({ text, structured }) variants of the four
// MCP tools that expose rich outputSchemas: memory_search, memory_list,
// memory_graph, memory_path.
//
// We assert that:
//   • the structured payload mirrors the rendered text (no drift),
//   • required fields are populated,
//   • shapes match what their tool-level outputSchema declares.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { EdgesRepo } from "../../src/db/edges.js";
import { searchMemories } from "../../src/tools/memory-search.js";
import { listMemories } from "../../src/tools/memory-list.js";
import { walkMemoryGraph } from "../../src/tools/memory-graph.js";
import { findMemoryPath } from "../../src/tools/memory-path.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";

describe("structured tool payloads", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let edgesRepo: EdgesRepo;
  const dbPath = join(tmpdir(), `memento-structured-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    edgesRepo = new EdgesRepo(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
  });

  function store(title: string, body = `body of ${title}`): string {
    return memRepo.store({ title, body, memoryType: "fact", scope: "global" });
  }

  describe("searchMemories", () => {
    it("returns parallel text + structured payloads describing the same hits", async () => {
      const aId = store("Alpha topic", "alpha alpha alpha");
      store("Beta topic", "beta beta");

      const { text, structured } = await searchMemories(memRepo, DEFAULT_CONFIG, {
        query: "alpha", detail: "summary",
      });

      expect(text).toContain("Alpha topic");
      expect(structured.query).toBe("alpha");
      expect(structured.detail).toBe("summary");
      expect(structured.count).toBeGreaterThan(0);
      expect(structured.results.some(r => r.id === aId && r.title === "Alpha topic")).toBe(true);
      expect(structured.results.every(r => typeof r.score === "number")).toBe(true);
      expect(structured.results.every(r => r.source === "sqlite" || r.source === "file")).toBe(true);
      expect(structured.total_tokens).toBeGreaterThan(0);
      // Vault is disabled in DEFAULT_CONFIG → empty array, not undefined.
      expect(Array.isArray(structured.vault_results)).toBe(true);
    });

    it("renders empty result sets consistently in both shapes", async () => {
      const { text, structured } = await searchMemories(memRepo, DEFAULT_CONFIG, {
        query: "nooooomatch-xyzzy",
      });
      expect(text).toBe("No results found.");
      expect(structured.count).toBe(0);
      expect(structured.results).toEqual([]);
    });
  });

  describe("listMemories", () => {
    it("returns count + memories + empty vault_results when vault disabled", async () => {
      const id = store("Listed memory");

      const { text, structured } = await listMemories(memRepo, DEFAULT_CONFIG, { detail: "index" });

      expect(text).toContain("Listed memory");
      expect(structured.detail).toBe("index");
      expect(structured.count).toBeGreaterThan(0);
      expect(structured.memories.some(m => m.id === id && m.title === "Listed memory")).toBe(true);
      expect(structured.vault_results).toEqual([]);
    });
  });

  describe("walkMemoryGraph", () => {
    it("returns found=false with empty edges when the root is missing", async () => {
      const { text, structured } = await walkMemoryGraph(memRepo, edgesRepo, { id: "no-such-id" });
      expect(text).toContain("not found");
      expect(structured.found).toBe(false);
      expect(structured.edges).toEqual([]);
      expect(structured.root).toBeUndefined();
    });

    it("returns found=true with edges when neighbours exist", async () => {
      const a = store("A");
      const b = store("B");
      edgesRepo.link(a, b, "relates_to", 1.0);

      const { text, structured } = await walkMemoryGraph(memRepo, edgesRepo, { id: a, depth: 1 });

      expect(text).toContain("A");
      expect(text).toContain("relates_to");
      expect(structured.found).toBe(true);
      expect(structured.root?.id).toBe(a);
      expect(structured.edges.length).toBe(1);
      expect(structured.edges[0].direction).toBe("out");
      expect(structured.edges[0].edge_type).toBe("relates_to");
      expect(structured.edges[0].other.id).toBe(b);
    });
  });

  describe("findMemoryPath", () => {
    it("returns found=false with a message when there is no path", async () => {
      const a = store("A");
      const b = store("B");

      const { text, structured } = await findMemoryPath(memRepo, edgesRepo, { from_id: a, to_id: b });

      expect(text).toContain("No path");
      expect(structured.found).toBe(false);
      expect(structured.hops).toBe(0);
      expect(structured.path).toEqual([]);
      expect(structured.message).toBeTruthy();
    });

    it("returns hops + path with edge_type_to_next chained between nodes", async () => {
      const a = store("A");
      const b = store("B");
      const c = store("C");
      edgesRepo.link(a, b, "relates_to", 1.0);
      edgesRepo.link(b, c, "caused_by", 1.0);

      const { text, structured } = await findMemoryPath(memRepo, edgesRepo, { from_id: a, to_id: c });

      expect(text).toContain("A");
      expect(text).toContain("C");
      expect(structured.found).toBe(true);
      expect(structured.hops).toBe(2);
      expect(structured.path.map(n => n.id)).toEqual([a, b, c]);
      expect(structured.path[0].edge_type_to_next).toBe("relates_to");
      expect(structured.path[1].edge_type_to_next).toBe("caused_by");
      expect(structured.path[2].edge_type_to_next).toBeUndefined();
    });
  });
});
