# Importing existing project memory

If you've been using Claude Code, Cursor, GitHub Copilot, Codex (via AGENTS.md), Gemini CLI, Windsurf, Cline, or Roo Code, you can import their instruction files into memento in seconds — no retyping required.

## Five-second onramp

```bash
# One-shot: detect every known LLM memory file in the project and import them all
memento-mcp import auto --dry-run        # preview
memento-mcp import auto --no-confirm     # do it

# Or target a single format
memento-mcp import claude-md --no-confirm
memento-mcp import cursor --no-confirm
memento-mcp import copilot --no-confirm
memento-mcp import agents-md --no-confirm
```

## Supported formats

Each subcommand auto-detects the conventional file path for its tool. You can also pass an explicit path as the first positional argument.

| Subcommand | What it reads | `source` tag stored in DB |
|---|---|---|
| `claude-md` | `./CLAUDE.md` (project) or `~/.claude/CLAUDE.md` (global with `--scope global`) | `import-claude-md` |
| `cursor` | `./.cursor/rules/*.mdc` (preferred) or legacy `./.cursorrules` | `import-cursor` |
| `copilot` | `./.github/copilot-instructions.md` + `./.github/instructions/*.instructions.md` (aggregated) | `import-copilot` |
| `agents-md` | `./AGENTS.md` (walks up to the git root if not in cwd) — the cross-tool standard read by Codex, Aider, Roo, Cline, Cursor, Windsurf, OpenHands, Continue | `import-agents-md` |
| `gemini-md` | `./GEMINI.md` (walks up) or `~/.gemini/GEMINI.md` (with `--scope global`) | `import-gemini-md` |
| `windsurf` | `./.windsurfrules` or `./global_rules.md` (project), or `~/.codeium/windsurf/memories/global_rules.md` (global) | `import-windsurf` |
| `cline` | `./.clinerules` (file or directory — directory mode aggregates) | `import-cline` |
| `roo` | `./.roo/rules/**/*.md` (recursive, alphabetical) or legacy `./.roorules` | `import-roo` |
| `auto` | Detects every format above in canonical priority order, dedupes overlapping titles across formats, single confirmation prompt | each row keeps its per-format source |

## How `import auto` works

`auto` is the recommended entry point if you have files for more than one tool.

1. Walks the project for every known file/directory.
2. Reads each into typed memories.
3. Dedupes section titles **across** formats (priority order: `claude-md` → `cursor` → `copilot` → `agents-md` → `gemini-md` → `windsurf` → `cline` → `roo`). This means an `AGENTS.md` section that duplicates a `CLAUDE.md` section gets skipped, since both tools commonly hold the same project rules.
4. Prints a per-format summary table:
   ```
   Found 3 formats:
     CLAUDE.md                              12 sections
     .cursor/rules (3 files)                 8 sections
     AGENTS.md                               5 sections (3 dup, skipped)
   Total: 22 unique sections.

   Import 22 memories from 3 format(s)? [y/N]
   ```
5. One prompt covers everything. Each row stored carries its own `source` tag so audits stay precise.

## How parsing works

Every format is markdown at heart. The importer:

- If the file has `##` headings, each heading becomes one memory.
- If not, blank-line-separated paragraphs each become one memory.
- For `.cursor/rules/*.mdc` and `.github/instructions/*.instructions.md`, leading YAML frontmatter is stripped and routed:
  - `globs` / `applyTo` → `glob:*` tags (max 5, lowercased)
  - `alwaysApply: true` → `cursor:always` tag
  - `description` → used as title fallback or prepended to body for type/tag inference
- For directory imports (`.cursor/rules/`, `.roo/rules/`, etc.), section titles are prefixed with `[basename]` (e.g. `[auth.mdc] Validate JWT`) so headings from different files don't collide on the title-dedup query.

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
- frontmatter `globs`/`applyTo`/`alwaysApply` for `.mdc` and `.instructions.md`

## Flags

All subcommands share the same flag set.

| Flag | Default | Description |
|---|---|---|
| `[path]` | format-specific (see table above) | Source file or directory; overrides auto-detection |
| `--scope global\|project` | `project` | Where to store the memories. Only `claude-md`, `gemini-md`, and `windsurf` have meaningful global defaults |
| `--type <type>` | `fact` | Fallback type when no keyword matches |
| `--dry-run` | off | Print the section list and exit; no DB writes |
| `--no-confirm` | off | Skip the `Import N memories? [y/N]` prompt |

## Skip rules

Sections are silently skipped if they are:

- empty (no body text)
- body under 20 characters with no heading
- body that is a bare code fence only

## Duplicate handling

Within a single format, memories with the same title in the target scope are skipped and counted. Re-running on the same file is safe.

In `auto` mode, dedup also runs **across** formats by title — so the same rule duplicated in CLAUDE.md and AGENTS.md is imported only once (the higher-priority format wins).

## Policy composition

If a project has `.memento/policy.toml` with `required_tags`, sections that produce no matching inferred tags are blocked with a printed reason. Sections matching `banned_content` patterns are also blocked. This applies to every import format and mirrors the behavior of `memory_store` through the MCP tool path. See [Per-project policy](policy.md).

## Source tracking

Every imported memory carries a `source` tag matching its format (e.g. `import-cursor`, `import-agents-md`). You can identify them later with `memory_list` or:

```sql
SELECT source, count(*) FROM memories WHERE deleted_at IS NULL GROUP BY source;
```
