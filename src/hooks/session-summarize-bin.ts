#!/usr/bin/env node
// src/hooks/session-summarize-bin.ts
// Claude Code hook binary for SessionEnd auto-summarization (Issue #3).
// Registered as a SessionEnd hook in .claude/settings.json:
//   { "hooks": { "SessionEnd": [{ "hooks": [{ "type": "command", "command": "memento-hook-summarize", "timeout": 10 }] }] } }
//
// Reads a SessionEnd event JSON from stdin, produces one session_summary memory
// from all auto-captures tagged with that claude_session_id, then exits.
// Never crashes Claude Code: always exits 0 on any failure.

import { createDatabase } from "../db/database.js";
import { MemoriesRepo } from "../db/memories.js";
import { loadConfig, getDefaultConfigPath, getDefaultDbPath } from "../lib/config.js";
import { summarizeAsCluster } from "../engine/compressor.js";
import { nowIso } from "../db/database.js";
import { randomUUID } from "node:crypto";
import { createLogger, logLevelFromEnv } from "../lib/logger.js";

const log = createLogger(logLevelFromEnv());

async function main(): Promise<void> {
  // Read the SessionEnd event from stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) process.exit(0);

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(raw);
  } catch {
    // Not valid JSON — exit silently
    process.exit(0);
  }

  const dbPath = process.env.MEMENTO_DB_PATH ?? getDefaultDbPath();
  const configPath = process.env.MEMENTO_CONFIG_PATH ?? getDefaultConfigPath();
  const rawConfig = loadConfig(configPath);

  // Extract config values
  const hooksConfig = rawConfig.hooks;
  const sessionEndSummarize = hooksConfig.sessionEndSummarize !== false; // default true
  if (!sessionEndSummarize) process.exit(0);

  const minCaptures = hooksConfig.sessionEndMinCaptures ?? 2;
  const maxBodyTokens = hooksConfig.sessionEndMaxBodyTokens ?? 1500;
  const keepOriginals = hooksConfig.sessionEndKeepOriginals === true; // default false

  const db = createDatabase(dbPath);
  db.pragma("busy_timeout = 30000");

  try {
    const claudeSessionId = typeof event.session_id === "string" ? event.session_id : "";
    const cwd = typeof event.cwd === "string" ? event.cwd : "";

    if (!claudeSessionId) process.exit(0);

    const memRepo = new MemoriesRepo(db);

    // Resolve project_id from cwd
    const projectId = cwd ? memRepo.ensureProject(cwd) : undefined;

    // Idempotency check: if a session_summary already exists for this claude_session_id, skip
    const existing = db.prepare(`
      SELECT id FROM memories
      WHERE claude_session_id = ? AND memory_type = 'session_summary' AND deleted_at IS NULL
      LIMIT 1
    `).get(claudeSessionId) as { id: string } | undefined;

    if (existing) {
      // Already summarized — exit silently
      process.exit(0);
    }

    // Fetch all auto-capture memories for this session
    const captures = memRepo.listBySession(claudeSessionId, { sourceFilter: "auto-capture" });

    // 0 captures → no-op
    if (captures.length === 0) process.exit(0);

    const now = nowIso();

    if (captures.length === 1) {
      // 1 capture → just retype it to session_summary in-place
      db.prepare(`
        UPDATE memories SET memory_type = 'session_summary', source = 'session-summary', updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `).run(now, captures[0].id);
      process.exit(0);
    }

    // 2+ captures → fewer than minCaptures → skip
    if (captures.length < minCaptures) process.exit(0);

    // Build the summary using compressor helper
    const compressionCfg = {
      cluster_similarity_threshold: rawConfig.compression.clusterSimilarityThreshold,
      min_cluster_size: rawConfig.compression.minClusterSize,
      max_body_ratio: rawConfig.compression.maxBodyRatio,
      temporal_window_hours: rawConfig.compression.temporalWindowHours,
      maxBodyTokens,
    };

    const summary = summarizeAsCluster(captures as any[], compressionCfg);

    // Write the summary + optional soft-delete of sources in a single transaction
    const tx = db.transaction(() => {
      const summaryId = randomUUID();

      db.prepare(`
        INSERT INTO memories (id, project_id, memory_type, scope, title, body, tags,
                              importance_score, source, claude_session_id,
                              created_at, updated_at, last_accessed_at)
        VALUES (?, ?, 'session_summary', 'project', ?, ?, ?, ?, 'session-summary', ?,
                ?, ?, ?)
      `).run(
        summaryId,
        projectId ?? null,
        summary.title,
        summary.body,
        JSON.stringify(summary.tags),
        summary.importance,
        claudeSessionId,
        now, now, now
      );

      // compression_log entry
      db.prepare(`
        INSERT INTO compression_log (compressed_memory_id, source_memory_ids, tokens_before, tokens_after, compression_ratio, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        summaryId,
        JSON.stringify(captures.map((m: any) => m.id)),
        summary.tokens_before,
        summary.tokens_after,
        summary.tokens_before === 0 ? 1 : summary.tokens_after / summary.tokens_before,
        now
      );

      // analytics_events row
      db.prepare(`
        INSERT INTO analytics_events (session_id, project_id, memory_id, event_type, event_data, created_at)
        VALUES (?, ?, ?, 'session_summary', ?, ?)
      `).run(
        claudeSessionId,
        projectId ?? null,
        summaryId,
        JSON.stringify({
          source_count: captures.length,
          tokens_before: summary.tokens_before,
          tokens_after: summary.tokens_after,
        }),
        now
      );

      // Soft-delete source auto-captures unless keep_originals is set
      if (!keepOriginals) {
        const softDelete = db.prepare(
          "UPDATE memories SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL"
        );
        for (const cap of captures) {
          softDelete.run(now, (cap as any).id);
        }
      }
    });

    tx();

  } catch (err) {
    // Issue #3 acceptance criterion: never crash. Log to stderr at warn level.
    log.warn(`session-summarize-bin error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }

  process.exit(0);
}

main().catch(() => process.exit(0)); // Never crash the hook
