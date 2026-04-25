# Vault integration

When enabled, `memento-mcp` can index an Obsidian vault and use it as a curated knowledge source. The vault layer is the long-form, hand-curated counterpart to the operational SQLite memory layer.

## How vault integration works

1. `rebuildVaultIndex` scans the vault and parses frontmatter
2. Graph edges are built from `memento_children` and `[[wikilinks]]`
3. Routable notes are stored in SQLite index tables
4. `memory_search`, `memory_list`, `memory_get`, and hooks can surface relevant vault notes

## Required root notes

At the root of the vault:

- `me.md` — identity (who you are, working style, constraints)
- `vault.md` — map / routing rules

## Required frontmatter

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

## Vault commands

```bash
memento-mcp vault-index init       # creates me.md and vault.md from templates
memento-mcp vault-index rebuild    # re-scan vault and update SQLite indexes
memento-mcp vault-index stats      # totals, reachable, orphaned, edges
memento-mcp vault-index doctor     # diagnose orphans and missing roots
```

## SQLite vs Obsidian

Use **SQLite** for:

- fast operational memory
- preferences, facts, pitfalls, short-lived context
- hook injection state, analytics, budgets, and session tracking

Use **Obsidian** for:

- stable, curated knowledge
- maps, playbooks, project notes, decisions, skills
- longer-lived notes you want to keep readable and editable as Markdown

The intersection is:

- vault notes stay as Markdown files
- `memento-mcp` indexes them into SQLite for routing and retrieval
- search results can merge SQLite memory and vault knowledge

## Optional vault promotion from `memory_store`

`memory_store` always writes to SQLite. It can also promote a memory into the vault.

### Explicit promotion

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

Promote certain memory types automatically:

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

Default destination folders:

| Type | Folder |
|---|---|
| `preference` | `30 Domains/Memento Preferences` |
| `decision` | `40 Decisions/Memento Decisions` |
| `pattern` | `50 Playbooks/Memento Patterns` |
| `architecture` | `30 Domains/Memento Architecture` |
| `fact` | `30 Domains/Memento Facts` |
| `pitfall` | `50 Playbooks/Memento Pitfalls` |

Promoted notes are marked with:

- `memento_source: memory_store`
- `memento_memory_id: <sqlite-memory-id>`

This gives idempotent create/update behavior when using `create_or_update`.
