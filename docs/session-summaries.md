# End-of-session summaries

The `SessionEnd` hook (`memento-hook-summarize`) compresses a session's auto-captures into a single typed `session_summary` memory, linked to the `claude_session_id`.

## Two modes

### Deterministic (default)

Uses the existing compression clustering. No LLM call required, no API key needed, no content leaves the machine.

```toml
[hooks]
summarize_mode = "deterministic"   # default
session_end_summarize = true
session_end_min_captures = 2
session_end_max_body_tokens = 1500
session_end_keep_originals = false
```

The summary memory has type `session_summary`, importance equal to the max of source importances, and tags equal to the deduplicated union of source tags. Source memories are soft-deleted unless `session_end_keep_originals = true`.

### LLM-assisted (opt-in)

Calls Anthropic or OpenAI for prose distillation in four sections: *what changed*, *decisions*, *blockers*, *open questions*.

```toml
[hooks]
summarize_mode = "llm"

[hooks.session_end_llm]
provider = "anthropic"                           # "anthropic" | "openai"
model = "claude-haiku-3-5"                       # alias, not a dated id
api_key_env = "ANTHROPIC_API_KEY"
max_input_tokens = 4000
max_output_tokens = 800
request_timeout_ms = 8000                        # MUST be < SessionEnd subprocess budget (10s)
fallback_to_deterministic = true
```

The hook subprocess timeout in Claude Code is 10 seconds. `request_timeout_ms` must be less than that — otherwise the process gets killed before the fallback path can fire.

### Fallback behavior

If LLM mode fails for any reason (no key, network error, timeout, malformed response):

- with `fallback_to_deterministic = true` (default): falls back to the deterministic path, hook completes normally
- with `fallback_to_deterministic = false`: still exits 0 (hooks never block Claude Code), but no summary is created

## Audit before enabling

Print the exact prompt that would be sent without making any API call:

```bash
memento-mcp session summarize <claude_session_id> --dry-run
```

Output is prefixed with:

```
# DRY RUN — DO NOT STORE THIS OUTPUT
# Generated at <ISO timestamp>
```

Don't pipe `--dry-run` output into anything that triggers memory capture (e.g., a parent session's tool stdout) — the prompt contains memory body text.

## Privacy

`scrubSecrets` and `redactPrivate` are applied to:

1. Every capture's body **before** building the prompt
2. The **final assembled-and-truncated prompt** (so a truncation boundary that splits a `<private>` tag still redacts correctly)
3. The LLM response itself (in case the model echoes redactable content back)

The provider class is unloggable — its `toJSON()` returns `"[LlmProvider redacted]"` to prevent accidental key serialization in error stacks.

## Idempotency

Running the hook twice for the same `claude_session_id` produces exactly one `session_summary` memory. The second run detects the existing row and exits silently.
