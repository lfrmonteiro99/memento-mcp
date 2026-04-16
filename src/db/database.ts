import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    sql: `
CREATE TABLE IF NOT EXISTS projects (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    root_path  TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memories (
    id                   TEXT PRIMARY KEY,
    project_id           TEXT REFERENCES projects(id),
    memory_type          TEXT NOT NULL DEFAULT 'fact',
    scope                TEXT NOT NULL DEFAULT 'project',
    title                TEXT NOT NULL,
    body                 TEXT,
    tags                 TEXT,
    importance_score     REAL DEFAULT 0.5,
    confidence_score     REAL DEFAULT 0.5,
    access_count         INTEGER NOT NULL DEFAULT 0,
    last_accessed_at     TEXT,
    is_pinned            INTEGER NOT NULL DEFAULT 0,
    supersedes_memory_id TEXT REFERENCES memories(id),
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at           TEXT
);

CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(project_id, updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_memories_pruning ON memories(is_pinned, importance_score, last_accessed_at) WHERE deleted_at IS NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    title, body,
    content='memories', content_rowid='rowid'
);

CREATE TABLE IF NOT EXISTS decisions (
    id               TEXT PRIMARY KEY,
    project_id       TEXT NOT NULL REFERENCES projects(id),
    title            TEXT NOT NULL,
    body             TEXT NOT NULL,
    category         TEXT NOT NULL DEFAULT 'general',
    importance_score REAL NOT NULL DEFAULT 0.5,
    supersedes_id    TEXT REFERENCES decisions(id),
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project_id, importance_score DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
    title, body,
    content='decisions', content_rowid='rowid'
);

CREATE TABLE IF NOT EXISTS pitfalls (
    id               TEXT PRIMARY KEY,
    project_id       TEXT NOT NULL REFERENCES projects(id),
    title            TEXT NOT NULL,
    body             TEXT NOT NULL,
    occurrence_count INTEGER NOT NULL DEFAULT 1,
    importance_score REAL NOT NULL DEFAULT 0.5,
    last_seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
    resolved         INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_pitfalls_project ON pitfalls(project_id) WHERE deleted_at IS NULL AND resolved = 0;

CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    budget      INTEGER NOT NULL DEFAULT 8000,
    spent       INTEGER NOT NULL DEFAULT 0,
    floor       INTEGER NOT NULL DEFAULT 500,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_active TEXT NOT NULL DEFAULT (datetime('now'))
);
`,
  },
];

const FTS_TRIGGERS_SQL = `
-- FTS sync triggers for memories
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memory_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
    INSERT INTO memory_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

-- FTS sync triggers for decisions
CREATE TRIGGER IF NOT EXISTS decisions_ai AFTER INSERT ON decisions BEGIN
    INSERT INTO decisions_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS decisions_ad AFTER DELETE ON decisions BEGIN
    INSERT INTO decisions_fts(decisions_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS decisions_au AFTER UPDATE ON decisions BEGIN
    INSERT INTO decisions_fts(decisions_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
    INSERT INTO decisions_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
`;

export function createDatabase(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new BetterSqlite3(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  const currentVersion = db.pragma("user_version", { simple: true }) as number;

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    }
  }

  // Apply FTS triggers separately (CREATE TRIGGER IF NOT EXISTS is idempotent)
  db.exec(FTS_TRIGGERS_SQL);

  return db;
}

export function nowIso(): string {
  return new Date().toISOString().replace("T", "T").split(".")[0] + "Z";
}
