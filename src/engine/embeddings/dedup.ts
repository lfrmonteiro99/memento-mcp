// src/engine/embeddings/dedup.ts
// Write-time dedup via embedding similarity (issue #8).
//
// findDuplicate() applies scrubSecrets(redactPrivate(text)) BEFORE calling
// provider.embed() — defense-in-depth to avoid leaking secrets/private content
// to the embedding API (triage requirement #12 dependency).

import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "./provider.js";
import type { EmbeddingsRepo } from "../../db/embeddings.js";
import { cosineSimilarity } from "./cosine.js";
import { scrubSecrets } from "../text-utils.js";
import { redactPrivate } from "../privacy.js";
import { createLogger, logLevelFromEnv } from "../../lib/logger.js";
import type { Config } from "../../lib/config.js";

const logger = createLogger(logLevelFromEnv());

export interface DedupHit {
  memoryId: string;
  title: string;
  similarity: number;
}

export interface DedupResult {
  /** The best match above threshold, or null if none. */
  duplicate: DedupHit | null;
  /** Additional matches above threshold (top 5, excluding duplicate). */
  candidates: DedupHit[];
  /** True when the scan was skipped due to dedupMaxScan. Write proceeds. */
  skipped?: boolean;
}

/**
 * One-time startup log guard. Ensured to fire at most once per process.
 * Export so callers (src/index.ts) can invoke it.
 */
let _dedupStartupLogged = false;
export function logDedupOnFirstUse(cfg: Config["search"]["embeddings"]): void {
  if (_dedupStartupLogged) return;
  if (cfg.enabled && cfg.dedup) {
    _dedupStartupLogged = true;
    logger.info(
      "Note: dedup sends each new memory's text to your embedding provider before storing."
    );
  }
}

/** Reset the one-time log guard (test helper only). */
export function _resetDedupStartupLoggedForTest(): void {
  _dedupStartupLogged = false;
}

/**
 * Find a near-duplicate of `text` among the project's stored memories.
 *
 * Security: applies scrubSecrets(redactPrivate(text)) BEFORE the embed() call.
 *
 * @param db          - SQLite database (used to look up memory titles)
 * @param embRepo     - Embeddings repository
 * @param provider    - Embedding provider (e.g. OpenAI)
 * @param text        - Candidate text (title + "\n\n" + body)
 * @param projectId   - Project scope, or null for global
 * @param threshold   - Cosine similarity threshold
 * @param maxScan     - Max vectors to scan; if exceeded, skip and warn
 * @param excludeId   - Memory ID to exclude from candidates (for updates)
 */
export async function findDuplicate(
  db: Database.Database,
  embRepo: EmbeddingsRepo,
  provider: EmbeddingProvider,
  text: string,
  projectId: string | null,
  threshold: number,
  maxScan?: number,
  excludeId?: string,
): Promise<DedupResult> {
  // Fetch existing vectors first so we can check the count BEFORE making a
  // network call to the embedding provider (cost-correctness: don't embed
  // when we know we'll skip the scan anyway).
  const all = embRepo.getByProject(projectId, provider.model);

  // Cap scan to avoid unbounded heap usage on very large projects.
  // Check BEFORE calling provider.embed() to avoid a wasted API round-trip.
  if (maxScan !== undefined && all.length > maxScan) {
    logger.warn(
      `dedup skipped: project has ${all.length} vectors which exceeds dedup_max_scan=${maxScan}. Write proceeds.`
    );
    return { duplicate: null, candidates: [], skipped: true };
  }

  // Apply privacy redaction and secret scrubbing BEFORE embedding.
  const safeText = scrubSecrets(redactPrivate(text));

  let qvec: Float32Array;
  try {
    [qvec] = await provider.embed([safeText]);
  } catch (err) {
    // Never block writes on provider failure.
    logger.warn(`dedup embed failed (write proceeds): ${err instanceof Error ? err.message : String(err)}`);
    return { duplicate: null, candidates: [] };
  }

  // Compute cosine similarities for all candidates.
  const scored: Array<{ memoryId: string; similarity: number }> = all
    .filter(({ memoryId }) => !excludeId || memoryId !== excludeId)
    .map(({ memoryId, vector }) => ({
      memoryId,
      similarity: cosineSimilarity(qvec, vector),
    }))
    .filter((h) => h.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity);

  if (scored.length === 0) {
    return { duplicate: null, candidates: [] };
  }

  // Fetch titles for the top matches.
  function getTitle(memoryId: string): string {
    const row = db.prepare("SELECT title FROM memories WHERE id = ?").get(memoryId) as
      | { title: string }
      | undefined;
    return row?.title ?? memoryId;
  }

  const topHit = scored[0];
  const duplicate: DedupHit = {
    memoryId: topHit.memoryId,
    title: getTitle(topHit.memoryId),
    similarity: topHit.similarity,
  };

  const candidates: DedupHit[] = scored.slice(1, 6).map((h) => ({
    memoryId: h.memoryId,
    title: getTitle(h.memoryId),
    similarity: h.similarity,
  }));

  return { duplicate, candidates };
}
