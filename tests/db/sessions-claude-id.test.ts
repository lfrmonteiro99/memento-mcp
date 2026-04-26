// tests/db/sessions-claude-id.test.ts
// Coverage for the claude_session_id branches in SessionsRepo.getOrCreate.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/db/database.js";
import { SessionsRepo } from "../../src/db/sessions.js";

describe("SessionsRepo — claude_session_id branches", () => {
  let db: ReturnType<typeof createDatabase>;
  let repo: SessionsRepo;
  let dbPath: string;
  const config = { total: 8000, floor: 500, sessionTimeout: 1800 };

  beforeEach(() => {
    dbPath = join(tmpdir(), `memento-sess-claude-${process.pid}-${randomUUID()}.sqlite`);
    db = createDatabase(dbPath);
    repo = new SessionsRepo(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("creates a session and stamps the claude_session_id", () => {
    const s = repo.getOrCreate(config, "claude-abc-1");
    expect(s.claude_session_id).toBe("claude-abc-1");
  });

  it("returns the same session on exact-match lookup by claude_session_id", () => {
    const s1 = repo.getOrCreate(config, "claude-abc-2");
    const s2 = repo.getOrCreate(config, "claude-abc-2");
    expect(s2.id).toBe(s1.id);
    expect(s2.claude_session_id).toBe("claude-abc-2");
  });

  it("backfills claude_session_id on an existing un-stamped session", () => {
    const s1 = repo.getOrCreate(config); // no claude id yet
    expect(s1.claude_session_id).toBeFalsy();

    const s2 = repo.getOrCreate(config, "claude-abc-3");
    // Same session, now stamped.
    expect(s2.id).toBe(s1.id);
    expect(s2.claude_session_id).toBe("claude-abc-3");

    // Persisted to DB.
    const row = db.prepare("SELECT claude_session_id FROM sessions WHERE id = ?").get(s1.id) as
      | { claude_session_id: string | null } | undefined;
    expect(row?.claude_session_id).toBe("claude-abc-3");
  });

  it("creates a brand-new session when there is no active match for the claude_session_id", () => {
    // Seed an aged session — should not be reused
    const stale = repo.getOrCreate(config, "claude-old");
    db.prepare("UPDATE sessions SET last_active = datetime('now','-90 minutes') WHERE id = ?").run(stale.id);

    const fresh = repo.getOrCreate(config, "claude-new");
    expect(fresh.id).not.toBe(stale.id);
    expect(fresh.claude_session_id).toBe("claude-new");
  });
});
