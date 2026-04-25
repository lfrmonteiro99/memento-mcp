// src/tools/memory-delete.ts
import type Database from "better-sqlite3";
import type { MemoriesRepo } from "../db/memories.js";
import type { Config } from "../lib/config.js";
import { createLogger, logLevelFromEnv } from "../lib/logger.js";
import { pushSingleMemory } from "../sync/git-sync.js";

const logger = createLogger(logLevelFromEnv());

export async function handleMemoryDelete(
  repo: MemoriesRepo,
  params: { memory_id: string; project_path?: string },
  config?: Config,
  db?: Database.Database,
): Promise<string> {
  if (params.memory_id.startsWith("file:")) return "Cannot delete file-based memories.";

  // Capture scope before deleting (soft-delete sets deleted_at)
  const existing = repo.getById(params.memory_id);
  const wasTeamScope = existing?.scope === "team";

  const ok = repo.delete(params.memory_id);

  // Issue #11: write soft-deleted file so other clones can pick up the deletion on pull
  if (ok && wasTeamScope && db && config && config.sync.enabled && config.sync.autoPushOnStore) {
    const projectPath = params.project_path || process.cwd();
    try {
      await pushSingleMemory(db, projectPath, params.memory_id, config.sync);
    } catch (e) {
      logger.warn(`sync auto-push (delete) failed for memory ${params.memory_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return ok
    ? `Memory ${params.memory_id} deleted.`
    : `Memory ${params.memory_id} not found or already deleted.`;
}
