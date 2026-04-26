import type Database from "better-sqlite3";
import type { MemoriesRepo } from "../db/memories.js";
import type { Config } from "../lib/config.js";
import type { AnalyticsTracker } from "../analytics/tracker.js";
import { applyDecay } from "../lib/decay.js";
import { searchFileMemories } from "../lib/file-memory.js";
import { formatIndex, formatFull, formatSummary, formatVaultEntry, formatVaultIndex } from "../lib/formatter.js";
import { estimateTokensV2 } from "../engine/token-estimator.js";
import { searchVault } from "../engine/vault-router.js";

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
  },
  db?: Database.Database,
  analyticsTracker?: AnalyticsTracker,
): Promise<{ text: string; structured: MemorySearchResult }> {
  const limit = params.limit ?? config.search.maxResults;
  const detail = params.detail ?? config.search.defaultDetail;
  const sqliteResults: any[] = [];

  const raw = repo.search(params.query, {
    projectPath: params.project_path, memoryType: params.memory_type, limit,
  });

  const rawRanks = raw.map(r => Math.abs(r.rank ?? 0));
  const maxRank = Math.max(...rawRanks, 1);
  for (const r of raw) {
    const normalizedRank = Math.abs(r.rank ?? 0) / maxRank;
    const baseScore = normalizedRank * 0.6 + (r.importance_score ?? 0.5) * 0.4;
    r.score = applyDecay(baseScore, r.last_accessed_at);
    r.source = "sqlite";
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
  },
  db?: Database.Database,
  analyticsTracker?: AnalyticsTracker,
): Promise<string> {
  const { text } = await searchMemories(repo, config, params, db, analyticsTracker);
  return text;
}
