// tests/hooks/session-context.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { processSessionHook } from "../../src/hooks/session-context.js";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { PitfallsRepo } from "../../src/db/pitfalls.js";
import { SessionsRepo } from "../../src/db/sessions.js";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("session-context hook", () => {
  let db: ReturnType<typeof createDatabase>;
  const dbPath = join(tmpdir(), `memento-sesshook-test-${Date.now()}.sqlite`);

  beforeEach(() => { db = createDatabase(dbPath); });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("outputs recent memories and pitfalls", () => {
    const memRepo = new MemoriesRepo(db);
    const pitRepo = new PitfallsRepo(db);
    const sessRepo = new SessionsRepo(db);
    memRepo.store({ title: "User is a dev", body: "senior", memoryType: "fact", scope: "global" });
    pitRepo.store("/proj", "FTS5 bug", "ranking issue");
    const output = processSessionHook(db, memRepo, pitRepo, sessRepo, DEFAULT_CONFIG);
    expect(output).toContain("User is a dev");
    expect(output).toContain("FTS5 bug");
  });

  it("creates a session budget", () => {
    const sessRepo = new SessionsRepo(db);
    processSessionHook(db, new MemoriesRepo(db), new PitfallsRepo(db), sessRepo, DEFAULT_CONFIG);
    const session = sessRepo.getOrCreate(DEFAULT_CONFIG.budget);
    expect(session.spent).toBeGreaterThan(0); // debited for injection
  });
});
