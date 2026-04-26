import type Database from "better-sqlite3";
import type { MemoriesRepo } from "../db/memories.js";
import type { EmbeddingsRepo } from "../db/embeddings.js";
import type { EmbeddingProvider } from "../engine/embeddings/provider.js";
import type { Config } from "../lib/config.js";
import { findDuplicate } from "../engine/embeddings/dedup.js";
import { estimateTokensV2 } from "../engine/token-estimator.js";

export interface DedupCheckParams {
  content: string;
  title?: string;
  project_path?: string;
  threshold?: number;     // overrides config.search.embeddings.dedupThreshold
  limit?: number;         // default 5, max 20
}

export async function handleMemoryDedupCheck(
  db: Database.Database,
  memRepo: MemoriesRepo,
  embRepo: EmbeddingsRepo,
  provider: EmbeddingProvider | null,
  config: Config,
  params: DedupCheckParams,
): Promise<string> {
  // If embeddings disabled or no provider, return no-op message.
  if (!config.search.embeddings.enabled || !provider) {
    return "Dedup unavailable: embeddings disabled (set search.embeddings.enabled = true and provide API key).";
  }

  // Compute threshold and limit.
  const threshold = params.threshold ?? config.search.embeddings.dedupThreshold;
  const limit = Math.min(params.limit ?? 5, 20);

  // Resolve project ID if project_path provided.
  let projectId: string | null = null;
  if (params.project_path) {
    const row = db.prepare("SELECT id FROM projects WHERE root_path = ?").get(params.project_path) as
      | { id: string }
      | undefined;
    projectId = row?.id ?? null;
  }

  // Concatenate title and content.
  const text = params.title ? `${params.title}\n\n${params.content}` : params.content;

  // Call findDuplicate.
  const { duplicate, candidates } = await findDuplicate(
    db,
    embRepo,
    provider,
    text,
    projectId,
    threshold,
  );

  // Combine and slice results.
  const hits = [duplicate, ...candidates].filter((h) => h !== null).slice(0, limit);

  if (hits.length === 0) {
    return `No duplicates above threshold ${threshold.toFixed(2)}.`;
  }

  // Format output with token cost markers.
  const lines: string[] = [];
  lines.push(`Top ${hits.length} match(es) above threshold ${threshold.toFixed(2)}:`);

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    const mem = memRepo.getById(hit.memoryId);
    if (!mem) continue;

    const titleDisplay = mem.title ? `"${mem.title}"` : "(untitled)";
    const memType = mem.memory_type ?? "fact";
    const line = `  ${i + 1}. sim=${hit.similarity.toFixed(3)}  ${hit.memoryId}  ${titleDisplay}  (${memType})`;
    const tokenCost = estimateTokensV2(line);
    lines.push(`  [${tokenCost}t] ${i + 1}. sim=${hit.similarity.toFixed(3)}  ${hit.memoryId}  ${titleDisplay}  (${memType})`);
  }

  return lines.join("\n");
}
