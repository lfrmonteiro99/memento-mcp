// src/hooks/search-context.ts
import { MemoriesRepo } from "../db/memories.js";
import { SessionsRepo } from "../db/sessions.js";
import { searchFileMemories } from "../lib/file-memory.js";
import { classifyPrompt } from "../lib/classify.js";
import { estimateTokens } from "../lib/budget.js";
import type { Config } from "../lib/config.js";

const STOP_WORDS = new Set([
  "the","is","at","in","on","to","for","and","or","an","a","of","it",
  "want","make","how","can","need","this","that","let","do","be",
  "o","a","os","as","um","de","do","da","em","no","na","por","para","com","que","e","se","não","mais",
]);

function extractKeywords(prompt: string): string[] {
  return prompt.toLowerCase().match(/\w+/g)
    ?.filter(w => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, 5) ?? [];
}

const TIER_LIMITS = { trivial: 0, standard: 3, complex: 5 };

export function processSearchHook(prompt: string, memRepo: MemoriesRepo, sessRepo: SessionsRepo, config: Config): string {
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

  const keywords = extractKeywords(prompt);
  if (keywords.length < 2) return "";

  const query = keywords.join(" ");
  const dbResults = memRepo.search(query, { limit: maxResults });
  const fileResults = searchFileMemories(query).slice(0, Math.min(2, maxResults));

  const lines: string[] = [];
  for (const r of dbResults) {
    lines.push(`[db] ${r.title}: ${(r.body ?? "").slice(0, 120)}`);
  }
  for (const r of fileResults) {
    lines.push(`[file] ${r.title}: ${(r.body ?? "").slice(0, 120)}`);
  }

  if (!lines.length) return "";

  const output = "Memory context found:\n" + lines.map(l => `  - ${l}`).join("\n");
  const tokens = estimateTokens(output);
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
    if (!prompt) process.exit(0);

    const { createDatabase } = await import("../db/database.js");
    const { MemoriesRepo: MemRepo } = await import("../db/memories.js");
    const { SessionsRepo: SessRepo } = await import("../db/sessions.js");
    const { loadConfig, getDefaultDbPath, getDefaultConfigPath } = await import("../lib/config.js");

    const config = loadConfig(getDefaultConfigPath());
    const db = createDatabase(config.database.path || getDefaultDbPath());
    const memRepo = new MemRepo(db);
    const sessRepo = new SessRepo(db);

    const output = processSearchHook(prompt, memRepo, sessRepo, config);
    if (output) process.stdout.write(output + "\n");

    db.close();
  } catch {
    // Hooks MUST fail silently
    process.exit(0);
  }
}

// At bottom of file, only runs when executed directly (not imported by tests)
if (process.argv[1]?.includes("search-context")) {
  main();
}
