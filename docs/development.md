# Development

## Build & test

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

## Token optimization (theory of operation)

memento-mcp is designed to keep injected context small without losing relevance:

- **Trivial prompts** can skip injection completely (see [mode profiles](mode-profiles.md))
- **Progressive disclosure** — `memory_search(detail="index" | "summary" | "full")` (see [token-aware search](search.md))
- **Adaptive token budget** shrinks injection when the session is near budget exhaustion
- **Compression** folds similar auto-captured memories into one row; originals are soft-deleted but tracked in `compression_log` for audit
- **VACUUM + WAL checkpoint** run at most once per 24h during maintenance to reclaim disk space from soft-deletes and compressions
- **File-memory cache** — Markdown memory files under `~/.claude/projects/*/memory/` are parsed lazily and cached (TTL + mtime check) to avoid disk reads on every hook invocation

## Upgrading from v1 to v2

The v2 upgrade is designed to be drop-in:

1. `npm install -g @lfrmonteiro99/memento-memory-mcp@latest` — the bin names from v1 (`memento-mcp`, `memento-hook-search`, `memento-hook-session`) continue to work. v2 added `memento-hook-capture` and `memento-hook-summarize`.
2. The SQLite migration runs automatically on the first open. New tables: `analytics_events`, `compression_log`, `embeddings`, `memory_edges`-equivalents (none yet — see roadmap), `vault_*`, `sync_state`, `sync_file_hashes`. New columns on `memories`: `source`, `adaptive_score`, `claude_session_id`, `has_private`. v1 tags stored as CSV are auto-converted to JSON arrays.
3. v1 config files continue to parse. New v2 sections (`[auto_capture]`, `[compression]`, `[adaptive]`, `[analytics]`, `[file_memory]`, `[decay]`, `[search.embeddings]`, `[hooks.session_end_llm]`, `[sync]`, `[profile]`) are optional and default to safe values.
4. Add the `PostToolUse` hook if you want auto-capture (see [install](install.md)). This is what feeds `analytics_events` — skip it and `memory_analytics` will still work but show neutral utility scores.
5. One behavioral change: `search.default_detail` is now `"index"` (was `"full"` in v1). Override with `default_detail = "full"` if you want the v1 behavior.

### Verify the upgrade

```bash
# Schema is at v7 (or higher):
node -e "const D=require('better-sqlite3');const d=new D(process.env.HOME+'/.local/share/memento-mcp/memento.sqlite',{readonly:true});console.log(d.pragma('user_version',{simple:true}));d.close()"

# v2 tables exist:
node -e "const D=require('better-sqlite3');const d=new D(process.env.HOME+'/.local/share/memento-mcp/memento.sqlite',{readonly:true});console.log(d.prepare(\"SELECT name FROM sqlite_master WHERE name IN ('analytics_events','compression_log','embeddings','sync_state','sync_file_hashes')\").all());d.close()"
```

The server never deletes pre-existing v1 memories. To wipe and start fresh, delete the SQLite file — it will be recreated on next boot.

## Troubleshooting

### The client does not find `memento-mcp`

Use absolute paths instead of relying on `PATH`:

- absolute `node` binary
- absolute `dist/cli/main.js`

See [install](install.md) for examples.

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

```bash
memento-mcp vault-index rebuild
memento-mcp vault-index stats
```

### Embeddings always fall back to FTS

- `[search.embeddings].enabled` must be `true`
- the env var named in `api_key_env` (default `OPENAI_API_KEY`) must be set
- check stderr for the one-time warning at startup

### LLM session summary never fires

- `[hooks].summarize_mode = "llm"`
- `request_timeout_ms` must be less than the SessionEnd hook timeout (10s in Claude Code)
- check stderr for the fallback warning

### `better-sqlite3` fails to install

If prebuilt binaries are unavailable for your environment, install Node build prerequisites and retry.

## Test infrastructure

- **vitest** — run `npm test` for the full suite (1062+ tests)
- **tests/integration/secret-scrub-coverage.test.ts** — contract test for [privacy](privacy.md); fails if any new write path bypasses `scrubSecrets`
- **tests/sync/** — round-trip + path-traversal + future-timestamp tests for [team sync](team-sync.md)
- **tests/server/** — API + security + pagination for the [web inspector](web-inspector.md)

Migrations are versioned via `PRAGMA user_version`. Migration tests in `tests/db/migration-v2.test.ts` lock down the schema version assertion — if you add a migration, bump it there too.
