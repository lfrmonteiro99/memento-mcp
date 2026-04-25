import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { nowIso } from "./database.js";

export interface SessionConfig {
  total: number;
  floor: number;
  sessionTimeout: number; // seconds
}

export interface Session {
  id: string;
  budget: number;
  spent: number;
  floor: number;
  created_at: string;
  last_active: string;
  claude_session_id?: string | null;
}

export class SessionsRepo {
  constructor(private db: Database.Database) {}

  getOrCreate(config: SessionConfig, claudeSessionId?: string): Session {
    const timeoutMinutes = Math.floor(config.sessionTimeout / 60);

    // If we have a claude_session_id, try to find an exact match first
    if (claudeSessionId) {
      const exact = this.db.prepare(
        "SELECT * FROM sessions WHERE claude_session_id = ? ORDER BY last_active DESC LIMIT 1"
      ).get(claudeSessionId) as Session | undefined;
      if (exact) {
        this.db.prepare("UPDATE sessions SET last_active = ? WHERE id = ?").run(nowIso(), exact.id);
        return exact;
      }
    }

    const active = this.db.prepare(`
      SELECT * FROM sessions
      WHERE last_active > datetime('now', ? || ' minutes')
      ORDER BY last_active DESC LIMIT 1
    `).get(`-${timeoutMinutes}`) as Session | undefined;

    if (active) {
      this.db.prepare("UPDATE sessions SET last_active = ? WHERE id = ?").run(nowIso(), active.id);
      // Backfill claude_session_id if not set
      if (claudeSessionId && !active.claude_session_id) {
        this.db.prepare("UPDATE sessions SET claude_session_id = ? WHERE id = ?").run(claudeSessionId, active.id);
        active.claude_session_id = claudeSessionId;
      }
      return active;
    }

    const id = randomUUID();
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO sessions (id, budget, spent, floor, created_at, last_active, claude_session_id)
      VALUES (?, ?, 0, ?, ?, ?, ?)
    `).run(id, config.total, config.floor, now, now, claudeSessionId ?? null);

    return { id, budget: config.total, spent: 0, floor: config.floor, created_at: now, last_active: now, claude_session_id: claudeSessionId ?? null };
  }

  debit(sessionId: string, tokens: number): void {
    this.db.prepare("UPDATE sessions SET spent = spent + ?, last_active = ? WHERE id = ?")
      .run(tokens, nowIso(), sessionId);
  }

  refill(sessionId: string, tokens: number): void {
    this.db.prepare("UPDATE sessions SET spent = MAX(0, spent - ?), last_active = ? WHERE id = ?")
      .run(tokens, nowIso(), sessionId);
  }
}
