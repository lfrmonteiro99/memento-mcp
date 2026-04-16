# Memento MCP — Design Spec v2

**Date:** 2026-04-16
**Author:** Luis Monteiro
**Status:** Approved for implementation (v2 — with senior review fixes)

## Overview

Persistent memory MCP server for AI coding assistants. Stores typed memories (facts, decisions, preferences, patterns, architecture notes, pitfalls) in SQLite with FTS5 full-text search, memory decay scoring, and token-aware context injection via hooks.

**Differentiators vs claude-mem:** typed memories with semantic categories, memory decay (time-based score degradation), decisions log with versioning (supersedes_id), pitfalls tracker with occurrence counting, hybrid SQLite + Claude Code file-based memory reader, adaptive token budget per session.

**Distribution:** npm package. Install: `npm install -g memento-mcp && memento-mcp install`. MCP server compatible with Claude Code, Cursor, Windsurf, and any MCP client.

**Language:** TypeScript (Node.js). SQLite via `better-sqlite3`.

**All user-facing messages in English.** No hardcoded Portuguese strings.

## Architecture

```
memento-mcp/
├── src/
│   ├── index.ts              # MCP server entry point (@modelcontextprotocol/sdk)
│   ├── tools/
│   │   ├── memory-store.ts
│   │   ├── memory-search.ts
│   │   ├── memory-get.ts      # Progressive disclosure detail fetch
│   │   ├── memory-list.ts
│   │   ├── memory-delete.ts
│   │   ├── decisions-log.ts
│   │   └── pitfalls-log.ts
│   ├── db/
│   │   ├── database.ts        # SQLite connection, migrations via PRAGMA user_version
│   │   ├── memories.ts        # Memory CRUD + FTS5 queries
│   │   ├── decisions.ts       # Decision CRUD + FTS5
│   │   ├── pitfalls.ts        # Pitfall CRUD + occurrence tracking
│   │   └── sessions.ts        # Session budget tracking
│   ├── hooks/
│   │   ├── search-context.ts  # UserPromptSubmit hook (smart skip + budget-aware)
│   │   └── session-context.ts # SessionStart hook (budget init)
│   ├── lib/
│   │   ├── decay.ts           # Memory decay scoring (3-tier)
│   │   ├── budget.ts          # Token estimation + budget logic
│   │   ├── classify.ts        # Prompt classification (trivial/standard/complex)
│   │   ├── config.ts          # TOML config loader + env override
│   │   ├── file-memory.ts     # Claude Code .md file reader
│   │   ├── formatter.ts       # Output formatters (index/full/detail)
│   │   └── logger.ts          # Structured logger to stderr
│   └── cli/
│       ├── install.ts         # Interactive installer
│       └── main.ts            # CLI entry (memento-mcp <command>)
├── package.json
├── tsconfig.json
├── README.md
├── LICENSE (MIT)
└── tests/
    ├── db/
    ├── hooks/
    ├── lib/
    └── tools/
```

## Build Pipeline

**Bundler:** `tsup` (fast, ESM output, zero config).

```json
{
  "scripts": {
    "build": "tsup src/index.ts src/cli/main.ts src/hooks/search-context.ts src/hooks/session-context.ts --format esm --dts --clean",
    "dev": "tsup --watch",
    "test": "vitest",
    "prepublishOnly": "npm run build && npm test"
  }
}
```

Output to `dist/`. Published package includes only `dist/`, `package.json`, `README.md`, `LICENSE`.

## Data Flow

```
SessionStart hook
  → create/resume session in SQLite (budget init)
  → inject top 5 memories + 5 pitfalls
  → debit ~600 tokens from session budget

UserPromptSubmit hook (every prompt)
  → classify prompt: trivial / standard / complex
  → if trivial OR budget < floor: exit 0 (zero tokens spent)
  → else: search DB (limit scaled to tier), inject results, debit budget
  → if complex: refill budget partially

MCP Tools (called by LLM explicitly — NOT budget-tracked)
  → memory_search(detail="index"): titles + scores (~30 tokens/result)
  → memory_search(detail="full"): titles + body preview (~120 tokens/result)
  → memory_get(id): full body, no truncation (~200-500 tokens)
  → memory_store / delete / decisions_log / pitfalls_log: unchanged semantics
```

## Database Schema

SQLite with WAL mode, FTS5 full-text search, auto-synced triggers.

### Schema Migrations

Uses `PRAGMA user_version` for tracking. Migrations are numbered and applied in order at startup:

```typescript
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    sql: `-- All CREATE TABLE, CREATE INDEX, CREATE VIRTUAL TABLE, CREATE TRIGGER statements`
  },
  // Future: { version: 2, name: "add_column_x", sql: "ALTER TABLE ..." }
];

function migrate(db: Database) {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (const m of MIGRATIONS) {
    if (m.version > current) {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    }
  }
}
```

### Tables (v1 migration)

```sql
CREATE TABLE projects (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    root_path  TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE memories (
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

CREATE VIRTUAL TABLE memory_fts USING fts5(
    title, body,
    content='memories', content_rowid='rowid'
);

CREATE TABLE decisions (
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

CREATE VIRTUAL TABLE decisions_fts USING fts5(
    title, body,
    content='decisions', content_rowid='rowid'
);

CREATE TABLE pitfalls (
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

CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,
    budget      INTEGER NOT NULL DEFAULT 8000,
    spent       INTEGER NOT NULL DEFAULT 0,
    floor       INTEGER NOT NULL DEFAULT 500,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_active TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Indexes

```sql
CREATE INDEX idx_memories_project ON memories(project_id);
CREATE INDEX idx_memories_type ON memories(memory_type);
CREATE INDEX idx_memories_scope ON memories(scope);
CREATE INDEX idx_memories_active ON memories(project_id, updated_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_memories_pruning ON memories(is_pinned, importance_score, last_accessed_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_decisions_project ON decisions(project_id, importance_score DESC);
CREATE INDEX idx_pitfalls_project ON pitfalls(project_id) WHERE deleted_at IS NULL AND resolved = 0;
```

### FTS Sync Triggers

INSERT/UPDATE/DELETE triggers on `memories` and `decisions` tables automatically sync the FTS5 virtual tables. Standard FTS5 external content pattern.

### FTS5 Query Sanitization

Tokens must be sanitized before FTS5 MATCH to prevent syntax injection:

```typescript
function sanitizeFtsToken(token: string): string {
  return token.replace(/"/g, '""');
}

function buildFtsQuery(query: string): string {
  const tokens = query.split(/\s+/).filter(t => t.length > 0);
  return tokens.map(t => `"${sanitizeFtsToken(t)}"`).join(" OR ");
}
```

## MCP Tools

### memory_search

```typescript
{
  name: "memory_search",
  params: {
    query: string,
    project_path?: string,
    memory_type?: string,        // fact|decision|preference|pattern|architecture|pitfall
    limit?: number,              // default 10
    detail?: "index" | "full",   // default "full"
    include_file_memories?: boolean,  // default true
  }
}
```

**detail="index"** (~30 tokens/result):
```
- [fact] User profile: Luis Monteiro (score:0.85, id:ea6f7a28-69e3-4368-962c-e7da68d0ffdd)
```

**detail="full"** (~120 tokens/result):
```
[sqlite] (fact) User profile: Luis Monteiro
  ID: ea6f7a28-69e3-4368-962c-e7da68d0ffdd
  Luis Monteiro, developer at Sinmetro. Works on ACCEPT platform...
  Score: 0.85 | Created: 2026-04-01T15:26:18Z
```

IDs always returned in FULL (36-char UUID), never truncated.

### memory_get

```typescript
{
  name: "memory_get",
  params: {
    memory_id: string,  // full UUID or file:path ID
  }
}
```

Returns complete body without truncation. Works for both SQLite and file-based memories.

### memory_store

Types: fact, decision, preference, pattern, architecture, pitfall. Scope: project or global. Supports supersedes_id for versioning, pin for pruning protection.

### memory_delete

Soft-delete by ID. SQLite memories only (file memories are read-only).

### memory_list

Same as memory_search but no query — filter by project/type/scope/pinned. Gains `detail` parameter.

### decisions_log

Action-based: store, list, search. Categories: general, architecture, tooling, convention, performance. Supports supersedes_id.

### pitfalls_log

Action-based: store, list, resolve. Auto-increments occurrence_count on duplicate title. Tracks last_seen_at.

## Token Optimization

### 1. Smart Hook Skip (hooks/search-context.ts)

```typescript
const BUILTIN_TRIVIAL = new Set([
  "ok","sim","não","yes","no","bora","go","next","done","já","feito",
  "sure","yep","nope","k","thanks","obrigado","confirmo","approved",
  "got it","agreed","proceed","continue","lgtm"
]);

function classifyPrompt(prompt: string, config: Config): "trivial" | "standard" | "complex" {
  const stripped = prompt.trim().toLowerCase().replace(/[!?.,]+$/, "");

  // Merge builtin + user-configured trivial patterns
  const trivial = new Set([...BUILTIN_TRIVIAL, ...config.hooks.customTrivialPatterns]);
  if (trivial.has(stripped) || stripped.length < 8) return "trivial";

  const hasCode = prompt.includes("```");
  const hasPath = /[/\\][\w.-]+[/\\]/.test(prompt);
  const hasSlashCmd = prompt.trimStart().startsWith("/");
  if (prompt.length > 150 || hasCode || hasPath || hasSlashCmd) return "complex";

  return "standard";
}
```

Tier → max results: trivial=0 (skip), standard=3, complex=5.

Custom patterns configurable:
```toml
[hooks]
custom_trivial_patterns = ["roger", "ack", "vale", "pronto"]
```

**Estimated saving:** ~60% of hook token waste eliminated.

### 2. Progressive Disclosure (memory_search detail param)

LLM calls `memory_search(query, detail="index")` first (~30 tokens/result), then `memory_get(id)` only for results it needs (~200-500 tokens each).

**Estimated saving:** ~15% of MCP tool token waste for queries with >5 results.

### 3. Adaptive Token Budget (sessions table)

Per-session budget tracked in SQLite. Session detected by activity gap (>30 min idle = new session).

```typescript
const session = db.getOrCreateSession(config);
const remaining = session.budget - session.spent;

if (remaining < session.floor) {
  maxResults = 1;  // floor: always allow minimum context
} else if (tier === "trivial") {
  return;  // skip entirely
} else if (tier === "complex") {
  db.refillSession(session.id, config.refill);
  maxResults = 5;
} else {
  maxResults = 3;
}

// After injection
const tokensSpent = estimateTokens(output); // Math.ceil(output.length / 4)
db.debitSession(session.id, tokensSpent);
```

**Defaults:** budget=8000, floor=500, refill=200, session_timeout=1800s. All configurable.

**Estimated saving:** ~5% additional, prevents budget exhaustion in long sessions.

## Memory Decay

3-tier time-based decay applied to search scores:

| Days since last access | Decay factor |
|---|---|
| 0–14 | 1.0 (no decay) |
| 14–30 | 0.75 |
| >30 | 0.5 |

Scoring: `finalScore = (normalizedFTSRank * 0.6 + importanceScore * 0.4) * decayFactor`

## File Memory Integration

Reads Claude Code's native `.md` memory files from `~/.claude/projects/<sanitized-path>/memory/`. Parses YAML frontmatter for metadata (name, description, type). Returns as read-only results alongside SQLite results.

Falls back gracefully (empty list) when directory doesn't exist (non-Claude-Code clients).

## Automatic Pruning

Background interval runs every 24 hours + once on startup. Soft-deletes memories that are:
- Not pinned (`is_pinned = 0`)
- Low importance (`importance_score < 0.3`)
- Stale (`last_accessed_at > 60 days ago`)

All thresholds configurable via config file.

## Configuration

**File:** `~/.config/memento-mcp/config.toml`

```toml
[budget]
total = 8000
floor = 500
refill = 200
session_timeout = 1800

[search]
default_detail = "full"
max_results = 10
body_preview_chars = 200

[hooks]
trivial_skip = true
session_start_memories = 5
session_start_pitfalls = 5
custom_trivial_patterns = []

[pruning]
enabled = true
max_age_days = 60
min_importance = 0.3
interval_hours = 24

[database]
path = ""  # empty = default platform path
```

**Load hierarchy:** hardcoded defaults → TOML config file → env vars (`MEMENTO_BUDGET`, `MEMENTO_FLOOR`, etc.)

**TOML parsing:** `smol-toml` (zero-dependency, ESM native).

**Platform paths:**
- Linux: data `~/.local/share/memento-mcp/`, config `~/.config/memento-mcp/`
- macOS: data `~/Library/Application Support/memento-mcp/`, config same
- Windows: data+config `%APPDATA%/memento-mcp/`

## Distribution

### package.json

```json
{
  "name": "memento-mcp",
  "version": "1.0.0",
  "description": "Persistent memory MCP server with typed memories, decay scoring, and token-aware context injection",
  "bin": {
    "memento-mcp": "./dist/cli/main.js",
    "memento-hook-search": "./dist/hooks/search-context.js",
    "memento-hook-session": "./dist/hooks/session-context.js"
  },
  "type": "module",
  "engines": { "node": ">=18" },
  "license": "MIT",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "better-sqlite3": "^11.0.0",
    "smol-toml": "^1.0.0"
  },
  "devDependencies": {
    "tsup": "^8.0.0",
    "vitest": "^2.0.0",
    "typescript": "^5.5.0",
    "@types/better-sqlite3": "^7.0.0"
  }
}
```

Hooks registered as **bin entry points** (not file paths). Survives npm upgrades.

### Installation Flow

```bash
npm install -g memento-mcp    # step 1: global install (persistent)
memento-mcp install            # step 2: configure client
```

If user runs `npx memento-mcp install` without global install, installer detects and prompts:
```
memento-mcp is not installed globally. Hooks require a global install.
Run: npm install -g memento-mcp
Then: memento-mcp install
```

### Installer Steps (memento-mcp install)

1. **Detect client**: Claude Code (`~/.claude/settings.json`), Cursor (`~/.cursor/mcp.json`), or manual
2. **Register MCP server** in client config (atomic: read → modify → write temp → rename)
3. **Register hooks** (Claude Code only — SessionStart + UserPromptSubmit, append to existing hooks)
4. **Create data directory** (platform-appropriate path)
5. **Migration check**: if `~/.local/share/claude-memory/context.sqlite` exists, offer to copy DB
6. **Create default config**: `~/.config/memento-mcp/config.toml` with commented defaults, permissions 0600
7. **Verify**: test DB connection, print success summary

**Uninstall:** `memento-mcp uninstall` (removes hooks + MCP config entry, keeps data + config).

### better-sqlite3 Native Addon Note

`better-sqlite3` is a native C++ addon. Pre-built binaries are published for common platforms (Windows x64, macOS arm64/x64, Linux x64/arm64). Most users get a binary download, no compilation needed.

Edge cases requiring compilation: unusual Node versions, musl Linux (Alpine), older glibc. Document in README troubleshooting section.

## Logging

All logging to stderr (stdout = MCP transport). Structured logger:
- `error`: DB failures, hook crashes
- `warn`: budget exhausted, pruning failures
- `info`: session created, pruning count
- `debug`: search queries, budget debits (off by default)

Config: `MEMENTO_LOG_LEVEL` env var. Default: `warn`.

Debug logging may contain prompt fragments (keyword extraction). Noted in README privacy section.

## Error Resilience

**Hooks:** MUST fail silently. Broken hook blocks Claude Code prompt pipeline. All hook code in try/catch, exit 0 on any error, log to stderr only.

**MCP tools:** Return descriptive error strings (not exceptions). LLM sees error and can adapt.

**Graceful shutdown:** SIGTERM/SIGINT handler closes SQLite connection cleanly.

## Testing Strategy

**Framework:** vitest

- **Unit tests**: db CRUD, decay math, budget logic, prompt classification, FTS5 sanitization, formatters
- **Integration tests**: hook stdin→stdout contract (pipe JSON, assert output format)
- **Prompt classification regression**: edge cases ("fix it", "yes/no", emoji, pasted error log, "/commit")
- **FTS5 search quality**: known queries → expected ranking
- **Budget flow**: session create → debit → floor → refill → timeout → new session

## Migration from claude-memory (Python)

SQLite schema is structurally identical. Migration = DB file copy. Installer detects `~/.local/share/claude-memory/context.sqlite` and offers migration with user confirmation. No data transformation needed.

The new `sessions` table is additive — doesn't affect existing data. `PRAGMA user_version` starts at 0 for migrated DBs; migration runner applies version 1 schema additions.
