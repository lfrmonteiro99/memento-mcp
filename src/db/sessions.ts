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
}

export class SessionsRepo {
  constructor(private db: Database.Database) {}

  getOrCreate(config: SessionConfig): Session {
    const timeoutMinutes = Math.floor(config.sessionTimeout / 60);
    const active = this.db.prepare(`
      SELECT * FROM sessions
      WHERE last_active > datetime('now', ? || ' minutes')
      ORDER BY last_active DESC LIMIT 1
    `).get(`-${timeoutMinutes}`) as Session | undefined;

    if (active) {
      this.db.prepare("UPDATE sessions SET last_active = ? WHERE id = ?").run(nowIso(), active.id);
      return active;
    }

    const id = randomUUID();
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO sessions (id, budget, spent, floor, created_at, last_active)
      VALUES (?, ?, 0, ?, ?, ?)
    `).run(id, config.total, config.floor, now, now);

    return { id, budget: config.total, spent: 0, floor: config.floor, created_at: now, last_active: now };
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
