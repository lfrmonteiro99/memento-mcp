// tests/integration/session-summary-timeout.test.ts
// Integration test: when LLM provider hangs past timeout,
// the hook logic completes with a deterministic summary (fallback fires).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildSessionSummaryPrompt } from "../../src/engine/llm/session-summary-prompt.js";
import { createLlmProvider } from "../../src/engine/llm/provider.js";
import { summarizeAsCluster } from "../../src/engine/compressor.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";
import type { SessionEndLlmConfig } from "../../src/lib/config.js";

const captures = Array.from({ length: 3 }, (_, i) => ({
  id: `cap-${i}`,
  title: `Capture ${i}: feature implemented`,
  body: `Feature ${i} was built. Tests passed. The implementation is complete.`,
  tags: JSON.stringify(["feature", "typescript"]),
  importance_score: 0.6,
  source: "auto-capture",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  deleted_at: null,
  memory_type: "fact",
  scope: "project",
  project_id: "proj-1",
  confidence_score: 0.5,
  access_count: 0,
  last_accessed_at: null,
  is_pinned: 0,
  supersedes_memory_id: null,
  adaptive_score: 0.5,
}));

const llmCfg: SessionEndLlmConfig = {
  provider: "anthropic",
  model: "claude-haiku-3-5",
  apiKeyEnv: "TEST_TIMEOUT_KEY",
  maxInputTokens: 4000,
  maxOutputTokens: 800,
  requestTimeoutMs: 100, // very short timeout for testing
  fallbackToDeterministic: true,
};

async function runWithFallback(
  cfg: SessionEndLlmConfig,
): Promise<{ mode: string; body: string; fallback: boolean }> {
  const provider = createLlmProvider(cfg);
  const now = new Date().toISOString();
  let mode = "llm";
  let body: string | null = null;
  let fallback = false;

  if (provider) {
    try {
      const summaryInput = {
        sessionId: "sess-timeout-test",
        sessionStart: now,
        sessionEnd: now,
        projectName: "timeout-test",
        captures: captures.map((c) => ({
          tool: "auto-capture",
          title: c.title,
          body: c.body,
          createdAt: c.created_at,
        })),
        decisionsCreated: [],
        pitfallsCreated: [],
        injections: 0,
        budget: { spent: 0, total: 8000 },
      };
      const { system, user } = buildSessionSummaryPrompt(summaryInput, cfg.maxInputTokens);
      const text = await provider.complete(system, user, {
        maxOutputTokens: cfg.maxOutputTokens,
        timeoutMs: cfg.requestTimeoutMs,
      });
      body = text;
    } catch {
      if (!cfg.fallbackToDeterministic) throw new Error("LLM failed and fallback disabled");
      fallback = true;
      mode = "deterministic";
    }
  } else {
    fallback = true;
    mode = "deterministic";
  }

  if (body === null) {
    // Deterministic fallback
    const result = summarizeAsCluster(captures as any[], {
      cluster_similarity_threshold: 0.45,
      min_cluster_size: 2,
      max_body_ratio: 0.6,
      temporal_window_hours: 48,
    });
    body = result.body || result.title;
  }

  return { mode, body, fallback };
}

describe("Timeout / fallback behavior", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const origEnv = { ...process.env };

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    process.env["TEST_TIMEOUT_KEY"] = "mock-timeout-key";
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    for (const k of Object.keys(process.env)) {
      if (!(k in origEnv)) delete process.env[k];
    }
    Object.assign(process.env, origEnv);
  });

  it("provider hangs >requestTimeoutMs → fallback to deterministic within budget", async () => {
    // Simulate a hanging provider by never resolving
    fetchSpy.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          // Simulate AbortController firing after a short delay
          setTimeout(
            () => reject(new DOMException("The operation was aborted.", "AbortError")),
            50,
          );
        }),
    );

    const start = Date.now();
    const result = await runWithFallback(llmCfg);
    const elapsed = Date.now() - start;

    // Should have fallen back to deterministic
    expect(result.mode).toBe("deterministic");
    expect(result.fallback).toBe(true);
    expect(result.body).toBeTruthy();
    // Should complete well within 8000ms (our test timeout is 100ms)
    expect(elapsed).toBeLessThan(5000);
  }, 10000);

  it("default requestTimeoutMs is 8000 — under the 10s subprocess kill threshold", () => {
    // This is the critical non-negotiable constraint from triage bug #1
    const defaultTimeout = DEFAULT_CONFIG.hooks.sessionEndLlm.requestTimeoutMs;
    expect(defaultTimeout).toBe(8000);
    expect(defaultTimeout).toBeLessThan(10000); // Must be < 10s subprocess timeout
  });

  it("default model is NOT a dated ID", () => {
    const defaultModel = DEFAULT_CONFIG.hooks.sessionEndLlm.model;
    // Dated IDs contain patterns like -YYYYMMDD or -20XXXXXX
    expect(defaultModel).not.toMatch(/-\d{8}$/);
    expect(defaultModel).not.toMatch(/-20\d{6}/);
    expect(defaultModel).toBe("claude-haiku-3-5");
  });
});
