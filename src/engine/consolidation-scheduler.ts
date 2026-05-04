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
  private readonly hostname = hostname();
  private readonly pid = process.pid;

  constructor(private db: Database.Database, private opts: SchedulerOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((e) => {
        // Never throw out of the timer — the scheduler keeps the server alive.
        logger.warn(`consolidation tick failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }, this.opts.intervalMs);
    // Don't keep the event loop alive solely for the scheduler.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
   * Wrapped in a transaction so the SELECT-then-INSERT is atomic.
   */
  private acquireLock(): number | null {
    return this.db.transaction(() => {
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
    })();
  }
}
