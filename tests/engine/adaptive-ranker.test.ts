// tests/engine/adaptive-ranker.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  computeAdaptiveScore, computeUtilityScore, SCORE_WEIGHTS, SCORE_WEIGHTS_WITH_EMBEDDINGS, AdaptiveScoreFactors
} from "../../src/engine/adaptive-ranker.js";
import { createDatabase } from "../../src/db/database.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("computeAdaptiveScore", () => {
  it("returns weighted sum of all factors (embeddings disabled)", () => {
    const factors: AdaptiveScoreFactors = {
      fts_relevance: 1.0,
      embedding_relevance: 0,
      importance: 1.0,
      decay: 1.0,
      utility: 1.0,
      recency_bonus: 0.2,
    };
    const score = computeAdaptiveScore(factors);
    // 1.0*0.30 + 1.0*0.20 + 1.0*0.15 + 1.0*0.25 + 0.2*0.10 = 0.92
    expect(score).toBeCloseTo(0.92, 2);
  });

  it("returns 0 when all factors are 0", () => {
    const factors: AdaptiveScoreFactors = {
      fts_relevance: 0, embedding_relevance: 0, importance: 0, decay: 0, utility: 0, recency_bonus: 0,
    };
    expect(computeAdaptiveScore(factors)).toBeCloseTo(0, 2);
  });

  it("FTS relevance has highest single weight (0.30) in base mode", () => {
    const withFts: AdaptiveScoreFactors = { fts_relevance: 1.0, embedding_relevance: 0, importance: 0, decay: 0, utility: 0, recency_bonus: 0 };
    const withUtility: AdaptiveScoreFactors = { fts_relevance: 0, embedding_relevance: 0, importance: 0, decay: 0, utility: 1.0, recency_bonus: 0 };
    expect(computeAdaptiveScore(withFts)).toBeGreaterThan(computeAdaptiveScore(withUtility));
  });

  it("base weights sum to 1.0", () => {
    const total = SCORE_WEIGHTS.fts_relevance + SCORE_WEIGHTS.importance +
      SCORE_WEIGHTS.decay + SCORE_WEIGHTS.utility + SCORE_WEIGHTS.recency_bonus;
    expect(total).toBeCloseTo(1.0, 5);
  });

  it("embedding weights sum to 1.0", () => {
    const total = SCORE_WEIGHTS_WITH_EMBEDDINGS.fts_relevance +
      SCORE_WEIGHTS_WITH_EMBEDDINGS.embedding_relevance +
      SCORE_WEIGHTS_WITH_EMBEDDINGS.importance +
      SCORE_WEIGHTS_WITH_EMBEDDINGS.decay +
      SCORE_WEIGHTS_WITH_EMBEDDINGS.utility +
      SCORE_WEIGHTS_WITH_EMBEDDINGS.recency_bonus;
    expect(total).toBeCloseTo(1.0, 5);
  });

  it("uses embedding weight set when embeddingsEnabled=true", () => {
    const factors: AdaptiveScoreFactors = {
      fts_relevance: 1.0, embedding_relevance: 1.0, importance: 1.0,
      decay: 1.0, utility: 1.0, recency_bonus: 1.0,
    };
    const withEmb = computeAdaptiveScore(factors, true);
    // 0.20+0.15+0.20+0.15+0.20+0.10 = 1.0
    expect(withEmb).toBeCloseTo(1.0, 5);
  });
});

describe("computeUtilityScore", () => {
  let db: ReturnType<typeof createDatabase>;
  const dbPath = join(tmpdir(), `memento-adaptive-test-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => { db = createDatabase(dbPath); });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("returns neutral 0.5 for memory with no analytics data", () => {
    expect(computeUtilityScore(db, "nonexistent")).toBeCloseTo(0.5, 2);
  });

  it("returns high score for memory frequently used after injection (I6)", () => {
    // I6: Insert 10 'injection' events and 8 'utility_signal' (used) events separately
    for (let i = 0; i < 10; i++) {
      db.prepare(`
        INSERT INTO analytics_events (session_id, memory_id, event_type, event_data, created_at)
        VALUES ('s1', 'm1', 'injection', '{}', datetime('now'))
      `).run();
    }
    for (let i = 0; i < 8; i++) {
      db.prepare(`
        INSERT INTO analytics_events (session_id, memory_id, event_type, event_data, created_at)
        VALUES ('s1', 'm1', 'utility_signal', ?, datetime('now'))
      `).run(JSON.stringify({ signal_type: "tool_reference", signal_strength: 0.8 }));
    }

    const score = computeUtilityScore(db, "m1");
    // usageRate = 8/10 = 0.8; score should be high
    expect(score).toBeGreaterThan(0.6);
  });

  it("returns low score for memory injected but never used (I6)", () => {
    // 10 injections, 0 utility_signal events → used_count = 0
    for (let i = 0; i < 10; i++) {
      db.prepare(`
        INSERT INTO analytics_events (session_id, memory_id, event_type, event_data, created_at)
        VALUES ('s1', 'm1', 'injection', '{}', datetime('now'))
      `).run();
    }

    const score = computeUtilityScore(db, "m1");
    // usageRate = 0/10 = 0; score should be low
    expect(score).toBeLessThan(0.3);
  });

  it("confidence increases with more injection data points (I6)", () => {
    // 2 injections, 2 uses
    for (let i = 0; i < 2; i++) {
      db.prepare(`
        INSERT INTO analytics_events (session_id, memory_id, event_type, event_data, created_at)
        VALUES ('s1', 'm1', 'injection', '{}', datetime('now'))
      `).run();
      db.prepare(`
        INSERT INTO analytics_events (session_id, memory_id, event_type, event_data, created_at)
        VALUES ('s1', 'm1', 'utility_signal', ?, datetime('now'))
      `).run(JSON.stringify({ signal_type: "tool_reference", signal_strength: 0.8 }));
    }
    const scoreLow = computeUtilityScore(db, "m1");

    // 10 injections, 10 uses (same usage rate but higher confidence)
    for (let i = 0; i < 8; i++) {
      db.prepare(`
        INSERT INTO analytics_events (session_id, memory_id, event_type, event_data, created_at)
        VALUES ('s1', 'm1', 'injection', '{}', datetime('now'))
      `).run();
      db.prepare(`
        INSERT INTO analytics_events (session_id, memory_id, event_type, event_data, created_at)
        VALUES ('s1', 'm1', 'utility_signal', ?, datetime('now'))
      `).run(JSON.stringify({ signal_type: "tool_reference", signal_strength: 0.8 }));
    }
    const scoreHigh = computeUtilityScore(db, "m1");

    expect(scoreHigh).toBeGreaterThan(scoreLow);
  });

  // R9: edge case — null signal_strength in event_data
  it("R9: handles null signal_strength in event_data without crashing", () => {
    // Insert injection so total_injections > 0
    db.prepare(`
      INSERT INTO analytics_events (session_id, memory_id, event_type, event_data, created_at)
      VALUES ('s1', 'm2', 'injection', '{}', datetime('now'))
    `).run();
    // utility_signal with no signal_strength field
    db.prepare(`
      INSERT INTO analytics_events (session_id, memory_id, event_type, event_data, created_at)
      VALUES ('s1', 'm2', 'utility_signal', ?, datetime('now'))
    `).run(JSON.stringify({ signal_type: "tool_reference" /* no signal_strength */ }));

    // Should not throw; avg_strength will be NULL → treated as 0
    const score = computeUtilityScore(db, "m2");
    expect(score).toBeDefined();
    expect(typeof score).toBe("number");
    expect(Number.isFinite(score)).toBe(true);
  });

  // R9: edge case — malformed event_data JSON
  it("R9: handles malformed event_data JSON without crashing", () => {
    // Insert injection event
    db.prepare(`
      INSERT INTO analytics_events (session_id, memory_id, event_type, event_data, created_at)
      VALUES ('s1', 'm3', 'injection', '{}', datetime('now'))
    `).run();
    // utility_signal with non-JSON event_data — json_extract returns NULL
    db.prepare(`
      INSERT INTO analytics_events (session_id, memory_id, event_type, event_data, created_at)
      VALUES ('s1', 'm3', 'utility_signal', 'not-valid-json', datetime('now'))
    `).run();

    // Should not crash; json_extract on non-JSON returns NULL
    const score = computeUtilityScore(db, "m3");
    expect(score).toBeDefined();
    expect(typeof score).toBe("number");
    expect(Number.isFinite(score)).toBe(true);
  });

  // R9: edge case — memory_id pointing to a hard-deleted memory
  // computeUtilityScore only queries analytics_events, so a deleted memory
  // (no row in memories table) still has valid event rows and returns a valid score.
  it("R9: handles memory_id pointing to hard-deleted memory without crashing", () => {
    const deletedId = "deleted-memory-uuid";
    // Insert injection and utility_signal events referencing a memory_id
    // that doesn't exist in the memories table (simulating hard delete)
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO analytics_events (session_id, memory_id, event_type, event_data, created_at)
        VALUES ('s1', ?, 'injection', '{}', datetime('now'))
      `).run(deletedId);
    }
    for (let i = 0; i < 3; i++) {
      db.prepare(`
        INSERT INTO analytics_events (session_id, memory_id, event_type, event_data, created_at)
        VALUES ('s1', ?, 'utility_signal', ?, datetime('now'))
      `).run(deletedId, JSON.stringify({ signal_type: "tool_reference", signal_strength: 0.7 }));
    }

    // Should not crash even though the memory_id has no corresponding memories row
    const score = computeUtilityScore(db, deletedId);
    expect(score).toBeDefined();
    expect(typeof score).toBe("number");
    expect(Number.isFinite(score)).toBe(true);
    // usageRate = 3/5 = 0.6, confidence = min(5/5, 1.0) = 1.0
    // score = 0.6*0.6 + 0.7*0.2 + 1.0*0.2 = 0.36 + 0.14 + 0.2 = 0.70
    expect(score).toBeGreaterThan(0.5);
  });
});
