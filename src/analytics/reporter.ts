// src/analytics/reporter.ts
import type Database from "better-sqlite3";

export interface PruneRecommendation {
  memory_id: string;
  title: string;
  reason: string;
  action: "delete" | "archive";
  confidence: number;
}

export function getPruneRecommendations(db: Database.Database): PruneRecommendation[] {
  const recommendations: PruneRecommendation[] = [];

  // Memories injected 5+ times but never used (no non-ignored utility_signal)
  const neverUsed = db.prepare(`
    SELECT m.id, m.title, COUNT(ae.id) as injection_count
    FROM memories m
    JOIN analytics_events ae ON ae.memory_id = m.id AND ae.event_type = 'injection'
    LEFT JOIN analytics_events used ON used.memory_id = m.id AND used.event_type = 'utility_signal'
      AND json_extract(used.event_data, '$.signal_type') != 'ignored'
    WHERE m.deleted_at IS NULL AND m.is_pinned = 0
    GROUP BY m.id
    HAVING COUNT(ae.id) >= 5 AND COUNT(used.id) = 0
  `).all() as Array<{ id: string; title: string; injection_count: number }>;

  for (const mem of neverUsed) {
    recommendations.push({
      memory_id: mem.id,
      title: mem.title,
      reason: `Injected ${mem.injection_count} times, never used.`,
      action: "delete",
      confidence: 0.8,
    });
  }

  // Stale + low importance (not accessed in 60+ days, importance < 0.5)
  const stale = db.prepare(`
    SELECT id, title, importance_score, last_accessed_at
    FROM memories
    WHERE deleted_at IS NULL AND is_pinned = 0
      AND last_accessed_at < datetime('now', '-60 days')
      AND importance_score < 0.5
  `).all() as Array<{ id: string; title: string; importance_score: number; last_accessed_at: string }>;

  for (const mem of stale) {
    // Skip if already recommended for deletion
    if (!recommendations.some(r => r.memory_id === mem.id)) {
      recommendations.push({
        memory_id: mem.id,
        title: mem.title,
        reason: `Not accessed in 60+ days, low importance (${mem.importance_score}).`,
        action: "archive",
        confidence: 0.6,
      });
    }
  }

  return recommendations;
}

export interface AnalyticsReport {
  period: string;
  session_count: number;
  total_tokens_consumed: number;
  avg_tokens_per_session: number;
  auto_capture_stats: {
    total_captures: number;
    total_skips: number;
    capture_rate: number;
  };
  memory_stats: {
    total_active: number;
    total_deleted: number;
    by_type: Record<string, number>;
  };
  compression_stats: {
    total_runs: number;
    tokens_before: number;
    tokens_after: number;
    avg_ratio: number;
    tokens_saved: number;
  };
  search_layer_stats?: {
    total_searches: number;
    by_detail: Record<string, number>;
  };
}

export function periodToSqlClause(period: string): string {
  switch (period) {
    case "last_24h": return "AND created_at > datetime('now', '-24 hours')";
    case "last_7d": return "AND created_at > datetime('now', '-7 days')";
    case "last_30d": return "AND created_at > datetime('now', '-30 days')";
    case "all": return "";
    default: return "";
  }
}

// K4: projectId may be null to aggregate across all projects (no WHERE project_id filter).
export function generateReport(db: Database.Database, projectId: string | null, period: string): AnalyticsReport {
  const clause = periodToSqlClause(period);

  // Build the project-id filter fragment. For null we emit "1=1" (no filter); for a real id we bind it.
  const projSql = projectId === null ? "1=1" : "project_id = ?";
  const projBind: string[] = projectId === null ? [] : [projectId];

  const sessionStats = db.prepare(`
    SELECT
      COUNT(DISTINCT session_id) as session_count,
      COALESCE(SUM(CASE WHEN event_type = 'budget_debit' THEN tokens_cost ELSE 0 END), 0) as total_tokens
    FROM analytics_events
    WHERE ${projSql} ${clause}
  `).get(...projBind) as { session_count: number; total_tokens: number };

  const captureStats = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN event_type = 'auto_capture' THEN 1 ELSE 0 END), 0) as captures,
      COALESCE(SUM(CASE WHEN event_type = 'auto_capture_skip' THEN 1 ELSE 0 END), 0) as skips
    FROM analytics_events
    WHERE ${projSql} ${clause}
  `).get(...projBind) as { captures: number; skips: number };

  const memStats = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END), 0) as active,
      COALESCE(SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END), 0) as deleted
    FROM memories
    WHERE ${projSql}
  `).get(...projBind) as { active: number; deleted: number };

  const typeRows = db.prepare(`
    SELECT memory_type, COUNT(*) as cnt FROM memories
    WHERE ${projSql} AND deleted_at IS NULL
    GROUP BY memory_type
  `).all(...projBind) as Array<{ memory_type: string; cnt: number }>;

  const byType: Record<string, number> = {};
  for (const r of typeRows) byType[r.memory_type] = r.cnt;

  const totalCaptures = captureStats.captures + captureStats.skips;

  // Compression stats: compression_log has no project_id column, so we join to memories
  // to filter by project. Period clause applies to compression_log.created_at.
  const compressionClause = clause.replace(/created_at/g, "cl.created_at");
  const compressionStats = db
    .prepare(
      projectId === null
        ? `
          SELECT
            COUNT(*) as runs,
            COALESCE(SUM(cl.tokens_before), 0) as tokens_before,
            COALESCE(SUM(cl.tokens_after), 0) as tokens_after,
            COALESCE(AVG(cl.compression_ratio), 0) as avg_ratio
          FROM compression_log cl
          WHERE 1=1 ${compressionClause}
        `
        : `
          SELECT
            COUNT(*) as runs,
            COALESCE(SUM(cl.tokens_before), 0) as tokens_before,
            COALESCE(SUM(cl.tokens_after), 0) as tokens_after,
            COALESCE(AVG(cl.compression_ratio), 0) as avg_ratio
          FROM compression_log cl
          JOIN memories m ON m.id = cl.compressed_memory_id
          WHERE m.project_id = ? ${compressionClause}
        `,
    )
    .get(...projBind) as {
    runs: number;
    tokens_before: number;
    tokens_after: number;
    avg_ratio: number;
  };

  // Search layer stats
  const searchLayerRows = db.prepare(`
    SELECT
      json_extract(event_data, '$.detail') as detail,
      COUNT(*) as count
    FROM analytics_events
    WHERE ${projSql} AND event_type = 'search_layer_used' ${clause}
    GROUP BY detail
  `).all(...projBind) as Array<{ detail: string; count: number }>;

  const searchLayerByDetail: Record<string, number> = {};
  let totalSearches = 0;
  for (const r of searchLayerRows) {
    if (r.detail) {
      searchLayerByDetail[r.detail] = r.count;
      totalSearches += r.count;
    }
  }

  return {
    period,
    session_count: sessionStats.session_count,
    total_tokens_consumed: sessionStats.total_tokens,
    avg_tokens_per_session: sessionStats.session_count > 0
      ? Math.round(sessionStats.total_tokens / sessionStats.session_count) : 0,
    auto_capture_stats: {
      total_captures: captureStats.captures,
      total_skips: captureStats.skips,
      capture_rate: totalCaptures > 0 ? captureStats.captures / totalCaptures : 0,
    },
    memory_stats: {
      total_active: memStats.active,
      total_deleted: memStats.deleted,
      by_type: byType,
    },
    compression_stats: {
      total_runs: compressionStats.runs,
      tokens_before: compressionStats.tokens_before,
      tokens_after: compressionStats.tokens_after,
      avg_ratio: compressionStats.avg_ratio,
      tokens_saved: Math.max(0, compressionStats.tokens_before - compressionStats.tokens_after),
    },
    search_layer_stats: totalSearches > 0 ? {
      total_searches: totalSearches,
      by_detail: searchLayerByDetail,
    } : undefined,
  };
}
