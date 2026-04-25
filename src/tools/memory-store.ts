// src/tools/memory-store.ts
import type Database from "better-sqlite3";
import type { MemoriesRepo } from "../db/memories.js";
import type { EmbeddingsRepo } from "../db/embeddings.js";
import type { Config } from "../lib/config.js";
import { rebuildVaultIndex } from "../engine/vault-index.js";
import { persistMemoryToVault } from "../engine/vault-writer.js";
import { createProvider } from "../engine/embeddings/provider.js";
import { createLogger, logLevelFromEnv } from "../lib/logger.js";
import { validateTags } from "../engine/privacy.js";
import { loadProjectPolicy } from "../lib/policy.js";
import { pushSingleMemory } from "../sync/git-sync.js";

const logger = createLogger(logLevelFromEnv());

export async function handleMemoryStore(repo: MemoriesRepo, params: {
  title: string; content: string; memory_type?: string; scope?: string;
  project_path?: string; tags?: string[]; importance?: number;
  supersedes_id?: string; pin?: boolean;
  persist_to_vault?: boolean; vault_mode?: "create" | "create_or_update";
  vault_kind?: string; vault_folder?: string; vault_note_title?: string;
}, db?: Database.Database, config?: Config, embRepo?: EmbeddingsRepo): Promise<string> {
  // Issue #4: validate balanced <private> tags before storing.
  const tagValidation = validateTags(params.content ?? "");
  if (!tagValidation.valid) {
    return `Memory not stored: unbalanced <private> tags. Found ${tagValidation.opens} opening, ${tagValidation.closes} closing.`;
  }

  // Issue #9: enforce per-project policy
  const projectPath = params.project_path || process.cwd();
  const policy = loadProjectPolicy(projectPath);

  if (policy) {
    // 1. required_tags any_of
    if (policy.requiredTagsAnyOf.length > 0) {
      const has = (params.tags ?? []).some(t => policy.requiredTagsAnyOf.includes(t));
      if (!has) {
        return `Memory not stored: project policy requires one of: ${policy.requiredTagsAnyOf.join(", ")}`;
      }
    }
    // 2. required_tags all_of (each group needs at least one match)
    for (const group of policy.requiredTagsAllOf) {
      const has = (params.tags ?? []).some(t => group.includes(t));
      if (!has) {
        return `Memory not stored: project policy requires one tag from group [${group.join(", ")}]`;
      }
    }
    // 3. banned_content — check title, body, AND tags
    const tagsBlob = (params.tags ?? []).join(" ");
    for (const re of policy.bannedContent) {
      if (re.test(params.content) || re.test(params.title) || re.test(tagsBlob)) {
        const policyRef = policy.policyFilePath.includes(".memento/policy.toml")
          ? ".memento/policy.toml"
          : ".memento.toml";
        return `Memory not stored: blocked by ${policyRef} policy (pattern: ${re.source})`;
      }
    }
    // 4. default importance by type (only applied when importance is not provided)
    if (params.importance === undefined && policy.defaultImportanceByType[params.memory_type ?? "fact"] !== undefined) {
      params = { ...params, importance: policy.defaultImportanceByType[params.memory_type ?? "fact"] };
    }
    // 5. auto-promote to vault
    if (policy.autoPromoteToVaultTypes.includes(params.memory_type ?? "fact")) {
      params = { ...params, persist_to_vault: true };
    }
  }

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

  // Issue #11: auto-push to file when scope=team and autoPushOnStore=true
  if (db && config && config.sync.enabled && config.sync.autoPushOnStore && (params.scope === "team")) {
    try {
      await pushSingleMemory(db, projectPath, id, config.sync);
    } catch (e) {
      logger.warn(`sync auto-push failed for memory ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

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
