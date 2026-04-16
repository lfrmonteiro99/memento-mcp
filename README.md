# memento-mcp

Persistent memory MCP server for AI coding assistants. Stores typed memories (facts, decisions, preferences, patterns, architecture notes, pitfalls) in SQLite with FTS5 full-text search, memory decay scoring, and token-aware context injection via hooks. Compatible with Claude Code, Cursor, Windsurf, and any MCP client.

## Key Features

- **Typed memories** — 6 semantic categories: fact, decision, preference, pattern, architecture, pitfall
- **FTS5 full-text search** — fast ranked search with relevance scoring
- **Memory decay** — time-based score degradation (3 tiers: fresh / aging / stale)
- **Decisions log** — versioned architectural decisions with `supersedes_id` support
- **Pitfalls tracker** — recurring problem tracking with occurrence count and auto-dedup
- **Progressive disclosure** — `detail="index"` returns ~30 tokens/result; `memory_get(id)` fetches full body on demand
- **Smart hook skip** — trivial prompts ("ok", "yes", "done") skip memory injection entirely (~60% token waste eliminated)
- **Adaptive token budget** — per-session budget tracked in SQLite; scales results to tier (trivial=0, standard=3, complex=5)
- **File memory hybrid** — reads Claude Code's native `.md` memory files alongside SQLite results

## Install

```bash
npm install -g memento-mcp
memento-mcp install
```

The installer auto-detects your MCP client (Claude Code, Cursor, or manual), registers the MCP server, sets up hooks (Claude Code only), creates the data directory, and generates a default config file.

If running via `npx` without a global install, the installer will warn you — hooks require a globally installed binary to survive npm upgrades.

**Uninstall** (removes hooks + MCP config entry, keeps data):

```bash
memento-mcp uninstall
```

## Configuration

Config file: `~/.config/memento-mcp/config.toml` (Linux/macOS) or `%APPDATA%/memento-mcp/config.toml` (Windows).

```toml
[budget]
total = 8000          # per-session token budget for hooks
floor = 500           # minimum budget before scaling to 1 result
refill = 200          # tokens refilled on complex prompts
session_timeout = 1800  # seconds of idle before new session

[search]
default_detail = "full"
max_results = 10
body_preview_chars = 200

[hooks]
trivial_skip = true
session_start_memories = 5
session_start_pitfalls = 5
custom_trivial_patterns = []  # e.g. ["roger", "ack", "vale"]

[pruning]
enabled = true
max_age_days = 60
min_importance = 0.3
interval_hours = 24

[database]
path = ""  # empty = platform default
```

Environment variable overrides: `MEMENTO_BUDGET`, `MEMENTO_FLOOR`, `MEMENTO_LOG_LEVEL` (error/warn/info/debug, default: warn).

## MCP Tools

| Tool | Description |
|---|---|
| `memory_store` | Store a typed memory (fact/decision/preference/pattern/architecture/pitfall), project or global scope |
| `memory_search` | FTS5 search with `detail="index"` (titles only) or `detail="full"` (with body preview) |
| `memory_get` | Retrieve complete body of a specific memory by UUID — use after index search |
| `memory_list` | List memories without a query — filter by type, scope, or pinned status |
| `memory_delete` | Soft-delete a SQLite memory by ID (file memories are read-only) |
| `decisions_log` | Store, list, or search architectural decisions with category and versioning |
| `pitfalls_log` | Track recurring problems — auto-increments occurrence count on duplicate titles |

## Token Optimization

### Smart Hook Skip

Every user prompt is classified before querying the DB:

- **Trivial** (`ok`, `yes`, `done`, short acks, < 8 chars): skip entirely — 0 tokens spent
- **Standard**: inject up to 3 results
- **Complex** (> 150 chars, contains code blocks, file paths, or `/commands`): inject up to 5 results, partially refill budget

Custom trivial patterns configurable via `config.toml`.

### Progressive Disclosure

Use `memory_search(query, detail="index")` first to get titles + scores (~30 tokens/result), then `memory_get(id)` only for the results you need (~200–500 tokens each). Avoids loading full bodies for large result sets.

### Adaptive Token Budget

Each session has a token budget (default: 8000). Hook injections debit the budget. When the remaining budget falls below the floor (500), results are capped to 1 (never zero — minimum context always provided). Budget refills partially on complex prompts. Session resets after 30 minutes of idle.

## Comparison with claude-memory (Python)

| Feature | memento-mcp | claude-memory |
|---|---|---|
| Language | TypeScript / Node.js | Python |
| Memory types | 6 typed categories | Untyped |
| Search | FTS5 ranked + decay scoring | Basic keyword |
| Decay scoring | 3-tier time-based | None |
| Decisions log | Versioned with supersedes | None |
| Pitfalls tracker | Occurrence count + dedup | None |
| Progressive disclosure | `detail=index` + `memory_get` | None |
| Smart hook skip | Trivial prompt detection | None |
| Adaptive budget | Per-session SQLite tracking | None |
| Migration | DB copy from claude-memory | — |

**Migration from claude-memory:** the installer detects `~/.local/share/claude-memory/context.sqlite` and offers to copy the DB. No data transformation needed — schemas are structurally compatible.

## Native Addon Note

`better-sqlite3` is a native C++ addon. Pre-built binaries are available for Linux x64/arm64, macOS arm64/x64, and Windows x64. Compilation is required only for Alpine Linux (musl), unusual Node versions, or older glibc systems.

If you hit a compilation error:

```bash
npm install -g node-gyp
npm install -g memento-mcp --build-from-source
```

## Privacy

Debug logging (`MEMENTO_LOG_LEVEL=debug`) may include prompt keyword fragments used for FTS search. All logs go to stderr only. No data leaves the local machine.

## Development

```bash
npm install
npm test          # vitest — runs all 88 tests
npm run build     # tsup — outputs dist/
npm run dev       # tsup --watch
```

**Test structure:**

```
tests/
├── db/           # database, memories, decisions, pitfalls, sessions
├── hooks/        # search-context, session-context integration
├── lib/          # decay, budget, classify, formatter, config, file-memory, logger
└── tools/        # memory-tools, decisions-pitfalls MCP tool handlers
```

## License

MIT
