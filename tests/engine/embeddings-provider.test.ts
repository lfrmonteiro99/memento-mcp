// tests/engine/embeddings-provider.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createProvider, OpenAIEmbeddingProvider } from "../../src/engine/embeddings/provider.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";

describe("createProvider", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("returns null when disabled", () => {
    const cfg = { ...DEFAULT_CONFIG.search.embeddings, enabled: false };
    expect(createProvider(cfg)).toBeNull();
  });

  it("falls back to local provider with a warning when API key env not set (P2)", () => {
    const envName = "NEVER_SET_KEY_FOR_TEST";
    delete process.env[envName];
    const cfg = {
      ...DEFAULT_CONFIG.search.embeddings,
      enabled: true,
      provider: "openai" as const,
      apiKeyEnv: envName,
    };
    const provider = createProvider(cfg);
    // P2: openai without key now silently falls back to LocalTransformersProvider
    // (zero-config MiniLM-L6) instead of returning null. This keeps embeddings
    // working out of the box; the warning surfaces the misconfiguration.
    expect(provider).not.toBeNull();
    expect(provider?.constructor.name).toBe("LocalTransformersProvider");
  });

  it("returns OpenAIEmbeddingProvider when configured", () => {
    process.env.MEMENTO_TEST_KEY = "sk-test";
    const cfg = {
      ...DEFAULT_CONFIG.search.embeddings,
      enabled: true,
      provider: "openai" as const,
      apiKeyEnv: "MEMENTO_TEST_KEY",
      model: "text-embedding-3-small",
      dim: 1536,
      requestTimeoutMs: 5000,
    };
    const provider = createProvider(cfg);
    expect(provider).not.toBeNull();
    expect(provider!.model).toBe("text-embedding-3-small");
    expect(provider!.dim).toBe(1536);
  });

  it("throws on unsupported provider type", () => {
    process.env.MEMENTO_TEST_KEY = "sk-test";
    const cfg = {
      ...DEFAULT_CONFIG.search.embeddings,
      enabled: true,
      provider: "anthropic" as any,
      apiKeyEnv: "MEMENTO_TEST_KEY",
    };
    expect(() => createProvider(cfg)).toThrow(/unsupported embedding provider/);
  });
});

describe("OpenAIEmbeddingProvider.embed", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts to OpenAI embeddings endpoint and returns Float32Arrays", async () => {
    const mockFetch = vi.fn(async (_url: any, _init: any) => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { embedding: [0.1, 0.2, 0.3] },
          { embedding: [0.4, 0.5, 0.6] },
        ],
      }),
      text: async () => "",
    }));
    globalThis.fetch = mockFetch as any;

    const provider = new OpenAIEmbeddingProvider("sk-test", "text-embedding-3-small", 3, 5000);
    const result = await provider.embed(["hello", "world"]);

    expect(result).toHaveLength(2);
    expect(result[0]).toBeInstanceOf(Float32Array);
    expect(Array.from(result[0])).toEqual([
      Math.fround(0.1),
      Math.fround(0.2),
      Math.fround(0.3),
    ]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-test");
    const body = JSON.parse(init.body as string);
    expect(body.input).toEqual(["hello", "world"]);
    expect(body.model).toBe("text-embedding-3-small");
  });

  it("throws on non-ok response, including status and body in message", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
      text: async () => "rate limit exceeded",
    })) as any;

    const provider = new OpenAIEmbeddingProvider("sk-test", "m", 3, 5000);
    await expect(provider.embed(["x"])).rejects.toThrow(/429/);
    await expect(provider.embed(["x"])).rejects.toThrow(/rate limit exceeded/);
  });

  it("aborts on timeout", async () => {
    globalThis.fetch = vi.fn(async (_url: any, init: RequestInit) => {
      // Wait until aborted, then throw an AbortError-like
      return await new Promise((_resolve, reject) => {
        const signal = init.signal!;
        if (signal.aborted) reject(new Error("aborted"));
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as any;

    const provider = new OpenAIEmbeddingProvider("sk-test", "m", 3, 10);
    await expect(provider.embed(["x"])).rejects.toThrow();
  });
});
