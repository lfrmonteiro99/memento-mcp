// src/hooks/session-context.ts
import { MemoriesRepo } from "../db/memories.js";
import { PitfallsRepo } from "../db/pitfalls.js";
import { SessionsRepo } from "../db/sessions.js";
import { estimateTokens } from "../lib/budget.js";
import type { Config } from "../lib/config.js";

export function processSessionHook(memRepo: MemoriesRepo, pitRepo: PitfallsRepo, sessRepo: SessionsRepo, config: Config): string {
  const session = sessRepo.getOrCreate(config.budget);

  const memories = memRepo.list({ limit: config.hooks.sessionStartMemories });
  const pitfalls = pitRepo.listAll(config.hooks.sessionStartPitfalls);

  const lines: string[] = [];
  if (memories.length) {
    lines.push("Recent memories:");
    for (const m of memories) lines.push(`  - [${m.memory_type}] ${m.title}`);
  }
  if (pitfalls.length) {
    lines.push("Active pitfalls:");
    for (const p of pitfalls) lines.push(`  - (x${p.occurrence_count}) ${p.title}`);
  }

  const output = lines.join("\n");
  // Always debit at least 1 token to mark the session as started
  sessRepo.debit(session.id, output ? estimateTokens(output) : 1);

  return output;
}

// CLI entry point (for bin script)
export async function main(): Promise<void> {
  try {
    const { readFileSync } = await import("node:fs");
    try { readFileSync(0 as unknown as string, "utf-8"); } catch { /* consume stdin */ }

    const { createDatabase } = await import("../db/database.js");
    const { MemoriesRepo } = await import("../db/memories.js");
    const { PitfallsRepo: PitRepo } = await import("../db/pitfalls.js");
    const { SessionsRepo } = await import("../db/sessions.js");
    const { loadConfig, getDefaultDbPath, getDefaultConfigPath } = await import("../lib/config.js");

    const config = loadConfig(getDefaultConfigPath());
    const db = createDatabase(config.database.path || getDefaultDbPath());

    const output = processSessionHook(new MemoriesRepo(db), new PitRepo(db), new SessionsRepo(db), config);
    if (output) process.stdout.write(output + "\n");

    db.close();
  } catch {
    process.exit(0);
  }
}

// At bottom of file, only runs when executed directly (not imported by tests)
if (process.argv[1]?.includes("session-context")) {
  main();
}
