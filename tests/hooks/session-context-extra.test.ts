// tests/hooks/session-context-extra.test.ts
// Extra coverage for branches not exercised by tests/hooks/session-context.test.ts:
//  - claudeSessionId injection events
//  - empty memories + empty pitfalls (debit-1 path)
//  - analytics-reminder branch (interval=1 forces the tip)
//  - reminder disabled when interval=0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { processSessionHook } from "../../src/hooks/session-context.js";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { PitfallsRepo } from "../../src/db/pitfalls.js";
import { SessionsRepo } from "../../src/db/sessions.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";

describe("session-context hook — extra branches", () => {
  let db: ReturnType<typeof createDatabase>;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `memento-sess-extra-${process.pid}-${randomUUID()}.sqlite`);
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("emits injection events when claudeSessionId is provided", () => {
    const memRepo = new MemoriesRepo(db);
    const pitRepo = new PitfallsRepo(db);
    const sessRepo = new SessionsRepo(db);
    memRepo.store({ title: "Mem A", body: "A", memoryType: "fact", scope: "global" });
    memRepo.store({ title: "Mem B", body: "B", memoryType: "fact", scope: "global" });

    const sessionId = "claude-session-abc";
    processSessionHook(db, memRepo, pitRepo, sessRepo, DEFAULT_CONFIG, sessionId);

    const events = db.prepare(
      "SELECT * FROM analytics_events WHERE event_type = 'injection' AND session_id = ?",
    ).all(sessionId);
    expect(events.length).toBeGreaterThan(0);
  });

  it("does NOT emit injection events without a claudeSessionId", () => {
    const memRepo = new MemoriesRepo(db);
    const pitRepo = new PitfallsRepo(db);
    const sessRepo = new SessionsRepo(db);
    memRepo.store({ title: "Mem A", body: "A", memoryType: "fact", scope: "global" });

    processSessionHook(db, memRepo, pitRepo, sessRepo, DEFAULT_CONFIG);

    const events = db.prepare(
      "SELECT * FROM analytics_events WHERE event_type = 'injection'",
    ).all();
    expect(events).toHaveLength(0);
  });

  it("returns empty output and debits the session when nothing to inject", () => {
    const memRepo = new MemoriesRepo(db);
    const pitRepo = new PitfallsRepo(db);
    const sessRepo = new SessionsRepo(db);
    const config = {
      ...DEFAULT_CONFIG,
      hooks: { ...DEFAULT_CONFIG.hooks, analyticsReminderIntervalSessions: 0 },
    };

    const before = sessRepo.getOrCreate(config.budget);
    const output = processSessionHook(db, memRepo, pitRepo, sessRepo, config);
    const after = sessRepo.getOrCreate(config.budget);

    expect(output).toBe("");
    // The empty-output path still debits 1 token.
    expect(after.spent).toBeGreaterThan(before.spent);
  });

  it("appends analytics-reminder tip when interval=1", () => {
    const memRepo = new MemoriesRepo(db);
    const pitRepo = new PitfallsRepo(db);
    const sessRepo = new SessionsRepo(db);
    memRepo.store({ title: "Recent", body: "x", memoryType: "fact", scope: "global" });

    const config = {
      ...DEFAULT_CONFIG,
      hooks: { ...DEFAULT_CONFIG.hooks, analyticsReminderIntervalSessions: 1 },
    };

    const output = processSessionHook(db, memRepo, pitRepo, sessRepo, config);
    expect(output).toContain("memory_analytics");
  });

  it("does not append reminder tip when interval=0", () => {
    const memRepo = new MemoriesRepo(db);
    const pitRepo = new PitfallsRepo(db);
    const sessRepo = new SessionsRepo(db);
    memRepo.store({ title: "Recent", body: "x", memoryType: "fact", scope: "global" });

    const config = {
      ...DEFAULT_CONFIG,
      hooks: { ...DEFAULT_CONFIG.hooks, analyticsReminderIntervalSessions: 0 },
    };
    const output = processSessionHook(db, memRepo, pitRepo, sessRepo, config);
    expect(output).not.toContain("memory_analytics");
  });
});
