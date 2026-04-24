// tests/integration/phase2-auto-capture.test.ts
// Phase 2 end-to-end integration tests for the auto-capture + utility-signal pipeline.
// Uses real SQLite DBs, real classifier, real MemoriesRepo, real AnalyticsTracker — no mocks.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { AnalyticsTracker } from "../../src/analytics/tracker.js";
import { processAutoCapture, AutoCaptureConfig, clearSessionTracker } from "../../src/hooks/auto-capture.js";
import { processUtilitySignals } from "../../src/hooks/utility-signal.js";
import { computeUtilityScore } from "../../src/engine/adaptive-ranker.js";
import { jaccardSimilarity, trigramSimilarity } from "../../src/engine/similarity.js";
import { stringifyToolResponse, scrubSecrets } from "../../src/engine/text-utils.js";
import { setClock, resetClock } from "../../src/lib/decay.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// G7: unique DB paths per process + UUID, prevents cross-test contamination
function makeTmpDb(): string {
  return join(tmpdir(), `memento-p2-int-${process.pid}-${randomUUID()}.sqlite`);
}

// ─────────────────────────────────────────────────────────────────
// Suite 1: End-to-end auto-capture pipeline
// ─────────────────────────────────────────────────────────────────
describe("Phase 2 integration: auto-capture pipeline", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let dbPath: string;

  const config: AutoCaptureConfig = {
    enabled: true,
    min_output_length: 50, // lower threshold so short test payloads pass the length gate
    max_output_length: 50000,
    cooldown_seconds: 0,
    dedup_similarity_threshold: 0.7,
    max_per_session: 20,
    default_importance: 0.3,
    tools: ["Bash", "Read", "Grep", "Edit"],
    session_timeout_seconds: 3600,
  };

  beforeEach(() => {
    dbPath = makeTmpDb();
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    clearSessionTracker("test-session");
    // R10: freeze time for determinism
    setClock(() => new Date("2026-04-17T12:00:00Z").getTime());
  });

  afterEach(() => {
    resetClock();
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("full pipeline: classify -> dedup -> store for git log, source=auto-capture", () => {
    const result = processAutoCapture(db, memRepo, {
      tool_name: "Bash",
      tool_input: { command: "git log --oneline -10" },
      tool_response_text: "abc123 feat: initial commit\ndef456 fix: bug\n" + "x".repeat(200),
      session_id: "test-session",
    }, config);

    expect(result.captured).toBe(true);
    expect(result.memoryId).toBeDefined();

    const stored = memRepo.getById(result.memoryId!);
    expect(stored).not.toBeNull();
    expect(stored.title).toContain("Git log");

    // M5: source set in the single INSERT, not via a subsequent UPDATE
    const row = db.prepare("SELECT source FROM memories WHERE id = ?").get(result.memoryId!) as any;
    expect(row.source).toBe("auto-capture");
  });

  it("dedup prevents storing identical content across multiple calls within cooldown window", () => {
    const output = "abc123 feat: initial commit\ndef456 fix: bug\n" + "x".repeat(200);

    const first = processAutoCapture(db, memRepo, {
      tool_name: "Bash",
      tool_input: { command: "git log --oneline -10" },
      tool_response_text: output,
      session_id: "test-session",
    }, config);

    const second = processAutoCapture(db, memRepo, {
      tool_name: "Bash",
      tool_input: { command: "git log --oneline -10" },
      tool_response_text: output,
      session_id: "test-session",
    }, config);

    expect(first.captured).toBe(true);
    expect(second.captured).toBe(false);
    expect(second.reason).toMatch(/duplicate/i);

    // Only one row in the DB
    const count = db.prepare("SELECT COUNT(*) as c FROM memories WHERE source = 'auto-capture'").get() as any;
    expect(count.c).toBe(1);
  });

  it("multiple tool types captured in same session", () => {
    const r1 = processAutoCapture(db, memRepo, {
      tool_name: "Bash",
      tool_input: { command: "git log --oneline" },
      tool_response_text: "abc fix: something\n" + "x".repeat(200),
      session_id: "test-session",
    }, config);

    const r2 = processAutoCapture(db, memRepo, {
      tool_name: "Read",
      tool_input: { file_path: "/project/package.json" },
      tool_response_text: '{"name":"app","version":"1.0","dependencies":{"vitest":"1.0"}}' + " ".repeat(200),
      session_id: "test-session",
    }, config);

    expect(r1.captured).toBe(true);
    expect(r2.captured).toBe(true);
    // Both stored
    const count = db.prepare("SELECT COUNT(*) as c FROM memories WHERE source = 'auto-capture'").get() as any;
    expect(count.c).toBe(2);
  });

  it("similarity functions correctly prevent false positives (real-world strings)", () => {
    // Two very different strings — below dedup threshold
    const simLow = jaccardSimilarity(
      "git log snapshot showing recent commits to main branch",
      "docker compose configuration with postgres and redis services"
    );
    expect(simLow).toBeLessThan(0.3);

    // Two very similar strings — above dedup threshold
    const simHigh = jaccardSimilarity(
      "git log snapshot showing recent commits",
      "git log snapshot showing recent commit history"
    );
    expect(simHigh).toBeGreaterThan(0.5);

    // trigramSimilarity for near-identical titles
    const titSim = trigramSimilarity("Git log snapshot", "Git log snapshat");
    expect(titSim).toBeGreaterThan(0.6);
  });
});

// ─────────────────────────────────────────────────────────────────
// Suite 2: K2 — real Claude Code PostToolUse event shape parsing
// ─────────────────────────────────────────────────────────────────
describe("K2: real PostToolUse event shape parsed correctly", () => {
  it("stringifyToolResponse flattens Bash tool_response object (stdout/stderr)", () => {
    const toolResponse = {
      stdout: "abc123 feat: initial\ndef456 fix: null\n",
      stderr: "",
      interrupted: false,
      isImage: false,
    };
    const text = stringifyToolResponse(toolResponse);
    expect(text).toContain("abc123 feat: initial");
    expect(text).toContain("def456 fix: null");
  });

  it("stringifyToolResponse handles string tool_response as-is (N2 string branch)", () => {
    const text = stringifyToolResponse("plain string response");
    expect(text).toBe("plain string response");
  });

  it("stringifyToolResponse returns empty string for null/undefined (N2 null branch)", () => {
    expect(stringifyToolResponse(null)).toBe("");
    expect(stringifyToolResponse(undefined)).toBe("");
  });

  it("end-to-end: object tool_response -> stringifyToolResponse -> auto-capture stores memory", () => {
    const dbPath = makeTmpDb();
    const db = createDatabase(dbPath);
    const memRepo = new MemoriesRepo(db);
    clearSessionTracker("k2-session");

    try {
      // Simulate what auto-capture-bin.ts does: narrow tool_response, scrub, then processAutoCapture
      const rawResp = {
        stdout: "abc123 feat: initial commit\ndef456 fix: null pointer\n" + "x".repeat(200),
        stderr: "",
        interrupted: false,
        isImage: false,
      };

      let toolResponseText = stringifyToolResponse(rawResp);
      toolResponseText = scrubSecrets(toolResponseText);

      const result = processAutoCapture(db, memRepo, {
        tool_name: "Bash",
        tool_input: { command: "git log --oneline -5" },
        tool_response_text: toolResponseText,
        session_id: "k2-session",
      }, {
        enabled: true,
        min_output_length: 50,
        max_output_length: 50000,
        cooldown_seconds: 0,
        dedup_similarity_threshold: 0.7,
        max_per_session: 20,
        default_importance: 0.3,
        tools: ["Bash", "Read", "Grep", "Edit"],
        session_timeout_seconds: 3600,
      });

      expect(result.captured).toBe(true);
      const stored = memRepo.getById(result.memoryId!);
      expect(stored).not.toBeNull();
      expect(stored.source).toBe("auto-capture");
    } finally {
      clearSessionTracker("k2-session");
      db.close();
      rmSync(dbPath, { force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// Suite 3: K4 — cwd resolves to project_id via ensureProject
// ─────────────────────────────────────────────────────────────────
describe("K4: cwd resolves to project_id via ensureProject", () => {
  it("ensureProject creates a new project and returns stable UUID for same path", () => {
    const dbPath = makeTmpDb();
    const db = createDatabase(dbPath);
    const memRepo = new MemoriesRepo(db);

    try {
      const cwd = "/home/user/projects/my-app";
      const id1 = memRepo.ensureProject(cwd);
      const id2 = memRepo.ensureProject(cwd);

      expect(id1).toMatch(/^[0-9a-f-]{36}$/); // UUID format
      expect(id1).toBe(id2); // idempotent — same path returns same id
    } finally {
      db.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("different cwd paths produce different project_ids", () => {
    const dbPath = makeTmpDb();
    const db = createDatabase(dbPath);
    const memRepo = new MemoriesRepo(db);

    try {
      const id1 = memRepo.ensureProject("/projects/app-a");
      const id2 = memRepo.ensureProject("/projects/app-b");
      expect(id1).not.toBe(id2);
    } finally {
      db.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("auto-captured memory is scoped to the resolved project_id from cwd", () => {
    const dbPath = makeTmpDb();
    const db = createDatabase(dbPath);
    const memRepo = new MemoriesRepo(db);
    clearSessionTracker("k4-session");

    try {
      const cwd = "/home/user/projects/my-service";
      const projectId = memRepo.ensureProject(cwd);

      const result = processAutoCapture(db, memRepo, {
        tool_name: "Bash",
        tool_input: { command: "git log --oneline -5" },
        tool_response_text: "abc123 feat: auth\ndef456 fix: bug\n" + "x".repeat(200),
        session_id: "k4-session",
        project_id: projectId, // as the bin would pass it
      }, {
        enabled: true,
        min_output_length: 50,
        max_output_length: 50000,
        cooldown_seconds: 0,
        dedup_similarity_threshold: 0.7,
        max_per_session: 20,
        default_importance: 0.3,
        tools: ["Bash", "Read", "Grep", "Edit"],
        session_timeout_seconds: 3600,
      });

      expect(result.captured).toBe(true);

      const row = db.prepare("SELECT project_id FROM memories WHERE id = ?").get(result.memoryId!) as any;
      expect(row.project_id).toBe(projectId);
    } finally {
      clearSessionTracker("k4-session");
      db.close();
      rmSync(dbPath, { force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// Suite 4: G2 — secrets scrubbed before storage
// ─────────────────────────────────────────────────────────────────
describe("G2: secrets scrubbed before storage", () => {
  it("API key in tool output is redacted — DB row does NOT contain the raw secret", () => {
    const dbPath = makeTmpDb();
    const db = createDatabase(dbPath);
    const memRepo = new MemoriesRepo(db);
    clearSessionTracker("g2-session");

    const secretValue = "sk-1234567890abcdef";
    const rawOutput = `Here is the config:\napi_key=${secretValue}\nSome other git log output: abc123 feat: init\n` + "x".repeat(200);

    // Simulate what the bin does: scrub first, then process
    const scrubbed = scrubSecrets(rawOutput);

    try {
      const result = processAutoCapture(db, memRepo, {
        tool_name: "Bash",
        tool_input: { command: "cat config.env" },
        tool_response_text: scrubbed,
        session_id: "g2-session",
      }, {
        enabled: true,
        min_output_length: 50,
        max_output_length: 50000,
        cooldown_seconds: 0,
        dedup_similarity_threshold: 0.7,
        max_per_session: 20,
        default_importance: 0.3,
        tools: ["Bash", "Read", "Grep", "Edit"],
        session_timeout_seconds: 3600,
      });

      // Whether captured or not, the DB must not contain the raw secret
      if (result.captured && result.memoryId) {
        const row = db.prepare("SELECT title, body FROM memories WHERE id = ?").get(result.memoryId!) as any;
        expect(row.body).not.toContain(secretValue);
        expect(row.title ?? "").not.toContain(secretValue);
      }

      // Also verify the scrubbed text itself doesn't contain the secret
      expect(scrubbed).not.toContain(secretValue);
      expect(scrubbed).toContain("[REDACTED]");
    } finally {
      clearSessionTracker("g2-session");
      db.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("ANTHROPIC_API_KEY env-style assignment is redacted", () => {
    const secretKey = "sk-ant-api03-supersecretkey";
    const text = `ANTHROPIC_API_KEY=${secretKey}\nsome other content`;
    const result = scrubSecrets(text);
    expect(result).not.toContain(secretKey);
    expect(result).toContain("[REDACTED]");
  });

  it("PEM private key block is redacted", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAK...\n-----END RSA PRIVATE KEY-----";
    const text = `Config output:\n${pem}\nEnd of output`;
    const result = scrubSecrets(text);
    expect(result).not.toContain("MIIEowIBAAK");
    expect(result).toContain("[REDACTED");
  });
});

// ─────────────────────────────────────────────────────────────────
// Suite 5: K1 closure — injection → utility_signal producer-consumer loop
// This is the defining end-to-end test for the K1 loop.
// ─────────────────────────────────────────────────────────────────
describe("K1 closure: injection -> utility_signal end-to-end loop", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let tracker: AnalyticsTracker;
  let dbPath: string;

  beforeEach(() => {
    dbPath = makeTmpDb();
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    tracker = new AnalyticsTracker(db, { flushThreshold: 1 });
    // R10: freeze time so injection window is deterministic
    setClock(() => new Date("2026-04-17T12:00:00Z").getTime());
  });

  afterEach(() => {
    resetClock();
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("K1 full loop: store memory -> inject -> matching tool call -> utility_signal -> computeUtilityScore reflects signal", () => {
    // Step 1: Store a memory (as if it was auto-captured earlier)
    const memId = memRepo.store({
      title: "UserService authentication flow",
      body: "See src/auth/UserService.ts for the validate() logic and RBAC table lookups.",
      memoryType: "architecture",
      scope: "global",
    });

    // Step 2: Simulate injection event (as if search-context hook injected this memory into context)
    // Direct DB insert to simulate the injection that would come from search-context/session-context hooks
    db.prepare(`
      INSERT INTO analytics_events (session_id, memory_id, event_type, event_data, created_at)
      VALUES (?, ?, 'injection', '{}', datetime('now'))
    `).run("k1-session", memId);

    // Step 3: A subsequent tool call references a file path from the memory (the producer-consumer loop)
    processUtilitySignals(db, tracker, {
      session_id: "k1-session",
      tool_name: "Read",
      tool_input: { file_path: "src/auth/UserService.ts" },
      tool_response_text: "export class UserService { validate() { /* RBAC check */ } }",
      utility_window_minutes: 10,
    });
    tracker.flush();

    // Step 4: Verify utility_signal was emitted
    const signals = db.prepare(`
      SELECT json_extract(event_data, '$.signal_type') as signal_type,
             json_extract(event_data, '$.signal_strength') as signal_strength
      FROM analytics_events
      WHERE memory_id = ? AND event_type = 'utility_signal'
    `).all(memId) as Array<{ signal_type: string; signal_strength: number }>;

    expect(signals.length).toBe(1);
    expect(signals[0].signal_type).toBe("tool_reference");
    expect(signals[0].signal_strength).toBeGreaterThan(0);

    // Step 5: computeUtilityScore reflects the signal — score must exceed neutral 0.5
    // (1 injection + 1 used signal → usageRate = 1.0, confidence = 1/5 = 0.2)
    // score = 0.5 + (1.0 - 0.5) * avgStrength * confidence = 0.5 + 0.5 * 0.5 * 0.2 = 0.55
    const score = computeUtilityScore(db, memId);
    expect(score).toBeGreaterThan(0.5); // higher than neutral confirms signal was recorded
  });

  it("K1 loop: multiple injections + matching tool calls accumulate utility, score increases", () => {
    const memId = memRepo.store({
      title: "Docker compose configuration",
      body: "Services: web, db, redis. Ports: 3000, 5432, 6379. File: docker-compose.yml",
      memoryType: "architecture",
      scope: "global",
    });

    // Simulate 5 injections and 4 matching tool calls
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO analytics_events (session_id, memory_id, event_type, event_data, created_at)
        VALUES (?, ?, 'injection', '{}', datetime('now'))
      `).run("k1-multi-session", memId);
    }

    // 4 tool calls that reference fingerprints from the memory
    const toolCalls = [
      { tool_input: { file_path: "docker-compose.yml" }, response: "version: '3.8'\nservices:" },
      { tool_input: { command: "docker compose up" }, response: "Starting web, db, redis..." },
      { tool_input: { file_path: "docker-compose.yml" }, response: "ports: 3000:3000" },
      { tool_input: { command: "docker compose ps" }, response: "web    Up\ndb     Up" },
    ];

    for (const call of toolCalls) {
      processUtilitySignals(db, tracker, {
        session_id: "k1-multi-session",
        tool_name: "Bash",
        tool_input: call.tool_input,
        tool_response_text: call.response,
        utility_window_minutes: 10,
      });
    }
    tracker.flush();

    // At least one utility_signal should have been emitted (docker-compose.yml fingerprint match)
    const signalCount = db.prepare(`
      SELECT COUNT(*) as c FROM analytics_events
      WHERE memory_id = ? AND event_type = 'utility_signal'
        AND json_extract(event_data, '$.signal_type') != 'ignored'
    `).get(memId) as any;
    expect(signalCount.c).toBeGreaterThan(0);

    // Score above neutral
    const score = computeUtilityScore(db, memId);
    expect(score).toBeGreaterThan(0.5);
  });

  it("K1 loop: un-matched injection within window stays open (no signal yet)", () => {
    const memId = memRepo.store({
      title: "Redis cache configuration",
      body: "Redis config in src/cache/redis-client.ts with TTL of 3600 seconds.",
      memoryType: "architecture",
      scope: "global",
    });

    db.prepare(`
      INSERT INTO analytics_events (session_id, memory_id, event_type, event_data, created_at)
      VALUES (?, ?, 'injection', '{}', datetime('now'))
    `).run("k1-open-session", memId);

    // Tool call that does NOT reference any fingerprint from the memory
    processUtilitySignals(db, tracker, {
      session_id: "k1-open-session",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
      tool_response_text: "total 0\ndrwxr-xr-x 2 user user 40 Apr 17 12:00 .\n",
      utility_window_minutes: 10,
    });
    tracker.flush();

    // No utility_signal emitted (window still open, no match)
    const signals = db.prepare(`
      SELECT COUNT(*) as c FROM analytics_events
      WHERE memory_id = ? AND event_type = 'utility_signal'
    `).get(memId) as any;
    expect(signals.c).toBe(0);

    // When there is injection data but NO usage signals, the score is low (not neutral).
    // computeUtilityScore returns 0.5 only when total_injections === 0.
    // With 1 injection and 0 used signals: usageRate=0, confidence=0.2 → score=0.04
    const score = computeUtilityScore(db, memId);
    expect(score).toBeLessThan(0.5); // injected but unused → penalized below neutral
  });
});

// ─────────────────────────────────────────────────────────────────
// Suite 6: I3 — cross-project dedup isolation
// Same memory title in different projects must NOT dedup each other
// ─────────────────────────────────────────────────────────────────
describe("I3: cross-project dedup does not prevent stores in different projects", () => {
  it("same memory title stored in project-A does not block storage in project-B", () => {
    const dbPath = makeTmpDb();
    const db = createDatabase(dbPath);
    const memRepo = new MemoriesRepo(db);
    clearSessionTracker("i3-session-a");
    clearSessionTracker("i3-session-b");

    const baseConfig: AutoCaptureConfig = {
      enabled: true,
      min_output_length: 50,
      max_output_length: 50000,
      cooldown_seconds: 0,
      dedup_similarity_threshold: 0.7,
      max_per_session: 20,
      default_importance: 0.3,
      tools: ["Bash", "Read", "Grep", "Edit"],
      session_timeout_seconds: 3600,
    };

    try {
      const projectA = memRepo.ensureProject("/projects/app-alpha");
      const projectB = memRepo.ensureProject("/projects/app-beta");

      const sharedOutput = "abc123 feat: initial commit\ndef456 fix: bug\n" + "x".repeat(200);

      // Store in project A
      const rA = processAutoCapture(db, memRepo, {
        tool_name: "Bash",
        tool_input: { command: "git log --oneline -10" },
        tool_response_text: sharedOutput,
        session_id: "i3-session-a",
        project_id: projectA,
      }, baseConfig);

      // Store same content in project B — should NOT be blocked by project-A dedup
      const rB = processAutoCapture(db, memRepo, {
        tool_name: "Bash",
        tool_input: { command: "git log --oneline -10" },
        tool_response_text: sharedOutput,
        session_id: "i3-session-b",
        project_id: projectB,
      }, baseConfig);

      expect(rA.captured).toBe(true);
      expect(rB.captured).toBe(true); // different project → no dedup cross-project

      // Verify each memory is scoped to its own project
      const rowA = db.prepare("SELECT project_id FROM memories WHERE id = ?").get(rA.memoryId!) as any;
      const rowB = db.prepare("SELECT project_id FROM memories WHERE id = ?").get(rB.memoryId!) as any;
      expect(rowA.project_id).toBe(projectA);
      expect(rowB.project_id).toBe(projectB);
    } finally {
      clearSessionTracker("i3-session-a");
      clearSessionTracker("i3-session-b");
      db.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("same memory title stored in same project IS deduped (positive dedup case)", () => {
    const dbPath = makeTmpDb();
    const db = createDatabase(dbPath);
    const memRepo = new MemoriesRepo(db);
    clearSessionTracker("i3-same-project");

    const baseConfig: AutoCaptureConfig = {
      enabled: true,
      min_output_length: 50,
      max_output_length: 50000,
      cooldown_seconds: 0,
      dedup_similarity_threshold: 0.7,
      max_per_session: 20,
      default_importance: 0.3,
      tools: ["Bash", "Read", "Grep", "Edit"],
      session_timeout_seconds: 3600,
    };

    try {
      const projectId = memRepo.ensureProject("/projects/app-gamma");
      const sharedOutput = "abc123 feat: initial commit\ndef456 fix: bug\n" + "x".repeat(200);

      const r1 = processAutoCapture(db, memRepo, {
        tool_name: "Bash",
        tool_input: { command: "git log --oneline -10" },
        tool_response_text: sharedOutput,
        session_id: "i3-same-project",
        project_id: projectId,
      }, baseConfig);

      const r2 = processAutoCapture(db, memRepo, {
        tool_name: "Bash",
        tool_input: { command: "git log --oneline -10" },
        tool_response_text: sharedOutput,
        session_id: "i3-same-project",
        project_id: projectId,
      }, baseConfig);

      expect(r1.captured).toBe(true);
      expect(r2.captured).toBe(false);
    } finally {
      clearSessionTracker("i3-same-project");
      db.close();
      rmSync(dbPath, { force: true });
    }
  });
});
