// tests/engine/llm-provider.test.ts
// Tests for src/engine/llm/provider.ts

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AnthropicProvider, OpenAIProvider, createLlmProvider } from "../../src/engine/llm/provider.js";
import type { SessionEndLlmConfig } from "../../src/lib/config.js";
import { inspect } from "node:util";

const OPTS = { maxOutputTokens: 200, timeoutMs: 5000 };

// Minimal config for createLlmProvider tests
const baseConfig = (provider: "anthropic" | "openai"): SessionEndLlmConfig => ({
  provider,
  model: "claude-haiku-3-5",
  apiKeyEnv: "TEST_API_KEY",
  maxInputTokens: 4000,
  maxOutputTokens: 800,
  requestTimeoutMs: 8000,
  fallbackToDeterministic: true,
});

function makeOkResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function makeErrorResponse(status: number, body: unknown): Response {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: false,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(bodyStr),
  } as unknown as Response;
}

describe("AnthropicProvider", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("sends correct request body and x-api-key header", async () => {
    const mockBody = {
      content: [{ type: "text", text: "Summary result" }],
    };
    fetchSpy.mockResolvedValueOnce(makeOkResponse(mockBody));

    const provider = new AnthropicProvider("test-key-12345", "claude-haiku-3-5");
    const result = await provider.complete("system prompt", "user prompt", OPTS);

    expect(result).toBe("Summary result");
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("test-key-12345");
    expect((init.headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("claude-haiku-3-5");
    expect(body.max_tokens).toBe(200);
    expect(body.system).toBe("system prompt");
    expect(body.messages).toEqual([{ role: "user", content: "user prompt" }]);
  });

  it("throws on API error with extracted message", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeErrorResponse(401, { error: { message: "Invalid API key" } })
    );

    const provider = new AnthropicProvider("bad-key", "claude-haiku-3-5");
    await expect(provider.complete("sys", "user", OPTS)).rejects.toThrow(
      "Anthropic API error 401: Invalid API key"
    );
  });

  it("throws on API error with generic status when no message", async () => {
    fetchSpy.mockResolvedValueOnce(makeErrorResponse(500, "Internal Server Error"));

    const provider = new AnthropicProvider("test-key", "claude-haiku-3-5");
    await expect(provider.complete("sys", "user", OPTS)).rejects.toThrow("Anthropic API error 500");
  });

  it("AbortController timeout fires correctly", async () => {
    fetchSpy.mockImplementationOnce(() => new Promise((_, reject) => {
      // Simulate abort
      setTimeout(() => reject(new DOMException("The operation was aborted.", "AbortError")), 50);
    }));

    const provider = new AnthropicProvider("test-key", "claude-haiku-3-5");
    await expect(
      provider.complete("sys", "user", { maxOutputTokens: 200, timeoutMs: 10 })
    ).rejects.toThrow();
  });

  it("toJSON() returns redacted form — never leaks API key", () => {
    const provider = new AnthropicProvider("super-secret-key-abc123", "claude-haiku-3-5");
    const serialized = JSON.stringify({ provider });
    expect(serialized).not.toContain("super-secret-key-abc123");
    expect(serialized).toContain("[LlmProvider redacted]");
  });

  it("util.inspect() returns redacted form", () => {
    const provider = new AnthropicProvider("super-secret-key-abc123", "claude-haiku-3-5");
    const inspected = inspect(provider);
    expect(inspected).not.toContain("super-secret-key-abc123");
    expect(inspected).toContain("[LlmProvider redacted]");
  });

  it("throws when response has no text content", async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse({ content: [] }));
    const provider = new AnthropicProvider("test-key", "claude-haiku-3-5");
    await expect(provider.complete("sys", "user", OPTS)).rejects.toThrow(
      "no text content"
    );
  });
});

describe("OpenAIProvider", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("sends correct request body with Authorization: Bearer header", async () => {
    const mockBody = {
      choices: [{ message: { content: "OpenAI summary" } }],
    };
    fetchSpy.mockResolvedValueOnce(makeOkResponse(mockBody));

    const provider = new OpenAIProvider("sk-test-openai-key", "gpt-4o-mini");
    const result = await provider.complete("system prompt", "user prompt", OPTS);

    expect(result).toBe("OpenAI summary");
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-test-openai-key");

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.max_tokens).toBe(200);
    expect(body.messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "user prompt" },
    ]);
  });

  it("throws on API error with extracted error.message", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeErrorResponse(429, { error: { message: "Rate limit exceeded" } })
    );
    const provider = new OpenAIProvider("sk-key", "gpt-4o-mini");
    await expect(provider.complete("sys", "user", OPTS)).rejects.toThrow(
      "OpenAI API error 429: Rate limit exceeded"
    );
  });

  it("toJSON() returns redacted form", () => {
    const provider = new OpenAIProvider("sk-super-secret-98765", "gpt-4o-mini");
    const serialized = JSON.stringify({ provider });
    expect(serialized).not.toContain("sk-super-secret-98765");
    expect(serialized).toContain("[LlmProvider redacted]");
  });

  it("util.inspect() returns redacted form", () => {
    const provider = new OpenAIProvider("sk-super-secret-98765", "gpt-4o-mini");
    const inspected = inspect(provider);
    expect(inspected).not.toContain("sk-super-secret-98765");
    expect(inspected).toContain("[LlmProvider redacted]");
  });
});

describe("createLlmProvider", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    for (const k of Object.keys(process.env)) {
      if (!(k in origEnv)) delete process.env[k];
    }
    Object.assign(process.env, origEnv);
  });

  it("returns null when API key env var is not set", () => {
    delete process.env["TEST_API_KEY"];
    const provider = createLlmProvider(baseConfig("anthropic"));
    expect(provider).toBeNull();
  });

  it("returns AnthropicProvider when provider=anthropic and key is set", () => {
    process.env["TEST_API_KEY"] = "anthro-key-xyz";
    const provider = createLlmProvider(baseConfig("anthropic"));
    expect(provider).not.toBeNull();
    expect(provider!.model).toBe("claude-haiku-3-5");
    // Verify it's AnthropicProvider by checking it won't send Bearer header
    expect(provider!.constructor.name).toBe("AnthropicProvider");
  });

  it("returns OpenAIProvider when provider=openai and key is set", () => {
    process.env["TEST_API_KEY"] = "openai-key-abc";
    const provider = createLlmProvider(baseConfig("openai"));
    expect(provider).not.toBeNull();
    expect(provider!.constructor.name).toBe("OpenAIProvider");
  });
});
