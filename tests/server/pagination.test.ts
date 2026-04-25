// tests/server/pagination.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { startWebServer } from "../../src/server/web.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";

describe("web server pagination", () => {
  let db: ReturnType<typeof createDatabase>;
  let server: Server;
  let baseUrl: string;
  const dbPath = join(tmpdir(), `memento-web-pag-${Date.now()}-${Math.random()}.sqlite`);

  beforeEach(async () => {
    db = createDatabase(dbPath);
    const repo = new MemoriesRepo(db);
    for (let i = 0; i < 75; i++) {
      repo.store({ title: `mem ${String(i).padStart(3, "0")}`, body: `body ${i}`, scope: "global" });
    }
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

  it("default limit is 50", async () => {
    const res = await fetch(`${baseUrl}/api/memories`);
    const body = await res.json();
    expect(body.limit).toBe(50);
    expect(body.items.length).toBe(50);
    expect(body.total).toBe(75);
  });

  it("offset moves the page", async () => {
    const r1 = await (await fetch(`${baseUrl}/api/memories?limit=20&offset=0`)).json();
    const r2 = await (await fetch(`${baseUrl}/api/memories?limit=20&offset=20`)).json();
    expect(r1.items.length).toBe(20);
    expect(r2.items.length).toBe(20);
    expect(r1.items[0].id).not.toBe(r2.items[0].id);
  });

  it("limit cap is 200", async () => {
    const res = await fetch(`${baseUrl}/api/memories?limit=10000`);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(200);
  });

  it("total matches total memories", async () => {
    const res = await fetch(`${baseUrl}/api/memories?limit=1`);
    const body = await res.json();
    expect(body.total).toBe(75);
  });

  it("offset past end returns empty items but valid total", async () => {
    const res = await fetch(`${baseUrl}/api/memories?limit=20&offset=100`);
    const body = await res.json();
    expect(body.items.length).toBe(0);
    expect(body.total).toBe(75);
  });

  it("decisions endpoint also paginates", async () => {
    const projId = new MemoriesRepo(db).ensureProject("/tmp/pag-test-proj");
    db.prepare(`
      INSERT INTO decisions (id, project_id, title, body, category, importance_score, created_at)
      VALUES ('d1', ?, 't1', 'b1', 'g', 0.5, datetime('now'))
    `).run(projId);
    const res = await fetch(`${baseUrl}/api/decisions?limit=5`);
    const body = await res.json();
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("total");
    expect(body).toHaveProperty("limit");
    expect(body).toHaveProperty("offset");
  });
});
