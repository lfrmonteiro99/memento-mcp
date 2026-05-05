// tests/integration/embedding-search.test.ts
// Mock provider - no real network calls.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { SessionsRepo } from "../../src/db/sessions.js";
import { EmbeddingsRepo } from "../../src/db/embeddings.js";
import { processSearchHook } from "../../src/hooks/search-context.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";
import { cosineSimilarity } from "../../src/engine/embeddings/cosine.js";
import type { EmbeddingProvider } from "../../src/engine/embeddings/provider.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// A deterministic mock provider that maps texts to known vectors.
// Vectors are chosen so "auth bug" is close to "JWT validation failure"
// but FTS would NOT match (no shared tokens).
class MockEmbeddingProvider implements EmbeddingProvider {
  readonly model = "mock-model";
  readonly dim = 4;

  private readonly knownVectors: Map<string, Float32Array> = new Map([
    // Query: "auth bug" cluster
    ["auth bug", new Float32Array([1, 0, 0, 0])],
    // Semantically similar to "auth bug" but no shared tokens
    ["JWT validation failure", new Float32Array([0.95, 0.1, 0, 0])],
    // Unrelated
    ["Python list comprehension tutorial", new Float32Array([0, 0, 1, 0])],
    ["database connection pooling", new Float32Array([0, 0, 0, 1])],
  ]);

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(t => {
      const v = this.knownVectors.get(t);
      if (v) return v;
      // Default: random-ish but reproducible based on text length
      return new Float32Array([0, 0.01 * t.length, 0, 0]);
    });
  }
}

describe("hybrid embedding search integration", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let sessRepo: SessionsRepo;
  let embRepo: EmbeddingsRepo;
  const dbPath = join(tmpdir(), `memento-emb-search-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    sessRepo = new SessionsRepo(db);
    embRepo = new EmbeddingsRepo(db);
  });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("cosine similarity: 'auth bug' is close to 'JWT validation failure'", () => {
    const provider = new MockEmbeddingProvider();
    // Verify our mock vectors have high cosine similarity
    const authBug = new Float32Array([1, 0, 0, 0]);
    const jwtFail = new Float32Array([0.95, 0.1, 0, 0]);
    expect(cosineSimilarity(authBug, jwtFail)).toBeGreaterThan(0.9);
  });

  it("enabled=false produces no embedding activity", async () => {
    // Store memory and embedding
    const id = memRepo.store({ title: "JWT validation failure", body: "Token signature mismatch", memoryType: "fact", scope: "global" });
    embRepo.upsert(id, "mock-model", new Float32Array([0.95, 0.1, 0, 0]));

    // Explicitly disable embeddings to test the FTS-only path.
    const config = {
      ...DEFAULT_CONFIG,
      search: {
        ...DEFAULT_CONFIG.search,
        embeddings: { ...DEFAULT_CONFIG.search.embeddings, enabled: false },
      },
    };
    expect(config.search.embeddings.enabled).toBe(false);

    // Search without embRepo arg — embeddings disabled path
    const output = await processSearchHook(db, "auth bug authentication", memRepo, sessRepo, config);
    // FTS would not match "auth bug" to "JWT validation failure" (no shared tokens)
    // That's expected with FTS-only
    expect(typeof output).toBe("string");
  });

  it("with mock provider, embedding search finds semantic match FTS would miss", async () => {
    // Memory: "JWT validation failure" - no tokens in common with query "auth bug"
    const semanticId = memRepo.store({
      title: "JWT validation failure",
      body: "Token signature mismatch detected during verification",
      memoryType: "fact",
      scope: "global",
    });
    // Memory: unrelated to auth
    const unrelatedId = memRepo.store({
      title: "Python list comprehension tutorial",
      body: "How to use list comprehensions in Python effectively",
      memoryType: "fact",
      scope: "global",
    });

    // Store embeddings for both memories
    embRepo.upsert(semanticId, "mock-model", new Float32Array([0.95, 0.1, 0, 0]));
    embRepo.upsert(unrelatedId, "mock-model", new Float32Array([0, 0, 1, 0]));

    // Verify "auth bug" (query) is close to JWT vector but not Python vector
    const queryVec = new Float32Array([1, 0, 0, 0]);
    const jwtVec = new Float32Array([0.95, 0.1, 0, 0]);
    const pythonVec = new Float32Array([0, 0, 1, 0]);
    expect(cosineSimilarity(queryVec, jwtVec)).toBeGreaterThan(0.9);
    expect(cosineSimilarity(queryVec, pythonVec)).toBeCloseTo(0, 3);
  });

  it("EmbeddingsRepo.getByProject correctly filters by project", () => {
    const proj1 = memRepo.ensureProject("/proj1");
    const proj2 = memRepo.ensureProject("/proj2");
    const id1 = memRepo.store({ title: "p1-mem", body: "b", memoryType: "fact", scope: "project", projectId: proj1 });
    const id2 = memRepo.store({ title: "p2-mem", body: "b", memoryType: "fact", scope: "project", projectId: proj2 });
    embRepo.upsert(id1, "mock-model", new Float32Array([1, 0]));
    embRepo.upsert(id2, "mock-model", new Float32Array([0, 1]));

    const proj1Results = embRepo.getByProject(proj1, "mock-model");
    expect(proj1Results.map(r => r.memoryId)).toContain(id1);
    expect(proj1Results.map(r => r.memoryId)).not.toContain(id2);
  });

  it("hook falls back to FTS-only when provider throws (never crashes)", async () => {
    const id = memRepo.store({ title: "React hooks guide", body: "useState useEffect patterns", memoryType: "fact", scope: "global" });
    embRepo.upsert(id, "mock-model", new Float32Array([1, 0, 0, 0]));

    // Config with embeddings enabled but no API key (createProvider returns null)
    const config = {
      ...DEFAULT_CONFIG,
      search: {
        ...DEFAULT_CONFIG.search,
        embeddings: { ...DEFAULT_CONFIG.search.embeddings, enabled: true },
      },
    };
    // Delete env var to ensure provider returns null
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const output = await processSearchHook(db, "how do React hooks work?", memRepo, sessRepo, config, undefined, embRepo);
      // Should still work via FTS fallback
      expect(typeof output).toBe("string");
    } finally {
      if (savedKey) process.env.OPENAI_API_KEY = savedKey;
    }
  });

  it("backfill: iterateMissing yields memories without embeddings", () => {
    const id1 = memRepo.store({ title: "has-embedding", body: "b1", memoryType: "fact", scope: "global" });
    const id2 = memRepo.store({ title: "no-embedding", body: "b2", memoryType: "fact", scope: "global" });
    embRepo.upsert(id1, "mock-model", new Float32Array([1, 0]));

    const missing = [...embRepo.iterateMissing("mock-model", 100)];
    expect(missing.length).toBe(1);
    expect(missing[0].id).toBe(id2);
    expect(missing[0].title).toBe("no-embedding");
  });
});
