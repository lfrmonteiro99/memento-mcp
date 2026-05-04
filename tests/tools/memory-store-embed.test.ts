// tests/tools/memory-store-embed.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { EmbeddingsRepo } from "../../src/db/embeddings.js";
import { handleMemoryStore } from "../../src/tools/memory-store.js";
import type { EmbeddingProvider } from "../../src/engine/embeddings/provider.js";
import { loadConfig } from "../../src/lib/config.js";

function tmpDbPath(): string {
  return join(tmpdir(), `memento-test-${randomUUID()}.db`);
}

// Flush all queued microtasks so fire-and-forget Promise.then chains resolve.
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
}

describe("memory_store auto-embed", () => {
  let db: any, memRepo: MemoriesRepo, embRepo: EmbeddingsRepo, config: any;

  beforeEach(() => {
    db = createDatabase(tmpDbPath());
    memRepo = new MemoriesRepo(db);
    embRepo = new EmbeddingsRepo(db);
    config = loadConfig("/nonexistent/config.toml");
    config.search.embeddings = {
      ...config.search.embeddings,
      enabled: true,
      provider: "local",
      model: "test-model",
      dim: 4,
    };
  });

  it("auto-embeds a stored memory when provider injected", async () => {
    const fakeProvider: EmbeddingProvider = {
      model: "test-model",
      dim: 4,
      embed: async (texts) => texts.map(() => new Float32Array([1, 0, 0, 0])),
    };

    const response = await handleMemoryStore(
      memRepo,
      { title: "Auth pattern", content: "Use OAuth2 client_credentials with Passport", project_path: "/tmp/p" },
      db,
      config,
      embRepo,
      fakeProvider,
    );
    expect(response).toMatch(/Memory stored with ID:/);

    const idMatch = response.match(/Memory stored with ID:\s*([a-f0-9-]+)/);
    expect(idMatch).toBeTruthy();
    const id = idMatch![1];

    await flushMicrotasks();

    const stored = embRepo.get(id);
    expect(stored).toBeTruthy();
    expect(stored!.dim).toBe(4);
    expect(stored!.model).toBe("test-model");
  });

  it("memory persists even when provider throws", async () => {
    const failingProvider: EmbeddingProvider = {
      model: "test-model",
      dim: 4,
      embed: async () => { throw new Error("provider boom"); },
    };

    const response = await handleMemoryStore(
      memRepo,
      { title: "x", content: "y", project_path: "/tmp/p" },
      db,
      config,
      embRepo,
      failingProvider,
    );
    expect(response).toMatch(/Memory stored with ID:/);
    const id = response.match(/Memory stored with ID:\s*([a-f0-9-]+)/)![1];

    await flushMicrotasks();

    // Memory IS in DB
    const m = memRepo.getById(id);
    expect(m).toBeTruthy();
    expect(m!.title).toBe("x");

    // No embedding row was inserted
    const stored = embRepo.get(id);
    expect(stored).toBeNull();
  });

  it("no embedding when embRepo not passed (backwards compat)", async () => {
    const response = await handleMemoryStore(
      memRepo,
      { title: "x", content: "y", project_path: "/tmp/p" },
      db,
      config,
      // no embRepo, no providerOverride
    );
    const id = response.match(/Memory stored with ID:\s*([a-f0-9-]+)/)![1];
    await flushMicrotasks();

    // Memory IS stored in DB
    expect(memRepo.getById(id)).toBeTruthy();
    // No embedding table row (no embRepo was passed)
    expect(embRepo.get(id)).toBeNull();
  });
});
