# memento-mcp

**Persistent memory for AI coding agents.**

A local-first MCP server that gives Claude Code, Codex, Cursor, and any stdio-MCP client durable project memory: facts, decisions, patterns, architecture notes, pitfalls, session summaries, and team-shared knowledge.

![Memento Memory MCP overview](docs/assets/hero-overview.png)

AI coding agents are powerful, but they forget. They forget why a decision was made, which migration broke production, which convention your project follows, and which workaround saved you three hours last week.

`memento-mcp` fixes that.

It stores structured memories locally in SQLite, retrieves the right context when your agent needs it, and can sync selected team memories through git. No hosted vector database. No mandatory cloud account. No mystery SaaS quietly eating your project history.

Install from npm:

    npm install -g @lfrmonteiro99/memento-memory-mcp
    memento-mcp install
    memento-mcp import claude-md
    memento-mcp ui

## What it does

`memento-mcp` gives your AI coding tools a memory layer that survives across sessions, machines, and teammates.

It can remember:

- architectural decisions
- project conventions
- known pitfalls
- implementation patterns
- debugging notes
- user/team preferences
- session summaries
- reusable context from `CLAUDE.md`
- curated notes from an Obsidian vault

Then it injects the relevant context back into your agent at the right time, without forcing you to paste the same project explanation into every new chat like a medieval scribe with npm installed.

## Why use it

### Stop repeating project context

Import your existing `CLAUDE.md`, store typed memories, and let your MCP client retrieve the useful bits automatically.

    memento-mcp import claude-md

### Keep decisions close to the code

Log decisions, pitfalls, patterns, and architecture notes as structured memories instead of burying them in old chats, random Markdown files, or the cursed archaeology layer known as “Slack search”.

### Share memory with your team

Team-scoped memories are serialized into your repo under:

    .memento/memories/

Commit them, push them, and teammates can pull the same operational knowledge.

    memento-mcp sync init
    memento-mcp sync pull

### Stay local by default

The default setup uses:

- local SQLite
- SQLite FTS5 search
- local config
- local web inspector
- no required cloud account
- no hosted database

Optional embeddings are available, but they are opt-in.

### Keep private text private

`<private>...</private>` regions are excluded from search indexes, injection, embeddings, LLM calls, and sync paths. Secret scrubbing is applied at write time for common credentials such as env-var values, JWTs, GitHub tokens, URL credentials, and authorization headers.

### See and control what the agent knows

Run the local inspector:

    memento-mcp ui

Browse memories, sessions, projects, sync state, analytics, and drift without opening yet another SaaS dashboard pretending to be “simple”.

## Installation

Install from npm:

    npm install -g @lfrmonteiro99/memento-memory-mcp

Then wire it into your MCP client:

    memento-mcp install

This configures supported local clients such as Claude Code, Codex, Cursor, or other stdio-MCP clients.

Verify the install:

    memento-mcp --help

Open the local web UI:

    memento-mcp ui

## 60-second tour

1. Install from npm:

       npm install -g @lfrmonteiro99/memento-memory-mcp

2. Wire your MCP client:

       memento-mcp install

3. Import existing project memory:

       memento-mcp import claude-md --dry-run
       memento-mcp import claude-md --no-confirm

4. Open the local inspector:

       memento-mcp ui

5. Share team memory through git:

       memento-mcp sync init
       memento-mcp sync pull

## Core features

### Typed memories

Store different kinds of project knowledge with different ranking weights and retrieval behavior:

- `fact`
- `decision`
- `preference`
- `pattern`
- `architecture`
- `pitfall`

Dedicated tools such as `decisions_log` and `pitfalls_log` make high-signal memory capture easier.

Read more: [MCP tools reference](docs/mcp-tools.md)

### Team memory via git

Team-scoped memories are written as JSON files under:

    .memento/memories/<id>.json

That means your team can review, commit, diff, and sync shared agent memory like normal project files.

Read more: [Team-scoped memories with git sync](docs/team-sync.md)

### Per-project policy

Use `.memento/policy.toml` to control project-specific behavior:

- required tags
- banned content patterns
- retention rules
- vault promotion rules
- memory constraints

The policy lives in the repo, not hidden somewhere on one developer’s machine, because apparently “works on my machine” needed a memory layer too.

Read more: [Per-project policy](docs/policy.md)

### Local-first search

By default, `memento-mcp` uses:

- SQLite
- FTS5
- typed scoring
- token-aware result ranking
- adaptive utility feedback

No vector database is required.

Read more: [Token-aware search](docs/search.md)

### Optional semantic search

If you want semantic retrieval, enable embeddings. FTS5 and vector results are merged through an adaptive ranker.

Embeddings are opt-in and use your own provider key.

Read more: [Optional embeddings](docs/embeddings.md)

### Smart write-time deduplication

When embeddings are enabled, near-duplicate memories can be detected at write time, before your memory store becomes a landfill of almost-identical “important notes”.

Read more: [Smart write-time dedup](docs/embeddings.md#smart-write-time-dedup)

### Session summaries

Capture useful session context at the end of a coding session.

Supported modes:

- deterministic summaries by default
- optional LLM-assisted summaries using Anthropic or OpenAI

Read more: [End-of-session summaries](docs/session-summaries.md)

### Obsidian vault integration

Index a curated Obsidian vault and route context through:

- `me.md`
- `vault.md`
- maps
- skills
- playbooks
- long-form project notes

The vault layer is indexed and searched, but not auto-written by the agent unless explicitly promoted.

Read more: [Vault integration](docs/vault.md)

### Privacy controls

Privacy features include:

- `<private>...</private>` redaction
- FTS exclusion for private regions
- embedding exclusion for private regions
- sync exclusion for private content
- secret scrubbing at write time
- title and body sanitization

Read more: [Privacy](docs/privacy.md)

### Mode profiles

Switch stop-words and trivial-prompt classifiers by profile:

- English
- Portuguese
- Spanish

Use config or environment variables:

    MEMENTO_PROFILE=portuguese

Read more: [Mode profiles](docs/mode-profiles.md)

### Claude Code hooks

Use hooks for automatic context injection and capture:

- `SessionStart`
- `UserPromptSubmit`
- `PostToolUse`
- `SessionEnd`

Read more: [Installation & client setup](docs/install.md)

### Web inspector

Launch a local browser UI:

    memento-mcp ui

Inspect:

- memories
- sessions
- projects
- sync drift
- analytics
- memory health

Read more: [Web inspector](docs/web-inspector.md)

## Knowledge model

`memento-mcp` separates fast operational memory from curated long-form knowledge.

### SQLite memory layer

Fast, typed, agent-written memory.

Use it for:

- decisions
- facts
- patterns
- bugs
- pitfalls
- preferences
- session-derived notes

### Vault knowledge layer

Curated Markdown knowledge from an Obsidian vault.

Use it for:

- long-form docs
- project maps
- personal/team playbooks
- technical notes
- stable reference material

Search and hooks can combine both layers.

![What is Memento Memory MCP](docs/assets/what-is-memento-memory-mcp.png)

![Why use Memento Memory MCP](docs/assets/why-use-memento-memory-mcp.png)

## Example use cases

### Remember project decisions

Decision: We use repository classes for complex SQL access instead of putting queries in controllers.

Reason: Keeps business logic separate from persistence and makes performance tuning easier.

Scope: project

Tags: architecture, backend

### Remember pitfalls

Pitfall: The quality scheduling query becomes expensive when paginating after loading all rows.

Fix: Use database-level pagination and a separate count query.

Scope: project

Tags: performance, sql

### Remember team conventions

Preference: In this project, bug fixes and improvements are tracked separately in release notes.

Scope: team

Tags: process, release-notes

## Documentation

### Getting started

- [Installation & client setup](docs/install.md)
- [Importing CLAUDE.md](docs/import.md)

### Features

- [Team-scoped memories with git sync](docs/team-sync.md)
- [Per-project policy](docs/policy.md)
- [Optional embeddings](docs/embeddings.md)
- [End-of-session summaries](docs/session-summaries.md)
- [Privacy](docs/privacy.md)
- [Token-aware search](docs/search.md)
- [Mode profiles](docs/mode-profiles.md)
- [Vault integration](docs/vault.md)
- [Web inspector](docs/web-inspector.md)

### Reference

- [Configuration](docs/configuration.md)
- [MCP tools reference](docs/mcp-tools.md)
- [Development & troubleshooting](docs/development.md)

## Requirements

- Node.js 18 or newer
- npm
- An MCP-compatible client, such as Claude Code, Codex, Cursor, or another stdio-MCP client

Optional:

- Obsidian vault for curated Markdown knowledge
- OpenAI key for semantic embeddings
- Anthropic or OpenAI key for LLM-assisted session summaries
- git repo for team memory sync

## Package

Published on npm as:

    @luispmonteiro/memento-memory-mcp

Install globally:

    npm install -g @luispmonteiro/memento-memory-mcp

## License

MIT
