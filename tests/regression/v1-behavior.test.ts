// tests/regression/v1-behavior.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { DecisionsRepo } from "../../src/db/decisions.js";
import { PitfallsRepo } from "../../src/db/pitfalls.js";
import { SessionsRepo } from "../../src/db/sessions.js";
import { handleMemoryStore } from "../../src/tools/memory-store.js";
import { handleMemorySearch } from "../../src/tools/memory-search.js";
import { handleMemoryGet } from "../../src/tools/memory-get.js";
import { handleMemoryList } from "../../src/tools/memory-list.js";
import { handleMemoryDelete } from "../../src/tools/memory-delete.js";
import { handleDecisionsLog } from "../../src/tools/decisions-log.js";
import { handlePitfallsLog } from "../../src/tools/pitfalls-log.js";
import { processSearchHook } from "../../src/hooks/search-context.js";
import { processSessionHook } from "../../src/hooks/session-context.js";
import { estimateTokens } from "../../src/lib/budget.js";
import { classifyPrompt } from "../../src/lib/classify.js";
import { daysSince, getDecayFactor, applyDecay } from "../../src/lib/decay.js";
import { formatIndex, formatFull, formatDetail } from "../../src/lib/formatter.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";
import { ENGLISH_PROFILE } from "../../src/lib/profiles.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("v1 regression: core tool contracts", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let decRepo: DecisionsRepo;
  let pitRepo: PitfallsRepo;
  let sessRepo: SessionsRepo;
  // G7: randomUUID() prevents test-runner parallelism collisions.
  const dbPath = join(tmpdir(), `memento-v1-regression-${process.pid}-${randomUUID()}.sqlite`);
  const config = DEFAULT_CONFIG;

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    decRepo = new DecisionsRepo(db);
    pitRepo = new PitfallsRepo(db);
    sessRepo = new SessionsRepo(db);
  });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  // memory_store contract
  // I4: Relax to substring match instead of exact format — behavior over wording.
  it("memory_store returns string containing 'stored' and a UUID", async () => {
    const result = await handleMemoryStore(memRepo, {
      title: "regression test", content: "body", memory_type: "fact", scope: "global",
    });
    expect(result.toLowerCase()).toMatch(/stored/);
    expect(result).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it("memory_store with all optional params still works", async () => {
    const result = await handleMemoryStore(memRepo, {
      title: "full params", content: "body", memory_type: "architecture",
      scope: "project", project_path: "/test/path", tags: ["a", "b"],
      importance: 0.9, pin: true,
    });
    // I4: Behavior-focused; accept either "Memory stored" or "stored" phrasing.
    expect(result.toLowerCase()).toMatch(/stored/);
  });

  // memory_search contract
  it("memory_search detail=index returns compact format without body", async () => {
    memRepo.store({ title: "React patterns", body: "hooks useState useEffect", memoryType: "fact", scope: "global" });
    const result = await handleMemorySearch(memRepo, config, { query: "React", detail: "index" });
    expect(result).toContain("[fact]");
    expect(result).toContain("React patterns");
    // index format should NOT include body text
    expect(result).not.toContain("hooks useState useEffect");
  });

  it("memory_search detail=full returns body preview", async () => {
    memRepo.store({ title: "React patterns", body: "hooks useState useEffect", memoryType: "fact", scope: "global" });
    const result = await handleMemorySearch(memRepo, config, { query: "React", detail: "full" });
    expect(result).toContain("hooks useState useEffect");
  });

  // memory_get contract
  it("memory_get returns full untruncated body", async () => {
    const longBody = "detailed ".repeat(100);
    const id = memRepo.store({ title: "detail test", body: longBody, memoryType: "fact", scope: "global" });
    const result = await handleMemoryGet(memRepo, db, DEFAULT_CONFIG, { memory_id: id });
    expect(result).toContain(longBody);
  });

  it("memory_get returns 'not found' for missing ID", async () => {
    const result = await handleMemoryGet(memRepo, db, DEFAULT_CONFIG, { memory_id: "nonexistent-id" });
    expect(result.toLowerCase()).toContain("not found");
  });

  // memory_list contract
  it("memory_list returns stored memories", async () => {
    memRepo.store({ title: "list item", body: "x", memoryType: "fact", scope: "global" });
    const result = await handleMemoryList(memRepo, config, {});
    expect(result).toContain("list item");
  });

  // memory_delete contract
  it("memory_delete soft-deletes and confirms", async () => {
    const id = memRepo.store({ title: "to delete", body: "x", memoryType: "fact", scope: "global" });
    const result = await handleMemoryDelete(memRepo, { memory_id: id });
    expect(result.toLowerCase()).toContain("deleted");
    expect(memRepo.getById(id)).toBeNull();
  });

  // decisions_log contract
  it("decisions_log store returns ID", async () => {
    const result = await handleDecisionsLog(decRepo, {
      action: "store", project_path: "/p", title: "Use TS", body: "Chose TypeScript",
    });
    expect(result).toContain("Decision stored with ID:");
  });

  it("decisions_log list returns stored decisions", async () => {
    await handleDecisionsLog(decRepo, { action: "store", project_path: "/p", title: "D1", body: "b1" });
    const result = await handleDecisionsLog(decRepo, { action: "list", project_path: "/p" });
    expect(result).toContain("D1");
  });

  // pitfalls_log contract
  it("pitfalls_log store returns ID", async () => {
    const result = await handlePitfallsLog(pitRepo, {
      action: "store", project_path: "/p", title: "Bug X", body: "details",
    });
    expect(result).toContain("Pitfall logged");
  });

  it("pitfalls_log resolve works", async () => {
    const storeR = await handlePitfallsLog(pitRepo, {
      action: "store", project_path: "/p", title: "Bug", body: "d",
    });
    const id = storeR.split("ID: ")[1];
    const result = await handlePitfallsLog(pitRepo, { action: "resolve", project_path: "/p", pitfall_id: id });
    expect(result.toLowerCase()).toContain("resolved");
  });
});

describe("v1 regression: hook contracts", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let pitRepo: PitfallsRepo;
  let sessRepo: SessionsRepo;
  const dbPath = join(tmpdir(), `memento-v1-hook-regression-${process.pid}-${randomUUID()}.sqlite`);
  const config = DEFAULT_CONFIG;

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    pitRepo = new PitfallsRepo(db);
    sessRepo = new SessionsRepo(db);
  });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  // K6 (Task 16b): hooks now accept `db` as the first argument.
  // Updated signatures: processSessionHook(db, memRepo, pitRepo, sessRepo, config)
  // and processSearchHook(db, prompt, memRepo, sessRepo, config).
  it("session hook outputs memories and pitfalls", () => {
    memRepo.store({ title: "Session mem", body: "content", memoryType: "fact", scope: "global" });
    pitRepo.store("/proj", "Session pitfall", "issue desc");
    const output = processSessionHook(db, memRepo, pitRepo, sessRepo, config);
    expect(output).toContain("Session mem");
    expect(output).toContain("Session pitfall");
  });

  it("search hook returns context for non-trivial prompts", async () => {
    memRepo.store({ title: "Auth flow guide", body: "OAuth2 token validation patterns", memoryType: "fact", scope: "global" });
    const output = await processSearchHook(db, "how does auth flow work with OAuth2?", memRepo, sessRepo, config);
    expect(output).toContain("Auth flow");
  });

  it("search hook returns empty for trivial prompts", async () => {
    memRepo.store({ title: "test", body: "content", memoryType: "fact", scope: "global" });
    const output = await processSearchHook(db, "ok", memRepo, sessRepo, config);
    expect(output).toBe("");
  });

  it("search hook debits session budget", async () => {
    memRepo.store({ title: "budget test", body: "something to search", memoryType: "fact", scope: "global" });
    const before = sessRepo.getOrCreate(config.budget);
    await processSearchHook(db, "how does budget test work?", memRepo, sessRepo, config);
    const after = sessRepo.getOrCreate(config.budget);
    expect(after.spent).toBeGreaterThan(before.spent);
  });
});

describe("v1 regression: library contracts", () => {
  it("estimateTokens returns ceil(len/4)", () => {
    expect(estimateTokens("hello world")).toBe(3); // 11/4 = 2.75 -> 3
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("classifyPrompt categories are stable", () => {
    expect(classifyPrompt("ok", DEFAULT_CONFIG, ENGLISH_PROFILE)).toBe("trivial");
    expect(classifyPrompt("how do React hooks work?", DEFAULT_CONFIG, ENGLISH_PROFILE)).toBe("standard");
    expect(classifyPrompt("x".repeat(200), DEFAULT_CONFIG, ENGLISH_PROFILE)).toBe("complex");
    expect(classifyPrompt("look at /home/user/file.ts and fix the issue", DEFAULT_CONFIG, ENGLISH_PROFILE)).toBe("complex");
  });

  it("decay factors match v1 step function", () => {
    expect(getDecayFactor(5)).toBe(1.0);
    expect(getDecayFactor(20)).toBe(0.75);
    expect(getDecayFactor(60)).toBe(0.5);
  });

  it("formatIndex produces single-line entries", () => {
    const out = formatIndex([{ id: "abc", title: "Test", memory_type: "fact", score: 0.9 }]);
    expect(out).toContain("[fact]");
    expect(out).toContain("Test");
    expect(out).toContain("0.90");
  });
});

describe("v1 regression: database schema", () => {
  let db: ReturnType<typeof createDatabase>;
  const dbPath = join(tmpdir(), `memento-v1-schema-regression-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => { db = createDatabase(dbPath); });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("creates required tables", () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map((r: any) => r.name);
    expect(tables).toContain("projects");
    expect(tables).toContain("memories");
    expect(tables).toContain("decisions");
    expect(tables).toContain("pitfalls");
    expect(tables).toContain("sessions");
    expect(tables).toContain("memory_fts");
    expect(tables).toContain("decisions_fts");
  });

  it("schema version is 6 for fresh DB (v6 migration applied)", () => {
    const version = db.pragma("user_version", { simple: true });
    expect(version).toBe(6);
  });

  it("FTS sync triggers exist", () => {
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map((r: any) => r.name);
    expect(triggers).toContain("memories_ai");
    expect(triggers).toContain("memories_au");
    expect(triggers).toContain("memories_ad");
    expect(triggers).toContain("decisions_ai");
    expect(triggers).toContain("decisions_au");
    expect(triggers).toContain("decisions_ad");
  });
});
