// tests/hooks/auto-capture-bin.test.ts
// R8-compliant bin integration test: builds the binary, spawns it, asserts DB row written.
// K2: uses REAL Claude Code PostToolUse shape with tool_response as object.
// K7: asserts correct bin path dist/hooks/auto-capture-bin.js.
// G7: unique DB path using process.pid + randomUUID.

import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import BetterSqlite3 from "better-sqlite3";

describe("auto-capture-bin integration (R8 + K2 + K7)", () => {
  const binPath = join(process.cwd(), "dist/hooks/auto-capture-bin.js");

  beforeAll(() => {
    // R8: Build the binary as a test prerequisite.
    // Use ./node_modules/.bin/tsup directly since yarn may not be available.
    const buildResult = spawnSync(
      "./node_modules/.bin/tsup",
      [
        "src/index.ts",
        "src/cli/main.ts",
        "src/hooks/search-context.ts",
        "src/hooks/session-context.ts",
        "src/hooks/auto-capture-bin.ts",
        "--format", "esm",
        "--dts",
        "--clean",
      ],
      { cwd: process.cwd(), encoding: "utf-8", timeout: 60000 }
    );

    if (buildResult.status !== 0) {
      throw new Error(
        `Bin-test prerequisite failed (build did not succeed).\n` +
        `stderr: ${buildResult.stderr}\nstdout: ${buildResult.stdout}`
      );
    }
  }, 120000); // 2 minute timeout for build

  it("bin reads PostToolUse stdin JSON and stores memory in SQLite (R8 + K2 + K7)", () => {
    // R8: Hard-fail if binary is missing — no silent skip guard.
    if (!existsSync(binPath)) {
      throw new Error(
        `Auto-capture binary missing at ${binPath}. ` +
        `The beforeAll build step must have failed. Check build output.`
      );
    }

    // G7: unique DB path
    const testDbPath = join(tmpdir(), `memento-bin-test-${process.pid}-${randomUUID()}.sqlite`);

    // K2: REAL Claude Code PostToolUse event shape — tool_response is an object, not a string.
    const postToolUseEvent = JSON.stringify({
      session_id: "bin-test-session",
      transcript_path: "/tmp/transcript.jsonl",
      cwd: "/tmp/bin-test-project",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "git log --oneline -5" },
      tool_response: {
        stdout: "abc123 feat: initial\ndef456 fix: null\n" + "x".repeat(250),
        stderr: "",
        interrupted: false,
        isImage: false,
      },
    });

    const result = spawnSync(
      process.execPath,
      [binPath],
      {
        input: postToolUseEvent,
        encoding: "utf-8",
        env: { ...process.env, MEMENTO_DB_PATH: testDbPath },
        timeout: 15000,
      }
    );

    // R8: assert exit code 0 — hook must never crash Claude Code
    expect(result.status).toBe(0);

    // R8: hard-assert the DB was written. No silent pass if the bin failed to write.
    expect(existsSync(testDbPath)).toBe(true);

    const verifyDb = new BetterSqlite3(testDbPath) as any;
    try {
      const count = verifyDb.prepare(
        "SELECT COUNT(*) as c FROM memories WHERE source = 'auto-capture'"
      ).get() as { c: number };
      expect(count.c).toBeGreaterThan(0);
    } finally {
      verifyDb.close();
      rmSync(testDbPath, { force: true });
    }
  });

  it("bin exits 0 even with invalid JSON stdin (silent fail)", () => {
    const result = spawnSync(
      process.execPath,
      [binPath],
      {
        input: "not-valid-json",
        encoding: "utf-8",
        env: { ...process.env, MEMENTO_DB_PATH: join(tmpdir(), `memento-bin-invalid-${process.pid}-${randomUUID()}.sqlite`) },
        timeout: 10000,
      }
    );
    expect(result.status).toBe(0);
  });

  it("bin exits 0 with empty stdin (silent fail)", () => {
    const result = spawnSync(
      process.execPath,
      [binPath],
      {
        input: "",
        encoding: "utf-8",
        env: { ...process.env, MEMENTO_DB_PATH: join(tmpdir(), `memento-bin-empty-${process.pid}-${randomUUID()}.sqlite`) },
        timeout: 10000,
      }
    );
    expect(result.status).toBe(0);
  });

  it("K2: N2 narrowing — null tool_response still exits 0 (no capture)", () => {
    const testDbPath = join(tmpdir(), `memento-bin-null-${process.pid}-${randomUUID()}.sqlite`);

    const event = JSON.stringify({
      session_id: "bin-test-null",
      cwd: "/tmp/null-test",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "git log" },
      tool_response: null,
    });

    const result = spawnSync(
      process.execPath,
      [binPath],
      {
        input: event,
        encoding: "utf-8",
        env: { ...process.env, MEMENTO_DB_PATH: testDbPath },
        timeout: 10000,
      }
    );

    expect(result.status).toBe(0);
    // DB may or may not be created, but no crash
    if (existsSync(testDbPath)) {
      rmSync(testDbPath, { force: true });
    }
  });
});
