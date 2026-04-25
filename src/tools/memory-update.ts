// src/tools/memory-update.ts
import type { MemoriesRepo } from "../db/memories.js";
import type { EmbeddingsRepo } from "../db/embeddings.js";
import type { Config } from "../lib/config.js";
import { createProvider } from "../engine/embeddings/provider.js";
import { createLogger, logLevelFromEnv } from "../lib/logger.js";

const logger = createLogger(logLevelFromEnv());

export async function handleMemoryUpdate(
  repo: MemoriesRepo,
  params: {
    memory_id: string;
    title?: string;
    content?: string;
    tags?: string[];
    importance?: number;
    memory_type?: string;
    pinned?: boolean;
  },
  config?: Config,
  embRepo?: EmbeddingsRepo,
): Promise<string> {
  const patch: Parameters<MemoriesRepo["update"]>[1] = {};
  if (params.title !== undefined) patch.title = params.title;
  if (params.content !== undefined) patch.body = params.content;
  if (params.tags !== undefined) patch.tags = params.tags;
  if (params.importance !== undefined) patch.importance = params.importance;
  if (params.memory_type !== undefined) patch.memoryType = params.memory_type;
  if (params.pinned !== undefined) patch.pinned = params.pinned;

  if (Object.keys(patch).length === 0) {
    return "No fields to update. Pass at least one of: title, content, tags, importance, memory_type, pinned.";
  }

  const current = repo.getById(params.memory_id);
  if (!current) {
    return `Memory not found: ${params.memory_id}`;
  }

  const ok = repo.update(params.memory_id, patch);
  if (!ok) {
    return `Memory not found: ${params.memory_id}`;
  }

  // Fire-and-forget re-embedding when title or body changes — do NOT await.
  if (config && embRepo && (params.title !== undefined || params.content !== undefined)) {
    const provider = createProvider(config.search.embeddings);
    if (provider) {
      const updated = repo.getById(params.memory_id);
      if (updated) {
        provider.embed([`${updated.title}\n\n${updated.body ?? ""}`])
          .then(([v]) => embRepo.upsert(params.memory_id, provider.model, v))
          .catch(err => logger.warn(`embed failed for ${params.memory_id}: ${err}`));
      }
    }
  }

  return `Memory updated: ${params.memory_id}`;
}
