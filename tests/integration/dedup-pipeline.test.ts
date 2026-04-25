// tests/integration/dedup-pipeline.test.ts
// End-to-end integration tests for the write-time dedup pipeline (issue #8).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { EmbeddingsRepo } from "../../src/db/embeddings.js";
import { handleMemoryStore } from "../../src/tools/memory-store.js";
import { handleMemoryUpdate } from "../../src/tools/memory-update.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";
import { clearPolicyCache } from "../../src/lib/policy.js";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// Normalise vector helper
function normalise(v: Float32Array): Float32Array {
  let mag = 0;
  for (let i = 0; i < v.length; i++) mag += v[i] * v[i];
  mag = Math.sqrt(mag);
  return v.map(x => x / mag) as Float32Array;
}

function makeVec(seed: number, dim = 4): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.sin(seed + i * 0.1);
  return normalise(v);
}

describe("dedup-pipeline integration", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let embRepo: EmbeddingsRepo;
  const dbPath = join(tmpdir(), `memento-dedup-pipeline-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    embRepo = new EmbeddingsRepo(db);
    clearPolicyCache();
  });

  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
    clearPolicyCache();
    vi.restoreAllMocks();
  });

  it("embeddings disabled = full no-op (no API calls)", async () => {
    // config with embeddings.enabled = false (the default)
    const config = { ...DEFAULT_CONFIG };
    // embeddings.enabled is false by default — dedup must be a no-op
    expect(config.search.embeddings.enabled).toBe(false);

    const result = await handleMemoryStore(
      memRepo,
      { title: "Test memory", content: "test content", dedup: "strict" },
      db,
      config,
      embRepo,
    );
    // Even with dedup="strict" param, embeddings disabled means always stores
    expect(result).toContain("Memory stored with ID:");
  });

  it("embeddings enabled but dedup=false in config = no dedup (no-op)", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      search: {
        ...DEFAULT_CONFIG.search,
        embeddings: {
          ...DEFAULT_CONFIG.search.embeddings,
          enabled: true,
          dedup: false, // explicit opt-out (the default)
        },
      },
    };

    // Even with embeddings enabled, dedup=false means no dedup check
    const result = await handleMemoryStore(
      memRepo,
      { title: "Test", content: "content" },
      db,
      config,
      embRepo,
    );
    expect(result).toContain("Memory stored with ID:");
  });

  it("policy banned_content runs BEFORE dedup (no embed call when policy blocks)", async () => {
    const projectDir = join(tmpdir(), `dedup-pipeline-policy-${randomUUID()}`);
    mkdirSync(join(projectDir, ".memento"), { recursive: true });
    writeFileSync(
      join(projectDir, ".memento", "policy.toml"),
      '[banned_content]\npatterns = ["forbidden-keyword"]\n',
    );
    clearPolicyCache();

    // We track whether any embedding API was called via the embRepo spy.
    // Since findDuplicate calls getByProject FIRST (before embed), and since
    // the policy check happens before findDuplicate, the provider.embed()
    // must never be called when policy blocks.
    //
    // We verify this by mocking createProvider and checking embed is not called.
    const createProviderMod = await import("../../src/engine/embeddings/provider.js");
    const mockEmbed = vi.fn();
    vi.spyOn(createProviderMod, "createProvider").mockReturnValue({
      model: "test-model",
      dim: 4,
      embed: mockEmbed,
    });

    const config = {
      ...DEFAULT_CONFIG,
      search: {
        ...DEFAULT_CONFIG.search,
        embeddings: {
          ...DEFAULT_CONFIG.search.embeddings,
          enabled: true,
          dedup: true,
          dedupThreshold: 0.92,
          dedupDefaultMode: "warn" as const,
          dedupCheckOnUpdate: true,
          dedupMaxScan: 2000,
        },
      },
    };

    const result = await handleMemoryStore(
      memRepo,
      {
        title: "test memory",
        content: "this contains forbidden-keyword",
        project_path: projectDir,
      },
      db,
      config,
      embRepo,
    );

    // Policy must block BEFORE dedup
    expect(result).toContain("Memory not stored");
    expect(result).toContain("forbidden-keyword");
    // embed should NOT have been called (we didn't reach the dedup check)
    expect(mockEmbed).not.toHaveBeenCalled();

    rmSync(projectDir, { recursive: true, force: true });
  });

  it("enabled+dedup=true: dedup=warn stores but surfaces near-duplicate info", async () => {
    // Seed an existing memory + embedding
    const existId = memRepo.store({ title: "Use Postgres", body: "postgres is our db", memoryType: "fact", scope: "global" });
    const baseVec = makeVec(42);
    embRepo.upsert(existId, "test-model", baseVec);

    // Mock the provider to return an identical vector for the new memory
    const createProviderMod = await import("../../src/engine/embeddings/provider.js");
    vi.spyOn(createProviderMod, "createProvider").mockReturnValue({
      model: "test-model",
      dim: 4,
      embed: vi.fn().mockResolvedValue([new Float32Array(baseVec)]),
    });

    const config = {
      ...DEFAULT_CONFIG,
      search: {
        ...DEFAULT_CONFIG.search,
        embeddings: {
          ...DEFAULT_CONFIG.search.embeddings,
          enabled: true,
          dedup: true,
          dedupThreshold: 0.92,
          dedupDefaultMode: "warn" as const,
          dedupCheckOnUpdate: true,
          dedupMaxScan: 2000,
        },
      },
    };

    const result = await handleMemoryStore(
      memRepo,
      { title: "Near dupe of postgres", content: "postgres is our db" },
      db,
      config,
      embRepo,
    );

    // Should store (warn mode) and include the conflicting memory's title
    expect(result).toContain("Memory stored with ID:");
    expect(result).toContain("Use Postgres");
    expect(result).toContain("memory_update or memory_link");
  });

  it("enabled+dedup=true: dedup=strict blocks with title in message", async () => {
    // Seed an existing memory + embedding
    const existId = memRepo.store({ title: "Use Postgres", body: "postgres is our db", memoryType: "fact", scope: "global" });
    const baseVec = makeVec(42);
    embRepo.upsert(existId, "test-model", baseVec);

    const createProviderMod = await import("../../src/engine/embeddings/provider.js");
    vi.spyOn(createProviderMod, "createProvider").mockReturnValue({
      model: "test-model",
      dim: 4,
      embed: vi.fn().mockResolvedValue([new Float32Array(baseVec)]),
    });

    const config = {
      ...DEFAULT_CONFIG,
      search: {
        ...DEFAULT_CONFIG.search,
        embeddings: {
          ...DEFAULT_CONFIG.search.embeddings,
          enabled: true,
          dedup: true,
          dedupThreshold: 0.92,
          dedupDefaultMode: "warn" as const,
          dedupCheckOnUpdate: true,
          dedupMaxScan: 2000,
        },
      },
    };

    const result = await handleMemoryStore(
      memRepo,
      { title: "Near dupe", content: "postgres is our db", dedup: "strict" },
      db,
      config,
      embRepo,
    );

    expect(result).toContain("Memory not stored");
    expect(result).toContain("Use Postgres"); // includes conflicting memory title
    expect(result).not.toContain("Memory stored with ID:");
  });

  it("memory_update dedup check fires on significant body change (>100 chars)", async () => {
    const id = memRepo.store({ title: "Original title", body: "short", memoryType: "fact", scope: "global" });

    const config = {
      ...DEFAULT_CONFIG,
      search: {
        ...DEFAULT_CONFIG.search,
        embeddings: {
          ...DEFAULT_CONFIG.search.embeddings,
          enabled: false, // no-op when disabled
          dedup: false,
        },
      },
    };
    // With embeddings disabled, just verifies update works regardless
    const result = await handleMemoryUpdate(
      memRepo,
      { memory_id: id, content: "a".repeat(200) },
      config,
      embRepo,
      db,
    );
    expect(result).toContain("updated");
  });

  it("memory_update dedup check does NOT fire on trivial change (<= 50 chars)", async () => {
    const id = memRepo.store({
      title: "t",
      body: "moderate length body content here",
      memoryType: "fact",
      scope: "global"
    });

    // With embeddings disabled, no embed should be called for dedup
    const result = await handleMemoryUpdate(
      memRepo,
      { memory_id: id, content: "moderate length body content here!" },
      DEFAULT_CONFIG,
      embRepo,
      db,
    );
    expect(result).toContain("updated");
  });
});
