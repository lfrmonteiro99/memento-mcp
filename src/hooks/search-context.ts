#!/usr/bin/env node
// src/hooks/search-context.ts
import type Database from "better-sqlite3";
import { MemoriesRepo } from "../db/memories.js";
import { SessionsRepo } from "../db/sessions.js";
import { searchFileMemories } from "../lib/file-memory.js";
import { classifyPrompt } from "../lib/classify.js";
import { estimateTokensV2 } from "../engine/token-estimator.js";
import { daysSince, computeExponentialDecay } from "../lib/decay.js";
import { extractKeywordsV2, buildFtsQueryV2 } from "../engine/keyword-extractor.js";
import { computeAdaptiveScore, computeUtilityScore } from "../engine/adaptive-ranker.js";
import type { Config } from "../lib/config.js";
import { searchVault } from "../engine/vault-router.js";

const TIER_LIMITS = { trivial: 0, standard: 3, complex: 5 };
const VAULT_CONFIDENCE_THRESHOLD = 0.25;

export function processSearchHook(
  db: Database.Database,
  prompt: string,
  memRepo: MemoriesRepo,
  sessRepo: SessionsRepo,
  config: Config,
  claudeSessionId?: string
): string {
  if (!prompt) return "";

  const tier = config.hooks.trivialSkip ? classifyPrompt(prompt, config) : "standard";
  let maxResults = TIER_LIMITS[tier];
  if (maxResults === 0) return "";

  const session = sessRepo.getOrCreate(config.budget);
  const remaining = session.budget - session.spent;

  if (remaining < session.floor) {
    maxResults = 1;
  }

  if (tier === "complex") {
    sessRepo.refill(session.id, config.budget.refill);
  }

  // K6: use v2 keyword extractor (up to 8 keywords, phrase-aware) and v2 FTS builder.
  const keywords = extractKeywordsV2(prompt, {
    maxTokens: 8,
    preservePhrases: true,
    minWordLength: 3,
  });
  if (keywords.length < 2) return "";

  const ftsQuery = buildFtsQueryV2(keywords, true); // N4: prefix matching on by default

  // K6: take up to 3x the target count so adaptive re-ranking has enough candidates.
  const dbResults = memRepo.searchV2(ftsQuery, { limit: maxResults * 3 });

  // K6: adaptive re-rank using the correct decay + utility imports.
  const ranked = dbResults.map((row, idx) => {
    // Normalize FTS rank to [0, 1] (lower rank index = higher relevance).
    const ftsRelevance = dbResults.length > 0
      ? Math.max(0, 1 - idx / Math.max(1, dbResults.length))
      : 0;
    const ageDays = daysSince(row.last_accessed_at ?? row.created_at);
    const decay = computeExponentialDecay(ageDays, 14);
    const utility = computeUtilityScore(db, row.id);
    const recencyBonus = daysSince(row.created_at) < 1 ? 0.2 : 0;

    const adaptiveScore = computeAdaptiveScore({
      fts_relevance: ftsRelevance,
      importance: row.importance_score ?? 0.5,
      decay,
      utility,
      recency_bonus: recencyBonus,
    });
    return { ...row, adaptiveScore };
  });

  ranked.sort((a, b) => b.adaptiveScore - a.adaptiveScore);
  const topDb = ranked.slice(0, maxResults);

  // Batch-update access for memories we actually inject (M5 / Task 5).
  if (topDb.length > 0) {
    memRepo.batchUpdateAccess(topDb.map(r => r.id));

    // K1 producer: emit injection events so the utility-signal detector can match
    // subsequent tool calls against these memories within utility_window_minutes.
    if (claudeSessionId) {
      const insertInjection = db.prepare(`
        INSERT INTO analytics_events (session_id, project_id, memory_id, event_type, event_data, created_at)
        VALUES (?, ?, ?, 'injection', ?, datetime('now'))
      `);
      for (const r of topDb) {
        insertInjection.run(
          claudeSessionId,
          r.project_id ?? null,
          r.id,
          JSON.stringify({ context: "search", adaptive_score: r.adaptiveScore })
        );
      }
    }
  }

  // File memories (unchanged — keyed on the same keyword string for compatibility).
  const fileResults = searchFileMemories(keywords.join(" ")).slice(0, Math.min(2, maxResults));

  // Vault memories — summaries only, confidence-gated, budget-aware.
  let vaultLines: string[] = [];
  if (config.vault.enabled && config.vault.path) {
    try {
      const vaultResults = searchVault(db, config.vault, prompt);
      const confident = vaultResults
        .filter(r => (r.score ?? 0) >= VAULT_CONFIDENCE_THRESHOLD)
        .slice(0, config.vault.hookMaxResults);
      for (const r of confident) {
        const summary = r.summary ? r.summary.slice(0, 120) : r.title;
        vaultLines.push(`[vault/${r.kind ?? "note"}] ${r.title}: ${summary}`);
      }
    } catch {
      // Vault errors must never break the hook
      vaultLines = [];
    }
  }

  const lines: string[] = [];
  for (const r of topDb) {
    lines.push(`[db] ${r.title}: ${(r.body ?? "").slice(0, 120)}`);
  }
  for (const r of fileResults) {
    lines.push(`[file] ${r.title}: ${(r.body ?? "").slice(0, 120)}`);
  }
  lines.push(...vaultLines);

  if (!lines.length) return "";

  const output = "Memory context found:\n" + lines.map(l => `  - ${l}`).join("\n");
  const tokens = estimateTokensV2(output);
  sessRepo.debit(session.id, tokens);

  return output;
}

// CLI entry point (for bin script)
export async function main(): Promise<void> {
  try {
    const { readFileSync } = await import("node:fs");
    let raw = "";
    try { raw = readFileSync(0 as unknown as string, "utf-8"); } catch { /* stdin empty */ }
    const data = raw.trim() ? JSON.parse(raw) : {};
    const prompt = data.prompt ?? "";
    const claudeSessionId = data.session_id ?? undefined;
    if (!prompt) process.exit(0);

    const { createDatabase } = await import("../db/database.js");
    const { MemoriesRepo: MemRepo } = await import("../db/memories.js");
    const { SessionsRepo: SessRepo } = await import("../db/sessions.js");
    const { loadConfig, getDefaultDbPath, getDefaultConfigPath } = await import("../lib/config.js");

    const config = loadConfig(getDefaultConfigPath());
    const db = createDatabase(config.database.path || getDefaultDbPath());
    db.pragma("busy_timeout = 30000"); // R1: hook-friendly writer-lock tolerance
    const memRepo = new MemRepo(db);
    const sessRepo = new SessRepo(db);

    const output = processSearchHook(db, prompt, memRepo, sessRepo, config, claudeSessionId);
    if (output) process.stdout.write(output + "\n");

    db.close();
  } catch {
    // Hooks MUST fail silently
    process.exit(0);
  }
}

// At bottom of file, only runs when executed directly (not imported by tests)
if (process.argv[1]?.includes("search-context") || process.argv[1]?.includes("memento-hook-search")) {
  main();
}
