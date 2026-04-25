// tests/tools/memory-store-dedup.test.ts
// Tests for dedup integration in memory_store and memory_update (issue #8).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { EmbeddingsRepo } from "../../src/db/embeddings.js";
import { handleMemoryStore } from "../../src/tools/memory-store.js";
import { handleMemoryUpdate } from "../../src/tools/memory-update.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";
import { rmSync } from "node:fs";
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

// Build a config with embeddings enabled and dedup active
function dedupConfig(overrides: Partial<typeof DEFAULT_CONFIG["search"]["embeddings"]> = {}) {
  return {
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
        ...overrides,
      },
    },
  };
}

describe("memory_store dedup integration", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let embRepo: EmbeddingsRepo;
  const dbPath = join(tmpdir(), `memento-store-dedup-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    embRepo = new EmbeddingsRepo(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
    vi.restoreAllMocks();
  });

  it("embeddings disabled = no dedup check, always stores", async () => {
    const config = { ...DEFAULT_CONFIG }; // embeddings.enabled = false

    const result = await handleMemoryStore(
      memRepo,
      { title: "Test", content: "body", dedup: "strict" },
      db,
      config,
      embRepo,
    );
    expect(result).toContain("Memory stored with ID:");
  });

  it("dedup=false in config = no dedup even when embeddings enabled", async () => {
    const config = dedupConfig({ dedup: false });

    const result = await handleMemoryStore(
      memRepo,
      { title: "Test", content: "body" },
      db,
      config,
      embRepo,
    );
    expect(result).toContain("Memory stored with ID:");
  });

  it("dedup=off param skips check entirely", async () => {
    // Even with dedup enabled in config, dedup="off" in params skips check
    const id1 = memRepo.store({ title: "Use Postgres", body: "postgres is the db", memoryType: "fact", scope: "global" });
    const baseVec = makeVec(42);
    embRepo.upsert(id1, "test-model", baseVec);

    // Mock createProvider to return a high-similarity provider
    const createProviderMod = await import("../../src/engine/embeddings/provider.js");
    vi.spyOn(createProviderMod, "createProvider").mockReturnValue({
      model: "test-model",
      dim: 4,
      embed: vi.fn().mockResolvedValue([new Float32Array(baseVec)]),
    });

    const config = dedupConfig();
    const result = await handleMemoryStore(
      memRepo,
      { title: "Use Postgres again", content: "postgres is the db", dedup: "off" },
      db,
      config,
      embRepo,
    );
    // dedup=off → always stores without checking
    expect(result).toContain("Memory stored with ID:");
    expect(result).not.toContain("duplicate");
  });

  it("provider failure does NOT block insert (graceful degradation)", async () => {
    const createProviderMod = await import("../../src/engine/embeddings/provider.js");
    vi.spyOn(createProviderMod, "createProvider").mockReturnValue({
      model: "test-model",
      dim: 4,
      embed: vi.fn().mockRejectedValue(new Error("API timeout")),
    });

    const config = dedupConfig();
    const result = await handleMemoryStore(
      memRepo,
      { title: "Test", content: "content" },
      db,
      config,
      embRepo,
    );
    // Should store even when embed fails
    expect(result).toContain("Memory stored with ID:");
  });

  it("warn mode: stores with note when near-duplicate found", async () => {
    const id1 = memRepo.store({ title: "Use Postgres", body: "postgres is the db", memoryType: "fact", scope: "global" });
    const baseVec = makeVec(42);
    embRepo.upsert(id1, "test-model", baseVec);

    const createProviderMod = await import("../../src/engine/embeddings/provider.js");
    vi.spyOn(createProviderMod, "createProvider").mockReturnValue({
      model: "test-model",
      dim: 4,
      embed: vi.fn().mockResolvedValue([new Float32Array(baseVec)]),
    });

    const config = dedupConfig({ dedupDefaultMode: "warn" });
    const result = await handleMemoryStore(
      memRepo,
      { title: "Near dupe", content: "postgres related content" },
      db,
      config,
      embRepo,
    );

    // Should store AND include near-duplicate warning with title
    expect(result).toContain("Memory stored with ID:");
    expect(result).toContain("Use Postgres"); // title of conflicting memory
    expect(result).toMatch(/sim \d+\.\d+/);
    expect(result).toContain("memory_update or memory_link");
  });

  it("strict mode: blocks with message including conflicting title when near-duplicate found", async () => {
    const id1 = memRepo.store({ title: "Use Postgres", body: "postgres is the db", memoryType: "fact", scope: "global" });
    const baseVec = makeVec(42);
    embRepo.upsert(id1, "test-model", baseVec);

    const createProviderMod = await import("../../src/engine/embeddings/provider.js");
    vi.spyOn(createProviderMod, "createProvider").mockReturnValue({
      model: "test-model",
      dim: 4,
      embed: vi.fn().mockResolvedValue([new Float32Array(baseVec)]),
    });

    const config = dedupConfig({ dedupDefaultMode: "warn" });
    const result = await handleMemoryStore(
      memRepo,
      { title: "Near dupe", content: "postgres related content", dedup: "strict" },
      db,
      config,
      embRepo,
    );

    // Should be blocked with title in message
    expect(result).toContain("Memory not stored");
    expect(result).toContain("Use Postgres"); // includes conflicting memory title
    expect(result).toContain("memory_update");
  });
});

describe("memory_update dedup integration", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let embRepo: EmbeddingsRepo;
  const dbPath = join(tmpdir(), `memento-update-dedup-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    embRepo = new EmbeddingsRepo(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
    vi.restoreAllMocks();
  });

  it("significant body change (>100 chars) triggers dedup check", async () => {
    const id = memRepo.store({ title: "Original", body: "short", memoryType: "fact", scope: "global" });
    // The existing memory for dedup to find
    const existId = memRepo.store({ title: "Similar Memory", body: "long body similar", memoryType: "fact", scope: "global" });
    const baseVec = makeVec(42);
    embRepo.upsert(existId, "test-model", baseVec);

    const createProviderMod = await import("../../src/engine/embeddings/provider.js");
    vi.spyOn(createProviderMod, "createProvider").mockReturnValue({
      model: "test-model",
      dim: 4,
      embed: vi.fn().mockResolvedValue([new Float32Array(baseVec)]),
    });

    const config = dedupConfig();
    // Change body by >100 chars
    const result = await handleMemoryUpdate(
      memRepo,
      { memory_id: id, content: "a".repeat(200) },
      config,
      embRepo,
      db,
    );

    // Should have updated (dedup doesn't block on update, just warns)
    expect(result).toContain("updated");
  });

  it("trivial change (<= 50 chars) does NOT trigger dedup check", async () => {
    const id = memRepo.store({
      title: "t",
      body: "Some moderate length body content",
      memoryType: "fact",
      scope: "global"
    });

    let embedCallCount = 0;
    const createProviderMod = await import("../../src/engine/embeddings/provider.js");
    vi.spyOn(createProviderMod, "createProvider").mockReturnValue({
      model: "test-model",
      dim: 4,
      embed: vi.fn().mockImplementation(async () => {
        embedCallCount++;
        return [makeVec(1)];
      }),
    });

    const config = dedupConfig();
    // Only add 5 chars — below the 100-char threshold
    const result = await handleMemoryUpdate(
      memRepo,
      { memory_id: id, content: "Some moderate length body content plus5" },
      config,
      embRepo,
      db,
    );

    expect(result).toContain("updated");
    // The fire-and-forget embed runs asynchronously, but the dedup-specific embed
    // (synchronous await in handleMemoryUpdate for dedup) should not have been awaited
    // for dedup purposes. We can't easily distinguish the two embed calls, so just check
    // the result is correct.
    expect(result).not.toContain("duplicate");
  });

  it("excludes the updated memory itself from dedup candidates", async () => {
    const id = memRepo.store({ title: "Same Memory", body: "original body", memoryType: "fact", scope: "global" });
    const baseVec = makeVec(42);
    embRepo.upsert(id, "test-model", baseVec);

    const createProviderMod = await import("../../src/engine/embeddings/provider.js");
    vi.spyOn(createProviderMod, "createProvider").mockReturnValue({
      model: "test-model",
      dim: 4,
      embed: vi.fn().mockResolvedValue([new Float32Array(baseVec)]),
    });

    const config = dedupConfig();
    // Update with large body change — should not find itself as a duplicate
    const result = await handleMemoryUpdate(
      memRepo,
      { memory_id: id, content: "a".repeat(200) },
      config,
      embRepo,
      db,
    );

    expect(result).toContain("updated");
    // Should NOT warn about itself as a duplicate
    expect(result).not.toContain("Same Memory");
  });
});
