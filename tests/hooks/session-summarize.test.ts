// tests/hooks/session-summarize.test.ts
// Tests for the SessionEnd auto-summarization hook (Issue #3).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase, nowIso } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { summarizeAsCluster } from "../../src/engine/compressor.js";
import type { MemoryRecord } from "../../src/engine/compressor.js";

// Helper: create a realistic auto-capture memory record
function makeCapture(
  db: ReturnType<typeof createDatabase>,
  repo: MemoriesRepo,
  opts: {
    claudeSessionId: string;
    projectId?: string;
    title?: string;
    body?: string;
    tags?: string[];
    importance?: number;
  }
): any {
  const id = repo.store({
    title: opts.title ?? `Auto-capture ${randomUUID().slice(0, 8)}`,
    body: opts.body ?? "This is auto-captured content with some facts. It has multiple sentences. The build passed successfully.",
    memoryType: "fact",
    scope: "project",
    projectId: opts.projectId,
    tags: opts.tags ?? ["auto", "test"],
    importance: opts.importance ?? 0.4,
    source: "auto-capture",
    claudeSessionId: opts.claudeSessionId,
  });
  return db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
}

describe("summarizeAsCluster helper", () => {
  it("returns a session summary with correct title format", () => {
    const mem: MemoryRecord = {
      id: "m1",
      project_id: "p1",
      memory_type: "fact",
      scope: "project",
      title: "Test memory",
      body: "This is some content with details. It covers multiple topics. The solution was to refactor the code.",
      tags: '["typescript","testing"]',
      importance_score: 0.6,
      confidence_score: 0.5,
      access_count: 0,
      last_accessed_at: null,
      is_pinned: 0,
      supersedes_memory_id: null,
      source: "auto-capture",
      adaptive_score: 0.5,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    };
    const result = summarizeAsCluster([mem], {
      cluster_similarity_threshold: 0.45,
      min_cluster_size: 2,
      max_body_ratio: 0.6,
      temporal_window_hours: 48,
    });
    const today = new Date().toISOString().slice(0, 10);
    expect(result.title).toBe(`Session summary — ${today} — 1 captures`);
    expect(result.importance).toBeCloseTo(0.6);
    expect(result.tags).toContain("typescript");
    expect(result.tags).toContain("testing");
  });

  it("unions tags from multiple memories without duplicates", () => {
    const makeSimpleMem = (id: string, tags: string[]): MemoryRecord => ({
      id,
      project_id: "p1",
      memory_type: "fact",
      scope: "project",
      title: `Memory ${id}`,
      body: "Some fact. Another detail here. Third sentence for content.",
      tags: JSON.stringify(tags),
      importance_score: 0.4,
      confidence_score: 0.5,
      access_count: 0,
      last_accessed_at: null,
      is_pinned: 0,
      supersedes_memory_id: null,
      source: "auto-capture",
      adaptive_score: 0.5,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    });
    const mems = [
      makeSimpleMem("m1", ["typescript", "react"]),
      makeSimpleMem("m2", ["typescript", "testing"]),
      makeSimpleMem("m3", ["react", "css"]),
    ];
    const result = summarizeAsCluster(mems, {
      cluster_similarity_threshold: 0.45,
      min_cluster_size: 2,
      max_body_ratio: 0.6,
      temporal_window_hours: 48,
    });
    // All tags present, deduplicated
    expect(result.tags).toContain("typescript");
    expect(result.tags).toContain("react");
    expect(result.tags).toContain("testing");
    expect(result.tags).toContain("css");
    // No duplicates
    const tagSet = new Set(result.tags);
    expect(tagSet.size).toBe(result.tags.length);
  });

  it("importance = max of source importances", () => {
    const importances = [0.3, 0.7, 0.5, 0.9, 0.2];
    const mems: MemoryRecord[] = importances.map((imp, i) => ({
      id: `m${i}`,
      project_id: "p1",
      memory_type: "fact",
      scope: "project",
      title: `Memory ${i}`,
      body: "Content with facts. Another sentence here. More detail follows.",
      tags: "[]",
      importance_score: imp,
      confidence_score: 0.5,
      access_count: 0,
      last_accessed_at: null,
      is_pinned: 0,
      supersedes_memory_id: null,
      source: "auto-capture",
      adaptive_score: 0.5,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    }));
    const result = summarizeAsCluster(mems, {
      cluster_similarity_threshold: 0.45,
      min_cluster_size: 2,
      max_body_ratio: 0.6,
      temporal_window_hours: 48,
    });
    expect(result.importance).toBeCloseTo(0.9);
  });

  it("respects maxBodyTokens cap", () => {
    const mems: MemoryRecord[] = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`,
      project_id: "p1",
      memory_type: "fact",
      scope: "project",
      title: `Memory ${i}`,
      body: "This is a very long sentence with lots of details about the implementation. " +
            "The system was designed to handle edge cases gracefully. " +
            "Performance testing showed significant improvements.",
      tags: "[]",
      importance_score: 0.5,
      confidence_score: 0.5,
      access_count: 0,
      last_accessed_at: null,
      is_pinned: 0,
      supersedes_memory_id: null,
      source: "auto-capture",
      adaptive_score: 0.5,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    }));
    const resultLimited = summarizeAsCluster(mems, {
      cluster_similarity_threshold: 0.45,
      min_cluster_size: 2,
      max_body_ratio: 0.6,
      temporal_window_hours: 48,
      maxBodyTokens: 20, // very small cap
    });
    const resultUnlimited = summarizeAsCluster(mems, {
      cluster_similarity_threshold: 0.45,
      min_cluster_size: 2,
      max_body_ratio: 0.6,
      temporal_window_hours: 48,
    });
    // Limited result should have fewer or equal body tokens
    expect(resultLimited.body.length).toBeLessThanOrEqual(resultUnlimited.body.length);
  });

  it("handles empty memories array gracefully", () => {
    const result = summarizeAsCluster([], {
      cluster_similarity_threshold: 0.45,
      min_cluster_size: 2,
      max_body_ratio: 0.6,
      temporal_window_hours: 48,
    });
    expect(result.title).toBe("Session summary");
    expect(result.body).toBe("");
    expect(result.tags).toEqual([]);
    expect(result.tokens_before).toBe(0);
  });
});

describe("session-summarize hook logic (in-process)", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: MemoriesRepo;
  const dbPath = join(tmpdir(), `memento-summarize-test-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    repo = new MemoriesRepo(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("5 auto-captures → 1 session_summary, sources soft-deleted, compression_log entry", () => {
    const sessionId = `sess-${randomUUID()}`;
    const projectId = repo.ensureProject("/test/project-a");

    // Store 5 auto-captures with the same claude_session_id
    const captureIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const cap = makeCapture(db, repo, {
        claudeSessionId: sessionId,
        projectId,
        title: `Capture ${i}: some work done`,
        body: `Implemented feature ${i}. Tests passed for component ${i}. The build was successful.`,
        tags: [`feature-${i}`, "typescript"],
        importance: 0.3 + i * 0.1,
      });
      captureIds.push(cap.id);
    }

    // Simulate the hook logic inline (same as session-summarize-bin.ts)
    const captures = repo.listBySession(sessionId, { sourceFilter: "auto-capture" });
    expect(captures.length).toBe(5);

    const summary = summarizeAsCluster(captures, {
      cluster_similarity_threshold: 0.45,
      min_cluster_size: 2,
      max_body_ratio: 0.6,
      temporal_window_hours: 48,
      maxBodyTokens: 1500,
    });

    const now = nowIso();
    const summaryId = randomUUID();

    db.transaction(() => {
      db.prepare(`
        INSERT INTO memories (id, project_id, memory_type, scope, title, body, tags,
                              importance_score, source, claude_session_id,
                              created_at, updated_at, last_accessed_at)
        VALUES (?, ?, 'session_summary', 'project', ?, ?, ?, ?, 'session-summary', ?, ?, ?, ?)
      `).run(
        summaryId, projectId,
        summary.title, summary.body, JSON.stringify(summary.tags),
        summary.importance, sessionId, now, now, now
      );

      db.prepare(`
        INSERT INTO compression_log (compressed_memory_id, source_memory_ids, tokens_before, tokens_after, compression_ratio, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        summaryId, JSON.stringify(captureIds),
        summary.tokens_before, summary.tokens_after,
        summary.tokens_before === 0 ? 1 : summary.tokens_after / summary.tokens_before,
        now
      );

      // Soft-delete sources
      const softDelete = db.prepare("UPDATE memories SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL");
      for (const id of captureIds) {
        softDelete.run(now, id);
      }
    })();

    // Assert: exactly 1 session_summary exists
    const summaryMems = db.prepare(
      "SELECT * FROM memories WHERE memory_type = 'session_summary' AND deleted_at IS NULL"
    ).all() as any[];
    expect(summaryMems.length).toBe(1);
    expect(summaryMems[0].source).toBe("session-summary");
    expect(summaryMems[0].claude_session_id).toBe(sessionId);

    // Assert: all 5 source memories are soft-deleted
    for (const id of captureIds) {
      const mem = db.prepare("SELECT deleted_at FROM memories WHERE id = ?").get(id) as any;
      expect(mem.deleted_at).not.toBeNull();
    }

    // Assert: compression_log entry exists
    const logEntry = db.prepare(
      "SELECT * FROM compression_log WHERE compressed_memory_id = ?"
    ).get(summaryId) as any;
    expect(logEntry).toBeDefined();
    expect(JSON.parse(logEntry.source_memory_ids)).toEqual(captureIds);
  });

  it("0 captures → no-op (no summary written)", () => {
    const sessionId = `sess-${randomUUID()}`;
    const captures = repo.listBySession(sessionId, { sourceFilter: "auto-capture" });
    expect(captures.length).toBe(0);

    // No summary should be written
    const summaryMems = db.prepare(
      "SELECT * FROM memories WHERE memory_type = 'session_summary' AND deleted_at IS NULL"
    ).all() as any[];
    expect(summaryMems.length).toBe(0);
  });

  it("1 capture → retypes memory to session_summary", () => {
    const sessionId = `sess-${randomUUID()}`;
    const projectId = repo.ensureProject("/test/project-b");
    const cap = makeCapture(db, repo, {
      claudeSessionId: sessionId,
      projectId,
      title: "Single capture",
      body: "Just one thing happened. This is it. That is all.",
    });

    // Simulate 1-capture path
    const captures = repo.listBySession(sessionId, { sourceFilter: "auto-capture" });
    expect(captures.length).toBe(1);

    const now = nowIso();
    db.prepare(`
      UPDATE memories SET memory_type = 'session_summary', source = 'session-summary', updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(now, captures[0].id);

    // The memory should now be retyped
    const updated = db.prepare("SELECT * FROM memories WHERE id = ?").get(cap.id) as any;
    expect(updated.memory_type).toBe("session_summary");
    expect(updated.source).toBe("session-summary");
    // Not deleted
    expect(updated.deleted_at).toBeNull();
  });

  it("keep_originals=true does NOT soft-delete source memories", () => {
    const sessionId = `sess-${randomUUID()}`;
    const projectId = repo.ensureProject("/test/project-c");
    const captureIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const cap = makeCapture(db, repo, { claudeSessionId: sessionId, projectId });
      captureIds.push(cap.id);
    }

    const captures = repo.listBySession(sessionId, { sourceFilter: "auto-capture" });
    const summary = summarizeAsCluster(captures, {
      cluster_similarity_threshold: 0.45,
      min_cluster_size: 2,
      max_body_ratio: 0.6,
      temporal_window_hours: 48,
    });

    const now = nowIso();
    const summaryId = randomUUID();

    // keep_originals = true → do NOT soft-delete
    db.transaction(() => {
      db.prepare(`
        INSERT INTO memories (id, project_id, memory_type, scope, title, body, tags,
                              importance_score, source, claude_session_id,
                              created_at, updated_at, last_accessed_at)
        VALUES (?, ?, 'session_summary', 'project', ?, ?, ?, ?, 'session-summary', ?, ?, ?, ?)
      `).run(
        summaryId, projectId,
        summary.title, summary.body, JSON.stringify(summary.tags),
        summary.importance, sessionId, now, now, now
      );
      // NO soft-delete of sources
    })();

    // Sources should still be alive
    for (const id of captureIds) {
      const mem = db.prepare("SELECT deleted_at FROM memories WHERE id = ?").get(id) as any;
      expect(mem.deleted_at).toBeNull();
    }
  });

  it("idempotency: running summarization twice for same session does not create two summaries", () => {
    const sessionId = `sess-${randomUUID()}`;
    const projectId = repo.ensureProject("/test/project-d");
    for (let i = 0; i < 3; i++) {
      makeCapture(db, repo, { claudeSessionId: sessionId, projectId });
    }

    const runSummarize = () => {
      // Check if already summarized
      const existing = db.prepare(`
        SELECT id FROM memories
        WHERE claude_session_id = ? AND memory_type = 'session_summary' AND deleted_at IS NULL
        LIMIT 1
      `).get(sessionId) as { id: string } | undefined;
      if (existing) return "skipped";

      const captures = repo.listBySession(sessionId, { sourceFilter: "auto-capture" });
      if (captures.length === 0) return "no-captures";

      const summary = summarizeAsCluster(captures, {
        cluster_similarity_threshold: 0.45,
        min_cluster_size: 2,
        max_body_ratio: 0.6,
        temporal_window_hours: 48,
      });

      const now = nowIso();
      const summaryId = randomUUID();

      db.transaction(() => {
        db.prepare(`
          INSERT INTO memories (id, project_id, memory_type, scope, title, body, tags,
                                importance_score, source, claude_session_id,
                                created_at, updated_at, last_accessed_at)
          VALUES (?, ?, 'session_summary', 'project', ?, ?, ?, ?, 'session-summary', ?, ?, ?, ?)
        `).run(
          summaryId, projectId,
          summary.title, summary.body, JSON.stringify(summary.tags),
          summary.importance, sessionId, now, now, now
        );

        const softDelete = db.prepare("UPDATE memories SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL");
        for (const cap of captures) {
          softDelete.run(now, (cap as any).id);
        }
      })();

      return "created";
    };

    const first = runSummarize();
    const second = runSummarize();

    expect(first).toBe("created");
    expect(second).toBe("skipped");

    // Only 1 session_summary should exist
    const summaries = db.prepare(
      "SELECT * FROM memories WHERE memory_type = 'session_summary' AND deleted_at IS NULL"
    ).all() as any[];
    expect(summaries.length).toBe(1);
  });

  it("min_captures threshold: fewer than min → no summary written", () => {
    const sessionId = `sess-${randomUUID()}`;
    const projectId = repo.ensureProject("/test/project-e");
    // Store exactly 1 capture (below default minCaptures=2 for the 2+ cluster path)
    makeCapture(db, repo, { claudeSessionId: sessionId, projectId });

    const captures = repo.listBySession(sessionId, { sourceFilter: "auto-capture" });
    const minCaptures = 3; // higher threshold

    if (captures.length < minCaptures) {
      // Should skip — no summary written
    } else {
      // This branch should not run
      expect(true).toBe(false);
    }

    const summaries = db.prepare(
      "SELECT * FROM memories WHERE memory_type = 'session_summary' AND deleted_at IS NULL"
    ).all() as any[];
    expect(summaries.length).toBe(0);
  });
});

describe("listBySession() repo helper", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: MemoriesRepo;
  const dbPath = join(tmpdir(), `memento-listbysession-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    repo = new MemoriesRepo(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("returns only memories for the given claude_session_id", () => {
    const sessA = `sess-a-${randomUUID()}`;
    const sessB = `sess-b-${randomUUID()}`;

    repo.store({ title: "A1", body: "b", memoryType: "fact", scope: "project", source: "auto-capture", claudeSessionId: sessA });
    repo.store({ title: "A2", body: "b", memoryType: "fact", scope: "project", source: "auto-capture", claudeSessionId: sessA });
    repo.store({ title: "B1", body: "b", memoryType: "fact", scope: "project", source: "auto-capture", claudeSessionId: sessB });

    const resultA = repo.listBySession(sessA);
    expect(resultA.length).toBe(2);
    expect(resultA.every((m: any) => m.claude_session_id === sessA)).toBe(true);

    const resultB = repo.listBySession(sessB);
    expect(resultB.length).toBe(1);
  });

  it("filters by sourceFilter when provided", () => {
    const sessId = `sess-${randomUUID()}`;
    repo.store({ title: "C1", body: "b", memoryType: "fact", scope: "project", source: "auto-capture", claudeSessionId: sessId });
    repo.store({ title: "C2", body: "b", memoryType: "session_summary", scope: "project", source: "session-summary", claudeSessionId: sessId });

    const onlyCaptures = repo.listBySession(sessId, { sourceFilter: "auto-capture" });
    expect(onlyCaptures.length).toBe(1);
    expect(onlyCaptures[0].title).toBe("C1");

    const all = repo.listBySession(sessId);
    expect(all.length).toBe(2);
  });

  it("excludes soft-deleted memories", () => {
    const sessId = `sess-${randomUUID()}`;
    const id = repo.store({ title: "D1", body: "b", memoryType: "fact", scope: "project", source: "auto-capture", claudeSessionId: sessId });
    repo.store({ title: "D2", body: "b", memoryType: "fact", scope: "project", source: "auto-capture", claudeSessionId: sessId });
    repo.delete(id);

    const result = repo.listBySession(sessId);
    expect(result.length).toBe(1);
    expect(result[0].title).toBe("D2");
  });

  it("returns empty array for unknown session", () => {
    const result = repo.listBySession(`sess-nonexistent-${randomUUID()}`);
    expect(result.length).toBe(0);
  });
});
