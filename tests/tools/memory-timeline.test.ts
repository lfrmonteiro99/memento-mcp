// tests/tools/memory-timeline.test.ts
// Tests for the memory_timeline tool, including Issue #3 claude_session_id path.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { handleMemoryTimeline } from "../../src/tools/memory-timeline.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("memory_timeline tool", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: MemoriesRepo;
  const dbPath = join(tmpdir(), `memento-timeline-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    repo = new MemoriesRepo(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("returns 'not found' message for unknown id", async () => {
    const result = await handleMemoryTimeline(repo, { id: "nonexistent-id" });
    expect(result).toContain("not found");
  });

  it("returns 'No neighbors found' when focus has no session neighbors", async () => {
    const id = repo.store({
      title: "Lonely memory",
      body: "This memory has no neighbors",
      memoryType: "fact",
      scope: "project",
      projectPath: "/test/lonely",
    });

    const result = await handleMemoryTimeline(repo, { id });
    expect(result).toContain("Lonely memory");
    expect(result).toContain("No neighbors");
  });

  it("claude_session_id path: finds neighbors in same session", async () => {
    const sessId = `sess-tl-${randomUUID()}`;
    const projectId = repo.ensureProject("/test/timeline-project");

    const id1 = repo.store({
      title: "Timeline memory 1",
      body: "First memory in session",
      memoryType: "fact",
      scope: "project",
      projectId,
      claudeSessionId: sessId,
    });
    const id2 = repo.store({
      title: "Timeline memory 2",
      body: "Second memory in session",
      memoryType: "fact",
      scope: "project",
      projectId,
      claudeSessionId: sessId,
    });
    const id3 = repo.store({
      title: "Timeline memory 3 different session",
      body: "Memory from another session",
      memoryType: "fact",
      scope: "project",
      projectId,
      claudeSessionId: "different-session",
    });

    // Focus on id1 with same_session_only=true
    const result = await handleMemoryTimeline(repo, {
      id: id1,
      same_session_only: true,
    });

    // Should show id2 (same session) but not id3 (different session)
    expect(result).toContain("Timeline memory 2");
    expect(result).not.toContain("Timeline memory 3");
  });

  it("time-window path: finds neighbors within ±2h when claude_session_id is null", async () => {
    const projectId = repo.ensureProject("/test/timeline-noSession");

    const id1 = repo.store({
      title: "No-session memory 1",
      body: "Memory without session id",
      memoryType: "fact",
      scope: "project",
      projectId,
    });
    const id2 = repo.store({
      title: "No-session memory 2",
      body: "Another memory without session",
      memoryType: "fact",
      scope: "project",
      projectId,
    });

    // Both memories have no claude_session_id, should use time-window fallback
    const result = await handleMemoryTimeline(repo, {
      id: id1,
      same_session_only: true,
    });

    // id2 is within ±2h (just created), should appear
    expect(result).toContain("No-session memory 2");
  });

  it("same_session_only=false returns time-window neighbors regardless of session", async () => {
    const sessId = `sess-tl-strict-${randomUUID()}`;
    const projectId = repo.ensureProject("/test/timeline-strict");

    const id1 = repo.store({
      title: "Session mem 1",
      body: "First",
      memoryType: "fact",
      scope: "project",
      projectId,
      claudeSessionId: sessId,
    });
    const id2 = repo.store({
      title: "Different session mem",
      body: "Second from different session",
      memoryType: "fact",
      scope: "project",
      projectId,
      claudeSessionId: "other-sess",
    });

    // With same_session_only=false, time window is used, so id2 should appear
    const result = await handleMemoryTimeline(repo, {
      id: id1,
      same_session_only: false,
    });

    expect(result).toContain("Different session mem");
  });
});
