// src/tools/memory-store.ts
import type Database from "better-sqlite3";
import type { MemoriesRepo } from "../db/memories.js";
import type { EmbeddingsRepo } from "../db/embeddings.js";
import type { Config } from "../lib/config.js";
import { rebuildVaultIndex } from "../engine/vault-index.js";
import { persistMemoryToVault } from "../engine/vault-writer.js";
import { createProvider, type EmbeddingProvider } from "../engine/embeddings/provider.js";
import { findDuplicate } from "../engine/embeddings/dedup.js";
import { createLogger, logLevelFromEnv } from "../lib/logger.js";
import { validateTags } from "../engine/privacy.js";
import { loadProjectPolicy } from "../lib/policy.js";
import { pushSingleMemory } from "../sync/git-sync.js";
import { AnchorsRepo } from "../db/anchors.js";
import { hasGit, currentCommitSha } from "../engine/git-introspect.js";

export interface AnchorInput {
  file_path: string;
  line_start?: number;
  line_end?: number;
}

const logger = createLogger(logLevelFromEnv());

export async function handleMemoryStore(repo: MemoriesRepo, params: {
  title: string; content: string; memory_type?: string; scope?: string;
  project_path?: string; tags?: string[]; importance?: number;
  supersedes_id?: string; pin?: boolean;
  persist_to_vault?: boolean; vault_mode?: "create" | "create_or_update";
  vault_kind?: string; vault_folder?: string; vault_note_title?: string;
  dedup?: "strict" | "warn" | "off";
  /** P4 Task 5: pin the memory to one or more code locations. commit_sha is
   *  auto-populated when project_path is a git working tree. */
  anchors?: AnchorInput[];
}, db?: Database.Database, config?: Config, embRepo?: EmbeddingsRepo, providerOverride?: EmbeddingProvider): Promise<string> {
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

  // Issue #8: dedup check — runs AFTER policy (don't pay for embed when policy blocks),
  // BEFORE store (so we can return early on strict mode).
  let dedupWarnMessage: string | null = null;
  if (config && embRepo && db) {
    const cfg = config.search.embeddings;
    if (cfg.enabled && cfg.dedup) {
      const provider = createProvider(cfg);
      if (provider) {
        const mode = params.dedup ?? cfg.dedupDefaultMode;
        if (mode !== "off") {
          // Resolve project id for scoping
          let projectId: string | null = null;
          if (params.project_path) {
            const row = db.prepare("SELECT id FROM projects WHERE root_path = ?").get(params.project_path) as
              | { id: string } | undefined;
            projectId = row?.id ?? null;
          }

          const text = `${params.title}\n\n${params.content}`;
          const { duplicate, skipped } = await findDuplicate(
            db,
            embRepo,
            provider,
            text,
            projectId,
            cfg.dedupThreshold,
            cfg.dedupMaxScan,
          );

          if (!skipped && duplicate) {
            const sim = duplicate.similarity.toFixed(2);
            if (mode === "strict") {
              return `Memory not stored: near-duplicate of "${duplicate.title}" (sim ${sim}, id ${duplicate.memoryId}). Pass dedup="off" to override or call memory_update on the existing memory.`;
            }
            // mode === "warn" — store but surface info
            dedupWarnMessage = `Near-duplicate of "${duplicate.title}" (sim ${sim}, id ${duplicate.memoryId}). Consider memory_update or memory_link.`;
          }
        }
      }
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

  // P4 Task 5: persist anchors and auto-populate commit_sha when in a git repo.
  if (params.anchors?.length && db) {
    const anchorRepo = new AnchorsRepo(db);
    const sha = hasGit(projectPath) ? currentCommitSha(projectPath) : undefined;
    for (const a of params.anchors) {
      try {
        anchorRepo.attach({
          memory_id: id,
          file_path: a.file_path,
          line_start: a.line_start,
          line_end: a.line_end,
          commit_sha: sha,
        });
      } catch (e) {
        logger.warn(`anchor attach failed for ${id} (${a.file_path}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

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
    const provider = providerOverride ?? createProvider(config.search.embeddings);
    if (provider) {
      provider.embed([`${params.title}\n\n${params.content}`])
        .then(([v]) => embRepo.upsert(id, provider.model, v))
        .catch(err => logger.warn(`embed failed for ${id}: ${err}`));
    }
  }

  // Build response, possibly including dedup warning.
  const baseMsg = `Memory stored with ID: ${id}`;
  const storeResult = dedupWarnMessage ? `${baseMsg}\n⚠ ${dedupWarnMessage}` : baseMsg;

  if (!shouldPersistToVault) {
    return storeResult;
  }

  if (!db || !config) {
    return `${storeResult}\nVault persistence skipped: database/config not available.`;
  }

  if (!config.vault.enabled || !config.vault.path) {
    return `${storeResult}\nVault persistence skipped: vault support is not enabled.`;
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

  return `${storeResult}\nVault note ${note.action}: ${note.relativePath}`;
}
