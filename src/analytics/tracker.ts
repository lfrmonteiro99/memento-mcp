// src/analytics/tracker.ts
import type Database from "better-sqlite3";

export type EventType =
  | "injection"
  | "utility_signal"
  | "auto_capture"
  | "auto_capture_skip"
  | "explicit_store"
  | "explicit_search"
  | "compression"
  | "budget_debit"
  | "budget_refill"
  | "search_layer_used";

export interface AnalyticsEvent {
  session_id: string;
  project_id?: string;
  memory_id?: string;
  event_type: EventType;
  event_data: string;
  tokens_cost?: number;
  created_at?: string;
}

export interface TrackerConfig {
  flushThreshold: number;
}

export class AnalyticsTracker {
  private buffer: AnalyticsEvent[] = [];

  constructor(
    private db: Database.Database,
    private config: TrackerConfig = { flushThreshold: 20 }
  ) {}

  track(event: Omit<AnalyticsEvent, "created_at">): void {
    this.buffer.push({
      ...event,
      created_at: new Date().toISOString(),
    });

    if (this.buffer.length >= this.config.flushThreshold) {
      this.flush();
    }
  }

  flush(): void {
    if (this.buffer.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT INTO analytics_events (session_id, project_id, memory_id, event_type, event_data, tokens_cost, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = this.db.transaction(() => {
      for (const event of this.buffer) {
        stmt.run(
          event.session_id,
          event.project_id ?? null,
          event.memory_id ?? null,
          event.event_type,
          event.event_data,
          event.tokens_cost ?? null,
          event.created_at,
        );
      }
    });

    tx();
    this.buffer = [];
  }

  get pendingCount(): number {
    return this.buffer.length;
  }
}

/**
 * R2 — Install flush-on-shutdown handlers for a tracker instance.
 *
 * Call this once per long-lived process (the MCP server). Short-lived hook
 * binaries should just call `tracker.flush()` explicitly before `process.exit`,
 * but they may ALSO install these handlers as defense-in-depth against SIGKILL.
 *
 * Returns a disposer that removes the handlers (used in tests and during
 * graceful shutdown chains).
 */
export function installFlushOnExit(tracker: AnalyticsTracker): () => void {
  const flushNow = () => {
    try { tracker.flush(); } catch { /* ignore; cannot recover at exit */ }
  };
  process.on("SIGINT", flushNow);
  process.on("SIGTERM", flushNow);
  process.on("beforeExit", flushNow);
  return () => {
    process.off("SIGINT", flushNow);
    process.off("SIGTERM", flushNow);
    process.off("beforeExit", flushNow);
  };
}
