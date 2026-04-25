// tests/server/security.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { startWebServer } from "../../src/server/web.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";

async function startServer(enableEdit: boolean, host: string = "127.0.0.1") {
  const dbPath = join(tmpdir(), `memento-web-sec-${Date.now()}-${Math.random()}.sqlite`);
  const db = createDatabase(dbPath);
  const repo = new MemoriesRepo(db);
  const id = repo.store({ title: "secured", body: "body", scope: "global" });
  const server = startWebServer({ port: 0, host, enableEdit, db, config: DEFAULT_CONFIG });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, db, dbPath, baseUrl: `http://127.0.0.1:${port}`, memoryId: id };
}

describe("web server security", () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;

  afterEach(async () => {
    if (ctx) {
      await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
      ctx.db.close();
      rmSync(ctx.dbPath, { force: true });
    }
  });

  it("read-only mode returns 403 for POST /api/memories/:id/pin", async () => {
    ctx = await startServer(false);
    const res = await fetch(`${ctx.baseUrl}/api/memories/${ctx.memoryId}/pin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Memento-UI": "1" },
      body: JSON.stringify({ pinned: true }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/read-only/);
  });

  it("read-only mode returns 403 for DELETE /api/memories/:id", async () => {
    ctx = await startServer(false);
    const res = await fetch(`${ctx.baseUrl}/api/memories/${ctx.memoryId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "X-Memento-UI": "1" },
    });
    expect(res.status).toBe(403);
  });

  it("edit mode rejects POST without X-Memento-UI header", async () => {
    ctx = await startServer(true);
    const res = await fetch(`${ctx.baseUrl}/api/memories/${ctx.memoryId}/pin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/X-Memento-UI/);
  });

  it("edit mode rejects POST without correct Content-Type", async () => {
    ctx = await startServer(true);
    const res = await fetch(`${ctx.baseUrl}/api/memories/${ctx.memoryId}/pin`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-Memento-UI": "1" },
      body: JSON.stringify({ pinned: true }),
    });
    expect(res.status).toBe(400);
  });

  it("edit mode accepts POST with both header and Content-Type", async () => {
    ctx = await startServer(true);
    const res = await fetch(`${ctx.baseUrl}/api/memories/${ctx.memoryId}/pin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Memento-UI": "1" },
      body: JSON.stringify({ pinned: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pinned).toBe(true);
  });

  it("edit mode soft-deletes memory via DELETE", async () => {
    ctx = await startServer(true);
    const res = await fetch(`${ctx.baseUrl}/api/memories/${ctx.memoryId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "X-Memento-UI": "1" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);
    const after = await fetch(`${ctx.baseUrl}/api/memories/${ctx.memoryId}`);
    expect(after.status).toBe(404);
  });

  it("invalid id pattern returns 400 on edit endpoints", async () => {
    ctx = await startServer(true);
    const res = await fetch(`${ctx.baseUrl}/api/memories/has spaces/pin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Memento-UI": "1" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it("non-localhost host triggers a stderr warning", async () => {
    const original = process.stderr.write.bind(process.stderr);
    let captured = "";
    (process.stderr as any).write = (chunk: any) => { captured += String(chunk); return true; };
    try {
      ctx = await startServer(false, "0.0.0.0");
    } finally {
      (process.stderr as any).write = original;
    }
    expect(captured).toMatch(/exposes memory contents on the network/);
  });

  it("/api/health reports enableEdit flag", async () => {
    ctx = await startServer(true);
    const res = await fetch(`${ctx.baseUrl}/api/health`);
    const body = await res.json();
    expect(body.enableEdit).toBe(true);
  });
});
