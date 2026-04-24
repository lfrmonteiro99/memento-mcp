// src/analytics/retention.ts
import type Database from "better-sqlite3";

/**
 * R3 — Delete analytics_events rows older than `retentionDays`. Called from the
 * MCP server's pruning interval (src/index.ts). Returns the number of deleted rows.
 */
export function cleanupExpiredAnalytics(db: Database.Database, retentionDays: number): number {
  const result = db.prepare(
    `DELETE FROM analytics_events WHERE created_at < datetime('now', '-' || ? || ' days')`
  ).run(retentionDays);
  return result.changes;
}
