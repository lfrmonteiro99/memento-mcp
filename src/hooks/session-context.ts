#!/usr/bin/env node
// src/hooks/session-context.ts
import type Database from "better-sqlite3";
import { MemoriesRepo } from "../db/memories.js";
import { PitfallsRepo } from "../db/pitfalls.js";
import { SessionsRepo } from "../db/sessions.js";
import { estimateTokensV2 } from "../engine/token-estimator.js";
import { daysSince, computeExponentialDecay } from "../lib/decay.js";
import { computeAdaptiveScore, computeUtilityScore } from "../engine/adaptive-ranker.js";
import type { Config } from "../lib/config.js";

export function processSessionHook(
  db: Database.Database,
  memRepo: MemoriesRepo,
  pitRepo: PitfallsRepo,
  sessRepo: SessionsRepo,
  config: Config,
  claudeSessionId?: string
): string {
  const session = sessRepo.getOrCreate(config.budget);

  // Pull 3x the target so adaptive re-ranking has candidates.
  // K6: correct config key is config.hooks.sessionStartMemories (exists in v1).
  const target = config.hooks.sessionStartMemories;
  const candidates = memRepo.list({ limit: Math.max(target * 3, target) });

  const scored = candidates.map(m => {
    const ageDays = daysSince(m.last_accessed_at ?? m.created_at);
    const decay = computeExponentialDecay(ageDays, 14);
    const utility = computeUtilityScore(db, m.id);
    const adaptive = computeAdaptiveScore({
      fts_relevance: 0.5, // no query context at session start — neutral
      embedding_relevance: 0,
      importance: m.importance_score ?? 0.5,
      decay,
      utility,
      recency_bonus: 0,
    });
    return { row: m, adaptive };
  });
  scored.sort((a, b) => b.adaptive - a.adaptive);
  const topMemories = scored.slice(0, target).map(s => s.row);

  // K1 producer: emit injection events tied to the Claude Code session id so that
  // subsequent PostToolUse tool calls can be matched against these memories.
  if (claudeSessionId && topMemories.length > 0) {
    const insertInjection = db.prepare(`
      INSERT INTO analytics_events (session_id, project_id, memory_id, event_type, event_data, created_at)
      VALUES (?, ?, ?, 'injection', ?, datetime('now'))
    `);
    for (const m of topMemories) {
      insertInjection.run(
        claudeSessionId,
        m.project_id ?? null,
        m.id,
        JSON.stringify({ context: "session_start" })
      );
    }
  }

  const pitfalls = pitRepo.listAll(config.hooks.sessionStartPitfalls);

  const lines: string[] = [];
  if (topMemories.length) {
    lines.push("Recent memories:");
    for (const m of topMemories) lines.push(`  - [${m.memory_type}] ${m.title}`);
  }
  if (pitfalls.length) {
    lines.push("Active pitfalls:");
    for (const p of pitfalls) lines.push(`  - (x${p.occurrence_count}) ${p.title}`);
  }

  // G6: memory_analytics reminder — once every N sessions.
  const interval = config.hooks.analyticsReminderIntervalSessions ?? 20;
  if (interval > 0 && session.id && (simpleHash(session.id) % interval === 0)) {
    lines.push("Tip: run the memory_analytics tool to see which memories saved tokens this week.");
  }

  const output = lines.join("\n");
  // Always debit at least 1 token to mark the session as started.
  sessRepo.debit(session.id, output ? estimateTokensV2(output) : 1);

  return output;
}

function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// CLI entry point (for bin script)
export async function main(): Promise<void> {
  try {
    const { readFileSync } = await import("node:fs");
    let raw = "";
    try { raw = readFileSync(0 as unknown as string, "utf-8"); } catch { /* consume stdin */ }
    const data = raw.trim() ? JSON.parse(raw) : {};
    const claudeSessionId = data.session_id ?? undefined;

    const { createDatabase } = await import("../db/database.js");
    const { MemoriesRepo } = await import("../db/memories.js");
    const { PitfallsRepo: PitRepo } = await import("../db/pitfalls.js");
    const { SessionsRepo } = await import("../db/sessions.js");
    const { loadConfig, getDefaultDbPath, getDefaultConfigPath } = await import("../lib/config.js");

    const config = loadConfig(getDefaultConfigPath());
    const db = createDatabase(config.database.path || getDefaultDbPath());
    db.pragma("busy_timeout = 30000"); // R1

    const output = processSessionHook(db, new MemoriesRepo(db), new PitRepo(db), new SessionsRepo(db), config, claudeSessionId);
    if (output) process.stdout.write(output + "\n");

    db.close();
  } catch {
    process.exit(0);
  }
}

// At bottom of file, only runs when executed directly (not imported by tests)
if (process.argv[1]?.includes("session-context") || process.argv[1]?.includes("memento-hook-session")) {
  main();
}
