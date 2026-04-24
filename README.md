# memento-mcp

Persistent memory MCP server for coding agents and apps. `memento-mcp` stores typed operational memory in SQLite, can index a curated Obsidian vault, and injects relevant context back into supported clients.

![Memento Memory MCP overview](docs/assets/hero-overview.png)

## What It Is

`memento-mcp` has two complementary knowledge layers:

- **SQLite memory layer** for fast, typed, operational memory written by the agent
- **Vault knowledge layer** for curated Markdown notes from an Obsidian vault

That split is intentional:

- `memory_store` always writes to SQLite
- vault notes are read, routed, indexed, and optionally promoted from stored memories
- searches and hooks can combine SQLite memories, vault notes, and legacy file memories

![What is Memento Memory MCP](docs/assets/what-is-memento-memory-mcp.png)

## Why Use It

- **Typed memory**: fact, decision, preference, pattern, architecture, pitfall
- **Fast search**: FTS5 ranking with decay-aware scoring
- **Hook-ready context injection**: useful for Claude Code and similar workflows
- **Curated vault support**: route through `me.md`, `vault.md`, maps, skills, and playbooks
- **Optional vault promotion**: persist a memory to SQLite and also write it into your vault
- **Local-first**: SQLite and vault files stay on your machine

![Why use Memento Memory MCP](docs/assets/why-use-memento-memory-mcp.png)

## Prerequisites

Before installation, make sure you have:

- **Node.js** `>=18`
- **npm**
- a **GitHub Personal Access Token** with `read:packages` to install from GitHub Packages
- a supported MCP client such as **Codex**, **Claude Code**, **Cursor**, or another stdio-compatible MCP client

Recommended:

- **Node 20** for development and test runs
- an **Obsidian vault** if you want vault integration

If `better-sqlite3` needs compilation on your machine, install the usual native build prerequisites for Node addons.

## Install

The package is published on **GitHub Packages**, not the public npm registry.

### 1. Configure npm for GitHub Packages

```bash
npm config set @lfrmonteiro99:registry https://npm.pkg.github.com
echo "//npm.pkg.github.com/:_authToken=YOUR_PAT_HERE" >> ~/.npmrc
```

Replace `YOUR_PAT_HERE` with a GitHub PAT that has `read:packages`.

### 2. Install globally

```bash
npm install -g @lfrmonteiro99/memento-memory-mcp
```

Global install matters because:

- the executable `memento-mcp` is then available on `PATH`
- Claude Code hooks can call `memento-hook-search`, `memento-hook-session`, and `memento-hook-capture`

### 3. Optional installer

You can still run the installer:

```bash
memento-mcp install
```

But the manual setup below is the stable path if the client-specific `add` flows are not behaving well.

## Manual Client Setup

Restart the client after editing its config.

### Codex

Codex uses `~/.codex/config.toml`.

Add:

```toml
[mcp_servers.memento-mcp]
command = "memento-mcp"
args = []
```

If `memento-mcp` is not on `PATH`, use an absolute command instead. A working example looks like:

```toml
[mcp_servers.memento-mcp]
command = "/home/you/.nvm/versions/node/v20.20.2/bin/node"
args = ["/home/you/.nvm/versions/node/v20.20.2/lib/node_modules/@lfrmonteiro99/memento-memory-mcp/dist/cli/main.js"]
```

### Claude Code

Claude Code uses `~/.claude/settings.json`.

Add the MCP server:

```json
{
  "mcpServers": {
    "memento-mcp": {
      "command": "memento-mcp",
      "args": [],
      "type": "stdio"
    }
  }
}
```

If you want context hooks as well, add:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "memento-hook-session", "timeout": 5 }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "memento-hook-search", "timeout": 5 }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash|Read|Grep|Edit",
        "hooks": [
          { "type": "command", "command": "memento-hook-capture", "timeout": 5 }
        ]
      }
    ]
  }
}
```

Notes:

- `SessionStart` injects initial memory context
- `UserPromptSubmit` injects query-time memory context
- `PostToolUse` is optional but enables auto-capture from tool results

### Cursor

Cursor uses `~/.cursor/mcp.json`.

Add:

```json
{
  "mcpServers": {
    "memento-mcp": {
      "command": "memento-mcp",
      "args": []
    }
  }
}
```

### Generic MCP Client

If your client supports stdio MCP servers, use this shape:

```json
{
  "command": "memento-mcp",
  "args": [],
  "type": "stdio"
}
```

If PATH resolution is unreliable in your client, prefer the absolute `node` + `dist/cli/main.js` form shown above for Codex.

## Verify Installation

After setup:

1. Restart your client
2. Confirm the MCP server appears in the client
3. Call:

```text
memory_store(title="test", content="hello", memory_type="fact", scope="global")
```

4. Then call:

```text
memory_search(query="hello", detail="full")
```

If both work, the MCP server is wired correctly.

## Configuration

Config file:

- Linux/macOS: `~/.config/memento-mcp/config.toml`
- Windows: `%APPDATA%/memento-mcp/config.toml`

Example:

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
path = ""

[vault]
enabled = false
path = ""
require_publish_flag = true
max_hops = 3
max_results = 5
hook_max_results = 2
auto_promote_types = []
```

Environment variable overrides:

- `MEMENTO_BUDGET`
- `MEMENTO_FLOOR`
- `MEMENTO_REFILL`
- `MEMENTO_SESSION_TIMEOUT`
- `MEMENTO_LOG_LEVEL`

## Vault Integration

When enabled, `memento-mcp` can index an Obsidian vault and use it as a curated knowledge source.

### How vault integration works

1. `rebuildVaultIndex` scans the vault and parses frontmatter
2. graph edges are built from `memento_children` and `[[wikilinks]]`
3. routable notes are stored in SQLite index tables
4. `memory_search`, `memory_list`, `memory_get`, and hooks can surface relevant vault notes

### Required root notes

At the root of the vault:

- `me.md`
- `vault.md`

### Required frontmatter

```yaml
---
memento_publish: true
memento_kind: skill
memento_summary: One-line summary used by memento-mcp.
tags:
  - scheduling
---
```

Supported note kinds:

- `identity`
- `map`
- `project`
- `effort`
- `domain`
- `decision`
- `playbook`
- `skill`
- `source`

### Vault commands

```bash
memento-mcp vault-index init
memento-mcp vault-index rebuild
memento-mcp vault-index stats
memento-mcp vault-index doctor
```

## SQLite vs Obsidian

Use `SQLite` for:

- fast operational memory
- preferences, facts, pitfalls, short-lived context
- hook injection state, analytics, budgets, and session tracking

Use `Obsidian` for:

- stable, curated knowledge
- maps, playbooks, project notes, decisions, skills
- longer-lived notes you want to keep readable and editable as Markdown

The intersection is:

- vault notes stay as Markdown files
- `memento-mcp` indexes them into SQLite for routing and retrieval
- search results can merge SQLite memory and vault knowledge

## Optional Vault Promotion From `memory_store`

`memory_store` always writes to SQLite.

It can now also promote a memory into the vault.

### Explicit promotion

Example:

```text
memory_store(
  title="Response preference",
  content="Prefer concise, truthful answers with enough context.",
  memory_type="preference",
  scope="global",
  persist_to_vault=true
)
```

Useful extra parameters:

- `vault_mode="create"` or `vault_mode="create_or_update"`
- `vault_kind="decision"` to override inferred note kind
- `vault_folder="40 Decisions/My Area"` to override destination folder
- `vault_note_title="Preferred Reply Style"` to override the note title

### Auto-promotion by type

You can promote certain memory types automatically:

```toml
[vault]
enabled = true
path = "/path/to/Obsidian"
auto_promote_types = ["preference", "decision", "pattern", "architecture"]
```

Behavior:

- if `persist_to_vault=true`, promotion always happens
- if `persist_to_vault` is omitted, promotion happens when `memory_type` is in `auto_promote_types`
- if `persist_to_vault=false`, promotion is skipped even if the type is auto-promoted

Current default destination folders:

- `preference` -> `30 Domains/Memento Preferences`
- `decision` -> `40 Decisions/Memento Decisions`
- `pattern` -> `50 Playbooks/Memento Patterns`
- `architecture` -> `30 Domains/Memento Architecture`
- `fact` -> `30 Domains/Memento Facts`
- `pitfall` -> `50 Playbooks/Memento Pitfalls`

Promoted notes are marked with:

- `memento_source: memory_store`
- `memento_memory_id: <sqlite-memory-id>`

This gives idempotent create/update behavior when using `create_or_update`.

## MCP Tools

| Tool | Description |
|---|---|
| `memory_store` | Store a typed memory in SQLite, with optional promotion to the Obsidian vault |
| `memory_search` | Search ranked SQLite memories and append vault matches when enabled |
| `memory_get` | Retrieve full body for a SQLite memory or `vault:path/to/note.md` |
| `memory_list` | List SQLite memories and optionally vault notes by kind or folder |
| `memory_update` | Edit an existing memory (title, content, tags, importance, type, pinned) |
| `memory_pin` | Pin or unpin a memory so it survives pruning and ranks higher |
| `memory_delete` | Soft-delete a SQLite memory by ID |
| `memory_compress` | Manually run the compression pipeline on a project (or all) |
| `memory_export` | Export memories, decisions, and pitfalls as portable JSON |
| `memory_import` | Import a JSON dump with `skip` or `overwrite` conflict strategy |
| `decisions_log` | Store, list, or search architectural decisions with category and versioning |
| `pitfalls_log` | Track recurring problems with occurrence count and dedup |
| `memory_analytics` | View injection, capture, compression, and memory analytics |

### Auto-capture via Claude Code hooks

Three hook binaries ship with the package:

- `memento-hook-search` — `UserPromptSubmit` hook that injects the top-N relevant memories
- `memento-hook-session` — `SessionStart` hook that surfaces pinned/recent memories and active pitfalls
- `memento-hook-capture` — `PostToolUse` hook that captures `Bash`/`Read`/`Grep`/`Edit` results as memories when they look informative (git log, config files, error output), with classifier-driven dedup, per-session cooldown, and secret scrubbing

Set them up via `memento-mcp install` or add manually to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "memento-hook-search"}]}],
    "SessionStart":     [{"hooks": [{"type": "command", "command": "memento-hook-session"}]}],
    "PostToolUse":      [{"hooks": [{"type": "command", "command": "memento-hook-capture"}]}]
  }
}
```

### Analytics, adaptive ranking, and compression

Once the `PostToolUse` hook is installed, `memento-mcp` records every memory injection and tracks whether the LLM's subsequent tool calls reference that memory (filenames, identifiers, explicit IDs). The signal feeds:

- `memory_analytics` — per-project or global report with injection counts, capture rate, compression totals, token savings, and prune recommendations
- **Adaptive ranking** — `memory_search` blends FTS relevance, importance, exponential decay, and utility score so memories that actually get used rise over time
- **Automatic importance tuning** — every maintenance pass nudges `importance_score` toward observed utility; pinned memories are left alone
- **Compression pipeline** — similar recent memories are clustered (Jaccard + trigram + file-path overlap + temporal proximity) and merged into a single summary, with the originals soft-deleted and the merge logged

### File-memory cache

Markdown memory files under `~/.claude/projects/*/memory/` are parsed lazily and cached (TTL + mtime check) to avoid disk reads on every hook invocation. Configure via `[file_memory]`:

```toml
[file_memory]
enabled = true
cache_ttl_seconds = 60
```

## Token Optimization

- **Trivial prompts** can skip injection completely
- **Progressive disclosure** — `memory_search(detail="index" | "summary" | "full")`
- **Adaptive token budget** shrinks injection when the session is near budget exhaustion
- **Compression** folds similar auto-captured memories into one row; originals are soft-deleted but tracked in `compression_log` for audit
- **VACUUM + WAL checkpoint** run at most once per 24h during maintenance to reclaim disk space from soft-deletes and compressions

## Development

```bash
npm install
npm run build
npm test
```

Recommended for local development:

```bash
source ~/.nvm/nvm.sh
nvm use 20
```

## Troubleshooting

### The client does not find `memento-mcp`

Use absolute paths instead of relying on `PATH`:

- absolute `node` binary
- absolute `dist/cli/main.js`

### Claude hooks do nothing

Check that:

- the hook commands are on `PATH`
- Claude Code was restarted after editing `settings.json`
- `memento-hook-search --help` and `memento-hook-session --help` resolve in your shell

### Vault notes are not showing up

Check:

- `[vault].enabled = true`
- `[vault].path` points to the correct vault
- notes contain `memento_publish: true`
- `me.md` and `vault.md` exist
- `memento-mcp vault-index rebuild` has been run after large vault changes

### Promoted memories are not visible in vault search

Run:

```bash
memento-mcp vault-index rebuild
memento-mcp vault-index stats
```

### `better-sqlite3` fails to install

If prebuilt binaries are unavailable for your environment, install Node build prerequisites and retry.

## Uninstall

```bash
memento-mcp uninstall
```

This removes the registered MCP entry and Claude hooks created by the installer, but keeps your data and config on disk.

## License

MIT
