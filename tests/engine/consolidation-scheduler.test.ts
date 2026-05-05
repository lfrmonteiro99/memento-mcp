import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { ConsolidationScheduler } from "../../src/engine/consolidation-scheduler.js";
import { setClock, resetClock } from "../../src/lib/decay.js";

describe("ConsolidationScheduler (P3 Task 4)", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let projectId: string;
  const dbPath = join(tmpdir(), `memento-cons-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    projectId = memRepo.ensureProject("/tmp/cons-proj");

    // Seed cluster of stale (60-day-old) memories so a tick has work to do.
    setClock(() => new Date("2026-05-04T12:00:00Z").getTime());
    for (let i = 0; i < 4; i++) {
      memRepo.store({
        title: `Edit: payments.ts step ${i}`,
        body: `Refactored payments.ts handler ${i} for retry semantics`,
        memoryType: "fact",
        scope: "project",
        projectId,
        tags: ["edit", "payments"],
      });
    }
    // Backdate both created_at AND last_accessed_at so the decay gate
    // (which prefers last_accessed_at when present) drops below the 0.6 floor.
    db.prepare(
      `UPDATE memories
       SET created_at = '2026-03-04T12:00:00Z',
           last_accessed_at = '2026-03-04T12:00:00Z'
       WHERE project_id = ?`,
    ).run(projectId);
  });

  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
    resetClock();
  });

  it("runOnce writes a 'finished' consolidation_runs row with non-zero counts", async () => {
    const scheduler = new ConsolidationScheduler(db, { intervalMs: 60_000, decayFloor: 0.6 });
    await scheduler.runOnce();

    const runs = db.prepare(
      "SELECT * FROM consolidation_runs ORDER BY id DESC",
    ).all() as Array<{ status: string; merged_count: number; clusters_seen: number }>;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("finished");
    expect(runs[0].clusters_seen).toBeGreaterThanOrEqual(1);
    expect(runs[0].merged_count).toBeGreaterThanOrEqual(1);
  });

  it("leader-election: second concurrent runOnce becomes a no-op when first is still running", async () => {
    const a = new ConsolidationScheduler(db, { intervalMs: 60_000, decayFloor: 0.6 });
    const b = new ConsolidationScheduler(db, { intervalMs: 60_000, decayFloor: 0.6 });

    // Manually plant a recent 'running' row to simulate first instance still in flight.
    db.prepare(
      `INSERT INTO consolidation_runs(started_at, status, hostname, pid)
       VALUES (datetime('now'), 'running', 'host-a', 1)`,
    ).run();

    await b.runOnce();

    // The pre-planted run is still 'running'; b should NOT have inserted a second 'running' row.
    const running = db.prepare(
      "SELECT COUNT(*) AS n FROM consolidation_runs WHERE status = 'running'",
    ).get() as { n: number };
    expect(running.n).toBe(1);
    void a; // suppress unused warning
  });

  it("stale lock (>5 minutes old) is bypassed", async () => {
    // Plant a 'running' row that's older than the staleness window.
    db.prepare(
      `INSERT INTO consolidation_runs(started_at, status, hostname, pid)
       VALUES (datetime('now', '-10 minutes'), 'running', 'host-dead', 999)`,
    ).run();

    const scheduler = new ConsolidationScheduler(db, { intervalMs: 60_000, decayFloor: 0.6 });
    await scheduler.runOnce();

    const finished = db.prepare(
      "SELECT COUNT(*) AS n FROM consolidation_runs WHERE status = 'finished'",
    ).get() as { n: number };
    expect(finished.n).toBeGreaterThanOrEqual(1);
  });

  it("acquireLock writes through a second DB handle (BEGIN IMMEDIATE doesn't break cross-handle reads)", async () => {
    // Genuine multi-process serialisation cannot be reproduced inside one Node
    // process (better-sqlite3 is synchronous; JS is single-threaded). What we
    // CAN verify: a fresh 'running' row written via handle A is immediately
    // visible to handle B's SELECT, so handle B's acquireLock no-ops correctly.
    // This is the dependency that BEGIN IMMEDIATE must preserve.
    const db2 = createDatabase(dbPath);
    db2.pragma("busy_timeout = 30000");

    try {
      const a = new ConsolidationScheduler(db, { intervalMs: 60_000, decayFloor: 0.6 });
      const b = new ConsolidationScheduler(db2, { intervalMs: 60_000, decayFloor: 0.6 });

      // a runs first and inserts a 'finished' row (releases the lock).
      await a.runOnce();
      // Manually re-plant a fresh 'running' row through handle A …
      db.prepare(
        `INSERT INTO consolidation_runs(started_at, status, hostname, pid)
         VALUES (datetime('now'), 'running', 'host-a', 1)`,
      ).run();
      // … and verify handle B sees it and skips its tick.
      await b.runOnce();

      const running = db2.prepare(
        "SELECT COUNT(*) AS n FROM consolidation_runs WHERE status = 'running'",
      ).get() as { n: number };
      expect(running.n).toBe(1); // the planted row is the only 'running'
    } finally {
      db2.close();
    }
  });

  it("start() sweeps orphaned 'running' rows older than the staleness window to 'failed'", async () => {
    // Plant a 6-minute-old 'running' row simulating a crashed previous run.
    db.prepare(
      `INSERT INTO consolidation_runs(started_at, status, hostname, pid)
       VALUES (datetime('now', '-6 minutes'), 'running', 'host-dead', 999)`,
    ).run();

    const sched = new ConsolidationScheduler(db, { intervalMs: 60_000_000, decayFloor: 0.6 });
    sched.start();
    try {
      const failedRow = db.prepare(
        "SELECT status FROM consolidation_runs WHERE hostname = 'host-dead'",
      ).get() as { status: string };
      expect(failedRow.status).toBe("failed");
    } finally {
      await sched.stop();
    }
  });

  it("stop() awaits in-flight runOnce so the DB isn't closed underneath it", async () => {
    const sched = new ConsolidationScheduler(db, { intervalMs: 50, decayFloor: 0.6 });
    sched.start();
    // Let the first tick fire.
    await new Promise(r => setTimeout(r, 80));
    await sched.stop(); // resolves only after the in-flight tick (if any)
    // After stop returns, no 'running' rows should be left behind.
    const running = db.prepare(
      "SELECT COUNT(*) AS n FROM consolidation_runs WHERE status = 'running'",
    ).get() as { n: number };
    expect(running.n).toBe(0);
  });

  it("on tick failure, run is marked 'failed' instead of left 'running'", async () => {
    const scheduler = new ConsolidationScheduler(db, { intervalMs: 60_000, decayFloor: 0.6 });
    // Disable FK enforcement so we can drop projects without cascading. The
    // inner SELECT then fails with "no such table: projects".
    db.pragma("foreign_keys = OFF");
    db.exec("DROP TABLE projects");

    await expect(scheduler.runOnce()).rejects.toBeDefined();

    const failed = db.prepare(
      "SELECT status FROM consolidation_runs ORDER BY id DESC LIMIT 1",
    ).get() as { status: string } | undefined;
    expect(failed?.status).toBe("failed");
  });
});
