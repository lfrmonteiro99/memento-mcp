# Configuration

Config file location:

- Linux/macOS: `~/.config/memento-mcp/config.toml`
- Windows: `%APPDATA%/memento-mcp/config.toml`

Every section is optional. Missing sections and keys fall back to the defaults shown below. A v1 config (only `[budget]` / `[search]` / `[hooks]` / `[pruning]`) continues to parse — the new v2 sections just use defaults.

Malformed TOML is **not** silently ignored. The server logs a `WARN` to stderr and falls back to defaults (see `MEMENTO_LOG_LEVEL`).

## Full reference

```toml
[budget]
total = 8000             # max tokens per session
floor = 500              # stop injection when remaining < floor
refill = 200             # top-up applied on "complex" prompts
session_timeout = 1800

[search]
default_detail = "index"         # "index" | "summary" | "full"
max_results = 10
body_preview_chars = 200
keyword_max_tokens = 8           # max keywords extracted per query
preserve_phrases = true          # bigram phrase boosting in FTS
fts_prefix_matching = true       # single terms become prefix matches

[search.embeddings]              # see docs/embeddings.md for full details
enabled = false
provider = "openai"
model = "text-embedding-3-small"
api_key_env = "OPENAI_API_KEY"
dim = 1536
top_k = 20
similarity_threshold = 0.5
dedup = false
dedup_threshold = 0.92
dedup_default_mode = "warn"      # "strict" | "warn" | "off"
dedup_check_on_update = true
dedup_max_scan = 2000

[hooks]
trivial_skip = true
session_start_memories = 5
session_start_pitfalls = 5
custom_trivial_patterns = []
analytics_reminder_interval_sessions = 20
summarize_mode = "deterministic" # "deterministic" | "llm" — see docs/session-summaries.md

[hooks.session_end_llm]
provider = "anthropic"           # "anthropic" | "openai"
model = "claude-haiku-3-5"
api_key_env = "ANTHROPIC_API_KEY"
max_input_tokens = 4000
max_output_tokens = 800
request_timeout_ms = 8000        # must be < SessionEnd subprocess budget
fallback_to_deterministic = true

[pruning]
enabled = true
max_age_days = 60
min_importance = 0.3
interval_hours = 24              # maintenance cadence (also drives compression + retention + VACUUM)

[database]
path = ""                        # empty = default (~/.local/share/memento-mcp/memento.sqlite)

[decay]
type = "exponential"             # "exponential" | "step"
half_life_days = 14

[auto_capture]
enabled = true
min_output_length = 200          # skip tool outputs shorter than this
max_output_length = 50000        # skip tool outputs larger than this
cooldown_seconds = 30            # min gap between captures for the same tool+key
dedup_similarity_threshold = 0.7 # Jaccard threshold that counts as a duplicate
max_per_session = 20
default_importance = 0.3
tools = ["Bash", "Read", "Grep", "Edit"]
session_timeout_seconds = 3600   # TTL for per-session cooldown trackers

[compression]
enabled = true
memory_count_threshold = 150     # trigger compression when project has more active memories
auto_capture_batch_threshold = 50 # or when > N auto-captured in the last 24h
staleness_days = 7
cluster_similarity_threshold = 0.45
min_cluster_size = 2
max_body_ratio = 0.6             # compressed body budget = max_body_ratio * sum(cluster tokens)
temporal_window_hours = 48

[adaptive]
enabled = true
utility_window_minutes = 10      # how long an injection stays "open" to collect utility signals
decay_half_life_days = 14
min_injections_for_confidence = 5
neutral_utility_score = 0.5

[adaptive.score_weights]         # must sum to ~1.0
fts_relevance = 0.30
importance = 0.20
decay = 0.15
utility = 0.25
recency_bonus = 0.10

[analytics]
enabled = true
flush_threshold = 20             # buffered events flushed when N is reached
retention_days = 90              # analytics_events rows older than this are pruned
prune_check_interval = 24

[file_memory]
enabled = true
cache_ttl_seconds = 60           # TTL for parsed ~/.claude/projects/*/memory/*.md files

[vault]                          # see docs/vault.md
enabled = false
path = ""
require_publish_flag = true
max_hops = 3
max_results = 5
hook_max_results = 2
auto_promote_types = []

[sync]                           # see docs/team-sync.md
enabled = true
auto_push_on_store = false
folder = ".memento"
include_private_in_files = false
max_future_drift_hours = 24

[profile]                        # see docs/mode-profiles.md
id = "english"                   # builtin: english | portuguese | spanish
extra_stop_words = []
extra_trivial_patterns = []
locale = ""
```

## Environment variables

| Variable | Effect |
|---|---|
| `MEMENTO_BUDGET` | Overrides `budget.total` |
| `MEMENTO_FLOOR` | Overrides `budget.floor` |
| `MEMENTO_REFILL` | Overrides `budget.refill` |
| `MEMENTO_SESSION_TIMEOUT` | Overrides `budget.session_timeout` |
| `MEMENTO_LOG_LEVEL` | `error` / `warn` (default) / `info` / `debug` — routed to stderr |
| `MEMENTO_PROFILE` | Overrides `[profile].id` (builtin: `english` / `portuguese` / `spanish`) |
| `OPENAI_API_KEY` | Embeddings provider (when `[search.embeddings].enabled = true`) |
| `ANTHROPIC_API_KEY` | LLM session-summary provider (when `[hooks].summarize_mode = "llm"` and `[hooks.session_end_llm].provider = "anthropic"`) |
