import type Database from "better-sqlite3";
import type { Config } from "../lib/config.js";
import { runCompressionCycle } from "../engine/compressor.js";
import { toCompressionConfig } from "../lib/compression-config.js";

export async function handleMemoryCompress(
  db: Database.Database,
  config: Config,
  params: { project_path?: string },
): Promise<string> {
  if (!config.compression.enabled) {
    return "Compression is disabled in config (compression.enabled = false).";
  }

  const compCfg = toCompressionConfig(config);

  let projectIds: string[];
  if (params.project_path) {
    const row = db
      .prepare("SELECT id FROM projects WHERE root_path = ?")
      .get(params.project_path) as { id: string } | undefined;
    if (!row) {
      return `No project found for path ${params.project_path}.`;
    }
    projectIds = [row.id];
  } else {
    projectIds = (db.prepare("SELECT id FROM projects").all() as Array<{ id: string }>).map(r => r.id);
  }

  if (projectIds.length === 0) {
    return "No projects to compress.";
  }

  let totalClusters = 0;
  let totalPrunedClusters = 0;
  let totalPrunedMemories = 0;
  let totalTokensBefore = 0;
  let totalTokensAfter = 0;
  const perProject: string[] = [];

  for (const projectId of projectIds) {
    const { compressed, pruned } = runCompressionCycle(db, projectId, compCfg);
    if (compressed.length === 0 && pruned.clusterCount === 0) continue;
    totalClusters += compressed.length;
    totalPrunedClusters += pruned.clusterCount;
    totalPrunedMemories += pruned.memoryCount;
    const tokensBefore = compressed.reduce((acc, r) => acc + r.tokens_before, 0);
    const tokensAfter = compressed.reduce((acc, r) => acc + r.tokens_after, 0);
    totalTokensBefore += tokensBefore;
    totalTokensAfter += tokensAfter;
    const prunedNote = pruned.clusterCount > 0
      ? `, pruned ${pruned.clusterCount} low-quality cluster(s) / ${pruned.memoryCount} mem(s)`
      : "";
    perProject.push(`  - project ${projectId}: ${compressed.length} cluster(s), ${tokensBefore}→${tokensAfter} tokens${prunedNote}`);
  }

  if (totalClusters === 0 && totalPrunedClusters === 0) {
    return "No clusters found to compress.";
  }

  const savings = totalTokensBefore > 0
    ? Math.round((1 - totalTokensAfter / totalTokensBefore) * 100)
    : 0;

  return (
    `Compressed ${totalClusters} cluster(s) across ${perProject.length} project(s).\n` +
    `Tokens: ${totalTokensBefore} → ${totalTokensAfter} (${savings}% reduction).\n` +
    perProject.join("\n")
  );
}
