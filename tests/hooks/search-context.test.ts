// tests/hooks/search-context.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { processSearchHook } from "../../src/hooks/search-context.js";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { SessionsRepo } from "../../src/db/sessions.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("search-context hook", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  let sessRepo: SessionsRepo;
  const dbPath = join(tmpdir(), `memento-hook-test-${Date.now()}.sqlite`);
  const config = DEFAULT_CONFIG;

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    sessRepo = new SessionsRepo(db);
    memRepo.store({ title: "React guide", body: "hooks and state management", memoryType: "fact", scope: "global" });
  });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("returns context for standard prompt", () => {
    const output = processSearchHook("how do React hooks work?", memRepo, sessRepo, config);
    expect(output).toContain("React guide");
  });

  it("returns empty for trivial prompt", () => {
    const output = processSearchHook("ok", memRepo, sessRepo, config);
    expect(output).toBe("");
  });

  it("returns empty for very short prompt", () => {
    const output = processSearchHook("yes", memRepo, sessRepo, config);
    expect(output).toBe("");
  });

  it("respects budget floor (always returns at least 1 result)", () => {
    // Drain budget
    const session = sessRepo.getOrCreate(config.budget);
    sessRepo.debit(session.id, config.budget.total - config.budget.floor + 1);
    const output = processSearchHook("how do React hooks work?", memRepo, sessRepo, config);
    // Should still return something (floor allows 1 result)
    expect(output).not.toBe("");
  });

  it("debits tokens from session budget", () => {
    const before = sessRepo.getOrCreate(config.budget);
    processSearchHook("how do React hooks work?", memRepo, sessRepo, config);
    const after = sessRepo.getOrCreate(config.budget);
    expect(after.spent).toBeGreaterThan(before.spent);
  });
});
