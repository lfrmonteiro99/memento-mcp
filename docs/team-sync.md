# Team-scoped memories (git sync)

memento-mcp can ship memories to your team via git — no server, no auth, no infrastructure to host. Memories tagged `[scope=team]` serialize to a `.memento/` folder in your repo; commit, push, and your teammate runs one command to merge them in.

## Quick start

```bash
# In a git repo, one-time setup:
memento-mcp sync init                          # creates .memento/
git add .memento && git commit -m "memento init" && git push

# Store a memory with team scope (in any client):
memory_store(title="Use Postgres", content="...", scope="team", memory_type="decision")

# Each store writes a canonical JSON file under .memento/memories/<id>.json
# (Default: auto_push_on_store = false — call sync push manually so files
#  appear in `git status` only when you're ready.)
memento-mcp sync push

git add .memento && git commit -m "memory: auth refactor decisions" && git push

# Your teammate, on the same repo:
git pull
memento-mcp sync pull
# Their memento now knows what you learned.
```

## What you get

- **Canonical JSON** — sorted keys, 2-space indent, trailing newline. Diffs are minimal and review-friendly.
- **Atomic writes** — `<id>.json.tmp` then `rename`. Interrupted syncs never leave half-written files.
- **Path traversal guard** — `pushSingleMemory` resolves and asserts the target stays under `.memento/memories/`.
- **Future-timestamp guard** — pulled files with `updated_at > now + 24h` are rejected with a warning. A malicious commit can't silently overwrite everyone's memory.
- **Privacy on the wire** — `<private>` regions are redacted in the JSON; titles and tags pass through `scrubSecrets` before write.
- **Conflict policy** — last-write-wins by `updated_at`, file wins on tie. `sync status` shows drift; resolution is manual (you have git).
- **No edges in v1** — relationships ship in a follow-up. Schema is forward-compatible.

## Configuration

In `~/.config/memento-mcp/config.toml`:

```toml
[sync]
enabled = true
auto_push_on_store = false               # opt in to immediate writes
folder = ".memento"                      # relative to project root
include_private_in_files = false         # default: redact <private> on write
max_future_drift_hours = 24
```

## Subcommands

```bash
memento-mcp sync init       # creates .memento/ with README.md and .gitignore
memento-mcp sync push       # mirror DB team memories to .memento/memories/*.json
memento-mcp sync pull       # ingest .memento/memories/*.json into DB
memento-mcp sync status     # show drift: file-only, db-only, conflicting, in-sync
```

All subcommands accept `--project <path>` (defaults to `cwd`) and `--dry-run` (preview without writing).
