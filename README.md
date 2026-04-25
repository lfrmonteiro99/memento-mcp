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

Every section is optional. Missing sections and keys fall back to the defaults shown below. A v1 config (only `[budget]` / `[search]` / `[hooks]` / `[pruning]`) continues to parse — the new v2 sections just use defaults.

Full example with every key:

```toml
[budget]
total = 8000             # max tokens per session
floor = 500              # stop injection when remaining < floor
refill = 200             # top-up applied on "complex" prompts
session_timeout = 1800

[search]
default_detail = "index"         # "index" | "summary" | "full"
max_results = 10
body_preview_chars = 200
keyword_max_tokens = 8           # v2 — max keywords extracted per query
preserve_phrases = true          # v2 — bigram phrase boosting in FTS
fts_prefix_matching = true       # v2 / N4 — single terms become prefix matches

[hooks]
trivial_skip = true
session_start_memories = 5
session_start_pitfalls = 5
custom_trivial_patterns = []
analytics_reminder_interval_sessions = 20   # v2 / G6 — remind LLM to run memory_analytics every N sessions

[pruning]
enabled = true
max_age_days = 60
min_importance = 0.3
interval_hours = 24              # maintenance cadence (also drives compression + retention + VACUUM)

[database]
path = ""                        # empty = default (~/.local/share/memento-mcp/memento.sqlite)

[decay]
type = "exponential"             # "exponential" | "step"
half_life_days = 14

[auto_capture]
enabled = true
min_output_length = 200          # skip tool outputs shorter than this
max_output_length = 50000        # skip tool outputs larger than this
cooldown_seconds = 30            # min gap between captures for the same tool+key
dedup_similarity_threshold = 0.7 # Jaccard threshold that counts as a duplicate
max_per_session = 20
default_importance = 0.3
tools = ["Bash", "Read", "Grep", "Edit"]
session_timeout_seconds = 3600   # TTL for per-session cooldown trackers

[compression]
enabled = true
memory_count_threshold = 150     # trigger compression when project has more active memories
auto_capture_batch_threshold = 50 # or when > N auto-captured in the last 24h
staleness_days = 7
cluster_similarity_threshold = 0.45
min_cluster_size = 2
max_body_ratio = 0.6             # compressed body budget = max_body_ratio * sum(cluster tokens)
temporal_window_hours = 48

[adaptive]
enabled = true
utility_window_minutes = 10      # how long an injection stays "open" to collect utility signals
decay_half_life_days = 14
min_injections_for_confidence = 5
neutral_utility_score = 0.5

[adaptive.score_weights]         # must sum to ~1.0
fts_relevance = 0.30
importance = 0.20
decay = 0.15
utility = 0.25
recency_bonus = 0.10

[analytics]
enabled = true
flush_threshold = 20             # buffered events flushed when N is reached
retention_days = 90              # analytics_events rows older than this are pruned
prune_check_interval = 24

[file_memory]
enabled = true
cache_ttl_seconds = 60           # TTL for parsed ~/.claude/projects/*/memory/*.md files

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

| Variable | Effect |
|---|---|
| `MEMENTO_BUDGET` | Overrides `budget.total` |
| `MEMENTO_FLOOR` | Overrides `budget.floor` |
| `MEMENTO_REFILL` | Overrides `budget.refill` |
| `MEMENTO_SESSION_TIMEOUT` | Overrides `budget.session_timeout` |
| `MEMENTO_LOG_LEVEL` | `error` / `warn` (default) / `info` / `debug` — routed to stderr |
| `MEMENTO_PROFILE` | Overrides `[profile].id` (builtin: `english` / `portuguese` / `spanish`) |

Malformed TOML is **not** silently ignored. The server logs a `WARN` to stderr and falls back to defaults (see `MEMENTO_LOG_LEVEL`).

## Mode Profiles

`memento-mcp` supports language-aware **mode profiles** for keyword extraction and trivial-prompt detection. Profiles bundle:

- Stop-word lists (used by keyword extraction)
- Trivial-prompt patterns (used by classification)
- Optional locale tag for future date/number formatting

### Built-in profiles

Three profiles ship by default:

- **`english`** (default) — English stop-words and trivial patterns
- **`portuguese`** — Portuguese stop-words (`o`, `a`, `de`, etc.) and trivial patterns (`oi`, `obrigado`, etc.)
- **`spanish`** — Spanish stop-words (`el`, `la`, `de`, etc.) and trivial patterns (`hola`, `gracias`, etc.)

### Selecting a profile

Profile resolution follows this precedence:

1. **Environment variable** `MEMENTO_PROFILE` (if set, overrides config and default)
2. **Config file** `[profile].id` (if set in `~/.config/memento-mcp/config.toml`)
3. **Default** `"english"`

Example config:

```toml
[profile]
id = "portuguese"                  # builtin: english | portuguese | spanish
extra_stop_words = []              # added on top of profile defaults
extra_trivial_patterns = []        # regex strings, case-insensitive
locale = ""                        # override profile locale (empty = use profile default)
```

Example environment override:

```bash
MEMENTO_PROFILE=portuguese memento-mcp profile
```

### Extending a profile

You can add custom stop-words and trivial patterns on top of any built-in profile:

```toml
[profile]
id = "english"
extra_stop_words = ["foo", "bar"]
extra_trivial_patterns = ["maybe", "perhaps"]
```

These are merged with the profile's defaults. Useful for domain-specific vocabulary or project-specific greetings.

### Inspecting the active profile

Two subcommands help debug which profile is in use:

```bash
# Show profile ID and counts
memento-mcp profile

# Dump full stop-word list and patterns
memento-mcp profile --dump
```

### Impact on search and classification

- **Keyword extraction** — stop-words from the active profile are filtered out, so Portuguese queries stay focused on meaningful terms.
- **Trivial-prompt detection** — short prompts like `"oi"` (Portuguese for "hi") classify as trivial under `portuguese` but standard under `english`, affecting how much context is injected.

Default behavior is **identical to v1** when using the default English profile.

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

## Token-aware search workflow

The search tools implement **three layers of progressive disclosure**, each with visible token costs. Use the cheapest layer that answers your question.

| Layer | Tool / Mode | Cost / Result | When to Use |
|---|---|---|---|
| 1 | `memory_search(detail="index")` | ~30 tokens | **First scan**: titles + scores only. Fastest, cheapest. |
| 2 | `memory_search(detail="summary")` | ~80 tokens | **Shortlist**: preview first sentences of matching bodies. |
| 3a | `memory_timeline(id, window=3)` | ~200 tokens | **Context around one hit**: chronological neighborhood (±2h session window). |
| 3b | `memory_get(id)` | ~300-800 tokens | **Full body**: complete memory for final decision. |

**Workflow example:**

```
1. memory_search("typescript strict mode", detail="index")
   → Returns 5 hits with ~30 tokens each = 150 tokens total
   
2. memory_timeline(id="...", window=3)
   → Fetches 6 neighbors around the #1 hit = ~200 tokens
   → Gives chronological context: what was done before/after this decision
   
3. memory_get(id="...")  [optional]
   → If timeline hints you need the full body = ~500 tokens
```

Every search result line shows its token cost in `[Nt]` format, so the model sees the cost upfront.
The footer displays totals and hints about next-layer tools when applicable.

## MCP Tools

| Tool | Description |
|---|---|
| `memory_store` | Store a typed memory in SQLite, with optional promotion to the Obsidian vault |
| `memory_search` | Search ranked SQLite memories with progressive disclosure (index / summary / full); cost visible per result |
| `memory_timeline` | Fetch chronological context around a memory (neighbors ±2h); cost ~200 tokens per neighbor |
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

### Tool parameters

<details>
<summary><code>memory_store</code></summary>

| Param | Type | Default | Notes |
|---|---|---|---|
| `title` | string | — | required |
| `content` | string | — | required; stored in `body` |
| `memory_type` | string | `"fact"` | `fact` / `decision` / `preference` / `pattern` / `architecture` / `pitfall` |
| `scope` | string | `"project"` | `"project"` or `"global"` |
| `project_path` | string | `""` | project root; resolved to `project_id` |
| `tags` | string[] | `[]` | stored as JSON |
| `importance` | number | `0.5` | clamped to [0, 1] |
| `supersedes_id` | string | `""` | marks that memory deleted; cycle-guarded (R4) |
| `pin` | bool | `false` | |
| `persist_to_vault` | bool | auto-type | see Vault Promotion |
| `vault_mode` | string | `"create_or_update"` | |
| `vault_kind`, `vault_folder`, `vault_note_title` | string | `""` | vault overrides |

</details>

<details>
<summary><code>memory_search</code></summary>

| Param | Type | Default | Notes |
|---|---|---|---|
| `query` | string | — | required |
| `project_path` | string | `""` | scope to a project (still includes globals) |
| `memory_type` | string | `""` | filter by type |
| `limit` | number | `10` | |
| `detail` | enum | `"index"` | `"index"` / `"summary"` / `"full"` — progressive disclosure; start with `"index"` |
| `include_file_memories` | bool | `true` | merge `~/.claude/projects/*/memory/*.md` results |

</details>

<details>
<summary><code>memory_timeline</code></summary>

Fetch memories created around a given memory (chronological neighborhood within same session or ±2h window).

| Param | Type | Default | Notes |
|---|---|---|---|
| `id` | string | — | required; the memory id to find neighbors around |
| `window` | number | `3` | how many neighbors on each side (±N); clamped to [1, 10] |
| `detail` | enum | `"summary"` | `"index"` (compact) or `"summary"` (first sentence) |
| `same_session_only` | bool | `true` | when true, filters by `claude_session_id` if available; falls back to ±2h `created_at` window |

</details>

<details>
<summary><code>memory_get</code></summary>

| Param | Type | Notes |
|---|---|---|
| `memory_id` | string | SQLite UUID, `file:<path>`, or `vault:<relative/path>` |

</details>

<details>
<summary><code>memory_list</code></summary>

| Param | Type | Default | Notes |
|---|---|---|---|
| `project_path` | string | `""` | |
| `memory_type` | string | `""` | |
| `scope` | string | `""` | |
| `pinned_only` | bool | `false` | |
| `limit` | number | `20` | |
| `detail` | enum | `"full"` | `index` / `summary` / `full` |
| `include_file_memories` | bool | `false` | |
| `vault_kind` | string | `""` | filter vault notes by kind |
| `vault_folder` | string | `""` | filter vault notes by folder |

</details>

<details>
<summary><code>memory_update</code></summary>

Patch-style update. Omitted fields are left untouched. At least one field (other than `memory_id`) is required.

| Param | Type | Notes |
|---|---|---|
| `memory_id` | string | required |
| `title` | string | |
| `content` | string | updates `body` |
| `tags` | string[] | replaces entire tag list (stored as JSON) |
| `importance` | number | clamped to [0, 1] |
| `memory_type` | string | |
| `pinned` | bool | |

Bumps `updated_at`. Rejects updates on soft-deleted memories with "not found".

</details>

<details>
<summary><code>memory_pin</code></summary>

| Param | Type | Default | Notes |
|---|---|---|---|
| `memory_id` | string | — | required |
| `pinned` | bool | `true` | pass `false` to unpin |

Pinned memories are skipped by pruning, the importance auto-promoter, and stay on top of `memory_list(pinned_only=true)`.

</details>

<details>
<summary><code>memory_delete</code></summary>

| Param | Type | Notes |
|---|---|---|
| `memory_id` | string | soft-delete; row is filtered from all reads, but preserved for audit |

</details>

<details>
<summary><code>memory_compress</code></summary>

Manual trigger of the compression pipeline.

| Param | Type | Default | Notes |
|---|---|---|---|
| `project_path` | string | `""` | empty → every registered project |

Returns a summary: cluster count, token totals, and per-project breakdown. Returns `"No clusters found to compress."` if nothing is similar enough. Honors `compression.enabled = false`.

</details>

<details>
<summary><code>memory_export</code></summary>

| Param | Type | Default | Notes |
|---|---|---|---|
| `project_path` | string | `""` | empty → export everything; otherwise include globals + that project's memories/decisions/pitfalls |

Output is JSON:

```json
{
  "schema_version": 2,
  "exported_at": "2026-04-24T15:00:00Z",
  "projects":  [...],
  "memories":  [...],
  "decisions": [...],
  "pitfalls":  [...]
}
```

Redirect to file via your MCP client's output capture (or call from another script and save stdout).

</details>

<details>
<summary><code>memory_import</code></summary>

| Param | Type | Default | Notes |
|---|---|---|---|
| `path` | string | — | required; path to JSON produced by `memory_export` |
| `strategy` | enum | `"skip"` | `"skip"` keeps existing rows on id conflict; `"overwrite"` replaces them |

Transactional (all-or-nothing). Rejects incompatible `schema_version` with a clear error. Returns counts of imported / skipped / overwritten rows.

</details>

<details>
<summary><code>decisions_log</code></summary>

| Param | Type | Default | Notes |
|---|---|---|---|
| `action` | string | — | `"store"` / `"list"` / `"search"` |
| `project_path` | string | — | required |
| `title`, `body`, `category` | string | — | `action="store"` |
| `importance` | number | `0.7` | |
| `supersedes_id` | string | `""` | |
| `query` | string | `""` | `action="search"` |
| `limit` | number | `10` | |

</details>

<details>
<summary><code>pitfalls_log</code></summary>

| Param | Type | Default | Notes |
|---|---|---|---|
| `action` | string | — | `"store"` / `"list"` / `"resolve"` |
| `project_path` | string | — | required |
| `title`, `body` | string | — | `action="store"` |
| `importance` | number | `0.6` | |
| `limit` | number | `10` | |
| `include_resolved` | bool | `false` | |
| `pitfall_id` | string | `""` | `action="resolve"` |

</details>

<details>
<summary><code>memory_analytics</code></summary>

| Param | Type | Default | Notes |
|---|---|---|---|
| `period` | enum | `"last_7d"` | `"last_24h"` / `"last_7d"` / `"last_30d"` / `"all"` |
| `section` | enum | `"all"` | `"all"` / `"injections"` / `"captures"` / `"compression"` / `"memories"` |
| `project_path` | string | `""` | empty or `"global"` → aggregate across all projects |

Output sections:
- **injections** — sessions, total tokens, avg tokens/session
- **captures** — auto-capture count, skip count, capture rate
- **compression** — runs, tokens_before → tokens_after, tokens saved, avg ratio
- **memories** — active vs deleted counts, breakdown by type
- **prune recommendations** — auto-generated "delete" / "archive" suggestions based on usage signal

Footer notes when tracking began, or warns when no events have been recorded yet (e.g., immediately after v2 upgrade).

</details>

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

### Auto-capture rules

`memento-hook-capture` runs after matching tool calls and decides per-call whether to store something:

- **Bash** — captures `git log` / `git diff` / `git status` output, build/test failures (pitfall type), and any stdout between `min_output_length` and `max_output_length`
- **Read** — captures config-file reads (`*.toml`, `*.yaml`, `*.json`, `Dockerfile`, …) as `architecture` memories; source-code reads are skipped
- **Grep** — captures pattern results when match count is in [3, 50]; trivially-narrow or repo-wide matches are skipped
- **Edit** — captures significant changes (multi-line or more than a trivial rename)

Always skipped:
- outputs shorter than `auto_capture.min_output_length` or larger than `auto_capture.max_output_length`
- tools not in `auto_capture.tools`
- rapid-fire duplicates (same tool + key within `cooldown_seconds`)
- body that matches a recent memory at Jaccard similarity ≥ `dedup_similarity_threshold` (project-scoped)
- sessions that already hit `max_per_session`

**Secret scrubbing** — before classification, the raw text is passed through `scrubSecrets`. Redacted patterns:
- `api_key` / `password` / `secret` / `token` assignments (any casing)
- Common provider env assignments: `AWS_*=`, `GITHUB_*=`, `OPENAI_*=`, etc.
- PEM private-key blocks (`-----BEGIN ... PRIVATE KEY-----`)

### Utility signals and adaptive ranking

Once a memory is injected, `memento-hook-capture` watches the next tool calls in that session (within `adaptive.utility_window_minutes`) to decide whether the memory was *actually useful*:

- **`explicit_access`** — the memory's id or title shows up in a subsequent `memory_get` / `memory_search` response. Strength `1.0`.
- **`tool_reference`** — a fingerprint of the memory (file path, PascalCase / camelCase identifier ≥ 5 chars) appears in a subsequent tool input or response. Strength `0.8` if the match is ≥ 20 chars, else `0.5`.
- **`ignored`** — the injection window expired without any match.

These land in `analytics_events` and feed two things:

1. **`computeUtilityScore(db, memory_id)`** — mixed ratio of *used* vs *injected* plus average signal strength, weighted by a confidence factor (N/5 capped at 1). Neutral `0.5` for memories with no injection history.
2. **Adaptive score** used by `memory_search` and `SessionStart`:

   ```
   score = fts_relevance * 0.30
         + importance    * 0.20
         + decay         * 0.15   // computeExponentialDecay(daysSince(last_accessed_at), half_life=14)
         + utility       * 0.25
         + recency_bonus * 0.10
   ```

   Weights are tunable via `[adaptive.score_weights]`.

The adaptive ranker also drives **automatic importance tuning**: every maintenance pass takes memories with ≥ `min_injections_for_confidence` injections and nudges their `importance_score` toward the observed utility (delta = `(utility - neutral_utility_score) * 0.2`, clamped to ±0.05 per pass). Pinned memories are skipped — user intent wins.

### Compression pipeline

Compression folds clusters of similar recent memories into one summary row. Triggered when any of:
- active memory count for a project exceeds `compression.memory_count_threshold`
- auto-captured memories in the last 24h exceed `compression.auto_capture_batch_threshold`

Pipeline (all inside one `db.transaction()` for R5 atomicity):

1. **Select candidates** — newest 200 active memories per project (excludes `source='compression'` to prevent re-compression).
2. **Cluster** — Union-Find single-linkage on pairwise similarity. The combined score is `tag_jaccard * 0.25 + title_trigram * 0.30 + file_path_jaccard * 0.30 + temporal_proximity * 0.15`. Clusters with size < `min_cluster_size` are discarded.
3. **Merge** — each cluster is collapsed into one memory: sentence dedup across the cluster (Jaccard > 0.6), token budget = `sum(cluster_tokens) * max_body_ratio`, importance = `max(sources) + 0.1` (capped at 1), dominant `memory_type` wins, `tags` includes `"compressed"`.
4. **Store** — the new row is inserted with `source='compression'`, the merge is audited in `compression_log` (FK is TEXT UUID — R6, safe under VACUUM), and source memories are soft-deleted.

Run manually with `memory_compress`; otherwise runs as part of the maintenance cycle.

### Maintenance cycle

On server startup and every `pruning.interval_hours`, the server runs:

1. **Prune stale memories** — `pruneStale(max_age_days, min_importance)` soft-deletes unpinned low-importance rows not accessed for `max_age_days`.
2. **Analytics retention** — `cleanupExpiredAnalytics(retention_days)` deletes `analytics_events` rows older than the cutoff.
3. **Importance auto-promote** — nudges unpinned memories' `importance_score` toward observed utility (see above).
4. **WAL checkpoint** — `PRAGMA wal_checkpoint(TRUNCATE)` rotates the WAL so it doesn't grow unboundedly between restarts.
5. **VACUUM** — rate-limited to once per 24h; reclaims disk space freed by soft-deletes and compression.
6. **Compression** — `runCompressionCycle` per project (if `compression.enabled`).

Each step is independently wrapped in try/catch so a failure in one doesn't abort the rest.

### File-memory cache

Markdown memory files under `~/.claude/projects/*/memory/` (legacy file memories) are parsed lazily and cached (TTL + mtime check) to avoid disk reads on every hook invocation. Configure via `[file_memory]` (see the config example above).

## Token Optimization

- **Trivial prompts** can skip injection completely
- **Progressive disclosure** — `memory_search(detail="index" | "summary" | "full")`
- **Adaptive token budget** shrinks injection when the session is near budget exhaustion
- **Compression** folds similar auto-captured memories into one row; originals are soft-deleted but tracked in `compression_log` for audit
- **VACUUM + WAL checkpoint** run at most once per 24h during maintenance to reclaim disk space from soft-deletes and compressions

## Upgrading from v1 to v2

The v2 upgrade is designed to be drop-in:

1. `npm install -g @lfrmonteiro99/memento-memory-mcp@2.0.0` — the bin names preserved from v1 (`memento-mcp`, `memento-hook-search`, `memento-hook-session`) continue to work. v2 adds one new binary: `memento-hook-capture`.
2. The SQLite migration runs automatically on the first open:
   - New tables: `analytics_events`, `compression_log`, and `vault_*` (if you haven't built a vault yet, these stay empty).
   - New columns on `memories`: `source` (default `"user"`), `adaptive_score` (default `0.5`).
   - v1 tags stored as CSV strings (`"foo,bar,baz"`) are auto-converted to JSON arrays (`["foo","bar","baz"]`). Reads tolerate both forms during the transition.
   - Migration is idempotent and wrapped in a transaction — failed migrations roll back cleanly.
3. v1 config files continue to parse. New v2 sections (`[auto_capture]`, `[compression]`, `[adaptive]`, `[analytics]`, `[file_memory]`, `[decay]`) are optional and default to the values shown in the config example.
4. Add the `PostToolUse` hook if you want auto-capture (see Claude Code setup above). This is what feeds `analytics_events` — skip it and `memory_analytics` will still work but show neutral utility scores.
5. One behavioral change: `search.default_detail` in `DEFAULT_CONFIG` is now `"index"` (was `"full"`). Override with `default_detail = "full"` if you want the v1 behavior. Callers passing `detail="full"` explicitly are unaffected.

Verifying the upgrade:

```bash
# Schema is at least v2:
node -e "const D=require('better-sqlite3');const d=new D(process.env.HOME+'/.local/share/memento-mcp/memento.sqlite',{readonly:true});console.log(d.pragma('user_version',{simple:true}));d.close()"

# v2 tables exist:
node -e "const D=require('better-sqlite3');const d=new D(process.env.HOME+'/.local/share/memento-mcp/memento.sqlite',{readonly:true});console.log(d.prepare(\"SELECT name FROM sqlite_master WHERE name IN ('analytics_events','compression_log')\").all());d.close()"
```

The server never deletes pre-existing v1 memories. To wipe and start fresh, delete the SQLite file — it will be recreated on next boot.

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
