// tests/analytics/prune-recommendations.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getPruneRecommendations } from "../../src/analytics/reporter.js";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("getPruneRecommendations", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  const dbPath = join(tmpdir(), `memento-prune-test-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
  });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("recommends deleting memories injected 5+ times but never used", () => {
    const id = memRepo.store({ title: "never used", body: "test", memoryType: "fact", scope: "global" });

    // Simulate 5 injections, all ignored
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO analytics_events (session_id, memory_id, event_type, event_data, created_at)
        VALUES ('s1', ?, 'injection', '{}', datetime('now'))
      `).run(id);
    }

    const recs = getPruneRecommendations(db);
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.some(r => r.memory_id === id && r.action === "delete")).toBe(true);
  });

  it("recommends archiving stale low-importance memories", () => {
    const id = memRepo.store({ title: "stale", body: "test", memoryType: "fact", scope: "global", importance: 0.2 });
    db.prepare("UPDATE memories SET last_accessed_at = datetime('now', '-90 days') WHERE id = ?").run(id);

    const recs = getPruneRecommendations(db);
    expect(recs.some(r => r.memory_id === id && r.action === "archive")).toBe(true);
  });

  it("does not recommend pruning pinned memories", () => {
    const id = memRepo.store({ title: "pinned stale", body: "test", memoryType: "fact", scope: "global", importance: 0.2, pin: true });
    db.prepare("UPDATE memories SET last_accessed_at = datetime('now', '-90 days') WHERE id = ?").run(id);

    const recs = getPruneRecommendations(db);
    expect(recs.every(r => r.memory_id !== id)).toBe(true);
  });

  it("returns empty array when no recommendations", () => {
    memRepo.store({ title: "fresh", body: "test", memoryType: "fact", scope: "global", importance: 0.9 });
    const recs = getPruneRecommendations(db);
    expect(recs.length).toBe(0);
  });

  // R9 edge cases

  it("returns empty array for empty database (no memories)", () => {
    const recs = getPruneRecommendations(db);
    expect(recs).toEqual([]);
  });

  it("does not include hard-deleted (deleted_at set) memories in recommendations", () => {
    const id = memRepo.store({ title: "hard deleted", body: "test", memoryType: "fact", scope: "global", importance: 0.2 });
    // Mark as hard-deleted and stale
    db.prepare("UPDATE memories SET deleted_at = datetime('now', '-1 day'), last_accessed_at = datetime('now', '-90 days') WHERE id = ?").run(id);
    // Also add 5 injections
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO analytics_events (session_id, memory_id, event_type, event_data, created_at)
        VALUES ('s1', ?, 'injection', '{}', datetime('now'))
      `).run(id);
    }

    const recs = getPruneRecommendations(db);
    expect(recs.every(r => r.memory_id !== id)).toBe(true);
  });

  it("handles null project (no project_id) correctly", () => {
    // Insert a memory without a project_id (global scope, no project association)
    const id = memRepo.store({ title: "global orphan", body: "test", memoryType: "fact", scope: "global", importance: 0.2 });
    db.prepare("UPDATE memories SET last_accessed_at = datetime('now', '-90 days') WHERE id = ?").run(id);

    // Should still recommend archiving even with no project
    const recs = getPruneRecommendations(db);
    expect(recs.some(r => r.memory_id === id && r.action === "archive")).toBe(true);
  });

  it("does not recommend deletion for memories injected fewer than 5 times", () => {
    const id = memRepo.store({ title: "rarely injected", body: "test", memoryType: "fact", scope: "global" });

    for (let i = 0; i < 4; i++) {
      db.prepare(`
        INSERT INTO analytics_events (session_id, memory_id, event_type, event_data, created_at)
        VALUES ('s1', ?, 'injection', '{}', datetime('now'))
      `).run(id);
    }

    const recs = getPruneRecommendations(db);
    expect(recs.filter(r => r.memory_id === id && r.action === "delete").length).toBe(0);
  });

  it("does not recommend archiving memories accessed recently", () => {
    const id = memRepo.store({ title: "recent low importance", body: "test", memoryType: "fact", scope: "global", importance: 0.2 });
    // last_accessed_at is NULL by default (not yet accessed) — also check recently accessed
    db.prepare("UPDATE memories SET last_accessed_at = datetime('now', '-10 days') WHERE id = ?").run(id);

    const recs = getPruneRecommendations(db);
    expect(recs.filter(r => r.memory_id === id && r.action === "archive").length).toBe(0);
  });

  it("does not recommend archiving stale memories with high importance", () => {
    const id = memRepo.store({ title: "stale but important", body: "test", memoryType: "fact", scope: "global", importance: 0.8 });
    db.prepare("UPDATE memories SET last_accessed_at = datetime('now', '-90 days') WHERE id = ?").run(id);

    const recs = getPruneRecommendations(db);
    expect(recs.filter(r => r.memory_id === id).length).toBe(0);
  });

  it("recommendation has correct shape (memory_id, title, reason, action, confidence)", () => {
    const id = memRepo.store({ title: "shape test", body: "test", memoryType: "fact", scope: "global" });
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO analytics_events (session_id, memory_id, event_type, event_data, created_at)
        VALUES ('s1', ?, 'injection', '{}', datetime('now'))
      `).run(id);
    }

    const recs = getPruneRecommendations(db);
    const rec = recs.find(r => r.memory_id === id);
    expect(rec).toBeDefined();
    expect(typeof rec!.memory_id).toBe("string");
    expect(typeof rec!.title).toBe("string");
    expect(typeof rec!.reason).toBe("string");
    expect(["delete", "archive"]).toContain(rec!.action);
    expect(typeof rec!.confidence).toBe("number");
    expect(rec!.confidence).toBeGreaterThan(0);
    expect(rec!.confidence).toBeLessThanOrEqual(1);
  });
});
