// tests/analytics/tracker.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AnalyticsTracker, EventType, installFlushOnExit } from "../../src/analytics/tracker.js";
import { createDatabase } from "../../src/db/database.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("AnalyticsTracker", () => {
  let db: ReturnType<typeof createDatabase>;
  let tracker: AnalyticsTracker;
  const dbPath = join(tmpdir(), `memento-analytics-test-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    tracker = new AnalyticsTracker(db, { flushThreshold: 5 });
  });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("tracks an event without immediate flush", () => {
    tracker.track({ session_id: "s1", event_type: "injection", event_data: "{}" });
    const count = db.prepare("SELECT COUNT(*) as c FROM analytics_events").get() as any;
    expect(count.c).toBe(0); // not flushed yet
  });

  it("flushes when threshold is reached", () => {
    for (let i = 0; i < 5; i++) {
      tracker.track({ session_id: "s1", event_type: "injection", event_data: `{"i":${i}}` });
    }
    const count = db.prepare("SELECT COUNT(*) as c FROM analytics_events").get() as any;
    expect(count.c).toBe(5);
  });

  it("manual flush writes buffered events", () => {
    tracker.track({ session_id: "s1", event_type: "auto_capture", event_data: "{}" });
    tracker.track({ session_id: "s1", event_type: "injection", event_data: "{}" });
    tracker.flush();
    const count = db.prepare("SELECT COUNT(*) as c FROM analytics_events").get() as any;
    expect(count.c).toBe(2);
  });

  it("flush is idempotent (no double-write)", () => {
    tracker.track({ session_id: "s1", event_type: "injection", event_data: "{}" });
    tracker.flush();
    tracker.flush();
    const count = db.prepare("SELECT COUNT(*) as c FROM analytics_events").get() as any;
    expect(count.c).toBe(1);
  });

  it("preserves all event fields", () => {
    tracker.track({
      session_id: "s1", project_id: "p1", memory_id: "m1",
      event_type: "injection",
      event_data: '{"score":0.85}', tokens_cost: 50,
    });
    tracker.flush();
    const row = db.prepare("SELECT * FROM analytics_events LIMIT 1").get() as any;
    expect(row.session_id).toBe("s1");
    expect(row.project_id).toBe("p1");
    expect(row.memory_id).toBe("m1");
    expect(row.event_type).toBe("injection");
    expect(row.event_data).toBe('{"score":0.85}');
    expect(row.tokens_cost).toBe(50);
  });

  it("tracks multiple event types", () => {
    const types: EventType[] = ["injection", "utility_signal", "auto_capture", "explicit_store", "compression"];
    for (const t of types) {
      tracker.track({ session_id: "s1", event_type: t, event_data: "{}" });
    }
    tracker.flush();
    const count = db.prepare("SELECT COUNT(*) as c FROM analytics_events").get() as any;
    expect(count.c).toBe(5);
  });
});

describe("installFlushOnExit (R2)", () => {
  let db: ReturnType<typeof createDatabase>;
  const dbPath = join(tmpdir(), `memento-analytics-r2-test-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
  });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("returns a disposer that removes all signal handlers", () => {
    const t = new AnalyticsTracker(db, { flushThreshold: 100 });
    // We can't realistically send signals in a unit test, but we CAN assert the
    // listeners are added and removed correctly.
    const before = process.listenerCount("SIGINT");
    const dispose = installFlushOnExit(t);
    const added = process.listenerCount("SIGINT");
    expect(added).toBeGreaterThan(0);
    dispose();
    expect(process.listenerCount("SIGINT")).toBe(before); // baseline restored
  });

  it("flushes buffered events on beforeExit emulation", () => {
    const t = new AnalyticsTracker(db, { flushThreshold: 100 });
    installFlushOnExit(t);
    t.track({ session_id: "s1", event_type: "injection", event_data: "{}" });
    process.emit("beforeExit", 0 as any);
    const count = db.prepare("SELECT COUNT(*) as c FROM analytics_events").get() as any;
    expect(count.c).toBe(1);
  });
});
