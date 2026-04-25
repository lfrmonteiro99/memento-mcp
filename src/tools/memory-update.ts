// src/tools/memory-update.ts
import type Database from "better-sqlite3";
import type { MemoriesRepo } from "../db/memories.js";
import type { EmbeddingsRepo } from "../db/embeddings.js";
import type { Config } from "../lib/config.js";
import { createProvider } from "../engine/embeddings/provider.js";
import { findDuplicate } from "../engine/embeddings/dedup.js";
import { createLogger, logLevelFromEnv } from "../lib/logger.js";
import { validateTags } from "../engine/privacy.js";
import { loadProjectPolicy } from "../lib/policy.js";
import { pushSingleMemory } from "../sync/git-sync.js";

const logger = createLogger(logLevelFromEnv());

// Body delta threshold for triggering dedup on update (chars).
const SIGNIFICANT_BODY_DELTA = 100;

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
    project_path?: string;
    dedup?: "strict" | "warn" | "off";
  },
  config?: Config,
  embRepo?: EmbeddingsRepo,
  db?: Database.Database,
): Promise<string> {
  // Issue #4: validate balanced <private> tags when content is provided.
  if (params.content !== undefined) {
    const tagValidation = validateTags(params.content);
    if (!tagValidation.valid) {
      return `Memory not updated: unbalanced <private> tags. Found ${tagValidation.opens} opening, ${tagValidation.closes} closing.`;
    }
  }

  // Issue #9: enforce banned_content on update (required_tags only fire on create)
  const projectPath = params.project_path || process.cwd();
  const policy = loadProjectPolicy(projectPath);
  if (policy && policy.bannedContent.length > 0) {
    const titleToCheck = params.title ?? "";
    const contentToCheck = params.content ?? "";
    const tagsBlob = (params.tags ?? []).join(" ");
    for (const re of policy.bannedContent) {
      if (
        (titleToCheck && re.test(titleToCheck)) ||
        (contentToCheck && re.test(contentToCheck)) ||
        (tagsBlob && re.test(tagsBlob))
      ) {
        const policyRef = policy.policyFilePath.includes(".memento/policy.toml")
          ? ".memento/policy.toml"
          : ".memento.toml";
        return `Memory not updated: blocked by ${policyRef} policy (pattern: ${re.source})`;
      }
    }
  }

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

  // Issue #8: dedup check on update — fires only when the change is significant.
  // Significant = title changed OR body grew/shrank by more than SIGNIFICANT_BODY_DELTA chars.
  let dedupWarnMessage: string | null = null;
  if (config && embRepo && db) {
    const cfg = config.search.embeddings;
    if (cfg.enabled && cfg.dedup && cfg.dedupCheckOnUpdate) {
      const titleChanged = params.title !== undefined && params.title !== current.title;
      const bodyDelta = params.content !== undefined
        ? Math.abs(params.content.length - (current.body ?? "").length)
        : 0;
      const significantChange = titleChanged || bodyDelta > SIGNIFICANT_BODY_DELTA;

      if (significantChange) {
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

            const updated = repo.getById(params.memory_id);
            const text = `${updated?.title ?? params.title ?? ""}\n\n${updated?.body ?? params.content ?? ""}`;
            const { duplicate, skipped } = await findDuplicate(
              db,
              embRepo,
              provider,
              text,
              projectId,
              cfg.dedupThreshold,
              cfg.dedupMaxScan,
              params.memory_id, // exclude self
            );

            if (!skipped && duplicate) {
              const sim = duplicate.similarity.toFixed(2);
              if (mode === "strict") {
                // NOTE: the update has already been committed above; we return the warning as info
                // (strict on update surfaces the info but does not undo the store since the update is in-place)
                dedupWarnMessage = `Near-duplicate of "${duplicate.title}" (sim ${sim}, id ${duplicate.memoryId}). Consider memory_update or memory_link.`;
              } else {
                // mode === "warn"
                dedupWarnMessage = `Near-duplicate of "${duplicate.title}" (sim ${sim}, id ${duplicate.memoryId}). Consider memory_update or memory_link.`;
              }
            }
          }
        }
      }
    }
  }

  // Issue #11: auto-push updated memory when scope=team and autoPushOnStore=true
  if (db && config && config.sync.enabled && config.sync.autoPushOnStore) {
    const updated = repo.getById(params.memory_id);
    if (updated && updated.scope === "team") {
      const projectPath = params.project_path || process.cwd();
      try {
        await pushSingleMemory(db, projectPath, params.memory_id, config.sync);
      } catch (e) {
        logger.warn(`sync auto-push failed for memory ${params.memory_id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  const baseMsg = `Memory updated: ${params.memory_id}`;
  return dedupWarnMessage ? `${baseMsg}\n⚠ ${dedupWarnMessage}` : baseMsg;
}
