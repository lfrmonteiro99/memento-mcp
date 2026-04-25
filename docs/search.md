# Token-aware search workflow

The search tools implement **three layers of progressive disclosure**, each with visible token costs. Use the cheapest layer that answers your question.

## The three layers

| Layer | Tool / Mode | Cost / Result | When to use |
|---|---|---|---|
| 1 | `memory_search(detail="index")` | ~30 tokens | **First scan**: titles + scores only. Fastest, cheapest. |
| 2 | `memory_search(detail="summary")` | ~80 tokens | **Shortlist**: preview first sentences of matching bodies. |
| 3a | `memory_timeline(id, window=3)` | ~200 tokens | **Context around one hit**: chronological neighborhood (±2h session window). |
| 3b | `memory_get(id)` | ~300-800 tokens | **Full body**: complete memory for final decision. |

## Workflow example

```
1. memory_search("typescript strict mode", detail="index")
   → Returns 5 hits with ~30 tokens each = 150 tokens total

2. memory_timeline(id="...", window=3)
   → Fetches 6 neighbors around the #1 hit = ~200 tokens
   → Gives chronological context: what was done before/after this decision

3. memory_get(id="...")  [optional]
   → If timeline hints you need the full body = ~500 tokens
```

## Visible costs

Every search result line shows its token cost in `[Nt]` format:

```
1. [28t] TypeScript strict mode rationale  (score: 0.94, type: decision)  id=abc-123
2. [31t] Build pipeline order  (score: 0.71, type: pattern)  id=def-456
...
Found 5 memories (total: 187 tokens).
Use memory_timeline(id) for chronological context (~200t each)
or memory_get(id) for full body (~400t each).
```

The footer displays totals and conditional hints about next-layer tools.

## Why this matters

Models tend to fetch the most expensive layer first when costs are invisible. Showing per-result and per-layer costs upfront lets the model pick the cheap path. In practice this saves 60-80% of context tokens spent on memory retrieval.

## Composition

- **`memory_search(detail="full")`** still works but is the costliest path; reserve for cases where you know exactly which memory you want and need its full body inline.
- **`memory_timeline`** uses `claude_session_id` (same-session preference) when available, falling back to a ±2h `created_at` window. Set `same_session_only=false` to always use the time window.
- The `[Nt]` markers come from `estimateTokensV2` — a character-based heuristic. They're approximations, sufficient for picking layers.

## Analytics

Every `memory_search` call emits a `search_layer_used` event recording `{ detail, results, total_tokens }`. View the breakdown via `memory_analytics` — useful to see whether your agent is actually picking cheap layers first.
