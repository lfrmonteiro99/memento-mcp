# Importing CLAUDE.md

If you have been using Claude Code's native `CLAUDE.md` memory file, you can import it into memento in seconds — no retyping required.

## Five-second onramp

```bash
# Preview what would be imported (no writes)
memento-mcp import claude-md --dry-run

# Import your global ~/.claude/CLAUDE.md
memento-mcp import claude-md --scope global --no-confirm

# Import a project-local CLAUDE.md (defaults to ./CLAUDE.md)
memento-mcp import claude-md --no-confirm
```

## How it works

The importer reads the file and splits it into sections:

- If the file has `##` headings, each heading becomes one memory.
- If not, blank-line-separated paragraphs each become one memory.

Each section is classified automatically:

| Keyword in heading or body | Inferred type |
|---|---|
| decision, chose, chosen, decided, ADR | `decision` |
| architecture, design, system | `architecture` |
| pitfall, gotcha, bug, trap, never, avoid | `pitfall` |
| pattern, convention, always, prefer | `pattern` |
| preference, style, like to | `preference` |
| (no match) | `fact` (or `--type` override) |

Tags are extracted from:

- `**BoldedProperNouns**` (5+ characters) in the body → lowercased tag
- `area:foo` and `env:bar` patterns in the body → kept as-is

## Flags

| Flag | Default | Description |
|---|---|---|
| `[path]` | `~/.claude/CLAUDE.md` (global) or `./CLAUDE.md` (project) | Source file |
| `--scope global\|project` | `project` | Where to store the memories |
| `--type <type>` | `fact` | Fallback type when no keyword matches |
| `--dry-run` | off | Print the section list and exit; no DB writes |
| `--no-confirm` | off | Skip the `Import N memories? [y/N]` prompt |

## Skip rules

Sections are silently skipped if they are:

- empty (no body text)
- body under 20 characters with no heading
- body that is a bare code fence only

## Duplicate handling

If a memory with the same title already exists in the target scope it is skipped and counted. Re-running on the same file is safe.

## Policy composition

If a project has `.memento/policy.toml` with `required_tags`, sections that produce no matching inferred tags are blocked with a printed reason. Sections matching `banned_content` patterns are also blocked. This mirrors the behavior of `memory_store` through the MCP tool path. See [Per-project policy](policy.md).

## Source tracking

All imported memories carry `source = "import-claude-md"` so you can identify them later with `memory_list` or direct SQL queries.
