// src/tools/memory-search.ts
import type { MemoriesRepo } from "../db/memories.js";
import type { Config } from "../lib/config.js";
import { applyDecay } from "../lib/decay.js";
import { searchFileMemories } from "../lib/file-memory.js";
import { formatIndex, formatFull } from "../lib/formatter.js";

export async function handleMemorySearch(repo: MemoriesRepo, config: Config, params: {
  query: string; project_path?: string; memory_type?: string;
  limit?: number; detail?: "index" | "full"; include_file_memories?: boolean;
}): Promise<string> {
  const limit = params.limit ?? config.search.maxResults;
  const detail = params.detail ?? config.search.defaultDetail;
  const results: any[] = [];

  const sqliteResults = repo.search(params.query, {
    projectPath: params.project_path, memoryType: params.memory_type, limit,
  });

  // Normalize FTS5 ranks and apply decay
  const rawRanks = sqliteResults.map(r => Math.abs(r.rank ?? 0));
  const maxRank = Math.max(...rawRanks, 1);
  for (const r of sqliteResults) {
    const normalizedRank = Math.abs(r.rank ?? 0) / maxRank;
    const baseScore = normalizedRank * 0.6 + (r.importance_score ?? 0.5) * 0.4;
    r.score = applyDecay(baseScore, r.last_accessed_at);
    r.source = "sqlite";
    results.push(r);
  }

  if (params.include_file_memories !== false) {
    const fileResults = searchFileMemories(params.query, params.project_path);
    for (const r of fileResults) { r.source = "file"; results.push(r); }
  }

  results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const limited = results.slice(0, limit);

  return detail === "index"
    ? formatIndex(limited)
    : formatFull(limited, config.search.bodyPreviewChars);
}
