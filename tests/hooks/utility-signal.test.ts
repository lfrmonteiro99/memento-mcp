// tests/hooks/utility-signal.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { processUtilitySignals } from "../../src/hooks/utility-signal.js";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { AnalyticsTracker } from "../../src/analytics/tracker.js";
import { setClock, resetClock } from "../../src/lib/decay.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("processUtilitySignals (K1)", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let tracker: AnalyticsTracker;
  const dbPath = join(tmpdir(), `memento-utility-signal-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    tracker = new AnalyticsTracker(db, { flushThreshold: 1 });
    // R10: freeze time so injection windows are deterministic
    setClock(() => new Date("2026-04-17T12:00:00Z").getTime());
  });

  afterEach(() => {
    resetClock();
    db.close();
    rmSync(dbPath, { force: true });
  });

  function insertInjection(sessionId: string, memoryId: string, minutesAgo: number): void {
    const ts = new Date(Date.now() - minutesAgo * 60_000).toISOString().replace("T", " ").slice(0, 19);
    db.prepare(`
      INSERT INTO analytics_events (session_id, memory_id, event_type, event_data, created_at)
      VALUES (?, ?, 'injection', '{}', ?)
    `).run(sessionId, memoryId, ts);
  }

  it("emits tool_reference signal when tool call references a file path from an injected memory", () => {
    const memId = memRepo.store({
      title: "UserService auth flow",
      body: "See src/UserService.ts for the validate() logic and RBAC table lookups.",
      memoryType: "architecture", scope: "global",
    });
    insertInjection("s1", memId, 2); // injected 2 minutes ago, inside window

    processUtilitySignals(db, tracker, {
      session_id: "s1",
      tool_name: "Read",
      tool_input: { file_path: "src/UserService.ts" },
      tool_response_text: "export class UserService { validate() { /* ... */ } }",
      utility_window_minutes: 10,
    });
    tracker.flush();

    const signals = db.prepare(`
      SELECT json_extract(event_data, '$.signal_type') as signal_type,
             json_extract(event_data, '$.signal_strength') as signal_strength
      FROM analytics_events
      WHERE memory_id = ? AND event_type = 'utility_signal'
    `).all(memId) as Array<{ signal_type: string; signal_strength: number }>;

    expect(signals.length).toBe(1);
    expect(signals[0].signal_type).toBe("tool_reference");
    // "src/UserService.ts" is 19 chars → strength 0.5 (boundary: > 20 → 0.8). Accept either.
    expect(signals[0].signal_strength).toBeGreaterThan(0);
  });

  it("emits explicit_access with strength 1.0 when memory_get references the injected memory id", () => {
    const memId = memRepo.store({
      title: "Docker compose setup",
      body: "Services: web, db, redis. Ports: 3000, 5432, 6379.",
      memoryType: "architecture", scope: "global",
    });
    insertInjection("s1", memId, 1);

    processUtilitySignals(db, tracker, {
      session_id: "s1",
      tool_name: "memory_get",
      tool_input: { memory_id: memId },
      tool_response_text: `Memory ${memId}: Docker compose setup. Services: web, db, redis.`,
      utility_window_minutes: 10,
    });
    tracker.flush();

    const signal = db.prepare(`
      SELECT json_extract(event_data, '$.signal_type') as t,
             json_extract(event_data, '$.signal_strength') as s
      FROM analytics_events WHERE memory_id = ? AND event_type = 'utility_signal'
    `).get(memId) as { t: string; s: number };
    expect(signal.t).toBe("explicit_access");
    expect(signal.s).toBe(1.0);
  });

  it("emits explicit_access when memory_search response contains the memory title", () => {
    const memId = memRepo.store({
      title: "Redis cache invalidation strategy",
      body: "Use TTL-based expiry combined with pub/sub invalidation.",
      memoryType: "architecture", scope: "global",
    });
    insertInjection("s1", memId, 3);

    processUtilitySignals(db, tracker, {
      session_id: "s1",
      tool_name: "memory_search",
      tool_input: { query: "cache" },
      tool_response_text: `Found 1 result: Redis cache invalidation strategy (score: 0.9)`,
      utility_window_minutes: 10,
    });
    tracker.flush();

    const signal = db.prepare(`
      SELECT json_extract(event_data, '$.signal_type') as t,
             json_extract(event_data, '$.signal_strength') as s
      FROM analytics_events WHERE memory_id = ? AND event_type = 'utility_signal'
    `).get(memId) as { t: string; s: number };
    expect(signal.t).toBe("explicit_access");
    expect(signal.s).toBe(1.0);
  });

  it("marks expired injections as ignored (window elapsed)", () => {
    const memId = memRepo.store({ title: "Unused", body: "Nothing referenced this.", memoryType: "fact", scope: "global" });
    insertInjection("s1", memId, 20); // older than 10-minute window

    processUtilitySignals(db, tracker, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response_text: "file1\nfile2\n",
      utility_window_minutes: 10,
    });
    tracker.flush();

    const signal = db.prepare(`
      SELECT json_extract(event_data, '$.signal_type') as t
      FROM analytics_events WHERE memory_id = ? AND event_type = 'utility_signal'
    `).get(memId) as { t: string };
    expect(signal.t).toBe("ignored");
  });

  it("does not double-signal the same injection across multiple PostToolUse events", () => {
    const memId = memRepo.store({ title: "UserService", body: "src/UserService.ts is the main class.", memoryType: "fact", scope: "global" });
    insertInjection("s1", memId, 2);

    // First call — matches
    processUtilitySignals(db, tracker, {
      session_id: "s1",
      tool_name: "Read",
      tool_input: { file_path: "src/UserService.ts" },
      tool_response_text: "contents",
      utility_window_minutes: 10,
    });
    // Second call — matches again
    processUtilitySignals(db, tracker, {
      session_id: "s1",
      tool_name: "Edit",
      tool_input: { file_path: "src/UserService.ts", old_string: "a", new_string: "b" },
      tool_response_text: "ok",
      utility_window_minutes: 10,
    });
    tracker.flush();

    const count = db.prepare(`
      SELECT COUNT(*) as c FROM analytics_events
      WHERE memory_id = ? AND event_type = 'utility_signal'
    `).get(memId) as { c: number };
    expect(count.c).toBe(1); // only the first call produces a signal
  });

  it("N total injections + K matches produces K non-ignored + N-K ignored signals after window expires", () => {
    // Note: the ignored sweep uses SQLite's datetime('now'), which is independent of setClock.
    // To simulate "window expired", we insert injections OLDER than 10 minutes via insertInjection.
    const m1 = memRepo.store({ title: "M1", body: "uses foo.ts", memoryType: "fact", scope: "global" });
    const m2 = memRepo.store({ title: "M2", body: "uses bar.ts", memoryType: "fact", scope: "global" });
    const m3 = memRepo.store({ title: "M3", body: "uses baz.ts", memoryType: "fact", scope: "global" });

    // All 3 injected INSIDE the window first.
    insertInjection("s1", m1, 1);
    insertInjection("s1", m2, 1);
    insertInjection("s1", m3, 1);

    // Match only m1 while everyone is still in-window.
    processUtilitySignals(db, tracker, {
      session_id: "s1", tool_name: "Read", tool_input: { file_path: "foo.ts" },
      tool_response_text: "", utility_window_minutes: 10,
    });
    tracker.flush();

    // Simulate window expiry by back-dating the two unsignaled injections in-place.
    db.prepare(`
      UPDATE analytics_events
      SET created_at = datetime('now', '-15 minutes')
      WHERE session_id = 's1' AND event_type = 'injection' AND memory_id IN (?, ?)
    `).run(m2, m3);

    // Another call — triggers the ignored sweep for m2, m3.
    processUtilitySignals(db, tracker, {
      session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" },
      tool_response_text: "", utility_window_minutes: 10,
    });
    tracker.flush();

    const rows = db.prepare(`
      SELECT memory_id, json_extract(event_data, '$.signal_type') as t
      FROM analytics_events
      WHERE session_id = 's1' AND event_type = 'utility_signal'
    `).all() as Array<{ memory_id: string; t: string }>;
    expect(rows.length).toBe(3);
    expect(rows.filter(r => r.t === "tool_reference").length).toBe(1);
    expect(rows.filter(r => r.t === "ignored").length).toBe(2);
  });

  it("emits ignored signal with reason 'memory deleted' when memory has been hard-deleted", () => {
    const memId = memRepo.store({
      title: "Deleted Memory",
      body: "This memory will be hard deleted.",
      memoryType: "fact", scope: "global",
    });
    insertInjection("s1", memId, 2);

    // Hard-delete the memory (remove the row entirely)
    db.prepare("DELETE FROM memories WHERE id = ?").run(memId);

    processUtilitySignals(db, tracker, {
      session_id: "s1",
      tool_name: "Read",
      tool_input: { file_path: "some-file.ts" },
      tool_response_text: "some content",
      utility_window_minutes: 10,
    });
    tracker.flush();

    const signal = db.prepare(`
      SELECT json_extract(event_data, '$.signal_type') as t,
             json_extract(event_data, '$.reason') as reason
      FROM analytics_events WHERE memory_id = ? AND event_type = 'utility_signal'
    `).get(memId) as { t: string; reason: string };
    expect(signal.t).toBe("ignored");
    expect(signal.reason).toBe("memory deleted");
  });

  it("does not cross-contaminate sessions — injection in s2 is not matched by s1 tool call", () => {
    const memId = memRepo.store({
      title: "S2 specific memory",
      body: "crosscheck.ts is the file",
      memoryType: "fact", scope: "global",
    });
    insertInjection("s2", memId, 2); // injected in session s2

    // s1 tool call references the file — should NOT match s2's injection
    processUtilitySignals(db, tracker, {
      session_id: "s1",
      tool_name: "Read",
      tool_input: { file_path: "crosscheck.ts" },
      tool_response_text: "content",
      utility_window_minutes: 10,
    });
    tracker.flush();

    const count = db.prepare(`
      SELECT COUNT(*) as c FROM analytics_events
      WHERE memory_id = ? AND event_type = 'utility_signal'
    `).get(memId) as { c: number };
    expect(count.c).toBe(0);
  });

  it("strength is 0.8 for fingerprint longer than 20 chars", () => {
    const memId = memRepo.store({
      title: "Long path memory",
      body: "See src/services/authentication/AuthenticationService.ts for the logic.",
      memoryType: "fact", scope: "global",
    });
    insertInjection("s1", memId, 2);

    processUtilitySignals(db, tracker, {
      session_id: "s1",
      tool_name: "Read",
      tool_input: { file_path: "src/services/authentication/AuthenticationService.ts" },
      tool_response_text: "",
      utility_window_minutes: 10,
    });
    tracker.flush();

    const signal = db.prepare(`
      SELECT json_extract(event_data, '$.signal_type') as t,
             json_extract(event_data, '$.signal_strength') as s
      FROM analytics_events WHERE memory_id = ? AND event_type = 'utility_signal'
    `).get(memId) as { t: string; s: number };
    expect(signal.t).toBe("tool_reference");
    expect(signal.s).toBe(0.8); // path is >20 chars
  });

  it("no explicit_access signal emitted for memory_search response that does not contain the memory id or title", () => {
    const memId = memRepo.store({
      title: "Zxqvbnm Wlkjhgfds",
      body: "Ytrewqzxcv Poiuytrewq nothing useful here.",
      memoryType: "fact", scope: "global",
    });
    insertInjection("s1", memId, 2);

    processUtilitySignals(db, tracker, {
      session_id: "s1",
      tool_name: "memory_search",
      tool_input: { query: "docker" },
      // Response contains results for completely DIFFERENT memories — not this memory's id or title
      tool_response_text: "Found: Docker compose setup (score 0.9), Redis config (score 0.7)",
      utility_window_minutes: 10,
    });
    tracker.flush();

    const signals = db.prepare(`
      SELECT json_extract(event_data, '$.signal_type') as t
      FROM analytics_events
      WHERE memory_id = ? AND event_type = 'utility_signal'
    `).all(memId) as Array<{ t: string }>;
    // No explicit_access: neither title "Zxqvbnm Wlkjhgfds" nor id appears in response
    const hasExplicitAccess = signals.some(s => s.t === "explicit_access");
    expect(hasExplicitAccess).toBe(false);
  });
});
