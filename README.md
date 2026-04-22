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

The package is hosted on **GitHub Packages** (not the public npm registry). You need a GitHub account and a Personal Access Token (PAT) with `read:packages` scope.

### 1. Create a GitHub PAT

Go to [GitHub → Settings → Developer Settings → Personal Access Tokens](https://github.com/settings/tokens) and create a token with `read:packages` checked.

### 2. Configure npm to use GitHub Packages for this scope

```bash
npm config set @lfrmonteiro99:registry https://npm.pkg.github.com
echo "//npm.pkg.github.com/:_authToken=YOUR_PAT_HERE" >> ~/.npmrc
```

Replace `YOUR_PAT_HERE` with the token you just created.

### 3. Install globally

```bash
npm install -g @lfrmonteiro99/memento-memory-mcp
```

The install wizard runs automatically. It auto-detects your MCP client (Claude Code, Cursor, or manual), registers the MCP server, sets up hooks (Claude Code only), creates the data directory, generates a default config file, and runs the **Obsidian vault wizard** (optional — see [Vault Integration](#vault-integration) below).

If running via `npx` without a global install, the installer will warn you — hooks require a globally installed binary to survive npm upgrades.

**Uninstall** (removes hooks + MCP config entry, keeps data):

```bash
memento-mcp uninstall
```

## Vault Integration

memento-mcp can index your [Obsidian](https://obsidian.md) vault and surface relevant notes directly in hook context. The install wizard asks if you want this — it auto-discovers vaults, scaffolds required root notes, and builds the index automatically.

### How it works

1. **Indexing** — `rebuildVaultIndex` scans the vault, parses YAML frontmatter, builds a graph of explicit `memento_children` links and `[[wikilinks]]`, and marks orphaned notes.
2. **Routing** — on each hook invocation, `searchVault` classifies the prompt intent (procedure/decision/project/domain), traverses the graph from root notes up to `max_hops`, and scores results by relevance × routing distance × note kind.
3. **Injection** — results above confidence threshold `0.25` are injected as `[vault/kind] title: summary` lines alongside SQLite and file memories.

### Required frontmatter

Notes are only indexed if they include `memento_publish: true` in their YAML frontmatter (configurable):

```yaml
---
memento_publish: true
memento_kind: skill          # identity | map | domain | project | playbook | skill | decision | source
memento_summary: One-line summary injected into hooks.
tags:
  - scheduling
---
```

### Root notes

Two root notes are required at the vault root (auto-created by the installer or `memento-mcp vault-index init`):

- **`me.md`** — your identity: role, working style, constraints
- **`vault.md`** — vault map: folder structure, routing rules, `memento_children` links

### CLI commands

```bash
# Full rebuild of the vault index
memento-mcp vault-index rebuild

# Scaffold me.md and vault.md if missing
memento-mcp vault-index init

# Show stats: total / reachable / orphaned / edges / roots
memento-mcp vault-index stats

# List orphaned and missing-root issues
memento-mcp vault-index doctor
```

### Vault config (config.toml)

```toml
[vault]
enabled = true
path = "/path/to/your/Obsidian/vault"
require_publish_flag = true   # only index notes with memento_publish: true
max_hops = 3                  # BFS depth from root notes
max_results = 5               # max results per memory_search call
hook_max_results = 2          # max vault results injected per hook invocation
```

The `include_folders` and `exclude_folders` defaults cover the standard Obsidian folder structure. Override in config if your vault layout differs.

### MCP tools — vault support

- **`memory_search`** — vault results appended after SQLite results when vault is enabled
- **`memory_get vault:path/to/note.md`** — fetch full content of a vault note by its `vault:` prefixed ID
- **`memory_list vault_kind=skill`** — list vault notes filtered by kind or folder

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
npm install -g @lfrmonteiro99/memento-memory-mcp --build-from-source
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
