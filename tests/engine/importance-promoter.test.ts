import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { promoteImportanceFromUtility } from "../../src/engine/importance-promoter.js";
import { AnalyticsTracker } from "../../src/analytics/tracker.js";

describe("promoteImportanceFromUtility", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let tracker: AnalyticsTracker;
  const dbPath = join(tmpdir(), `memento-importance-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    tracker = new AnalyticsTracker(db, { flushThreshold: 100 });
  });
  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
  });

  const opts = { minInjections: 5, neutralUtility: 0.5, maxDelta: 0.05 };

  it("promotes memory with high utility signal", () => {
    const id = memRepo.store({
      title: "useful mem",
      body: "body",
      memoryType: "fact",
      scope: "global",
      importance: 0.5,
    });
    for (let i = 0; i < 10; i++) {
      tracker.track({ session_id: "s", memory_id: id, event_type: "injection", event_data: "{}" });
      tracker.track({
        session_id: "s",
        memory_id: id,
        event_type: "utility_signal",
        event_data: JSON.stringify({ signal_type: "tool_reference", signal_strength: 0.9 }),
      });
    }
    tracker.flush();

    const result = promoteImportanceFromUtility(db, opts);
    expect(result.adjusted).toBeGreaterThanOrEqual(1);
    expect(result.promoted).toBeGreaterThanOrEqual(1);
    const row = memRepo.getById(id);
    expect(row.importance_score).toBeGreaterThan(0.5);
  });

  it("demotes memory with ignored signals", () => {
    const id = memRepo.store({
      title: "unused mem",
      body: "body",
      memoryType: "fact",
      scope: "global",
      importance: 0.5,
    });
    for (let i = 0; i < 10; i++) {
      tracker.track({ session_id: "s", memory_id: id, event_type: "injection", event_data: "{}" });
      tracker.track({
        session_id: "s",
        memory_id: id,
        event_type: "utility_signal",
        event_data: JSON.stringify({ signal_type: "ignored", signal_strength: 0 }),
      });
    }
    tracker.flush();

    const result = promoteImportanceFromUtility(db, opts);
    expect(result.demoted).toBeGreaterThanOrEqual(1);
    const row = memRepo.getById(id);
    expect(row.importance_score).toBeLessThan(0.5);
  });

  it("skips pinned memories", () => {
    const id = memRepo.store({
      title: "pinned",
      body: "body",
      memoryType: "fact",
      scope: "global",
      importance: 0.5,
      pin: true,
    });
    for (let i = 0; i < 10; i++) {
      tracker.track({ session_id: "s", memory_id: id, event_type: "injection", event_data: "{}" });
      tracker.track({
        session_id: "s",
        memory_id: id,
        event_type: "utility_signal",
        event_data: JSON.stringify({ signal_type: "tool_reference", signal_strength: 0.9 }),
      });
    }
    tracker.flush();

    const result = promoteImportanceFromUtility(db, opts);
    expect(result.considered).toBe(0);
    expect(memRepo.getById(id).importance_score).toBeCloseTo(0.5);
  });

  it("respects maxDelta cap per pass", () => {
    const id = memRepo.store({
      title: "bounded",
      body: "body",
      memoryType: "fact",
      scope: "global",
      importance: 0.5,
    });
    for (let i = 0; i < 50; i++) {
      tracker.track({ session_id: "s", memory_id: id, event_type: "injection", event_data: "{}" });
      tracker.track({
        session_id: "s",
        memory_id: id,
        event_type: "utility_signal",
        event_data: JSON.stringify({ signal_type: "tool_reference", signal_strength: 1.0 }),
      });
    }
    tracker.flush();

    promoteImportanceFromUtility(db, { ...opts, maxDelta: 0.03 });
    const row = memRepo.getById(id);
    expect(row.importance_score - 0.5).toBeLessThanOrEqual(0.03 + 0.001);
  });

  it("ignores memories below minInjections threshold", () => {
    const id = memRepo.store({ title: "new", body: "body", memoryType: "fact", scope: "global" });
    for (let i = 0; i < 2; i++) {
      tracker.track({ session_id: "s", memory_id: id, event_type: "injection", event_data: "{}" });
    }
    tracker.flush();
    const result = promoteImportanceFromUtility(db, opts);
    expect(result.considered).toBe(0);
  });

  it("clamps importance to [0, 1]", () => {
    const high = memRepo.store({
      title: "nearly one",
      body: "b",
      memoryType: "fact",
      scope: "global",
      importance: 0.99,
    });
    for (let i = 0; i < 10; i++) {
      tracker.track({ session_id: "s", memory_id: high, event_type: "injection", event_data: "{}" });
      tracker.track({
        session_id: "s",
        memory_id: high,
        event_type: "utility_signal",
        event_data: JSON.stringify({ signal_type: "tool_reference", signal_strength: 1.0 }),
      });
    }
    tracker.flush();
    promoteImportanceFromUtility(db, opts);
    const row = memRepo.getById(high);
    expect(row.importance_score).toBeLessThanOrEqual(1);
    expect(row.importance_score).toBeGreaterThanOrEqual(0.99);
  });
});
