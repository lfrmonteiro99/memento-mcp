// src/tools/memory-store.ts
import type Database from "better-sqlite3";
import type { MemoriesRepo } from "../db/memories.js";
import type { EmbeddingsRepo } from "../db/embeddings.js";
import type { Config } from "../lib/config.js";
import { rebuildVaultIndex } from "../engine/vault-index.js";
import { persistMemoryToVault } from "../engine/vault-writer.js";
import { createProvider } from "../engine/embeddings/provider.js";
import { createLogger, logLevelFromEnv } from "../lib/logger.js";

const logger = createLogger(logLevelFromEnv());

export async function handleMemoryStore(repo: MemoriesRepo, params: {
  title: string; content: string; memory_type?: string; scope?: string;
  project_path?: string; tags?: string[]; importance?: number;
  supersedes_id?: string; pin?: boolean;
  persist_to_vault?: boolean; vault_mode?: "create" | "create_or_update";
  vault_kind?: string; vault_folder?: string; vault_note_title?: string;
}, db?: Database.Database, config?: Config, embRepo?: EmbeddingsRepo): Promise<string> {
  const memoryType = params.memory_type ?? "fact";
  const shouldPersistToVault =
    params.persist_to_vault === true ||
    (params.persist_to_vault !== false && Boolean(config?.vault.autoPromoteTypes.includes(memoryType)));

  const id = repo.store({
    title: params.title, body: params.content,
    memoryType, scope: params.scope,
    projectPath: params.project_path, tags: params.tags,
    importance: params.importance, supersedesId: params.supersedes_id,
    pin: params.pin,
  });

  // Fire-and-forget embedding — do NOT await, store must remain fast.
  if (config && embRepo) {
    const provider = createProvider(config.search.embeddings);
    if (provider) {
      provider.embed([`${params.title}\n\n${params.content}`])
        .then(([v]) => embRepo.upsert(id, provider.model, v))
        .catch(err => logger.warn(`embed failed for ${id}: ${err}`));
    }
  }

  if (!shouldPersistToVault) {
    return `Memory stored with ID: ${id}`;
  }

  if (!db || !config) {
    return `Memory stored with ID: ${id}\nVault persistence skipped: database/config not available.`;
  }

  if (!config.vault.enabled || !config.vault.path) {
    return `Memory stored with ID: ${id}\nVault persistence skipped: vault support is not enabled.`;
  }

  const note = persistMemoryToVault(config.vault, {
    memoryId: id,
    title: params.vault_note_title || params.title,
    content: params.content,
    memoryType,
    tags: params.tags ?? [],
    mode: params.vault_mode ?? "create_or_update",
    vaultKind: params.vault_kind,
    vaultFolder: params.vault_folder,
  });
  rebuildVaultIndex(db, config.vault);

  return `Memory stored with ID: ${id}\nVault note ${note.action}: ${note.relativePath}`;
}
