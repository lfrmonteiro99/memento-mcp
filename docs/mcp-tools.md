# MCP tools reference

| Tool | Description |
|---|---|
| `memory_store` | Store a typed memory in SQLite, with optional promotion to the Obsidian vault |
| `memory_search` | Search ranked SQLite memories with progressive disclosure (index / summary / full); cost visible per result |
| `memory_timeline` | Fetch chronological context around a memory (neighbors ±2h); cost ~200 tokens per neighbor |
| `memory_get` | Retrieve full body for a SQLite memory or `vault:path/to/note.md` |
| `memory_list` | List SQLite memories and optionally vault notes by kind or folder |
| `memory_update` | Edit an existing memory (title, content, tags, importance, type, pinned) |
| `memory_pin` | Pin or unpin a memory so it survives pruning and ranks higher |
| `memory_delete` | Soft-delete a SQLite memory by ID |
| `memory_compress` | Manually run the compression pipeline on a project (or all) |
| `memory_export` | Export memories, decisions, and pitfalls as portable JSON |
| `memory_import` | Import a JSON dump with `skip` or `overwrite` conflict strategy |
| `decisions_log` | Store, list, or search architectural decisions with category and versioning |
| `pitfalls_log` | Track recurring problems with occurrence count and dedup |
| `memory_analytics` | View injection, capture, compression, and memory analytics |

## Tool parameters

<details>
<summary><code>memory_store</code></summary>

| Param | Type | Default | Notes |
|---|---|---|---|
| `title` | string | — | required |
| `content` | string | — | required; stored in `body` |
| `memory_type` | string | `"fact"` | `fact` / `decision` / `preference` / `pattern` / `architecture` / `pitfall` |
| `scope` | string | `"project"` | `"project"` / `"global"` / `"team"` (see [team sync](team-sync.md)) |
| `project_path` | string | `""` | project root; resolved to `project_id` |
| `tags` | string[] | `[]` | stored as JSON |
| `importance` | number | `0.5` | clamped to [0, 1] |
| `supersedes_id` | string | `""` | marks that memory deleted; cycle-guarded |
| `pin` | bool | `false` | |
| `dedup` | enum | `"warn"` | `"strict"` / `"warn"` / `"off"` — see [embeddings](embeddings.md) |
| `persist_to_vault` | bool | auto-type | see [vault](vault.md) |
| `vault_mode` | string | `"create_or_update"` | |
| `vault_kind`, `vault_folder`, `vault_note_title` | string | `""` | vault overrides |

</details>

<details>
<summary><code>memory_search</code></summary>

| Param | Type | Default | Notes |
|---|---|---|---|
| `query` | string | — | required |
| `project_path` | string | `""` | scope to a project (still includes globals) |
| `memory_type` | string | `""` | filter by type |
| `limit` | number | `10` | |
| `detail` | enum | `"index"` | `"index"` / `"summary"` / `"full"` — progressive disclosure; start with `"index"` |
| `include_file_memories` | bool | `true` | merge `~/.claude/projects/*/memory/*.md` results |

</details>

<details>
<summary><code>memory_timeline</code></summary>

Fetch memories created around a given memory (chronological neighborhood within same session or ±2h window).

| Param | Type | Default | Notes |
|---|---|---|---|
| `id` | string | — | required; the memory id to find neighbors around |
| `window` | number | `3` | how many neighbors on each side (±N); clamped to [1, 10] |
| `detail` | enum | `"summary"` | `"index"` (compact) or `"summary"` (first sentence) |
| `same_session_only` | bool | `true` | when true, filters by `claude_session_id` if available; falls back to ±2h `created_at` window |

</details>

<details>
<summary><code>memory_get</code></summary>

| Param | Type | Notes |
|---|---|---|
| `memory_id` | string | SQLite UUID, `file:<path>`, or `vault:<relative/path>` |
| `reveal_private` | bool | when true, returns `<private>` content with a banner; emits `private_revealed` analytics event |

</details>

<details>
<summary><code>memory_list</code></summary>

| Param | Type | Default | Notes |
|---|---|---|---|
| `project_path` | string | `""` | |
| `memory_type` | string | `""` | |
| `scope` | string | `""` | |
| `pinned_only` | bool | `false` | |
| `limit` | number | `20` | |
| `detail` | enum | `"full"` | `index` / `summary` / `full` |
| `include_file_memories` | bool | `false` | |
| `vault_kind` | string | `""` | filter vault notes by kind |
| `vault_folder` | string | `""` | filter vault notes by folder |

</details>

<details>
<summary><code>memory_update</code></summary>

Patch-style update. Omitted fields are left untouched. At least one field (other than `memory_id`) is required.

| Param | Type | Notes |
|---|---|---|
| `memory_id` | string | required |
| `title` | string | |
| `content` | string | updates `body` |
| `tags` | string[] | replaces entire tag list (stored as JSON) |
| `importance` | number | clamped to [0, 1] |
| `memory_type` | string | |
| `pinned` | bool | |

Bumps `updated_at`. Rejects updates on soft-deleted memories with "not found".

</details>

<details>
<summary><code>memory_pin</code></summary>

| Param | Type | Default | Notes |
|---|---|---|---|
| `memory_id` | string | — | required |
| `pinned` | bool | `true` | pass `false` to unpin |

Pinned memories are skipped by pruning, the importance auto-promoter, and stay on top of `memory_list(pinned_only=true)`.

</details>

<details>
<summary><code>memory_delete</code></summary>

| Param | Type | Notes |
|---|---|---|
| `memory_id` | string | soft-delete; row is filtered from all reads, but preserved for audit |

</details>

<details>
<summary><code>memory_compress</code></summary>

Manual trigger of the compression pipeline.

| Param | Type | Default | Notes |
|---|---|---|---|
| `project_path` | string | `""` | empty → every registered project |

Returns a summary: cluster count, token totals, and per-project breakdown. Returns `"No clusters found to compress."` if nothing is similar enough. Honors `compression.enabled = false`.

</details>

<details>
<summary><code>memory_export</code></summary>

| Param | Type | Default | Notes |
|---|---|---|---|
| `project_path` | string | `""` | empty → export everything; otherwise include globals + that project's memories/decisions/pitfalls |

Output is JSON:

```json
{
  "schema_version": 2,
  "exported_at": "2026-04-24T15:00:00Z",
  "projects":  [...],
  "memories":  [...],
  "decisions": [...],
  "pitfalls":  [...]
}
```

</details>

<details>
<summary><code>memory_import</code></summary>

| Param | Type | Default | Notes |
|---|---|---|---|
| `path` | string | — | required; path to JSON produced by `memory_export` |
| `strategy` | enum | `"skip"` | `"skip"` keeps existing rows on id conflict; `"overwrite"` replaces them |

Transactional (all-or-nothing). Rejects incompatible `schema_version` with a clear error. Returns counts of imported / skipped / overwritten rows.

</details>

<details>
<summary><code>decisions_log</code></summary>

| Param | Type | Default | Notes |
|---|---|---|---|
| `action` | string | — | `"store"` / `"list"` / `"search"` |
| `project_path` | string | — | required |
| `title`, `body`, `category` | string | — | `action="store"` |
| `importance` | number | `0.7` | |
| `supersedes_id` | string | `""` | |
| `query` | string | `""` | `action="search"` |
| `limit` | number | `10` | |

</details>

<details>
<summary><code>pitfalls_log</code></summary>

| Param | Type | Default | Notes |
|---|---|---|---|
| `action` | string | — | `"store"` / `"list"` / `"resolve"` |
| `project_path` | string | — | required |
| `title`, `body` | string | — | `action="store"` |
| `importance` | number | `0.6` | |
| `limit` | number | `10` | |
| `include_resolved` | bool | `false` | |
| `pitfall_id` | string | `""` | `action="resolve"` |

</details>

<details>
<summary><code>memory_analytics</code></summary>

| Param | Type | Default | Notes |
|---|---|---|---|
| `period` | enum | `"last_7d"` | `"last_24h"` / `"last_7d"` / `"last_30d"` / `"all"` |
| `section` | enum | `"all"` | `"all"` / `"injections"` / `"captures"` / `"compression"` / `"memories"` |
| `project_path` | string | `""` | empty or `"global"` → aggregate across all projects |

Output sections:

- **injections** — sessions, total tokens, avg tokens/session
- **captures** — auto-capture count, skip count, capture rate
- **compression** — runs, tokens_before → tokens_after, tokens saved, avg ratio
- **memories** — active vs deleted counts, breakdown by type
- **prune recommendations** — auto-generated "delete" / "archive" suggestions based on usage signal

Footer notes when tracking began, or warns when no events have been recorded yet.

</details>

## Auto-capture via Claude Code hooks

Three hook binaries ship with the package (plus the SessionEnd summarize hook covered in [session summaries](session-summaries.md)):

- `memento-hook-search` — `UserPromptSubmit` hook that injects the top-N relevant memories
- `memento-hook-session` — `SessionStart` hook that surfaces pinned/recent memories and active pitfalls
- `memento-hook-capture` — `PostToolUse` hook that captures `Bash`/`Read`/`Grep`/`Edit` results as memories when they look informative (git log, config files, error output), with classifier-driven dedup, per-session cooldown, and secret scrubbing

Set them up via `memento-mcp install` or add manually to `~/.claude/settings.json` (see [install](install.md)).

### Auto-capture rules

`memento-hook-capture` runs after matching tool calls and decides per-call whether to store something:

- **Bash** — captures `git log` / `git diff` / `git status` output, build/test failures (pitfall type), and any stdout between `min_output_length` and `max_output_length`
- **Read** — captures config-file reads (`*.toml`, `*.yaml`, `*.json`, `Dockerfile`, …) as `architecture` memories; source-code reads are skipped
- **Grep** — captures pattern results when match count is in [3, 50]; trivially-narrow or repo-wide matches are skipped
- **Edit** — captures significant changes (multi-line or more than a trivial rename)

Always skipped:

- outputs shorter than `auto_capture.min_output_length` or larger than `auto_capture.max_output_length`
- tools not in `auto_capture.tools`
- rapid-fire duplicates (same tool + key within `cooldown_seconds`)
- body that matches a recent memory at Jaccard similarity ≥ `dedup_similarity_threshold` (project-scoped)
- sessions that already hit `max_per_session`

## Utility signals and adaptive ranking

Once a memory is injected, `memento-hook-capture` watches the next tool calls in that session (within `adaptive.utility_window_minutes`) to decide whether the memory was *actually useful*:

- **`explicit_access`** — the memory's id or title shows up in a subsequent `memory_get` / `memory_search` response. Strength `1.0`.
- **`tool_reference`** — a fingerprint of the memory (file path, PascalCase / camelCase identifier ≥ 5 chars) appears in a subsequent tool input or response. Strength `0.8` if the match is ≥ 20 chars, else `0.5`.
- **`ignored`** — the injection window expired without any match.

These land in `analytics_events` and feed:

1. **`computeUtilityScore(db, memory_id)`** — mixed ratio of *used* vs *injected* plus average signal strength, weighted by a confidence factor (N/5 capped at 1). Neutral `0.5` for memories with no injection history.
2. **Adaptive score** used by `memory_search` and `SessionStart`:

   ```
   score = fts_relevance * 0.30
         + importance    * 0.20
         + decay         * 0.15   // computeExponentialDecay(daysSince(last_accessed_at), half_life=14)
         + utility       * 0.25
         + recency_bonus * 0.10
   ```

   Weights are tunable via `[adaptive.score_weights]`. When embeddings are enabled the weights rebalance — see [embeddings](embeddings.md).

The adaptive ranker also drives **automatic importance tuning**: every maintenance pass takes memories with ≥ `min_injections_for_confidence` injections and nudges their `importance_score` toward the observed utility (delta = `(utility - neutral_utility_score) * 0.2`, clamped to ±0.05 per pass). Pinned memories are skipped — user intent wins.

## Compression pipeline

Compression folds clusters of similar recent memories into one summary row. Triggered when any of:

- active memory count for a project exceeds `compression.memory_count_threshold`
- auto-captured memories in the last 24h exceed `compression.auto_capture_batch_threshold`

Pipeline (all inside one `db.transaction()` for atomicity):

1. **Select candidates** — newest 200 active memories per project (excludes `source='compression'` to prevent re-compression).
2. **Cluster** — Union-Find single-linkage on pairwise similarity. The combined score is `tag_jaccard * 0.25 + title_trigram * 0.30 + file_path_jaccard * 0.30 + temporal_proximity * 0.15`. Clusters with size < `min_cluster_size` are discarded.
3. **Merge** — each cluster is collapsed into one memory: sentence dedup across the cluster (Jaccard > 0.6), token budget = `sum(cluster_tokens) * max_body_ratio`, importance = `max(sources) + 0.1` (capped at 1), dominant `memory_type` wins, `tags` includes `"compressed"`.
4. **Store** — the new row is inserted with `source='compression'`, the merge is audited in `compression_log`, and source memories are soft-deleted.

Run manually with `memory_compress`; otherwise runs as part of the maintenance cycle.

## Maintenance cycle

On server startup and every `pruning.interval_hours`, the server runs:

1. **Prune stale memories** — `pruneStale(max_age_days, min_importance)` soft-deletes unpinned low-importance rows not accessed for `max_age_days`. Per-project policy (see [policy](policy.md)) can tighten this further.
2. **Analytics retention** — `cleanupExpiredAnalytics(retention_days)` deletes `analytics_events` rows older than the cutoff.
3. **Importance auto-promote** — nudges unpinned memories' `importance_score` toward observed utility.
4. **WAL checkpoint** — `PRAGMA wal_checkpoint(TRUNCATE)` rotates the WAL so it doesn't grow unboundedly between restarts.
5. **VACUUM** — rate-limited to once per 24h; reclaims disk space freed by soft-deletes and compression.
6. **Compression** — `runCompressionCycle` per project (if `compression.enabled`).

Each step is independently wrapped in try/catch so a failure in one doesn't abort the rest.
