import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { PitfallsRepo } from "../../src/db/pitfalls.js";
import { SessionsRepo } from "../../src/db/sessions.js";
import { DecisionsRepo } from "../../src/db/decisions.js";
import { handleMemoryStore } from "../../src/tools/memory-store.js";
import { handleMemorySearch } from "../../src/tools/memory-search.js";
import { handleMemoryGet } from "../../src/tools/memory-get.js";
import { handleMemoryDelete } from "../../src/tools/memory-delete.js";
import { processSessionHook } from "../../src/hooks/session-context.js";
import { processSearchHook } from "../../src/hooks/search-context.js";
import {
  processAutoCapture,
  clearSessionTracker,
  type AutoCaptureConfig,
} from "../../src/hooks/auto-capture.js";
import { AnalyticsTracker } from "../../src/analytics/tracker.js";
import { computeAdaptiveScore, computeUtilityScore } from "../../src/engine/adaptive-ranker.js";
import { computeExponentialDecay } from "../../src/lib/decay.js";
import { generateReport } from "../../src/analytics/reporter.js";
import { estimateTokensV2 } from "../../src/engine/token-estimator.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";
import { runCompressionCycle, DEFAULT_COMPRESSION_CONFIG } from "../../src/engine/compressor.js";

describe("end-to-end v2", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let sessRepo: SessionsRepo;
  let pitRepo: PitfallsRepo;
  let decRepo: DecisionsRepo;
  let tracker: AnalyticsTracker;
  const dbPath = join(tmpdir(), `memento-e2e-v2-${process.pid}-${randomUUID()}.sqlite`);

  const autoCaptureConfig: AutoCaptureConfig = {
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

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    sessRepo = new SessionsRepo(db);
    pitRepo = new PitfallsRepo(db);
    decRepo = new DecisionsRepo(db);
    tracker = new AnalyticsTracker(db, { flushThreshold: 100 });
    clearSessionTracker("e2e-session");
  });
  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("schema is v2 or higher", () => {
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(2);
  });

  it("v1 tools still work after v2 migration (store -> search -> get -> delete)", async () => {
    const storeResult = await handleMemoryStore(memRepo, {
      title: "e2e test",
      content: "body content here",
      memory_type: "fact",
      scope: "global",
    });
    expect(storeResult).toContain("Memory stored with ID:");

    const searchResult = await handleMemorySearch(memRepo, DEFAULT_CONFIG, {
      query: "e2e test body content",
      detail: "index",
    });
    expect(searchResult).toContain("e2e test");

    const id = storeResult.split("ID: ")[1]?.trim().split(/\s/)[0];
    expect(id).toBeTruthy();

    const getResult = await handleMemoryGet(memRepo, db, DEFAULT_CONFIG, { memory_id: id });
    expect(getResult).toContain("body content here");

    const delResult = await handleMemoryDelete(memRepo, { memory_id: id });
    expect(delResult.toLowerCase()).toContain("deleted");
  });

  it("auto-capture stores memories with source='auto-capture'", () => {
    const projectId = memRepo.ensureProject("/e2e-auto-proj");
    const result = processAutoCapture(
      db,
      memRepo,
      {
        tool_name: "Bash",
        tool_input: { command: "git log --oneline" },
        tool_response_text:
          "abc123 feat: stuff\ndef456 fix: thing\n" + "x".repeat(200),
        session_id: "e2e-session",
        project_id: projectId,
      },
      autoCaptureConfig,
    );

    expect(result.captured).toBe(true);
    const row = db
      .prepare("SELECT source FROM memories WHERE id = ?")
      .get(result.memoryId!) as any;
    expect(row.source).toBe("auto-capture");
  });

  it("analytics tracker records events the reporter can aggregate", () => {
    db.prepare("INSERT INTO projects (id, name, root_path) VALUES ('p-e2e', 'test', '/e2e-report')").run();
    tracker.track({
      session_id: "e2e",
      project_id: "p-e2e",
      event_type: "budget_debit",
      event_data: "{}",
      tokens_cost: 200,
    });
    tracker.track({
      session_id: "e2e",
      project_id: "p-e2e",
      event_type: "auto_capture",
      event_data: JSON.stringify({ tool: "Bash" }),
    });
    tracker.flush();

    const report = generateReport(db, "p-e2e", "all");
    expect(report.session_count).toBeGreaterThanOrEqual(1);
    expect(report.total_tokens_consumed).toBeGreaterThanOrEqual(200);
    expect(report.auto_capture_stats.total_captures).toBeGreaterThanOrEqual(1);
  });

  it("adaptive score computation works end-to-end", () => {
    const memId = memRepo.store({
      title: "adaptive test",
      body: "content for adaptive scoring",
      memoryType: "fact",
      scope: "global",
    });

    for (let i = 0; i < 5; i++) {
      tracker.track({
        session_id: "e2e",
        memory_id: memId,
        event_type: "injection",
        event_data: "{}",
      });
      tracker.track({
        session_id: "e2e",
        memory_id: memId,
        event_type: "utility_signal",
        event_data: JSON.stringify({ signal_type: "tool_reference", signal_strength: 0.8 }),
      });
    }
    tracker.flush();

    const utility = computeUtilityScore(db, memId);
    expect(utility).toBeGreaterThan(0.5);

    const score = computeAdaptiveScore({
      fts_relevance: 0.7,
      embedding_relevance: 0,
      importance: 0.5,
      decay: computeExponentialDecay(0),
      utility,
      recency_bonus: 0.2,
    });
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("hooks still work (session + search) with db as first arg (K6)", async () => {
    const projectId = memRepo.ensureProject("/e2e-hooks-proj");
    memRepo.store({
      title: "hook test mem",
      body: "hook body text about testing hooks",
      memoryType: "fact",
      scope: "global",
    });
    pitRepo.store("/e2e-hooks-proj", "hook pitfall", "issue body");

    const sessionOutput = processSessionHook(db, memRepo, pitRepo, sessRepo, DEFAULT_CONFIG);
    expect(sessionOutput).toContain("hook test mem");

    const searchOutput = await processSearchHook(
      db,
      "how does hook test work with memories?",
      memRepo,
      sessRepo,
      DEFAULT_CONFIG,
    );
    expect(searchOutput).toContain("hook test");
  });

  it("token estimator differentiates code vs prose", () => {
    const prose = "The quick brown fox jumps over the lazy dog repeatedly.";
    const code = "export function test(x: number): boolean { return x > 0 && x < 100; }";
    const proseTokens = estimateTokensV2(prose);
    const codeTokens = estimateTokensV2(code);
    expect(codeTokens).not.toBe(proseTokens);
    expect(proseTokens).toBeGreaterThan(0);
    expect(codeTokens).toBeGreaterThan(0);
  });

  it("exponential decay is smooth and monotonically decreasing", () => {
    const values = [0, 7, 14, 21, 28].map(d => computeExponentialDecay(d, 14));
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeLessThan(values[i - 1]);
    }
    for (let i = 2; i < values.length; i++) {
      const diff1 = values[i - 2] - values[i - 1];
      const diff2 = values[i - 1] - values[i];
      expect(diff2).toBeLessThanOrEqual(diff1 + 0.01);
    }
  });

  it("compression pipeline works end-to-end (Phase 4 wired in)", () => {
    const projectPath = "/e2e-compress-proj";
    const projectId = memRepo.ensureProject(projectPath);

    for (let i = 0; i < 4; i++) {
      memRepo.store({
        title: `Edit: parser.ts - change ${i}`,
        body: `Modified parser.ts handler ${i} to improve error recovery`,
        memoryType: "fact",
        scope: "project",
        projectPath,
        tags: ["edit", "code-change"],
      });
    }

    const results = runCompressionCycle(db, projectId, DEFAULT_COMPRESSION_CONFIG);
    expect(results.length).toBeGreaterThanOrEqual(1);

    const compressedRow = db
      .prepare(
        "SELECT COUNT(*) as c FROM memories WHERE project_id = ? AND source = 'compression'",
      )
      .get(projectId) as any;
    expect(compressedRow.c).toBeGreaterThanOrEqual(1);
  });

  it("K7: package.json retains v1 bin names AND adds memento-hook-capture", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"));
    expect(pkg.bin).toBeDefined();
    expect(pkg.bin["memento-mcp"]).toBe("dist/cli/main.js");
    expect(pkg.bin["memento-hook-search"]).toBe("dist/hooks/search-context.js");
    expect(pkg.bin["memento-hook-session"]).toBe("dist/hooks/session-context.js");
    expect(pkg.bin["memento-hook-capture"]).toBe("dist/hooks/auto-capture-bin.js");
  });

  it("G8: tsup config includes all four entry points", () => {
    const tsupConfig = readFileSync(join(process.cwd(), "tsup.config.ts"), "utf-8");
    expect(tsupConfig).toContain("src/hooks/auto-capture-bin.ts");
    expect(tsupConfig).toContain("src/hooks/search-context.ts");
    expect(tsupConfig).toContain("src/hooks/session-context.ts");
    expect(tsupConfig).toContain("src/cli/main.ts");
  });
});
