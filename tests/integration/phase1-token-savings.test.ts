// tests/integration/phase1-token-savings.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { SessionsRepo } from "../../src/db/sessions.js";
import { PitfallsRepo } from "../../src/db/pitfalls.js";
import { estimateTokensV2 } from "../../src/engine/token-estimator.js";
import { estimateTokens } from "../../src/lib/budget.js";
import { computeExponentialDecay } from "../../src/lib/decay.js";
import { extractKeywordsV2, buildFtsQueryV2 } from "../../src/engine/keyword-extractor.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("Phase 1 integration: token savings validation", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let sessRepo: SessionsRepo;
  let pitRepo: PitfallsRepo;
  const dbPath = join(tmpdir(), `memento-p1-integration-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    sessRepo = new SessionsRepo(db);
    pitRepo = new PitfallsRepo(db);

    // Seed with test memories
    for (let i = 0; i < 10; i++) {
      memRepo.store({
        title: `Architecture doc #${i}`,
        body: `Detailed architecture documentation for component ${i}. This includes API design, data flow, error handling patterns, and deployment considerations.`,
        memoryType: "architecture",
        scope: "global",
        tags: ["architecture", `component-${i}`],
      });
    }
  });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("v2 database has schema version 2", () => {
    const version = db.pragma("user_version", { simple: true });
    expect(version).toBe(3);
  });

  it("memories table has source and adaptive_score columns", () => {
    const cols = db.pragma("table_info(memories)") as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toContain("source");
    expect(names).toContain("adaptive_score");
  });

  it("default detail is 'index' in config", () => {
    expect(DEFAULT_CONFIG.search.defaultDetail).toBe("index");
  });

  it("v2 token estimator is more accurate than v1 for code", () => {
    const code = 'export function processData(items: Item[]): Result {\n  return items.map(i => transform(i));\n}';
    const v1 = estimateTokens(code);
    const v2 = estimateTokensV2(code);
    // v2 should estimate code differently from prose
    // Code has ~3.2 chars/token, v1 uses 4.0 for everything
    // v2 should give a HIGHER estimate for code than v1
    expect(v2).toBeGreaterThan(v1);
  });

  it("exponential decay is smoother than step decay", () => {
    const day13 = computeExponentialDecay(13);
    const day15 = computeExponentialDecay(15);
    // The difference between day 13 and 15 should be small (smooth)
    // v1 step function: day13 = 1.0, day15 = 0.75 (jump of 0.25)
    expect(Math.abs(day13 - day15)).toBeLessThan(0.1);
  });

  it("keyword extractor produces up to 8 keywords with phrases", () => {
    const kws = extractKeywordsV2("how does the authentication flow work with OAuth2 tokens in the service layer?");
    expect(kws.length).toBeLessThanOrEqual(8);
    expect(kws.length).toBeGreaterThan(0);
    // Should have filtered stop words
    expect(kws).not.toContain("the");
    expect(kws).not.toContain("with");
    expect(kws).not.toContain("how");
    expect(kws).not.toContain("does");
  });

  it("FTS5 query builder supports prefix matching", () => {
    const query = buildFtsQueryV2(["auth", "service layer"]);
    expect(query).toContain("auth*");
    expect(query).toContain('"service layer"');
  });

  it("batchUpdateAccess works on search results", () => {
    const id1 = memRepo.store({ title: "batch test 1", body: "content one", memoryType: "fact", scope: "global" });
    const id2 = memRepo.store({ title: "batch test 2", body: "content two", memoryType: "fact", scope: "global" });
    memRepo.batchUpdateAccess([id1, id2]);

    const m1 = db.prepare("SELECT access_count FROM memories WHERE id = ?").get(id1) as any;
    const m2 = db.prepare("SELECT access_count FROM memories WHERE id = ?").get(id2) as any;
    expect(m1.access_count).toBe(1);
    expect(m2.access_count).toBe(1);
  });
});
