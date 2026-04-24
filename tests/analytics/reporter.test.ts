// tests/analytics/reporter.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateReport, periodToSqlClause } from "../../src/analytics/reporter.js";
import { createDatabase } from "../../src/db/database.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("periodToSqlClause", () => {
  it("returns 24h clause", () => {
    expect(periodToSqlClause("last_24h")).toContain("-24 hours");
  });
  it("returns 7d clause", () => {
    expect(periodToSqlClause("last_7d")).toContain("-7 days");
  });
  it("returns 30d clause", () => {
    expect(periodToSqlClause("last_30d")).toContain("-30 days");
  });
  it("returns empty for 'all'", () => {
    expect(periodToSqlClause("all")).toBe("");
  });
});

describe("generateReport", () => {
  let db: ReturnType<typeof createDatabase>;
  const dbPath = join(tmpdir(), `memento-reporter-test-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    // Seed some analytics data
    db.prepare("INSERT INTO projects (id, name, root_path) VALUES ('p1', 'test', '/test')").run();

    // Seed events
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO analytics_events (session_id, project_id, event_type, event_data, tokens_cost, created_at)
        VALUES (?, 'p1', 'budget_debit', '{}', ?, datetime('now'))
      `).run(`s${i}`, 100 + i * 10);
    }

    db.prepare(`
      INSERT INTO analytics_events (session_id, project_id, event_type, event_data, created_at)
      VALUES ('s1', 'p1', 'auto_capture', '{"tool":"Bash"}', datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO analytics_events (session_id, project_id, event_type, event_data, created_at)
      VALUES ('s1', 'p1', 'auto_capture_skip', '{"tool":"Read"}', datetime('now'))
    `).run();
  });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("returns report with session count", () => {
    const report = generateReport(db, "p1", "all");
    expect(report.session_count).toBeGreaterThan(0);
  });

  it("returns report with total tokens consumed", () => {
    const report = generateReport(db, "p1", "all");
    expect(report.total_tokens_consumed).toBeGreaterThan(0);
  });

  it("returns report with auto_capture stats", () => {
    const report = generateReport(db, "p1", "all");
    expect(report.auto_capture_stats.total_captures).toBe(1);
    expect(report.auto_capture_stats.total_skips).toBe(1);
  });

  it("returns report with period label", () => {
    const report = generateReport(db, "p1", "last_7d");
    expect(report.period).toBe("last_7d");
  });

  it("calculates avg tokens per session", () => {
    const report = generateReport(db, "p1", "all");
    expect(report.avg_tokens_per_session).toBeGreaterThan(0);
  });

  it("handles empty analytics gracefully", () => {
    const freshDbPath = join(tmpdir(), `memento-reporter-empty-${process.pid}-${randomUUID()}.sqlite`);
    const freshDb = createDatabase(freshDbPath);
    freshDb.prepare("INSERT INTO projects (id, name, root_path) VALUES ('p1', 'test', '/test')").run();
    const report = generateReport(freshDb, "p1", "all");
    expect(report.session_count).toBe(0);
    expect(report.total_tokens_consumed).toBe(0);
    freshDb.close();
    rmSync(freshDbPath, { force: true });
  });

  it("K4: generateReport with null projectId aggregates across all projects", () => {
    // Use a fresh DB so we can seed two projects cleanly.
    const multiDbPath = join(tmpdir(), `memento-reporter-multi-${process.pid}-${randomUUID()}.sqlite`);
    const multiDb = createDatabase(multiDbPath);
    multiDb.prepare("INSERT INTO projects (id, name, root_path) VALUES ('pA','A','/a')").run();
    multiDb.prepare("INSERT INTO projects (id, name, root_path) VALUES ('pB','B','/b')").run();
    for (const p of ["pA", "pB"]) {
      multiDb.prepare(`
        INSERT INTO analytics_events (session_id, project_id, event_type, event_data, tokens_cost, created_at)
        VALUES (?, ?, 'budget_debit', '{}', 100, datetime('now'))
      `).run(`s-${p}`, p);
    }
    const report = generateReport(multiDb, null, "all"); // null = no project filter
    expect(report.session_count).toBe(2); // one session per project
    expect(report.total_tokens_consumed).toBe(200);
    multiDb.close();
    rmSync(multiDbPath, { force: true });
  });

  it("R9: handles malformed event_data JSON without crashing", () => {
    db.prepare(`
      INSERT INTO analytics_events (session_id, project_id, event_type, event_data, created_at)
      VALUES ('s1', 'p1', 'utility_signal', 'not-json', datetime('now'))
    `).run();
    // json_extract on non-JSON returns NULL. Report should still generate (no throw).
    const report = generateReport(db, "p1", "all");
    expect(report).toBeDefined();
  });

  it("R9: handles null signal_strength in event_data", () => {
    db.prepare(`
      INSERT INTO analytics_events (session_id, project_id, event_type, event_data, created_at)
      VALUES ('s1', 'p1', 'utility_signal', ?, datetime('now'))
    `).run(JSON.stringify({ signal_type: "tool_reference" /* no signal_strength */ }));
    const report = generateReport(db, "p1", "all");
    expect(report).toBeDefined(); // should not crash
  });

  it("reports compression_stats with totals and avg ratio", () => {
    // Insert a compressed memory + matching compression_log rows
    db.prepare(`
      INSERT INTO memories (id, project_id, memory_type, scope, title, body, source, created_at, updated_at)
      VALUES ('c1', 'p1', 'fact', 'project', 'compressed mem', 'body', 'compression', datetime('now'), datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO compression_log (compressed_memory_id, source_memory_ids, tokens_before, tokens_after, compression_ratio, created_at)
      VALUES ('c1', '["a","b"]', 200, 80, 0.4, datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO compression_log (compressed_memory_id, source_memory_ids, tokens_before, tokens_after, compression_ratio, created_at)
      VALUES ('c1', '["c","d"]', 100, 50, 0.5, datetime('now'))
    `).run();

    const report = generateReport(db, "p1", "all");
    expect(report.compression_stats.total_runs).toBe(2);
    expect(report.compression_stats.tokens_before).toBe(300);
    expect(report.compression_stats.tokens_after).toBe(130);
    expect(report.compression_stats.tokens_saved).toBe(170);
    expect(report.compression_stats.avg_ratio).toBeCloseTo(0.45, 2);
  });

  it("compression_stats aggregates across all projects when projectId=null", () => {
    db.prepare("INSERT INTO projects (id, name, root_path) VALUES ('p2', 'other', '/other')").run();
    db.prepare(`
      INSERT INTO memories (id, project_id, memory_type, scope, title, body, source, created_at, updated_at)
      VALUES ('c2', 'p2', 'fact', 'project', 'c2', 'body', 'compression', datetime('now'), datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO compression_log (compressed_memory_id, source_memory_ids, tokens_before, tokens_after, compression_ratio, created_at)
      VALUES ('c2', '["x"]', 50, 20, 0.4, datetime('now'))
    `).run();

    const report = generateReport(db, null, "all");
    expect(report.compression_stats.total_runs).toBeGreaterThanOrEqual(1);
  });
});
