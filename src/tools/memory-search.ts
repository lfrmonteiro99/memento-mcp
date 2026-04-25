import type Database from "better-sqlite3";
import type { MemoriesRepo } from "../db/memories.js";
import type { Config } from "../lib/config.js";
import type { AnalyticsTracker } from "../analytics/tracker.js";
import { applyDecay } from "../lib/decay.js";
import { searchFileMemories } from "../lib/file-memory.js";
import { formatIndex, formatFull, formatSummary, formatVaultEntry, formatVaultIndex } from "../lib/formatter.js";
import { estimateTokensV2 } from "../engine/token-estimator.js";
import { searchVault } from "../engine/vault-router.js";

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
