// src/tools/analytics-tools.ts
import type Database from "better-sqlite3";
import { generateReport } from "../analytics/reporter.js";

/**
 * K4 — Resolve a project_path string to a project_id (UUID) without creating the row.
 * Returns null if the project does not exist. The reporter treats a null id as
 * "no project filter" (aggregate across all projects) — see generateReport(db, null, ...).
 *
 * We deliberately DO NOT create the project here. memory_analytics should never
 * have the side-effect of creating projects — only read existing ones.
 */
export function resolveProjectId(db: Database.Database, path: string | undefined): string | null {
  if (!path || path === "global" || path === "") return null;
  const row = db.prepare("SELECT id FROM projects WHERE root_path = ?").get(path) as
    | { id: string } | undefined;
  return row?.id ?? null;
}

export async function handleMemoryAnalytics(
  db: Database.Database,
  params: { period?: string; section?: string; project_path?: string }
): Promise<string> {
  const period = params.period || "last_7d";

  // K4: resolve path → UUID. null means "no project filter".
  // "global" or empty string → aggregate across all projects.
  const projectId = resolveProjectId(db, params.project_path);

  // If the user passed a project_path that doesn't exist, tell them explicitly.
  if (params.project_path && params.project_path !== "global" && projectId === null) {
    return `No project registered for path "${params.project_path}". Memories must be stored against this path before analytics are available.`;
  }

  const report = generateReport(db, projectId, period);
  const section = params.section ?? "all";

  const lines: string[] = [
    `=== Memory Analytics (${report.period}${projectId ? " for project " + params.project_path : " (global / all projects)"}) ===`,
  ];

  if (section === "all" || section === "injections") {
    lines.push(
      `Sessions: ${report.session_count}`,
      `Total tokens: ${report.total_tokens_consumed}`,
      `Avg tokens/session: ${report.avg_tokens_per_session}`,
      "",
    );
  }

  if (section === "all" || section === "captures") {
    lines.push(
      `Auto-capture: ${report.auto_capture_stats.total_captures} captured, ${report.auto_capture_stats.total_skips} skipped`,
      `Capture rate: ${(report.auto_capture_stats.capture_rate * 100).toFixed(1)}%`,
      "",
    );
  }

  if (section === "all" || section === "compression") {
    const c = report.compression_stats;
    const savedPct = c.tokens_before > 0 ? (c.tokens_saved / c.tokens_before * 100).toFixed(1) : "0.0";
    lines.push(
      `Compression: ${c.total_runs} run(s), ${c.tokens_before}→${c.tokens_after} tokens (saved ${c.tokens_saved}, ${savedPct}%)`,
      `Avg ratio: ${c.avg_ratio.toFixed(2)}`,
      "",
    );
  }

  if (section === "all" || section === "memories") {
    lines.push(
      `Memories: ${report.memory_stats.total_active} active, ${report.memory_stats.total_deleted} deleted`,
    );
    if (Object.keys(report.memory_stats.by_type).length > 0) {
      lines.push("By type: " + Object.entries(report.memory_stats.by_type).map(([t, c]) => `${t}:${c}`).join(", "));
    }
    if (report.dedup_stats) {
      const d = report.dedup_stats;
      lines.push(
        `Dedup: ${d.blocked} blocked, ${d.warned} warned, ${d.passed} passed (${report.period})`
      );
    }
  }

  // G3: explanatory footer when the period predates the v2 install (i.e., no analytics events yet).
  const firstEventRow = db.prepare(
    "SELECT MIN(created_at) as first FROM analytics_events"
  ).get() as { first: string | null };
  if (!firstEventRow.first) {
    lines.push("");
    lines.push("Note: no analytics events recorded yet. This is expected immediately after v2 upgrade; data will accumulate over the next few sessions.");
  } else {
    lines.push("");
    lines.push(`Note: analytics tracking began ${firstEventRow.first}. Memories created before that appear with neutral (0.5) utility scores until they accumulate injection+use data.`);
  }

  return lines.join("\n");
}
