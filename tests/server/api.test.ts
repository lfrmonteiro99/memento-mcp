// tests/server/api.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { startWebServer } from "../../src/server/web.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";

describe("web server API", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: MemoriesRepo;
  let server: Server;
  let baseUrl: string;
  const dbPath = join(tmpdir(), `memento-web-api-${Date.now()}-${Math.random()}.sqlite`);
  const projectRoot = "/tmp/web-api-test-project";

  beforeEach(async () => {
    db = createDatabase(dbPath);
    repo = new MemoriesRepo(db);

    repo.store({ title: "alpha test memory", body: "first body content", memoryType: "fact", scope: "project", projectPath: projectRoot, importance: 0.8 });
    repo.store({ title: "beta test memory", body: "second body content", memoryType: "decision", scope: "project", projectPath: projectRoot, pin: true });
    repo.store({ title: "gamma global memory", body: "third body content", memoryType: "preference", scope: "global" });

    db.prepare(`
      INSERT INTO decisions (id, project_id, title, body, category, importance_score, created_at)
      VALUES ('dec-1', (SELECT id FROM projects WHERE root_path = ?), 'use postgres', 'chose pg over mysql', 'tech', 0.7, datetime('now'))
    `).run(projectRoot);
    db.prepare(`
      INSERT INTO pitfalls (id, project_id, title, body, occurrence_count, importance_score, last_seen_at, created_at)
      VALUES ('pit-1', (SELECT id FROM projects WHERE root_path = ?), 'forgot to await', 'common async bug', 3, 0.6, datetime('now'), datetime('now'))
    `).run(projectRoot);
    db.prepare(`
      INSERT INTO sessions (id, budget, spent, floor, created_at, last_active)
      VALUES ('sess-1', 8000, 1200, 500, datetime('now'), datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO analytics_events (session_id, event_type, event_data, tokens_cost, created_at)
      VALUES ('sess-1', 'injection', '{"tool_response":"api_key=sk-secret-12345"}', 200, datetime('now'))
    `).run();

    server = startWebServer({ port: 0, host: "127.0.0.1", enableEdit: false, db, config: DEFAULT_CONFIG });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("GET /api/health returns ok and version", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
    expect(body.enableEdit).toBe(false);
  });

  it("GET / serves the HTML page", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain("memento-mcp inspector");
  });

  it("GET /api/projects returns projects with memory counts", async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    const proj = body.find((p: any) => p.root_path === projectRoot);
    expect(proj).toBeDefined();
    expect(proj.memory_count).toBeGreaterThanOrEqual(2);
  });

  it("GET /api/memories returns paginated list", async () => {
    const res = await fetch(`${baseUrl}/api/memories`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ offset: 0, limit: 50 });
    expect(body.items.length).toBeGreaterThanOrEqual(3);
    expect(body.total).toBeGreaterThanOrEqual(3);
  });

  it("GET /api/memories?q=alpha filters by FTS", async () => {
    const res = await fetch(`${baseUrl}/api/memories?q=alpha`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items.some((m: any) => m.title.includes("alpha"))).toBe(true);
  });

  it("GET /api/memories?type=decision filters by type", async () => {
    const res = await fetch(`${baseUrl}/api/memories?type=decision`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.every((m: any) => m.memory_type === "decision")).toBe(true);
  });

  it("GET /api/memories?pinned=1 filters pinned only", async () => {
    const res = await fetch(`${baseUrl}/api/memories?pinned=1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.every((m: any) => m.is_pinned === 1)).toBe(true);
  });

  it("GET /api/memories/:id returns full memory + neighbors", async () => {
    const list = await (await fetch(`${baseUrl}/api/memories`)).json();
    const id = list.items[0].id;
    const res = await fetch(`${baseUrl}/api/memories/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
    expect(typeof body.body).toBe("string");
    expect(Array.isArray(body.linked_decisions)).toBe(true);
    expect(Array.isArray(body.linked_pitfalls)).toBe(true);
    expect(Array.isArray(body.neighbors)).toBe(true);
  });

  it("GET /api/memories/:id with bad id returns 400", async () => {
    const res = await fetch(`${baseUrl}/api/memories/has spaces`);
    expect(res.status).toBe(400);
  });

  it("GET /api/memories/:id with unknown id returns 404", async () => {
    const res = await fetch(`${baseUrl}/api/memories/00000000-0000-0000-0000-000000000000`);
    expect(res.status).toBe(404);
  });

  it("GET /api/decisions returns decisions list", async () => {
    const res = await fetch(`${baseUrl}/api/decisions`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items[0]).toHaveProperty("category");
  });

  it("GET /api/pitfalls returns pitfalls list", async () => {
    const res = await fetch(`${baseUrl}/api/pitfalls`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items[0]).toHaveProperty("occurrence_count");
  });

  it("GET /api/sessions returns sessions list", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items[0]).toHaveProperty("budget");
    expect(body.items[0]).toHaveProperty("spent");
  });

  it("GET /api/analytics/summary returns counters", async () => {
    const res = await fetch(`${baseUrl}/api/analytics/summary?days=7`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.days).toBe(7);
  });

  it("GET /api/analytics/events scrubs secrets in event_data", async () => {
    const res = await fetch(`${baseUrl}/api/analytics/events`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    const inj = body.items.find((e: any) => e.event_type === "injection");
    expect(inj).toBeDefined();
    expect(inj.event_data).not.toContain("sk-secret-12345");
    expect(inj.event_data).toContain("[REDACTED]");
  });

  it("unknown API path returns 404 JSON", async () => {
    const res = await fetch(`${baseUrl}/api/does-not-exist`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});
