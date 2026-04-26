# Per-project policy (`.memento/policy.toml`)

Beyond the global config, each project can ship its own policy file alongside `.eslintrc` and `tsconfig.json`. Policy is **purely additive** — it tightens the global setting, never loosens it.

Discovery walks up from `cwd` looking for `.memento/policy.toml` (preferred) or `.memento.toml` (back-compat). Symlink-safe (resolves `realpath` and aborts outside the user's home).

## Example `.memento/policy.toml`

```toml
schema_version = 1

[required_tags]
# Every new memory must carry at least one of these tags.
any_of = ["area:auth", "area:db", "area:ui", "area:infra"]

[banned_content]
# ReDoS-safe: patterns longer than 200 chars or with nested quantifiers
# are rejected at compile time with a warning.
patterns = [
  '(?i)internal-tool-name-x',
  '(?i)\bcustomer\s+data\b',
]

[retention]
max_age_days = 180     # tightens global pruning for this project only
min_importance = 0.4

[default_importance_by_type]
decision = 0.7
architecture = 0.7
pattern = 0.6
fact = 0.4

[auto_promote_to_vault]
types = ["architecture", "decision"]

[profile]
extra_stop_words = ["myproject", "internal"]    # adds to active mode profile
```

## Enforcement at the write path

- `required_tags.any_of` blocks `memory_store` if no listed tag is present. Error message includes the full allowed list so the caller can retry.
- `banned_content` regexes are tested against title, body, AND tags at write time. Error cites the policy file and the matching pattern.
- `default_importance_by_type` fills in `importance_score` when not explicitly set.
- `auto_promote_to_vault` flips `persist_to_vault = true` for matching `memory_type` values.
- `extra_stop_words` extends the active mode profile during keyword extraction.

## Enforcement at pruning

If `[retention]` is set, the project is pruned with the tighter of (project setting, global setting). The `Math.min` for `max_age_days` and `Math.max` for `min_importance` enforces the "policy can only tighten" rule.

## CLI

```bash
memento-mcp policy                    # show the resolved policy for cwd
memento-mcp policy validate <path>    # parse and report errors
memento-mcp policy init               # write a richly-commented template
```

The `init` command writes a template with every section commented out and a one-line explanation per field — designed to be the primary onramp for adoption.

## Composition with other features

- **Memory file imports** — `import claude-md`, `import cursor`, `import copilot`, `import auto`, and the other format subcommands all run sections through the same policy gate; violators are skipped with a printed reason. See [Importing existing project memory](import.md).
- **Auto-capture** — captured memories also pass through policy enforcement.
- **Team sync** — policy is per-clone (each repo carries its own); the file is git-tracked alongside other project config.
