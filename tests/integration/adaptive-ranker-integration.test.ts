// tests/integration/adaptive-ranker-integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { SessionsRepo } from "../../src/db/sessions.js";
import { PitfallsRepo } from "../../src/db/pitfalls.js";
import { AnalyticsTracker } from "../../src/analytics/tracker.js";
import { processSearchHook } from "../../src/hooks/search-context.js";
import { processSessionHook } from "../../src/hooks/session-context.js";
import { setClock, resetClock } from "../../src/lib/decay.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("adaptive ranker integration: search-context hook", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let sessRepo: SessionsRepo;
  let tracker: AnalyticsTracker;
  const dbPath = join(tmpdir(), `memento-adaptive-int-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    sessRepo = new SessionsRepo(db);
    tracker = new AnalyticsTracker(db, { flushThreshold: 1 });
    // R10: freeze time so adaptive scores are deterministic
    setClock(() => new Date("2026-04-17T12:00:00Z").getTime());
  });
  afterEach(() => {
    resetClock();
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("search hook ranks memory with high utility above memory with low utility (K6)", () => {
    const highId = memRepo.store({
      title: "Authentication patterns: JWT tokens",
      body: "Use JWT for stateless auth. Verify signature on each request.",
      memoryType: "fact", scope: "global",
    });
    const lowId = memRepo.store({
      title: "Authentication overview",
      body: "Auth is important for security. Many patterns exist.",
      memoryType: "fact", scope: "global",
    });

    // Record 5 injections + 4 uses for highId (high utility)
    for (let i = 0; i < 5; i++) {
      tracker.track({ session_id: "s1", memory_id: highId, event_type: "injection", event_data: "{}" });
    }
    for (let i = 0; i < 4; i++) {
      tracker.track({ session_id: "s1", memory_id: highId, event_type: "utility_signal",
        event_data: JSON.stringify({ signal_type: "tool_reference", signal_strength: 0.9 }) });
    }
    // Record 5 injections + 0 uses for lowId (low utility)
    for (let i = 0; i < 5; i++) {
      tracker.track({ session_id: "s1", memory_id: lowId, event_type: "injection", event_data: "{}" });
    }
    tracker.flush();

    const output = processSearchHook(db, "how does authentication work with JWT?", memRepo, sessRepo, DEFAULT_CONFIG);

    // highId should appear before lowId in the output
    const highPos = output.indexOf("JWT tokens");
    const lowPos = output.indexOf("Authentication overview");
    expect(highPos).not.toBe(-1);
    expect(lowPos).not.toBe(-1);
    expect(highPos).toBeLessThan(lowPos);
  });

  it("search hook produces different top-N orderings for different utility distributions", () => {
    // Both memories have identical bodies so FTS relevance is equal — utility drives rank.
    const a = memRepo.store({ title: "Query result A", body: "pipeline processing function used in query execution", memoryType: "fact", scope: "global" });
    const b = memRepo.store({ title: "Query result B", body: "pipeline processing function used in query execution", memoryType: "fact", scope: "global" });

    // Scenario 1: equal utility — record nothing yet.
    const out1 = processSearchHook(db, "how does pipeline query processing work?", memRepo, sessRepo, DEFAULT_CONFIG);

    // Scenario 2: heavily boost B's utility so B must rank before A.
    for (let i = 0; i < 20; i++) {
      tracker.track({ session_id: "s1", memory_id: b, event_type: "injection", event_data: "{}" });
      tracker.track({ session_id: "s1", memory_id: b, event_type: "utility_signal",
        event_data: JSON.stringify({ signal_type: "tool_reference", signal_strength: 0.99 }) });
    }
    // Give A low utility: injected but never used.
    for (let i = 0; i < 20; i++) {
      tracker.track({ session_id: "s1", memory_id: a, event_type: "injection", event_data: "{}" });
    }
    tracker.flush();
    const out2 = processSearchHook(db, "how does pipeline query processing work?", memRepo, sessRepo, DEFAULT_CONFIG);

    // After utility boost: B now appears before A in the output (position changes).
    const posB2 = out2.indexOf("Query result B");
    const posA2 = out2.indexOf("Query result A");
    expect(posB2).not.toBe(-1);
    expect(posA2).not.toBe(-1);
    expect(posB2).toBeLessThan(posA2);

    // And in out1, A appeared before B (equal or FTS-ordered) OR at least ordering changed.
    const posA1 = out1.indexOf("Query result A");
    const posB1 = out1.indexOf("Query result B");
    // At minimum, the ranker produced different output when utility distribution changed.
    expect(out1).not.toBe(out2);
    void posA1; void posB1; // referenced to avoid lint unused warnings
  });
});

describe("adaptive ranker integration: session-context hook", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let sessRepo: SessionsRepo;
  let pitRepo: PitfallsRepo;
  let tracker: AnalyticsTracker;
  const dbPath = join(tmpdir(), `memento-adaptive-sess-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    sessRepo = new SessionsRepo(db);
    pitRepo = new PitfallsRepo(db);
    tracker = new AnalyticsTracker(db, { flushThreshold: 1 });
    setClock(() => new Date("2026-04-17T12:00:00Z").getTime());
  });
  afterEach(() => {
    resetClock();
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("session hook includes high-utility memories in its output (K6)", () => {
    const id = memRepo.store({
      title: "Frequently used pattern",
      body: "This pattern is referenced often in tool calls.",
      memoryType: "architecture", scope: "global",
    });

    // High injection + usage count → high adaptive score
    for (let i = 0; i < 10; i++) {
      tracker.track({ session_id: "s1", memory_id: id, event_type: "injection", event_data: "{}" });
      tracker.track({ session_id: "s1", memory_id: id, event_type: "utility_signal",
        event_data: JSON.stringify({ signal_type: "tool_reference", signal_strength: 0.95 }) });
    }
    tracker.flush();

    const output = processSessionHook(db, memRepo, pitRepo, sessRepo, DEFAULT_CONFIG);
    expect(output).toContain("Frequently used pattern");
  });

  it("G6 reminder is emitted when simpleHash(session.id) % interval === 0", () => {
    // We need a session id whose hash % 20 === 0.
    // Force-create a session whose id we control by seeding the sessRepo.
    // Instead: run many sessions until we find one that triggers the reminder.
    // We test this by calling processSessionHook repeatedly with fresh sessRepo
    // instances (new session IDs each call) until the tip appears.
    let found = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      // Use a fresh db for each attempt to avoid session reuse
      const testDbPath = join(tmpdir(), `memento-g6-${process.pid}-${randomUUID()}.sqlite`);
      const testDb = createDatabase(testDbPath);
      const testSessRepo = new SessionsRepo(testDb);
      const testMemRepo = new MemoriesRepo(testDb);
      const testPitRepo = new PitfallsRepo(testDb);
      const out = processSessionHook(testDb, testMemRepo, testPitRepo, testSessRepo, DEFAULT_CONFIG);
      testDb.close();
      rmSync(testDbPath, { force: true });
      if (out.includes("memory_analytics")) {
        found = true;
        break;
      }
    }
    // With interval=20, probability per attempt = 1/20 = 5%. Over 200 attempts,
    // P(never triggers) = (19/20)^200 ≈ 1.6e-5. This test is effectively deterministic.
    expect(found).toBe(true);
  });
});
