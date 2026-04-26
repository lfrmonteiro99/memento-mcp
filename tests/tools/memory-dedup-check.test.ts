// tests/tools/memory-dedup-check.test.ts
// Tests for the memory_dedup_check tool (issue #28).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { EmbeddingsRepo } from "../../src/db/embeddings.js";
import { handleMemoryDedupCheck } from "../../src/tools/memory-dedup-check.js";
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

describe("memory_dedup_check tool", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let embRepo: EmbeddingsRepo;
  const dbPath = join(tmpdir(), `memento-dedup-check-${process.pid}-${randomUUID()}.sqlite`);

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

  it("disabled mode: config.search.embeddings.enabled = false returns no-op message", async () => {
    const config = { ...DEFAULT_CONFIG }; // embeddings.enabled = false
    const result = await handleMemoryDedupCheck(
      db,
      memRepo,
      embRepo,
      null,
      config,
      { content: "test" },
    );
    expect(result).toBe("Dedup unavailable: embeddings disabled (set search.embeddings.enabled = true and provide API key).");
  });

  it("no provider: provider = null returns no-op message", async () => {
    const config = dedupConfig();
    const result = await handleMemoryDedupCheck(
      db,
      memRepo,
      embRepo,
      null,
      config,
      { content: "test" },
    );
    expect(result).toBe("Dedup unavailable: embeddings disabled (set search.embeddings.enabled = true and provide API key).");
  });

  it("no matches: provider returns vector that doesn't match seeded memories", async () => {
    const createProviderMod = await import("../../src/engine/embeddings/provider.js");
    vi.spyOn(createProviderMod, "createProvider").mockReturnValue({
      model: "test-model",
      dim: 4,
      embed: vi.fn().mockResolvedValue([makeVec(999)]), // Very different seed
    });

    // Seed a memory with a different vector
    const id1 = memRepo.store({
      title: "Different topic",
      body: "This is about something completely different",
      memoryType: "fact",
      scope: "global",
    });
    embRepo.upsert(id1, "test-model", makeVec(42));

    const config = dedupConfig({ dedupThreshold: 0.92 });
    const provider = createProviderMod.createProvider(config.search.embeddings);
    const result = await handleMemoryDedupCheck(
      db,
      memRepo,
      embRepo,
      provider,
      config,
      { content: "test content" },
    );
    expect(result).toContain("No duplicates above threshold");
  });

  it("matches found: returns formatted top-N list with token markers and memory details", async () => {
    // Seed 3 memories
    const id1 = memRepo.store({
      title: "Postgres DB",
      body: "Use postgres for databases",
      memoryType: "fact",
      scope: "global",
    });
    const id2 = memRepo.store({
      title: "MySQL alternative",
      body: "MySQL is also a database",
      memoryType: "fact",
      scope: "global",
    });
    const id3 = memRepo.store({
      title: "SQLite option",
      body: "SQLite for embedded databases",
      memoryType: "fact",
      scope: "global",
    });

    // Use same vector for all to ensure high similarity
    const baseVec = makeVec(42);
    embRepo.upsert(id1, "test-model", baseVec);
    embRepo.upsert(id2, "test-model", baseVec);
    embRepo.upsert(id3, "test-model", baseVec);

    const createProviderMod = await import("../../src/engine/embeddings/provider.js");
    vi.spyOn(createProviderMod, "createProvider").mockReturnValue({
      model: "test-model",
      dim: 4,
      embed: vi.fn().mockResolvedValue([new Float32Array(baseVec)]),
    });

    const config = dedupConfig();
    const provider = createProviderMod.createProvider(config.search.embeddings, console as any);
    const result = await handleMemoryDedupCheck(
      db,
      memRepo,
      embRepo,
      provider,
      config,
      { content: "database topic" },
    );

    // Should start with "Top"
    expect(result).toMatch(/^Top \d+ match\(es\)/);
    // Should contain token markers
    expect(result).toMatch(/\[\d+t\]/);
    // Should contain similarity scores
    expect(result).toContain("sim=");
    // Should contain at least one memory title
    expect(result).toMatch(/Postgres DB|MySQL alternative|SQLite option/);
    // Should contain memory type
    expect(result).toContain("(fact)");
  });

  it("threshold override: strict threshold filters results", async () => {
    const id1 = memRepo.store({
      title: "Test memory",
      body: "test content",
      memoryType: "fact",
      scope: "global",
    });
    embRepo.upsert(id1, "test-model", makeVec(42));

    const createProviderMod = await import("../../src/engine/embeddings/provider.js");
    vi.spyOn(createProviderMod, "createProvider").mockReturnValue({
      model: "test-model",
      dim: 4,
      // Use a very different seed to create low similarity (~0.69)
      embed: vi.fn().mockResolvedValue([new Float32Array(makeVec(50))]),
    });

    const config = dedupConfig();
    const provider = createProviderMod.createProvider(config.search.embeddings, console as any);

    // With very strict threshold (0.99), should find no matches (similarity ~0.69 << 0.99)
    const result = await handleMemoryDedupCheck(
      db,
      memRepo,
      embRepo,
      provider,
      config,
      { content: "test", threshold: 0.99 },
    );
    expect(result).toContain("No duplicates above threshold 0.99");
  });

  it("threshold override: loose threshold shows more matches", async () => {
    const id1 = memRepo.store({
      title: "Test memory",
      body: "test content",
      memoryType: "fact",
      scope: "global",
    });
    embRepo.upsert(id1, "test-model", makeVec(42));

    const createProviderMod = await import("../../src/engine/embeddings/provider.js");
    vi.spyOn(createProviderMod, "createProvider").mockReturnValue({
      model: "test-model",
      dim: 4,
      embed: vi.fn().mockResolvedValue([new Float32Array(makeVec(42))]),
    });

    const config = dedupConfig();
    const provider = createProviderMod.createProvider(config.search.embeddings, console as any);

    // With very loose threshold (0.0), should find matches
    const result = await handleMemoryDedupCheck(
      db,
      memRepo,
      embRepo,
      provider,
      config,
      { content: "test", threshold: 0.0 },
    );
    expect(result).toMatch(/^Top \d+ match/);
    expect(result).toContain("Test memory");
  });

  it("limit cap: limit=50 never returns more than 20 results", async () => {
    // Seed 25 memories
    for (let i = 0; i < 25; i++) {
      const id = memRepo.store({
        title: `Memory ${i}`,
        body: `Content for memory ${i}`,
        memoryType: "fact",
        scope: "global",
      });
      embRepo.upsert(id, "test-model", makeVec(42));
    }

    const createProviderMod = await import("../../src/engine/embeddings/provider.js");
    vi.spyOn(createProviderMod, "createProvider").mockReturnValue({
      model: "test-model",
      dim: 4,
      embed: vi.fn().mockResolvedValue([new Float32Array(makeVec(42))]),
    });

    const config = dedupConfig();
    const provider = createProviderMod.createProvider(config.search.embeddings, console as any);

    const result = await handleMemoryDedupCheck(
      db,
      memRepo,
      embRepo,
      provider,
      config,
      { content: "test", limit: 50 },
    );

    // Count lines starting with [Nt]
    const lines = result.split("\n");
    const resultLines = lines.filter((l) => l.match(/\[\d+t\]/));
    expect(resultLines.length).toBeLessThanOrEqual(20);
  });

  it("project scoping: only returns matches in the specified project", async () => {
    // Create two projects
    const projectA = memRepo.ensureProject("/test/project-a");
    const projectB = memRepo.ensureProject("/test/project-b");

    // Seed memories in project A
    const idA = memRepo.store({
      title: "Memory in A",
      body: "Project A content",
      memoryType: "fact",
      scope: "project",
      projectId: projectA,
    });

    // Seed memories in project B
    const idB = memRepo.store({
      title: "Memory in B",
      body: "Project B content",
      memoryType: "fact",
      scope: "project",
      projectId: projectB,
    });

    const baseVec = makeVec(42);
    embRepo.upsert(idA, "test-model", baseVec);
    embRepo.upsert(idB, "test-model", baseVec);

    const createProviderMod = await import("../../src/engine/embeddings/provider.js");
    vi.spyOn(createProviderMod, "createProvider").mockReturnValue({
      model: "test-model",
      dim: 4,
      embed: vi.fn().mockResolvedValue([new Float32Array(baseVec)]),
    });

    const config = dedupConfig();
    const provider = createProviderMod.createProvider(config.search.embeddings, console as any);

    // Call with project_path pointing to project A
    const result = await handleMemoryDedupCheck(
      db,
      memRepo,
      embRepo,
      provider,
      config,
      { content: "test", project_path: "/test/project-a" },
    );

    // Should contain memory from A
    expect(result).toContain("Memory in A");
    // Should NOT contain memory from B
    expect(result).not.toContain("Memory in B");
  });

  it("title concatenation: includes title in text when provided", async () => {
    const createProviderMod = await import("../../src/engine/embeddings/provider.js");
    let lastEmbedInput: string[] = [];
    vi.spyOn(createProviderMod, "createProvider").mockReturnValue({
      model: "test-model",
      dim: 4,
      embed: vi.fn().mockImplementation((texts: string[]) => {
        lastEmbedInput = texts;
        return [makeVec(42)];
      }),
    });

    const config = dedupConfig();
    const provider = createProviderMod.createProvider(config.search.embeddings, console as any);

    await handleMemoryDedupCheck(
      db,
      memRepo,
      embRepo,
      provider,
      config,
      { content: "body text", title: "Test Title" },
    );

    // The concatenated text should include both title and body
    // (with scrubSecrets/redactPrivate applied, but structure preserved)
    expect(lastEmbedInput[0]).toContain("Test Title");
    expect(lastEmbedInput[0]).toContain("body text");
  });
});
