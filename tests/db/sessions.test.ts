import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { SessionsRepo } from "../../src/db/sessions.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("SessionsRepo", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: SessionsRepo;
  const dbPath = join(tmpdir(), `memento-sess-test-${Date.now()}.sqlite`);

  beforeEach(() => { db = createDatabase(dbPath); repo = new SessionsRepo(db); });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("creates a new session with defaults", () => {
    const s = repo.getOrCreate({ total: 8000, floor: 500, sessionTimeout: 1800 });
    expect(s.budget).toBe(8000);
    expect(s.spent).toBe(0);
    expect(s.floor).toBe(500);
  });

  it("reuses active session within timeout", () => {
    const s1 = repo.getOrCreate({ total: 8000, floor: 500, sessionTimeout: 1800 });
    const s2 = repo.getOrCreate({ total: 8000, floor: 500, sessionTimeout: 1800 });
    expect(s1.id).toBe(s2.id);
  });

  it("creates new session after timeout", () => {
    const s1 = repo.getOrCreate({ total: 8000, floor: 500, sessionTimeout: 1800 });
    // Manually age the session
    db.prepare("UPDATE sessions SET last_active = datetime('now', '-31 minutes') WHERE id = ?").run(s1.id);
    const s2 = repo.getOrCreate({ total: 8000, floor: 500, sessionTimeout: 1800 });
    expect(s2.id).not.toBe(s1.id);
  });

  it("debits tokens from session", () => {
    const s = repo.getOrCreate({ total: 8000, floor: 500, sessionTimeout: 1800 });
    repo.debit(s.id, 1000);
    const updated = repo.getOrCreate({ total: 8000, floor: 500, sessionTimeout: 1800 });
    expect(updated.spent).toBe(1000);
  });

  it("refills tokens", () => {
    const s = repo.getOrCreate({ total: 8000, floor: 500, sessionTimeout: 1800 });
    repo.debit(s.id, 5000);
    repo.refill(s.id, 200);
    const updated = repo.getOrCreate({ total: 8000, floor: 500, sessionTimeout: 1800 });
    expect(updated.spent).toBe(4800);
  });

  it("refill does not go below 0 spent", () => {
    const s = repo.getOrCreate({ total: 8000, floor: 500, sessionTimeout: 1800 });
    repo.refill(s.id, 200);
    const updated = repo.getOrCreate({ total: 8000, floor: 500, sessionTimeout: 1800 });
    expect(updated.spent).toBe(0);
  });
});
