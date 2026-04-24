// tests/tools/memory-analytics.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handleMemoryAnalytics, resolveProjectId } from "../../src/tools/analytics-tools.js";
import { createDatabase } from "../../src/db/database.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("resolveProjectId (K4)", () => {
  let db: ReturnType<typeof createDatabase>;
  const dbPath = join(tmpdir(), `memento-resolve-proj-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    db.prepare("INSERT INTO projects (id, name, root_path) VALUES ('uuid-123', 'myproject', '/home/user/myproject')").run();
  });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("returns null for undefined path", () => {
    expect(resolveProjectId(db, undefined)).toBeNull();
  });

  it("returns null for empty string path", () => {
    expect(resolveProjectId(db, "")).toBeNull();
  });

  it("returns null for 'global' path", () => {
    expect(resolveProjectId(db, "global")).toBeNull();
  });

  it("returns null for unknown path", () => {
    expect(resolveProjectId(db, "/nonexistent/path")).toBeNull();
  });

  it("returns UUID for known path", () => {
    expect(resolveProjectId(db, "/home/user/myproject")).toBe("uuid-123");
  });
});

describe("handleMemoryAnalytics (G3, K4)", () => {
  let db: ReturnType<typeof createDatabase>;
  const dbPath = join(tmpdir(), `memento-analytics-handler-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    db.prepare("INSERT INTO projects (id, name, root_path) VALUES ('p1', 'testproject', '/myproject')").run();
  });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("G3: includes 'no analytics events' footer when DB is empty", async () => {
    const result = await handleMemoryAnalytics(db, { period: "all" });
    expect(result).toContain("no analytics events recorded yet");
  });

  it("G3: includes tracking start footer when events exist", async () => {
    db.prepare(`
      INSERT INTO analytics_events (session_id, project_id, event_type, event_data, tokens_cost, created_at)
      VALUES ('s1', 'p1', 'budget_debit', '{}', 100, datetime('now'))
    `).run();
    const result = await handleMemoryAnalytics(db, { period: "all" });
    expect(result).toContain("analytics tracking began");
  });

  it("returns error message for unknown project_path", async () => {
    const result = await handleMemoryAnalytics(db, { project_path: "/unknown/path" });
    expect(result).toContain("No project registered");
    expect(result).toContain("/unknown/path");
  });

  it("K4: aggregates all projects when project_path is not provided", async () => {
    db.prepare("INSERT INTO projects (id, name, root_path) VALUES ('p2', 'project2', '/project2')").run();
    db.prepare(`
      INSERT INTO analytics_events (session_id, project_id, event_type, event_data, tokens_cost, created_at)
      VALUES ('s1', 'p1', 'budget_debit', '{}', 50, datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO analytics_events (session_id, project_id, event_type, event_data, tokens_cost, created_at)
      VALUES ('s2', 'p2', 'budget_debit', '{}', 50, datetime('now'))
    `).run();
    const result = await handleMemoryAnalytics(db, { period: "all" });
    expect(result).toContain("global / all projects");
    expect(result).toContain("Sessions: 2");
    expect(result).toContain("Total tokens: 100");
  });

  it("K4: uses 'global' path as aggregate (no project filter)", async () => {
    const result = await handleMemoryAnalytics(db, { project_path: "global", period: "all" });
    expect(result).toContain("global / all projects");
    expect(result).not.toContain("No project registered");
  });

  it("filters by project when valid project_path is provided", async () => {
    db.prepare(`
      INSERT INTO analytics_events (session_id, project_id, event_type, event_data, tokens_cost, created_at)
      VALUES ('s1', 'p1', 'budget_debit', '{}', 75, datetime('now'))
    `).run();
    const result = await handleMemoryAnalytics(db, { project_path: "/myproject", period: "all" });
    expect(result).toContain("/myproject");
    expect(result).toContain("Sessions: 1");
    expect(result).toContain("Total tokens: 75");
  });

  it("uses last_7d period by default", async () => {
    const result = await handleMemoryAnalytics(db, {});
    expect(result).toContain("last_7d");
  });

  it("returns formatted report with all sections", async () => {
    db.prepare(`
      INSERT INTO analytics_events (session_id, project_id, event_type, event_data, tokens_cost, created_at)
      VALUES ('s1', 'p1', 'budget_debit', '{}', 200, datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO analytics_events (session_id, project_id, event_type, event_data, created_at)
      VALUES ('s1', 'p1', 'auto_capture', '{"tool":"Bash"}', datetime('now'))
    `).run();
    const result = await handleMemoryAnalytics(db, { period: "all" });
    expect(result).toContain("Sessions:");
    expect(result).toContain("Total tokens:");
    expect(result).toContain("Avg tokens/session:");
    expect(result).toContain("Auto-capture:");
    expect(result).toContain("Memories:");
  });
});
