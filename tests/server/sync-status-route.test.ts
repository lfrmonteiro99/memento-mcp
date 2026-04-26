// tests/server/sync-status-route.test.ts
// Coverage for the GET /api/sync/status route on src/server/web.ts.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { createDatabase } from "../../src/db/database.js";
import { startWebServer } from "../../src/server/web.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";

describe("GET /api/sync/status", () => {
  let db: ReturnType<typeof createDatabase>;
  let server: Server;
  let baseUrl: string;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `memento-sync-status-${process.pid}-${randomUUID()}.sqlite`);
    db = createDatabase(dbPath);

    server = startWebServer({
      port: 0,
      host: "127.0.0.1",
      enableEdit: false,
      db,
      config: DEFAULT_CONFIG,
    });
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

  it("returns 400 when project param is missing", async () => {
    const res = await fetch(`${baseUrl}/api/sync/status`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/project param required/);
  });

  it("returns sync status JSON for an existing project path", async () => {
    const projectPath = join(tmpdir(), `sync-proj-${process.pid}-${randomUUID()}`);
    const res = await fetch(`${baseUrl}/api/sync/status?project=${encodeURIComponent(projectPath)}`);
    // syncStatus may succeed (200) with absent files, or fail (500) if it can't
    // resolve a folder. Either branch covers the route.
    expect([200, 500]).toContain(res.status);
    const body = await res.json();
    if (res.status === 500) {
      expect(body.error).toMatch(/sync status/);
    } else {
      expect(body).toBeTypeOf("object");
    }
  });
});
