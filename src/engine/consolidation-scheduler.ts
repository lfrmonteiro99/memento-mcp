// src/engine/consolidation-scheduler.ts
// P3 Task 4: cron-ish background loop that consolidates stale memory clusters.
// Reuses runCompressionCycle() with a decay_floor gate so still-being-iterated
// rows are excluded. Leader election uses the consolidation_runs audit table
// (5-minute staleness window) so multiple processes don't trample each other.

import type Database from "better-sqlite3";
import { hostname } from "node:os";
import { runCompressionCycle, DEFAULT_COMPRESSION_CONFIG } from "./compressor.js";
import { createLogger, logLevelFromEnv } from "../lib/logger.js";

const logger = createLogger(logLevelFromEnv());

export interface SchedulerOptions {
  intervalMs: number;
  decayFloor: number;
}

export class ConsolidationScheduler {
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  private readonly hostname = hostname();
  private readonly pid = process.pid;

  constructor(private db: Database.Database, private opts: SchedulerOptions) {}

  start(): void {
    if (this.timer) return;
    // Boot recovery: any 'running' row left dangling from a previous crashed
    // run keeps future leaders blocked until the 5-minute staleness window
    // elapses. Sweep them on start so the scheduler isn't paralysed by the
    // ghost of a dead process.
    this.recoverOrphanedRuns();

    this.timer = setInterval(() => {
      // Belt-and-braces: skip if a previous tick is still running.
      if (this.inflight) return;
      this.inflight = this.runOnce()
        .catch((e) => {
          logger.warn(`consolidation tick failed: ${e instanceof Error ? e.message : String(e)}`);
        })
        .finally(() => { this.inflight = null; });
    }, this.opts.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** Stop the timer AND wait for any in-flight tick to finish so callers can
   * safely close the DB right after. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.inflight) {
      try { await this.inflight; } catch { /* already logged in start() */ }
    }
  }

  private recoverOrphanedRuns(): void {
    try {
      const result = this.db.prepare(
        `UPDATE consolidation_runs
         SET status = 'failed', finished_at = datetime('now')
         WHERE status = 'running' AND started_at <= datetime('now', '-5 minutes')`,
      ).run();
      if (result.changes > 0) {
        logger.info(`consolidation: marked ${result.changes} orphaned run(s) as failed on boot`);
      }
    } catch (e) {
      logger.warn(`consolidation: orphan recovery failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** One-shot tick. Public for CLI `consolidate --now` and tests. */
  async runOnce(): Promise<void> {
    const runId = this.acquireLock();
    if (runId === null) {
      logger.debug("consolidation: another run is in progress, skipping tick");
      return;
    }

    try {
      const projects = this.db.prepare("SELECT id FROM projects").all() as Array<{ id: string }>;
      let totalSeen = 0;
      let totalMerged = 0;
      let totalPruned = 0;
      for (const p of projects) {
        const summary = runCompressionCycle(this.db, p.id, {
          ...DEFAULT_COMPRESSION_CONFIG,
          decay_floor: this.opts.decayFloor,
        });
        totalSeen += summary.compressed.length + summary.pruned.clusterCount;
        totalMerged += summary.compressed.length;
        totalPruned += summary.pruned.memoryCount;
      }
      this.db.prepare(
        `UPDATE consolidation_runs
         SET finished_at = datetime('now'),
             status = 'finished',
             clusters_seen = ?,
             merged_count = ?,
             pruned_count = ?
         WHERE id = ?`,
      ).run(totalSeen, totalMerged, totalPruned, runId);
    } catch (e) {
      this.db.prepare(
        `UPDATE consolidation_runs
         SET finished_at = datetime('now'), status = 'failed'
         WHERE id = ?`,
      ).run(runId);
      throw e;
    }
  }

  /**
   * Insert a 'running' row only if no other run is 'running' within the last
   * 5 minutes. Returns the new row id, or null if a fresh lock exists.
   *
   * Uses BEGIN IMMEDIATE (.immediate()) so the SELECT-then-INSERT serialises
   * across processes. With plain BEGIN DEFERRED (the default), two processes
   * could both pass the SELECT on a stale snapshot and both INSERT, ending up
   * with two concurrent 'running' rows. IMMEDIATE acquires RESERVED up-front;
   * the second writer blocks (within busy_timeout) until the first commits and
   * then sees the fresh row.
   */
  private acquireLock(): number | null {
    const tx = this.db.transaction(() => {
      const fresh = this.db.prepare(
        `SELECT id FROM consolidation_runs
         WHERE status = 'running' AND started_at > datetime('now', '-5 minutes')
         LIMIT 1`,
      ).get() as { id: number } | undefined;
      if (fresh) return null;

      const result = this.db.prepare(
        `INSERT INTO consolidation_runs(project_id, started_at, status, hostname, pid)
         VALUES (NULL, datetime('now'), 'running', ?, ?)`,
      ).run(this.hostname, this.pid);
      return Number(result.lastInsertRowid);
    });
    return tx.immediate();
  }
}
