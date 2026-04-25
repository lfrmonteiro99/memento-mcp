# memento-mcp

**Persistent typed memory for AI coding agents.** Runs as a local MCP server, ships memories to your team via git, keeps everything on your machine.

![Memento Memory MCP overview](docs/assets/hero-overview.png)

memento-mcp gives Claude Code, Codex, Cursor, and any stdio-MCP client a real memory: typed facts, decisions, patterns, architecture notes, and pitfalls — stored in SQLite, optionally indexed against an Obsidian vault, optionally synced across your team via git, optionally enriched with semantic embeddings, and injected back into your prompts at the right moments.

```bash
npm install -g @lfrmonteiro99/memento-memory-mcp
memento-mcp install                 # wires your MCP client
memento-mcp import claude-md        # five-second onramp from existing CLAUDE.md
memento-mcp ui                      # localhost web inspector
```

## Why memento-mcp

- **Typed memories** — fact, decision, preference, pattern, architecture, pitfall. Each has dedicated tools (`decisions_log`, `pitfalls_log`) and its own ranking weights.
- **Team memory via git** — `[scope=team]` memories serialize to `.memento/memories/<id>.json`. Commit, push. Your teammate runs `memento-mcp sync pull` and their memento knows what you learned. → [docs](docs/team-sync.md)
- **Per-project policy** — `.memento/policy.toml` enforces required tags, banned content patterns, retention overrides, vault auto-promotion. Versioned in your repo, not your machine. → [docs](docs/policy.md)
- **Local-first by default** — SQLite + FTS5. No vector DB to host, no daemon to babysit, no cloud account required.
- **Optional embeddings** — opt-in OpenAI vector search alongside FTS5, merged via adaptive ranker. Bring your own key. → [docs](docs/embeddings.md)
- **Smart write-time dedup** — when embeddings are on, near-duplicates are caught at write time, not weeks later in compression. → [docs](docs/embeddings.md#smart-write-time-dedup)
- **End-of-session summaries** — deterministic by default, opt-in LLM-assisted (Anthropic or OpenAI) for prose summaries. → [docs](docs/session-summaries.md)
- **Curated vault layer** — index an Obsidian vault; route through `me.md`, `vault.md`, maps, skills, and playbooks; optionally promote stored memories into vault notes. → [docs](docs/vault.md)
- **Privacy by design** — `<private>...</private>` regions are excluded from the FTS index, redacted in search and injection, and never leave the machine via embedding / LLM / sync paths. `scrubSecrets` covers env-var prefixes, JWTs, GitHub PATs, embedded URL credentials, and Authorization headers — applied to titles and bodies at write time. → [docs](docs/privacy.md)
- **Token-aware search** — every result shows its token cost; the agent picks the cheap layer first (`detail=index` → `memory_timeline` → `memory_get`). → [docs](docs/search.md)
- **Mode profiles** — English, Portuguese, Spanish stop-words and trivial-prompt classifiers, switchable via `MEMENTO_PROFILE` env var or config. → [docs](docs/mode-profiles.md)
- **Hooks for Claude Code** — `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `SessionEnd` for automatic context injection, auto-capture, and session distillation. → [docs](docs/install.md)
- **Web inspector** — `memento-mcp ui` opens a localhost browser UI for memories, sessions, sync drift, projects, and analytics. → [docs](docs/web-inspector.md)
- **Five-second onramp** — `memento-mcp import claude-md` converts your existing CLAUDE.md flat memory into typed memories. → [docs](docs/import.md)
- **Adaptive ranking** — utility-feedback loop weights past-injection success into future scoring.
- **MIT license** — fork it, ship it, embed it.

## 60-second tour

```bash
# 1. Install
npm install -g @lfrmonteiro99/memento-memory-mcp

# 2. Wire your MCP client (writes ~/.codex or ~/.claude config)
memento-mcp install

# 3. Bring over what you already wrote
memento-mcp import claude-md --dry-run         # preview
memento-mcp import claude-md --no-confirm      # commit

# 4. Browse what's stored
memento-mcp ui                                 # http://127.0.0.1:37778

# 5. Share with your team (in a git repo)
memento-mcp sync init                          # creates .memento/
# Store memories with scope="team"; commit .memento/; teammates run:
memento-mcp sync pull
```

## Two complementary knowledge layers

memento-mcp keeps two layers, deliberately separate:

- **SQLite memory layer** — fast, typed, operational memory the agent writes via `memory_store`, `decisions_log`, `pitfalls_log`. This is where session-derived knowledge lives.
- **Vault knowledge layer** — curated Markdown notes from an Obsidian vault, indexed and routed but never auto-written by the agent. This is where your long-form, hand-curated context lives.

Searches and hooks combine both. Memories can be promoted into vault notes with one flag.

![What is Memento Memory MCP](docs/assets/what-is-memento-memory-mcp.png)
![Why use Memento Memory MCP](docs/assets/why-use-memento-memory-mcp.png)

## Documentation

### Getting started

- [Installation & client setup](docs/install.md) — Prerequisites, install, configure Codex / Claude Code / Cursor, verify, uninstall
- [Importing CLAUDE.md](docs/import.md) — Five-second onramp from your existing memory file

### Features

- [Team-scoped memories (git sync)](docs/team-sync.md) — Share memories across machines via your repo
- [Per-project policy](docs/policy.md) — `.memento/policy.toml` for required tags, banned content, retention overrides
- [Optional embeddings](docs/embeddings.md) — Semantic search alongside FTS5, with smart write-time dedup
- [End-of-session summaries](docs/session-summaries.md) — Deterministic and LLM-assisted modes
- [Privacy](docs/privacy.md) — `<private>` tags and pattern-based secret scrubbing
- [Token-aware search](docs/search.md) — Three-layer progressive disclosure with visible costs
- [Mode profiles](docs/mode-profiles.md) — Multi-language stop-words and classifier rules
- [Vault integration](docs/vault.md) — Obsidian routing, indexing, and promotion
- [Web inspector](docs/web-inspector.md) — Localhost UI for memories, sessions, analytics, sync drift

### Reference

- [Configuration](docs/configuration.md) — Full TOML reference and env-var overrides
- [MCP tools reference](docs/mcp-tools.md) — Every tool, parameter, hook, and the auto-capture / utility / compression internals
- [Development & troubleshooting](docs/development.md) — Build, test, upgrade from v1, common issues

## License

MIT
