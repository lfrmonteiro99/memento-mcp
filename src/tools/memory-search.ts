import type Database from "better-sqlite3";
import type { MemoriesRepo } from "../db/memories.js";
import type { Config } from "../lib/config.js";
import type { AnalyticsTracker } from "../analytics/tracker.js";
import { applyDecay } from "../lib/decay.js";
import { searchFileMemories } from "../lib/file-memory.js";
import { formatIndex, formatFull, formatSummary, formatVaultEntry, formatVaultIndex } from "../lib/formatter.js";
import { estimateTokensV2 } from "../engine/token-estimator.js";
import { searchVault } from "../engine/vault-router.js";
import { EdgesRepo, type EdgeType, type Edge } from "../db/edges.js";
import { reciprocalRankFusion } from "../engine/rrf.js";
import { createProvider, type EmbeddingProvider } from "../engine/embeddings/provider.js";
import type { EmbeddingsRepo } from "../db/embeddings.js";

export async function handleMemorySearch(
  repo: MemoriesRepo,
  config: Config,
  params: {
    query: string; project_path?: string; memory_type?: string;
    limit?: number; detail?: "index" | "summary" | "full"; include_file_memories?: boolean;
    include_edges?: boolean;
    edge_types?: EdgeType[];
    edge_direction?: "outgoing" | "incoming" | "both";
  },
  db?: Database.Database,
  analyticsTracker?: AnalyticsTracker,
  embRepo?: EmbeddingsRepo,
  providerOverride?: EmbeddingProvider,
): Promise<string> {
  const limit = params.limit ?? config.search.maxResults;
  const detail = params.detail ?? config.search.defaultDetail;
  const sqliteResults: any[] = [];

  const raw = repo.search(params.query, {
    projectPath: params.project_path, memoryType: params.memory_type, limit,
  });

  // Hybrid retrieval: RRF-merge FTS hits with cosine vector hits when provider and embRepo are available.
  let workingSet: any[];
  const provider = providerOverride ?? (embRepo ? createProvider(config.search.embeddings) : null);

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
      // Provider failed (e.g. model not installed). Fall through to FTS-only silently.
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
    r.source = r.source ?? "sqlite";
    sqliteResults.push(r);
  }

  if (params.include_file_memories !== false) {
    const fileResults = searchFileMemories(params.query, params.project_path);
    for (const r of fileResults) { r.source = "file"; sqliteResults.push(r); }
  }

  sqliteResults.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const limitedSqlite = sqliteResults.slice(0, limit);

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

    const collect = (
      hit: any,
      edges: Edge[],
      arrow: "→" | "←",
      neighbourSide: "from" | "to",
    ) => {
      for (const e of edges) {
        const neighbourId = neighbourSide === "to" ? e.to_memory_id : e.from_memory_id;
        if (seen.has(neighbourId)) continue;
        const m = repo.getById(neighbourId);
        if (!m || m.deleted_at) continue;
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
      fn: (memId: string, et?: EdgeType) => Edge[],
      arrow: "→" | "←",
      neighbourSide: "from" | "to",
    ) => {
      if (filterTypes && filterTypes.length > 0) {
        for (const t of filterTypes) collect(hit, fn(hit.id, t), arrow, neighbourSide);
      } else {
        collect(hit, fn(hit.id), arrow, neighbourSide);
      }
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
    const lines = edgeNeighbours.map(en =>
      `  ${en.arrow} [${en.edge_type}, w=${en.weight.toFixed(2)}] ${en.neighbour.id} ${en.neighbour.title} (edge neighbour of ${en.hit_id} ${en.hit_title})`
    ).join("\n");
    const section = `\n\nEdge neighbours (${edgeNeighbours.length}):\n${lines}`;
    output = output && output !== "No results found."
      ? output + section
      : section.trim();
  }

  const finalOutput = output || "No results found.";

  // Emit analytics event for search layer used
  if (analyticsTracker) {
    const totalTokens = estimateTokensV2(finalOutput);
    const sessionId = process.env.CLAUDE_SESSION_ID || "unknown";
    analyticsTracker.track({
      event_type: "search_layer_used",
      session_id: sessionId,
      event_data: JSON.stringify({ detail: detail || "full", results: limitedSqlite.length, total_tokens: totalTokens }),
      tokens_cost: totalTokens,
    });
  }

  return finalOutput;
}
