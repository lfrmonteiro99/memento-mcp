// tests/hooks/session-summarize-llm.test.ts
// Tests for the LLM mode branch in session-summarize hook logic (Issue #10).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDatabase, nowIso } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { buildSessionSummaryPrompt } from "../../src/engine/llm/session-summary-prompt.js";
import { AnthropicProvider, createLlmProvider } from "../../src/engine/llm/provider.js";
import { summarizeAsCluster } from "../../src/engine/compressor.js";
import { redactPrivate } from "../../src/engine/privacy.js";
import type { SessionEndLlmConfig } from "../../src/lib/config.js";

// Simulate the hook's LLM summarization path
async function runLlmSummarizeLogic(
  captures: any[],
  llmCfg: SessionEndLlmConfig,
  claudeSessionId: string,
  projectName: string = "test-project",
): Promise<{ title: string; body: string; tags: string[]; mode: string; fallback: boolean }> {
  const provider = createLlmProvider(llmCfg);
  const now = new Date().toISOString();
  let actualMode = "llm";
  let didFallback = false;
  let summaryBody: string | null = null;
  let summaryTitle: string | null = null;
  let summaryTags: string[] = [];

  if (provider) {
    try {
      const summaryInput = {
        sessionId: claudeSessionId,
        sessionStart: captures[captures.length - 1]?.created_at ?? now,
        sessionEnd: captures[0]?.created_at ?? now,
        projectName,
        captures: captures.map((c) => ({
          tool: "auto-capture",
          title: c.title ?? "",
          body: c.body ?? "",
          createdAt: c.created_at ?? now,
        })),
        decisionsCreated: [],
        pitfallsCreated: [],
        injections: 0,
        budget: { spent: 0, total: 8000 },
      };
      const { system, user } = buildSessionSummaryPrompt(summaryInput, llmCfg.maxInputTokens);
      const text = await provider.complete(system, user, {
        maxOutputTokens: llmCfg.maxOutputTokens,
        timeoutMs: llmCfg.requestTimeoutMs,
      });
      summaryBody = redactPrivate(text);
      summaryTitle = `Session summary — ${new Date().toISOString().slice(0, 10)} — ${captures.length} captures (LLM)`;
      summaryTags = [];
    } catch (err) {
      if (!llmCfg.fallbackToDeterministic) {
        throw err;
      }
      didFallback = true;
      actualMode = "deterministic";
    }
  } else {
    didFallback = true;
    actualMode = "deterministic";
  }

  // Fallback to deterministic
  if (summaryBody === null) {
    const result = summarizeAsCluster(captures, {
      cluster_similarity_threshold: 0.45,
      min_cluster_size: 2,
      max_body_ratio: 0.6,
      temporal_window_hours: 48,
    });
    summaryBody = result.body;
    summaryTitle = result.title;
    summaryTags = result.tags;
  }

  return { title: summaryTitle!, body: summaryBody!, tags: summaryTags, mode: actualMode, fallback: didFallback };
}

const baseCaptures = Array.from({ length: 3 }, (_, i) => ({
  id: randomUUID(),
  title: `Capture ${i}: some work done`,
  body: `Implemented feature ${i}. Tests passed. The build succeeded.`,
  tags: JSON.stringify(["auto", "test"]),
  importance_score: 0.5,
  source: "auto-capture",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}));

const llmCfg: SessionEndLlmConfig = {
  provider: "anthropic",
  model: "claude-haiku-3-5",
  apiKeyEnv: "TEST_LLM_API_KEY",
  maxInputTokens: 4000,
  maxOutputTokens: 800,
  requestTimeoutMs: 8000,
  fallbackToDeterministic: true,
};

describe("LLM mode with mock provider", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const origEnv = { ...process.env };

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    process.env["TEST_LLM_API_KEY"] = "mock-api-key-12345";
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    for (const k of Object.keys(process.env)) {
      if (!(k in origEnv)) delete process.env[k];
    }
    Object.assign(process.env, origEnv);
  });

  it("mode=llm with mock provider returns LLM body", async () => {
    const llmText = "## What changed\n- Implemented 3 features\n\n## Decisions\n- (none)\n\n## Blockers\n- (none)\n\n## Open questions\n- (none)";
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ content: [{ type: "text", text: llmText }] }),
      text: () => Promise.resolve(JSON.stringify({ content: [{ type: "text", text: llmText }] })),
    } as unknown as Response);

    const result = await runLlmSummarizeLogic(
      baseCaptures,
      llmCfg,
      "sess-test-123",
    );

    expect(result.mode).toBe("llm");
    expect(result.fallback).toBe(false);
    expect(result.body).toContain("What changed");
    expect(result.title).toContain("(LLM)");
  });

  it("fallback fires when provider throws AND fallback_to_deterministic = true", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("Network timeout"));

    const result = await runLlmSummarizeLogic(
      baseCaptures,
      { ...llmCfg, fallbackToDeterministic: true },
      "sess-test-456",
    );

    expect(result.mode).toBe("deterministic");
    expect(result.fallback).toBe(true);
    // Deterministic result should have body (from summarizeAsCluster)
    expect(result.body).toBeTruthy();
    expect(result.title).not.toContain("(LLM)");
  });

  it("fallback does NOT fire when fallback_to_deterministic = false", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("API error: 503"));

    await expect(
      runLlmSummarizeLogic(
        baseCaptures,
        { ...llmCfg, fallbackToDeterministic: false },
        "sess-test-789",
      )
    ).rejects.toThrow("API error: 503");
  });

  it("when API key env var is missing, falls back to deterministic", async () => {
    delete process.env["TEST_LLM_API_KEY"];

    const result = await runLlmSummarizeLogic(
      baseCaptures,
      llmCfg,
      "sess-test-nokey",
    );

    expect(result.mode).toBe("deterministic");
    expect(result.fallback).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled(); // no network call made
  });
});
