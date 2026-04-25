// tests/integration/e2e-session-end.test.ts
// End-to-end test: auto-captures during a session → SessionEnd hook → summary memory created.
// Runs the hook binary as a subprocess, same pattern as auto-capture-bin.test.ts.

import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import BetterSqlite3 from "better-sqlite3";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";

const summarizeBinPath = join(process.cwd(), "dist/hooks/session-summarize-bin.js");
const captureBinPath = join(process.cwd(), "dist/hooks/auto-capture-bin.js");

describe("e2e SessionEnd auto-summarization", () => {
  beforeAll(() => {
    // Build the session-summarize binary if not already present.
    // We use --no-clean to avoid racing with auto-capture-bin.test.ts which also builds.
    if (!existsSync(summarizeBinPath)) {
      const buildResult = spawnSync(
        "./node_modules/.bin/tsup",
        [
          "src/index.ts",
          "src/cli/main.ts",
          "src/hooks/search-context.ts",
          "src/hooks/session-context.ts",
          "src/hooks/auto-capture-bin.ts",
          "src/hooks/session-summarize-bin.ts",
          "--format", "esm",
          "--dts",
        ],
        { cwd: process.cwd(), encoding: "utf-8", timeout: 60000 }
      );

      if (buildResult.status !== 0) {
        throw new Error(
          `Build failed.\nstderr: ${buildResult.stderr}\nstdout: ${buildResult.stdout}`
        );
      }
    }
  }, 120000);

  it("auto-capture → SessionEnd → summary memory exists in DB", () => {
    const testDbPath = join(tmpdir(), `memento-e2e-session-${process.pid}-${randomUUID()}.sqlite`);
    const claudeSessionId = `e2e-sess-${randomUUID()}`;
    const cwd = `/tmp/e2e-project-${randomUUID()}`;

    try {
      // Step 1: Prime DB and store some auto-capture memories directly
      const db = createDatabase(testDbPath);
      db.pragma("busy_timeout = 30000");
      const repo = new MemoriesRepo(db);
      const projectId = repo.ensureProject(cwd);

      for (let i = 0; i < 3; i++) {
        repo.store({
          title: `Auto-capture ${i}: implementation detail`,
          body: `Implemented feature ${i}. Tests were run successfully. The build passed with no errors.`,
          memoryType: "fact",
          scope: "project",
          projectId,
          tags: [`feature-${i}`, "typescript"],
          importance: 0.4,
          source: "auto-capture",
          claudeSessionId,
        });
      }
      db.close();

      // Step 2: Run the session-summarize-bin with a SessionEnd event
      const sessionEndEvent = JSON.stringify({
        session_id: claudeSessionId,
        cwd,
        reason: "exit",
      });

      const result = spawnSync(
        process.execPath,
        [summarizeBinPath],
        {
          input: sessionEndEvent,
          encoding: "utf-8",
          env: { ...process.env, MEMENTO_DB_PATH: testDbPath },
          timeout: 15000,
        }
      );

      expect(result.status).toBe(0);

      // Step 3: Verify the summary was written
      const verifyDb = new BetterSqlite3(testDbPath) as any;
      try {
        const summaries = verifyDb.prepare(
          "SELECT * FROM memories WHERE memory_type = 'session_summary' AND deleted_at IS NULL"
        ).all() as any[];
        expect(summaries.length).toBe(1);
        expect(summaries[0].source).toBe("session-summary");
        expect(summaries[0].claude_session_id).toBe(claudeSessionId);
        expect(summaries[0].title).toContain("Session summary");

        // Source auto-captures should be soft-deleted (default keep_originals=false)
        const remaining = verifyDb.prepare(
          "SELECT * FROM memories WHERE source = 'auto-capture' AND deleted_at IS NULL"
        ).all() as any[];
        expect(remaining.length).toBe(0);

        // compression_log should have an entry
        const logEntries = verifyDb.prepare(
          "SELECT * FROM compression_log WHERE compressed_memory_id = ?"
        ).all(summaries[0].id) as any[];
        expect(logEntries.length).toBe(1);

        // analytics_events should have a session_summary entry
        const events = verifyDb.prepare(
          "SELECT * FROM analytics_events WHERE event_type = 'session_summary'"
        ).all() as any[];
        expect(events.length).toBe(1);
      } finally {
        verifyDb.close();
      }
    } finally {
      rmSync(testDbPath, { force: true });
    }
  });

  it("running the hook twice for same session is idempotent (no double summary)", () => {
    const testDbPath = join(tmpdir(), `memento-e2e-idempotent-${process.pid}-${randomUUID()}.sqlite`);
    const claudeSessionId = `e2e-idem-${randomUUID()}`;
    const cwd = `/tmp/e2e-idem-project-${randomUUID()}`;

    try {
      // Setup DB with 3 auto-captures
      const db = createDatabase(testDbPath);
      const repo = new MemoriesRepo(db);
      const projectId = repo.ensureProject(cwd);
      for (let i = 0; i < 3; i++) {
        repo.store({
          title: `Capture ${i}`,
          body: `Work item ${i} completed. Tests passed. Build succeeded.`,
          memoryType: "fact",
          scope: "project",
          projectId,
          source: "auto-capture",
          claudeSessionId,
        });
      }
      db.close();

      const sessionEndEvent = JSON.stringify({ session_id: claudeSessionId, cwd, reason: "exit" });

      // Run hook first time
      const run1 = spawnSync(
        process.execPath,
        [summarizeBinPath],
        {
          input: sessionEndEvent,
          encoding: "utf-8",
          env: { ...process.env, MEMENTO_DB_PATH: testDbPath },
          timeout: 15000,
        }
      );
      expect(run1.status).toBe(0);

      // Run hook second time
      const run2 = spawnSync(
        process.execPath,
        [summarizeBinPath],
        {
          input: sessionEndEvent,
          encoding: "utf-8",
          env: { ...process.env, MEMENTO_DB_PATH: testDbPath },
          timeout: 15000,
        }
      );
      expect(run2.status).toBe(0);

      // Only 1 summary should exist
      const verifyDb = new BetterSqlite3(testDbPath) as any;
      try {
        const summaries = verifyDb.prepare(
          "SELECT * FROM memories WHERE memory_type = 'session_summary' AND deleted_at IS NULL"
        ).all() as any[];
        expect(summaries.length).toBe(1);
      } finally {
        verifyDb.close();
      }
    } finally {
      rmSync(testDbPath, { force: true });
    }
  });

  it("hook exits 0 on empty stdin", () => {
    const result = spawnSync(
      process.execPath,
      [summarizeBinPath],
      {
        input: "",
        encoding: "utf-8",
        env: { ...process.env, MEMENTO_DB_PATH: join(tmpdir(), `memento-empty-${randomUUID()}.sqlite`) },
        timeout: 10000,
      }
    );
    expect(result.status).toBe(0);
  });

  it("hook exits 0 on invalid JSON stdin", () => {
    const result = spawnSync(
      process.execPath,
      [summarizeBinPath],
      {
        input: "not-valid-json",
        encoding: "utf-8",
        env: { ...process.env, MEMENTO_DB_PATH: join(tmpdir(), `memento-invalid-${randomUUID()}.sqlite`) },
        timeout: 10000,
      }
    );
    expect(result.status).toBe(0);
  });

  it("hook exits 0 when session has 0 captures (no-op)", () => {
    const testDbPath = join(tmpdir(), `memento-e2e-zero-${process.pid}-${randomUUID()}.sqlite`);
    const claudeSessionId = `e2e-zero-${randomUUID()}`;
    const cwd = `/tmp/e2e-zero-${randomUUID()}`;

    try {
      // Setup DB (no auto-captures)
      const db = createDatabase(testDbPath);
      db.close();

      const sessionEndEvent = JSON.stringify({ session_id: claudeSessionId, cwd, reason: "exit" });

      const result = spawnSync(
        process.execPath,
        [summarizeBinPath],
        {
          input: sessionEndEvent,
          encoding: "utf-8",
          env: { ...process.env, MEMENTO_DB_PATH: testDbPath },
          timeout: 10000,
        }
      );
      expect(result.status).toBe(0);

      const verifyDb = new BetterSqlite3(testDbPath) as any;
      try {
        const summaries = verifyDb.prepare(
          "SELECT * FROM memories WHERE memory_type = 'session_summary'"
        ).all() as any[];
        expect(summaries.length).toBe(0);
      } finally {
        verifyDb.close();
      }
    } finally {
      rmSync(testDbPath, { force: true });
    }
  });
});
