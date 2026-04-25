# Mode profiles

`memento-mcp` supports language-aware **mode profiles** for keyword extraction and trivial-prompt detection. Profiles bundle:

- Stop-word lists (used by keyword extraction)
- Trivial-prompt patterns (used by classification)
- Optional locale tag for future date/number formatting

## Built-in profiles

Three profiles ship by default:

- **`english`** (default) — English stop-words and trivial patterns
- **`portuguese`** — Portuguese stop-words (`o`, `a`, `de`, etc.) and trivial patterns (`oi`, `obrigado`, etc.)
- **`spanish`** — Spanish stop-words (`el`, `la`, `de`, etc.) and trivial patterns (`hola`, `gracias`, etc.)

## Selecting a profile

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

## Extending a profile

You can add custom stop-words and trivial patterns on top of any built-in profile:

```toml
[profile]
id = "english"
extra_stop_words = ["foo", "bar"]
extra_trivial_patterns = ["maybe", "perhaps"]
```

These are merged with the profile's defaults. Useful for domain-specific vocabulary or project-specific greetings.

## Inspecting the active profile

Two subcommands help debug which profile is in use:

```bash
# Show profile ID and counts
memento-mcp profile

# Dump full stop-word list and patterns
memento-mcp profile --dump
```

## Impact on search and classification

- **Keyword extraction** — stop-words from the active profile are filtered out, so Portuguese queries stay focused on meaningful terms.
- **Trivial-prompt detection** — short prompts like `"oi"` (Portuguese for "hi") classify as trivial under `portuguese` but standard under `english`, affecting how much context is injected.

Default behavior is **identical to v1** when using the default English profile.
