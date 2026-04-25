import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

interface Migration {
  version: number;
  name: string;
  sql: string;
  afterSql?: (db: Database.Database) => void;
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
  {
    version: 2,
    name: "v2_analytics_compression_adaptive",
    sql: `
CREATE TABLE IF NOT EXISTS analytics_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    project_id TEXT,
    memory_id TEXT,
    event_type TEXT NOT NULL,
    event_data TEXT,
    tokens_cost INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_analytics_session ON analytics_events(session_id);
CREATE INDEX IF NOT EXISTS idx_analytics_memory ON analytics_events(memory_id);
CREATE INDEX IF NOT EXISTS idx_analytics_type ON analytics_events(event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics_events(created_at);

CREATE TABLE IF NOT EXISTS compression_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    compressed_memory_id TEXT NOT NULL,
    source_memory_ids TEXT NOT NULL,
    tokens_before INTEGER NOT NULL,
    tokens_after INTEGER NOT NULL,
    compression_ratio REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_compression_memory ON compression_log(compressed_memory_id);
`,
    afterSql: (db: Database.Database) => {
      const columns = db.pragma("table_info(memories)") as Array<{ name: string }>;
      const columnNames = columns.map(c => c.name);

      if (!columnNames.includes("source")) {
        db.exec("ALTER TABLE memories ADD COLUMN source TEXT DEFAULT 'user'");
      }
      if (!columnNames.includes("adaptive_score")) {
        db.exec("ALTER TABLE memories ADD COLUMN adaptive_score REAL DEFAULT 0.5");
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_memories_project_active_score
        ON memories(project_id, deleted_at, adaptive_score DESC)
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_memories_project_source
        ON memories(project_id, source, deleted_at)
      `);


      // K5: Convert CSV-format tags to JSON arrays. Legacy v1 rows stored tags as
      // comma-joined strings; v2 expects JSON. Detect by first-character: a JSON
      // array starts with '['. Leave NULL and already-JSON rows alone.
      const csvRows = db.prepare(
        "SELECT id, tags FROM memories WHERE tags IS NOT NULL AND tags != '' AND substr(tags, 1, 1) != '['"
      ).all() as Array<{ id: string; tags: string }>;
      const updateTags = db.prepare("UPDATE memories SET tags = ? WHERE id = ?");
      for (const row of csvRows) {
        const parts = row.tags.split(",").map((t: string) => t.trim()).filter((t: string) => t.length > 0);
        updateTags.run(JSON.stringify(parts), row.id);
      }
    },
  },
  {
    version: 3,
    name: "vault_index",
    sql: `
CREATE TABLE IF NOT EXISTS vault_notes (
  id              TEXT PRIMARY KEY,
  vault_path      TEXT NOT NULL,
  relative_path   TEXT NOT NULL,
  title           TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'source',
  summary         TEXT,
  aliases_json    TEXT,
  tags_json       TEXT,
  body_mode       TEXT NOT NULL DEFAULT 'summary',
  weight          REAL NOT NULL DEFAULT 1.0,
  routable        INTEGER NOT NULL DEFAULT 1,
  blocked         INTEGER NOT NULL DEFAULT 0,
  orphan          INTEGER NOT NULL DEFAULT 1,
  mtime_ms        INTEGER NOT NULL DEFAULT 0,
  body_hash       TEXT,
  breadcrumb_json TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_vault_notes_path ON vault_notes(vault_path, relative_path);
CREATE INDEX IF NOT EXISTS idx_vault_notes_kind ON vault_notes(kind);
CREATE INDEX IF NOT EXISTS idx_vault_notes_routable ON vault_notes(routable, orphan);

CREATE TABLE IF NOT EXISTS vault_edges (
  from_id   TEXT NOT NULL,
  to_id     TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  weight    REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (from_id, to_id, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_vault_edges_from ON vault_edges(from_id);
CREATE INDEX IF NOT EXISTS idx_vault_edges_to ON vault_edges(to_id);

CREATE TABLE IF NOT EXISTS vault_roots (
  note_id   TEXT PRIMARY KEY,
  root_type TEXT NOT NULL
);
`,
  },
  {
    version: 4,
    name: "embeddings",
    sql: `
CREATE TABLE IF NOT EXISTS embeddings (
  memory_id   TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  model       TEXT NOT NULL,
  dim         INTEGER NOT NULL,
  vector      BLOB NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model);
`,
  },
  {
    version: 5,
    name: "claude_session_id",
    sql: "",
    afterSql: (db: Database.Database) => {
      // Guard: sessions table may not exist if a minimal v1 schema was seeded manually
      const existingTables5 = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
          .map(r => r.name)
      );
      if (existingTables5.has("sessions")) {
        const sessionCols = db.pragma("table_info(sessions)") as Array<{ name: string }>;
        const sessionColNames = sessionCols.map(c => c.name);
        if (!sessionColNames.includes("claude_session_id")) {
          db.exec("ALTER TABLE sessions ADD COLUMN claude_session_id TEXT");
        }
      }

      const memoryCols = db.pragma("table_info(memories)") as Array<{ name: string }>;
      const memoryColNames = memoryCols.map(c => c.name);
      if (!memoryColNames.includes("claude_session_id")) {
        db.exec("ALTER TABLE memories ADD COLUMN claude_session_id TEXT");
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_memories_claude_session
        ON memories(claude_session_id) WHERE deleted_at IS NULL
      `);
    },
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
      // I5: Wrap each migration step in a transaction (SQL + afterSql + version bump).
      // Note: PRAGMA user_version takes effect immediately but the SQL + afterSql changes
      // are rolled back if the transaction fails, leaving the DB in the previous version.
      db.transaction(() => {
        db.exec(migration.sql);
        if (migration.afterSql) {
          migration.afterSql(db);
        }
        db.pragma(`user_version = ${migration.version}`);
      })();
    }
  }

  // Apply FTS triggers separately (CREATE TRIGGER IF NOT EXISTS is idempotent).
  // Guard: only create triggers if the referenced tables exist (e.g. a test may
  // seed a partial v1 schema that lacks decisions/decisions_fts).
  const existingTables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map(r => r.name)
  );
  if (existingTables.has("memory_fts")) {
    db.exec(`
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
`);
  }
  if (existingTables.has("decisions_fts")) {
    db.exec(`
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
`);
  }

  return db;
}

export function nowIso(): string {
  return new Date().toISOString().replace("T", "T").split(".")[0] + "Z";
}
