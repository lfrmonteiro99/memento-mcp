// src/tools/memory-list.ts
import type { MemoriesRepo } from "../db/memories.js";
import type { Config } from "../lib/config.js";
import { readFileMemories } from "../lib/file-memory.js";
import { formatIndex, formatFull } from "../lib/formatter.js";

export async function handleMemoryList(repo: MemoriesRepo, config: Config, params: {
  project_path?: string; memory_type?: string; scope?: string;
  pinned_only?: boolean; limit?: number; detail?: "index" | "full";
  include_file_memories?: boolean;
}): Promise<string> {
  const detail = params.detail ?? config.search.defaultDetail;
  const results: any[] = repo.list({
    projectPath: params.project_path, memoryType: params.memory_type,
    scope: params.scope, pinnedOnly: params.pinned_only, limit: params.limit,
  });
  for (const r of results) r.source = "sqlite";

  if (params.include_file_memories) {
    const fileResults = readFileMemories(params.project_path);
    for (const r of fileResults) {
      (r as any).importance_score = 1.0;
      (r as any).created_at = "(file)";
      results.push(r);
    }
  }

  return detail === "index" ? formatIndex(results) : formatFull(results, config.search.bodyPreviewChars);
}
