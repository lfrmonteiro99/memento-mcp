# Optional embeddings & smart dedup

memento-mcp ships an opt-in embedding layer that catches semantically similar memories the FTS5 keyword index would miss (e.g. "auth bug" finds "JWT validation failure"). It is **off by default** — no behavior change unless you enable it and provide an API key.

## Configure embeddings

In `~/.config/memento-mcp/config.toml`:

```toml
[search.embeddings]
enabled = false                       # opt-in
provider = "openai"
model = "text-embedding-3-small"
api_key_env = "OPENAI_API_KEY"
dim = 1536
top_k = 20
similarity_threshold = 0.5
```

Set the API key in your shell:

```bash
export OPENAI_API_KEY=sk-...
```

## Backfill existing memories

Run once after enabling, or any time you change the model:

```bash
memento-mcp backfill-embeddings --dry-run    # see what would happen
memento-mcp backfill-embeddings              # do it
memento-mcp backfill-embeddings --limit 100  # cap a single run
memento-mcp backfill-embeddings --model text-embedding-3-large
```

## How retrieval works

When enabled, the search hook merges FTS candidates with cosine top-K, then runs the existing adaptive ranker with rebalanced weights:

| Weight | FTS only | FTS + embeddings |
|---|---|---|
| `fts_relevance` | 0.30 | 0.20 |
| `embedding_relevance` | — | 0.15 |
| `importance` | 0.20 | 0.20 |
| `decay` | 0.15 | 0.15 |
| `utility` | 0.25 | 0.20 |
| `recency_bonus` | 0.10 | 0.10 |

Failures (network, timeout, missing key) gracefully fall back to FTS-only — embeddings never block a write or break a search.

## Smart write-time dedup

When embeddings are on, memento-mcp can refuse near-duplicate memories at write time instead of cleaning them up later in compression. **Off by default** — separate opt-in even when embeddings are enabled, because every write triggers an embedding API call.

```toml
[search.embeddings]
dedup = false                              # explicit second opt-in
dedup_threshold = 0.92
dedup_default_mode = "warn"                # "strict" | "warn" | "off"
dedup_check_on_update = true
dedup_max_scan = 2000                      # safety cap on per-write scan
```

Per-call override:

```text
memory_store(title="...", content="...", dedup="strict")    # block duplicates
memory_store(..., dedup="warn")                             # default — store + note
memory_store(..., dedup="off")                              # bypass
```

A `warn` mode hit returns:

```
Memory stored with ID: <id>
⚠ Possible duplicate of "Use Postgres" (sim 0.94, id abc-123). Consider memory_update or memory_link.
```

A `strict` mode hit blocks the insert entirely with the same message.

## Privacy

The dedup pipeline applies `scrubSecrets` and `redactPrivate` to the candidate text **before** it leaves for the embedding API. `<private>` regions and recognized secret patterns never reach the provider. See [Privacy](privacy.md).

## Storage

Embeddings are stored as `Float32Array` BLOBs in a dedicated `embeddings` table, keyed by `memory_id` and indexed by `model`. Cosine similarity is computed in-memory at query time — fine for projects up to ~50k memories per scope.

## Per-write cost guard

The `dedup_max_scan` cap (default 2000) skips the dedup check if the project's vector count exceeds the limit, logs a single warning, and lets the write proceed. Prevents unbounded scans on large projects.
