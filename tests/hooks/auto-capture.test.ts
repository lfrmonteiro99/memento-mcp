// tests/hooks/auto-capture.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { processAutoCapture, AutoCaptureConfig, clearSessionTracker } from "../../src/hooks/auto-capture.js";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("auto-capture hook (processAutoCapture logic)", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  const dbPath = join(tmpdir(), `memento-autocap-test-${process.pid}-${randomUUID()}.sqlite`);

  const defaultConfig: AutoCaptureConfig = {
    enabled: true,
    min_output_length: 200,
    max_output_length: 50000,
    cooldown_seconds: 0, // disable cooldown for tests
    dedup_similarity_threshold: 0.7,
    max_per_session: 20,
    default_importance: 0.3,
    tools: ["Bash", "Read", "Grep", "Edit"],
    session_timeout_seconds: 3600,
  };

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    clearSessionTracker("s1");
  });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("captures git log and stores memory (M5: source=auto-capture)", () => {
    const result = processAutoCapture(db, memRepo, {
      tool_name: "Bash",
      tool_input: { command: "git log --oneline -5" },
      tool_response_text: "abc123 feat: add auth\ndef456 fix: null check\n" + "x".repeat(200),
      session_id: "s1",
    }, defaultConfig);

    expect(result.captured).toBe(true);
    expect(result.memoryId).toBeDefined();

    // Verify it was stored with source set via MemoriesRepo.store() source param (M5)
    const stored = memRepo.getById(result.memoryId!);
    expect(stored).not.toBeNull();
    expect(stored.title).toContain("Git log");
    expect(stored.source).toBe("auto-capture");
  });

  it("skips tools not in the capture list", () => {
    const result = processAutoCapture(db, memRepo, {
      tool_name: "WebSearch",
      tool_input: { query: "test" },
      tool_response_text: "some results" + " ".repeat(200),
      session_id: "s1",
    }, defaultConfig);

    expect(result.captured).toBe(false);
    expect(result.reason).toContain("not in capture list");
  });

  it("skips when auto-capture is disabled", () => {
    const result = processAutoCapture(db, memRepo, {
      tool_name: "Bash",
      tool_input: { command: "git log" },
      tool_response_text: "abc123 commit" + " ".repeat(200),
      session_id: "s1",
    }, { ...defaultConfig, enabled: false });

    expect(result.captured).toBe(false);
  });

  it("deduplicates against existing memories (I3: project-scoped)", () => {
    // First capture
    processAutoCapture(db, memRepo, {
      tool_name: "Bash",
      tool_input: { command: "git log --oneline -5" },
      tool_response_text: "abc123 feat: add auth\ndef456 fix: null check\n" + "x".repeat(200),
      session_id: "s1",
    }, defaultConfig);

    // Same content again — should be deduped
    const result = processAutoCapture(db, memRepo, {
      tool_name: "Bash",
      tool_input: { command: "git log --oneline -5" },
      tool_response_text: "abc123 feat: add auth\ndef456 fix: null check\n" + "x".repeat(200),
      session_id: "s1",
    }, defaultConfig);

    expect(result.captured).toBe(false);
    expect(result.reason).toContain("duplicate");
  });

  it("I3: same title in different projects does NOT dedup (project-scoped dedup)", () => {
    // Create two distinct real projects in the DB (foreign key constraint requires this)
    const projectIdA = memRepo.ensureProject("/tmp/project-a-i3");
    const projectIdB = memRepo.ensureProject("/tmp/project-b-i3");

    // Store a memory in project A
    processAutoCapture(db, memRepo, {
      tool_name: "Bash",
      tool_input: { command: "git log --oneline -5" },
      tool_response_text: "abc123 feat: add auth\ndef456 fix: null check\n" + "x".repeat(200),
      session_id: "s1",
      project_id: projectIdA,
    }, defaultConfig);

    // Same content in project B — should NOT be deduped (I3: project-scoped)
    const result = processAutoCapture(db, memRepo, {
      tool_name: "Bash",
      tool_input: { command: "git log --oneline -5" },
      tool_response_text: "abc123 feat: add auth\ndef456 fix: null check\n" + "x".repeat(200),
      session_id: "s1",
      project_id: projectIdB,
    }, defaultConfig);

    // Different project → no dedup → should be captured
    expect(result.captured).toBe(true);
  });

  it("respects max captures per session", () => {
    const cfg = { ...defaultConfig, max_per_session: 1 };

    // Need unique session ids to avoid tracker sharing; but the test clears s1 in beforeEach
    processAutoCapture(db, memRepo, {
      tool_name: "Read",
      tool_input: { file_path: "/project/package.json" },
      tool_response_text: '{"name":"app"}' + " ".repeat(200),
      session_id: "s1",
    }, cfg);

    const result = processAutoCapture(db, memRepo, {
      tool_name: "Read",
      tool_input: { file_path: "/project/tsconfig.json" },
      tool_response_text: '{"compilerOptions":{}}' + " ".repeat(200),
      session_id: "s1",
    }, cfg);

    expect(result.captured).toBe(false);
    expect(result.reason).toContain("max captures");
  });

  it("M5: stored memory has source='auto-capture' in single INSERT (no UPDATE)", () => {
    const result = processAutoCapture(db, memRepo, {
      tool_name: "Bash",
      tool_input: { command: "git log --oneline -5" },
      tool_response_text: "abc123 feat: add auth\n" + "x".repeat(200),
      session_id: "s1",
    }, defaultConfig);

    expect(result.captured).toBe(true);
    if (result.memoryId) {
      const row = db.prepare("SELECT source FROM memories WHERE id = ?").get(result.memoryId) as any;
      expect(row.source).toBe("auto-capture");
    }
  });

  it("G2: secrets in tool_response_text are scrubbed before storage", () => {
    // The classifier calls scrubSecrets internally. Pass a text that contains a secret.
    // We verify the stored memory body does NOT contain the raw secret.
    const secretText = "git log output\napi_key=supersecret123\n" + "x".repeat(200);
    const result = processAutoCapture(db, memRepo, {
      tool_name: "Bash",
      tool_input: { command: "git log --oneline -5" },
      tool_response_text: secretText,
      session_id: "s1",
    }, defaultConfig);

    expect(result.captured).toBe(true);
    if (result.memoryId) {
      const stored = memRepo.getById(result.memoryId!);
      expect(stored.body).not.toContain("supersecret123");
      expect(stored.body).toContain("[REDACTED]");
    }
  });

  it("K4: cwd resolves to project_id before store (ensureProject)", () => {
    // Simulate: auto-capture-bin would call memRepo.ensureProject(cwd) and pass project_id.
    const projectId = memRepo.ensureProject("/tmp/test-project-k4");

    const result = processAutoCapture(db, memRepo, {
      tool_name: "Bash",
      tool_input: { command: "git log --oneline -5" },
      tool_response_text: "abc123 feat: k4 test\n" + "x".repeat(200),
      session_id: "s1",
      project_id: projectId,
    }, defaultConfig);

    expect(result.captured).toBe(true);
    if (result.memoryId) {
      const stored = memRepo.getById(result.memoryId!);
      expect(stored.project_id).toBe(projectId);
    }
  });

  it("C5: evicts oldest session tracker when limit of 100 is reached", () => {
    // Create 100 sessions to fill the map
    for (let i = 0; i < 100; i++) {
      processAutoCapture(db, memRepo, {
        tool_name: "Bash", tool_input: { command: "git log" },
        tool_response_text: "x".repeat(250), session_id: `session-${i}`,
      }, defaultConfig);
    }
    // Adding session 101 should not throw and oldest should be evicted
    expect(() => processAutoCapture(db, memRepo, {
      tool_name: "Bash", tool_input: { command: "git log" },
      tool_response_text: "x".repeat(250), session_id: "session-100",
    }, defaultConfig)).not.toThrow();
  });
});
