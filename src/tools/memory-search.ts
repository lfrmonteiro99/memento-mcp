import type Database from "better-sqlite3";
import type { MemoriesRepo } from "../db/memories.js";
import type { Config } from "../lib/config.js";
import type { AnalyticsTracker } from "../analytics/tracker.js";
import { applyDecay } from "../lib/decay.js";
import { searchFileMemories } from "../lib/file-memory.js";
import { formatIndex, formatFull, formatSummary, formatVaultEntry, formatVaultIndex } from "../lib/formatter.js";
import { estimateTokensV2 } from "../engine/token-estimator.js";
import { searchVault } from "../engine/vault-router.js";
import { EdgesRepo, type EdgeType, type EdgeRow } from "../db/edges.js";
import { reciprocalRankFusion } from "../engine/rrf.js";
import { createProvider, type EmbeddingProvider } from "../engine/embeddings/provider.js";
import type { EmbeddingsRepo } from "../db/embeddings.js";

/** Structured payload for the memory_search tool's outputSchema. */
export type MemorySearchResult = {
  query: string;
  detail: "index" | "summary" | "full";
  count: number;
  results: Array<{
    id: string;
    title: string;
    score: number;
    source: "sqlite" | "file";
    memory_type?: string;
    body?: string;
  }>;
  vault_results: Array<{ relativePath: string; title?: string }>;
  total_tokens: number;
};

/**
 * Run a memory search and produce both a human-readable text rendering and a
 * machine-readable structured payload. The text and structured shape are
 * computed from the same in-memory result set so they can never disagree.
 */
export async function searchMemories(
  repo: MemoriesRepo,
  config: Config,
  params: {
    query: string; project_path?: string; memory_type?: string;
    limit?: number; detail?: "index" | "summary" | "full"; include_file_memories?: boolean;
    include_edges?: boolean;
    edge_types?: EdgeType[];
    edge_direction?: "outgoing" | "incoming" | "both";
    /** P3 Task 6: when an edge points to a soft-deleted memory (e.g. a
     * derives_from source rolled up by consolidation), include it instead of
     * silently skipping. Useful for surfacing provenance on compressed hits. */
    include_deleted_neighbours?: boolean;
  },
  db?: Database.Database,
  analyticsTracker?: AnalyticsTracker,
  embRepo?: EmbeddingsRepo,
  providerOverride?: EmbeddingProvider,
): Promise<{ text: string; structured: MemorySearchResult }> {
  const limit = params.limit ?? config.search.maxResults;
  const detail = params.detail ?? config.search.defaultDetail;
  const sqliteResults: any[] = [];

  const raw = repo.search(params.query, {
    projectPath: params.project_path, memoryType: params.memory_type, limit,
  });

  // Hybrid retrieval: RRF-merge FTS hits with cosine vector hits when provider and embRepo are available.
  let workingSet: any[];
  let provider: EmbeddingProvider | null = null;
  try {
    provider = providerOverride ?? (embRepo ? createProvider(config.search.embeddings) : null);
  } catch {
    // TOML misconfiguration (e.g. unsupported provider). Fall back to FTS-only.
    provider = null;
  }

  if (provider && embRepo) {
    try {
      const [queryVec] = await provider.embed([params.query]);
      const projectId = params.project_path ? repo.ensureProject(params.project_path) : null;
      const vecHits = embRepo.topKByCosine(queryVec, projectId, provider.model, limit * 2);
      if (vecHits.length > 0) {
        const ftsRanking = raw.map((r: any) => ({ id: r.id, score: Math.abs(r.rank ?? 0) }));
        const vecRanking = vecHits.map(h => ({ id: h.id, score: h.score }));
        const fused = reciprocalRankFusion([ftsRanking, vecRanking], { k: 60 });
        const candidateIds = fused.slice(0, limit * 2).map(f => f.id);

        // Build workingSet preserving fused order, fetching any vec-only ids from DB.
        const idMap = new Map<string, any>();
        for (const r of raw) idMap.set(r.id, r);
        for (const id of candidateIds) {
          if (!idMap.has(id)) {
            const m = repo.getById(id);
            if (m && !m.deleted_at) idMap.set(id, m);
          }
        }
        workingSet = candidateIds.map(id => idMap.get(id)).filter(Boolean);
      } else {
        workingSet = raw;
      }
    } catch {
      // Provider failed at runtime (e.g. model not installed). Fall through to FTS-only silently.
      workingSet = raw;
    }
  } else {
    workingSet = raw;
  }

  const rawRanks = workingSet.map((r: any) => Math.abs(r.rank ?? 0));
  const maxRank = Math.max(...rawRanks, 1);
  for (const r of workingSet) {
    const normalizedRank = Math.abs(r.rank ?? 0) / maxRank;
    const baseScore = normalizedRank * 0.6 + (r.importance_score ?? 0.5) * 0.4;
    r.score = applyDecay(baseScore, r.last_accessed_at);
    // Hardcode the search-layer source. The DB has its own `source` column
    // (e.g. "user"|"auto-capture"|"compression") which would leak into the
    // structured output schema and break the "sqlite"|"file" enum.
    r.source = "sqlite";
    sqliteResults.push(r);
  }

  if (params.include_file_memories !== false) {
    const fileResults = searchFileMemories(params.query, params.project_path);
    for (const r of fileResults) { r.source = "file"; sqliteResults.push(r); }
  }

  sqliteResults.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const limitedSqlite = sqliteResults.slice(0, limit);

  // P4 Task 7: aggregate anchor status per result. Precedence:
  // anchor-deleted > stale > fresh. Memories without anchors are unannotated.
  if (db && limitedSqlite.length > 0) {
    const ids = limitedSqlite.map((r: any) => r.id).filter(Boolean) as string[];
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      const aggregateRows = db.prepare(`
        SELECT memory_id,
               SUM(CASE WHEN status = 'stale' THEN 1 ELSE 0 END) AS stale_count,
               SUM(CASE WHEN status = 'anchor-deleted' THEN 1 ELSE 0 END) AS deleted_count,
               COUNT(*) AS total
        FROM memory_anchors
        WHERE memory_id IN (${placeholders})
        GROUP BY memory_id
      `).all(...ids) as Array<{ memory_id: string; stale_count: number; deleted_count: number; total: number }>;
      const byId = new Map(aggregateRows.map(r => [r.memory_id, r]));
      for (const row of limitedSqlite) {
        const agg = byId.get(row.id);
        if (!agg) continue; // no anchors → leave undefined
        if (agg.deleted_count > 0) row.anchor_status = "anchor-deleted";
        else if (agg.stale_count > 0) row.anchor_status = "stale";
        else row.anchor_status = "fresh";
      }
    }
  }

  // Vault results — separate section appended after SQLite results
  const vaultEntries = db && config.vault.enabled
    ? searchVault(db, config.vault, params.query)
    : [];

  // Edge-neighbours pass — additive; only runs when explicitly requested.
  type EdgeNeighbour = {
    hit_id: string;
    hit_title: string;
    arrow: "→" | "←";
    edge_type: EdgeType;
    weight: number;
    neighbour: any;
  };
  let edgeNeighbours: EdgeNeighbour[] = [];

  if (params.include_edges && db) {
    const edgeRepo = new EdgesRepo(db);
    const direction = params.edge_direction ?? "both";
    const filterTypes = params.edge_types;
    const seen = new Set<string>(
      limitedSqlite.filter((r: any) => r.id).map((r: any) => r.id as string)
    );

    const includeDeleted = params.include_deleted_neighbours === true;
    const fetchById = (id: string): any | null =>
      includeDeleted ? repo.getByIdIncludingDeleted(id) : repo.getById(id);

    const collect = (
      hit: any,
      edges: EdgeRow[],
      arrow: "→" | "←",
      neighbourSide: "from" | "to",
    ) => {
      for (const e of edges) {
        const neighbourId = neighbourSide === "to" ? e.to_id : e.from_id;
        if (seen.has(neighbourId)) continue;
        const m = fetchById(neighbourId);
        if (!m) continue;
        if (m.deleted_at && !includeDeleted) continue;
        seen.add(neighbourId);
        edgeNeighbours.push({
          hit_id: hit.id,
          hit_title: hit.title,
          arrow,
          edge_type: e.edge_type,
          weight: e.weight,
          neighbour: m,
        });
      }
    };

    const queryByTypes = (
      hit: any,
      fn: (memId: string, types?: EdgeType[]) => EdgeRow[],
      arrow: "→" | "←",
      neighbourSide: "from" | "to",
    ) => {
      collect(hit, fn(hit.id, filterTypes), arrow, neighbourSide);
    };

    for (const hit of limitedSqlite) {
      if (!hit.id) continue; // file-memory results may not have a DB id
      if (direction === "outgoing" || direction === "both") {
        queryByTypes(hit, edgeRepo.outgoing.bind(edgeRepo), "→", "to");
      }
      if (direction === "incoming" || direction === "both") {
        queryByTypes(hit, edgeRepo.incoming.bind(edgeRepo), "←", "from");
      }
    }
  }

  // Format SQLite/file results
  let output = "";
  if (detail === "index") output = formatIndex(limitedSqlite);
  else if (detail === "summary") output = formatSummary(limitedSqlite);
  else output = formatFull(limitedSqlite, config.search.bodyPreviewChars);

  // Append vault results
  if (vaultEntries.length > 0) {
    const vaultSection = detail === "index"
      ? formatVaultIndex(vaultEntries)
      : vaultEntries.map(formatVaultEntry).join("\n\n");
    output = output && output !== "No results found."
      ? output + "\n\n" + vaultSection
      : vaultSection;
  }

  // Append edge-neighbour section
  if (edgeNeighbours.length > 0) {
    const lines = edgeNeighbours.map(en => {
      // P3 Task 6 follow-up: tag soft-deleted neighbours so the user knows
      // direct memory_get on this id will currently miss (sources of a
      // compression are archived but still reachable via this traversal).
      const archived = en.neighbour.deleted_at ? " [archived]" : "";
      return `  ${en.arrow} [${en.edge_type}, w=${en.weight.toFixed(2)}] ${en.neighbour.id} ${en.neighbour.title}${archived} (edge neighbour of ${en.hit_id} ${en.hit_title})`;
    }).join("\n");
    const section = `\n\nEdge neighbours (${edgeNeighbours.length}):\n${lines}`;
    output = output && output !== "No results found."
      ? output + section
      : section.trim();
  }

  const text = output || "No results found.";
  const total_tokens = estimateTokensV2(text);

  // Emit analytics event for search layer used
  if (analyticsTracker) {
    const sessionId = process.env.CLAUDE_SESSION_ID || "unknown";
    analyticsTracker.track({
      event_type: "search_layer_used",
      session_id: sessionId,
      event_data: JSON.stringify({ detail: detail || "full", results: limitedSqlite.length, total_tokens }),
      tokens_cost: total_tokens,
    });
  }

  const structured: MemorySearchResult = {
    query: params.query,
    detail: (detail ?? "index") as "index" | "summary" | "full",
    count: limitedSqlite.length,
    results: limitedSqlite.map(r => ({
      id: String(r.id),
      title: String(r.title ?? ""),
      score: Number(r.score ?? 0),
      source: r.source as "sqlite" | "file",
      ...(r.memory_type ? { memory_type: String(r.memory_type) } : {}),
      ...(detail !== "index" && r.body ? { body: String(r.body) } : {}),
    })),
    vault_results: vaultEntries.map(v => ({
      relativePath: String((v as any).relativePath ?? (v as any).path ?? ""),
      ...(((v as any).title) ? { title: String((v as any).title) } : {}),
    })),
    total_tokens,
  };

  return { text, structured };
}

/**
 * Backward-compatible wrapper — many tests and call sites import this and
 * expect a string. Internally it just delegates to `searchMemories` and
 * returns the rendered text.
 */
export async function handleMemorySearch(
  repo: MemoriesRepo,
  config: Config,
  params: {
    query: string; project_path?: string; memory_type?: string;
    limit?: number; detail?: "index" | "summary" | "full"; include_file_memories?: boolean;
    include_edges?: boolean;
    edge_types?: EdgeType[];
    edge_direction?: "outgoing" | "incoming" | "both";
    include_deleted_neighbours?: boolean;
  },
  db?: Database.Database,
  analyticsTracker?: AnalyticsTracker,
  embRepo?: EmbeddingsRepo,
  providerOverride?: EmbeddingProvider,
): Promise<string> {
  const { text } = await searchMemories(repo, config, params, db, analyticsTracker, embRepo, providerOverride);
  return text;
}
