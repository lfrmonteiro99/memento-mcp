import { describe, it, expect } from "vitest";
import {
  LocalTransformersProvider,
  createProvider,
} from "../../../src/engine/embeddings/provider.js";
import { cosineSimilarity } from "../../../src/engine/embeddings/cosine.js";

describe("LocalTransformersProvider", () => {
  it(
    "embeds two strings into 384-dim vectors with reasonable similarity",
    async () => {
      const provider = new LocalTransformersProvider(
        "Xenova/all-MiniLM-L6-v2",
        384,
      );
      const vectors = await provider.embed(["hello world", "goodbye world"]);
      expect(vectors).toHaveLength(2);
      expect(vectors[0].length).toBe(384);
      expect(vectors[1].length).toBe(384);
      // Both have "world"; cosine should be > 0.5
      const cos = cosineSimilarity(vectors[0], vectors[1]);
      expect(cos).toBeGreaterThan(0.5);
    },
    90_000,
  ); // 90s timeout: first run downloads ~22MB model

  it("createProvider returns LocalTransformersProvider when provider='local'", () => {
    const provider = createProvider({
      enabled: true,
      provider: "local",
      model: "Xenova/all-MiniLM-L6-v2",
      apiKeyEnv: "OPENAI_API_KEY",
      dim: 384,
      topK: 20,
      similarityThreshold: 0.5,
      batchSize: 32,
      requestTimeoutMs: 10_000,
      dedup: false,
      dedupThreshold: 0.92,
      dedupDefaultMode: "warn",
      dedupCheckOnUpdate: true,
      dedupMaxScan: 2000,
    } as any);
    expect(provider).toBeInstanceOf(LocalTransformersProvider);
  });

  it("createProvider falls back to local when openai key missing", () => {
    // Save and clear OPENAI_API_KEY
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const provider = createProvider({
        enabled: true,
        provider: "openai",
        model: "text-embedding-3-small",
        apiKeyEnv: "OPENAI_API_KEY",
        dim: 1536,
        topK: 20,
        similarityThreshold: 0.5,
        batchSize: 32,
        requestTimeoutMs: 10_000,
        dedup: false,
        dedupThreshold: 0.92,
        dedupDefaultMode: "warn",
        dedupCheckOnUpdate: true,
        dedupMaxScan: 2000,
      } as any);
      expect(provider).toBeInstanceOf(LocalTransformersProvider);
    } finally {
      if (original) process.env.OPENAI_API_KEY = original;
    }
  });

  it("createProvider returns null when enabled=false", () => {
    const provider = createProvider({
      enabled: false,
      provider: "local",
    } as any);
    expect(provider).toBeNull();
  });
});
