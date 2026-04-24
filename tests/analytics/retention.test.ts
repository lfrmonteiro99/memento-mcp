// tests/analytics/retention.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanupExpiredAnalytics } from "../../src/analytics/retention.js";
import { createDatabase } from "../../src/db/database.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("cleanupExpiredAnalytics (R3)", () => {
  let db: ReturnType<typeof createDatabase>;
  const dbPath = join(tmpdir(), `memento-retention-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => { db = createDatabase(dbPath); });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("deletes rows older than retention_days", () => {
    // Seed: 3 old rows, 2 recent rows
    for (let i = 0; i < 3; i++) {
      db.prepare(`
        INSERT INTO analytics_events (session_id, event_type, event_data, created_at)
        VALUES (?, 'injection', '{}', datetime('now', '-100 days'))
      `).run(`old-${i}`);
    }
    for (let i = 0; i < 2; i++) {
      db.prepare(`
        INSERT INTO analytics_events (session_id, event_type, event_data, created_at)
        VALUES (?, 'injection', '{}', datetime('now'))
      `).run(`new-${i}`);
    }

    const deleted = cleanupExpiredAnalytics(db, 90);
    expect(deleted).toBe(3);

    const remaining = db.prepare("SELECT COUNT(*) as c FROM analytics_events").get() as any;
    expect(remaining.c).toBe(2);
  });

  it("returns 0 when nothing to delete", () => {
    db.prepare(`
      INSERT INTO analytics_events (session_id, event_type, event_data, created_at)
      VALUES ('s1', 'injection', '{}', datetime('now'))
    `).run();
    expect(cleanupExpiredAnalytics(db, 90)).toBe(0);
  });

  it("handles retention_days of 0 (delete everything older than now)", () => {
    db.prepare(`
      INSERT INTO analytics_events (session_id, event_type, event_data, created_at)
      VALUES ('s1', 'injection', '{}', datetime('now', '-1 hour'))
    `).run();
    // With retention_days = 0, the threshold is 'now' — rows older than now are deleted.
    const deleted = cleanupExpiredAnalytics(db, 0);
    expect(deleted).toBeGreaterThanOrEqual(1);
  });
});
