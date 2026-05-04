import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { jaccardSimilarity, trigramSimilarity } from "./similarity.js";
import { estimateTokensV2 } from "./token-estimator.js";

export interface MemoryRecord {
  id: string;
  project_id: string | null;
  memory_type: string;
  scope: string;
  title: string;
  body: string;
  tags: string | null;
  importance_score: number;
  confidence_score: number;
  access_count: number;
  last_accessed_at: string | null;
  is_pinned: number;
  supersedes_memory_id: string | null;
  source: string;
  adaptive_score: number;
  quality_score?: number; // P0 Task 4/6: heuristic quality on auto-capture rows
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface CompressionConfig {
  cluster_similarity_threshold: number;
  min_cluster_size: number;
  max_body_ratio: number;
  temporal_window_hours: number;
  /** P0 Task 6: clusters whose median quality_score is < this floor are
   * soft-deleted instead of merged. Only auto-capture rows carry quality
   * scores; user rows default to 0.5 and are unaffected by typical floors. */
  qualityFloor?: number;
}

export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  cluster_similarity_threshold: 0.45,
  min_cluster_size: 2,
  max_body_ratio: 0.6,
  temporal_window_hours: 48,
  qualityFloor: 0.25,
};

export interface CompressionTriggerConfig {
  memory_count_threshold: number;
  auto_capture_batch: number;
  staleness_days: number;
}

export interface CompressionCluster {
  memories: MemoryRecord[];
  centroid_tags: string[];
  common_files: string[];
  date_range: { start: Date; end: Date };
  total_tokens: number;
}

export interface CompressionResult {
  compressed_memory: {
    title: string;
    body: string;
    memory_type: string;
    tags: string[];
    importance_score: number;
  };
  source_memory_ids: string[];
  tokens_before: number;
  tokens_after: number;
  compression_ratio: number;
}

const FILE_PATH_PATTERN = /[\w./\\-]+\.(?:ts|js|py|php|rs|go|java|vue|jsx|tsx|css|json|toml|yaml|yml|md)/g;

function parseTags(tags: string | string[] | null): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags;
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return tags.split(",").map(t => t.trim()).filter(t => t.length > 0);
  }
}

function extractPaths(text: string): string[] {
  return text.match(FILE_PATH_PATTERN) ?? [];
}

function filePathOverlap(a: MemoryRecord, b: MemoryRecord): number {
  const pathsA = new Set(extractPaths(`${a.title} ${a.body}`));
  const pathsB = new Set(extractPaths(`${b.title} ${b.body}`));
  if (pathsA.size === 0 && pathsB.size === 0) return 0;
  const intersection = new Set([...pathsA].filter(p => pathsB.has(p)));
  const union = new Set([...pathsA, ...pathsB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

function temporalProximity(dateA: string, dateB: string, windowHours: number): number {
  const diffHours =
    Math.abs(new Date(dateA).getTime() - new Date(dateB).getTime()) / (1000 * 60 * 60);
  if (diffHours >= windowHours) return 0;
  return 1 - diffHours / windowHours;
}

// I1: Cap input at 200 most recent non-compressed memories to bound clustering cost.
const MAX_CLUSTERING_MEMORIES = 200;

export function clusterMemories(
  memories: MemoryRecord[],
  config: CompressionConfig,
): CompressionCluster[] {
  const input = memories
    .filter(m => m.source !== "compression")
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, MAX_CLUSTERING_MEMORIES);

  const n = input.length;
  if (n < Math.max(2, config.min_cluster_size)) return [];

  // I1: Union-Find with O(n^2) pairwise similarity — single-linkage clustering.
  const parent = Array.from({ length: n }, (_, i) => i);
  const rank = new Array(n).fill(0);

  const find = (x: number): number => {
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  };

  const union = (x: number, y: number): void => {
    const rx = find(x);
    const ry = find(y);
    if (rx === ry) return;
    if (rank[rx] < rank[ry]) parent[rx] = ry;
    else if (rank[rx] > rank[ry]) parent[ry] = rx;
    else {
      parent[ry] = rx;
      rank[rx]++;
    }
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const tagSim = jaccardSimilarity(
        parseTags(input[i].tags).join(" "),
        parseTags(input[j].tags).join(" "),
      );
      const titleSim = trigramSimilarity(input[i].title, input[j].title);
      const fileSim = filePathOverlap(input[i], input[j]);
      const tempSim = temporalProximity(
        input[i].created_at,
        input[j].created_at,
        config.temporal_window_hours,
      );
      const combined =
        tagSim * 0.25 + titleSim * 0.3 + fileSim * 0.3 + tempSim * 0.15;
      if (combined >= config.cluster_similarity_threshold) {
        union(i, j);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  return [...groups.values()]
    .filter(indices => indices.length >= config.min_cluster_size)
    .map(indices => {
      const mems = indices.map(i => input[i]);

      const tagCounts = new Map<string, number>();
      for (const m of mems) {
        for (const t of parseTags(m.tags)) {
          tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
        }
      }
      const threshold = mems.length * 0.5;
      const commonTags = [...tagCounts.entries()]
        .filter(([, c]) => c >= threshold)
        .map(([t]) => t);

      const pathCounts = new Map<string, number>();
      for (const m of mems) {
        for (const p of extractPaths(`${m.title} ${m.body}`)) {
          pathCounts.set(p, (pathCounts.get(p) ?? 0) + 1);
        }
      }
      const commonFiles = [...pathCounts.entries()]
        .filter(([, c]) => c >= threshold)
        .map(([p]) => p);

      return {
        memories: mems,
        centroid_tags: commonTags,
        common_files: commonFiles,
        date_range: {
          start: new Date(Math.min(...mems.map(m => new Date(m.created_at).getTime()))),
          end: new Date(Math.max(...mems.map(m => new Date(m.created_at).getTime()))),
        },
        total_tokens: mems.reduce(
          (sum, m) => sum + estimateTokensV2(`${m.title} ${m.body ?? ""}`),
          0,
        ),
      };
    });
}

export function mergeCluster(cluster: CompressionCluster): CompressionResult {
  const memories = cluster.memories;

  const facts: string[] = [];
  const files = new Set<string>();
  const allTags = new Set<string>();

  for (const mem of memories) {
    const sentences = (mem.body ?? "")
      .split(/[.!?\n]+/)
      .map(s => s.trim())
      .filter(s => s.length > 10);
    for (const sentence of sentences) {
      let isNew = true;
      for (const existing of facts) {
        if (jaccardSimilarity(sentence, existing) > 0.6) {
          isNew = false;
          break;
        }
      }
      if (isNew) facts.push(sentence);
    }

    for (const p of extractPaths(mem.body ?? "")) files.add(p);
    for (const t of parseTags(mem.tags)) allTags.add(t);
  }

  const titleParts: string[] = [];
  if (files.size > 0) {
    const fileList = [...files].slice(0, 3).join(", ");
    titleParts.push(`Files: ${fileList}${files.size > 3 ? ` +${files.size - 3}` : ""}`);
  }
  if (cluster.centroid_tags.length > 0) {
    titleParts.push(`[${cluster.centroid_tags.slice(0, 3).join(", ")}]`);
  }
  const title =
    titleParts.length > 0
      ? `Compressed: ${titleParts.join(" ")}`
      : `Compressed: ${memories.length} related memories`;

  const scoreFact = (fact: string): number => {
    const lengthScore = fact.length;
    const colonBonus = fact.includes(":") ? 1.2 : 1;
    const signalBonus = /error|fix|fail|bug|crash/i.test(fact) ? 1.5 : 1;
    return lengthScore * colonBonus * signalBonus;
  };
  const sortedFacts = [...facts].sort((a, b) => scoreFact(b) - scoreFact(a));

  const tokenBudget = Math.max(
    32,
    Math.floor(cluster.total_tokens * DEFAULT_COMPRESSION_CONFIG.max_body_ratio),
  );

  let body = "";
  let currentTokens = 0;
  for (const fact of sortedFacts) {
    const factTokens = estimateTokensV2(fact);
    if (currentTokens + factTokens > tokenBudget) break;
    body += `- ${fact}\n`;
    currentTokens += factTokens;
  }

  const importance = Math.min(
    1.0,
    Math.max(...memories.map(m => m.importance_score)) + 0.1,
  );

  const typeCounts: Record<string, number> = {};
  for (const m of memories) {
    typeCounts[m.memory_type] = (typeCounts[m.memory_type] ?? 0) + 1;
  }
  const dominantType =
    Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "fact";

  const tokens_before = cluster.total_tokens;
  const tokens_after = estimateTokensV2(`${title} ${body.trim()}`);
  const compression_ratio = tokens_before === 0 ? 1 : tokens_after / tokens_before;

  return {
    compressed_memory: {
      title,
      body: body.trim(),
      memory_type: dominantType,
      tags: [...allTags, "compressed"].slice(0, 10),
      importance_score: importance,
    },
    source_memory_ids: memories.map(m => m.id),
    tokens_before,
    tokens_after,
    compression_ratio,
  };
}

export interface SessionSummaryResult {
  title: string;
  body: string;
  tags: string[];
  tokens_before: number;
  tokens_after: number;
  importance: number;
}

/**
 * Issue #3: Produce a single deterministic session summary from a list of memories.
 * Skips clustering — treats all inputs as one cluster. Title pattern:
 *   "Session summary — YYYY-MM-DD — N captures"
 * Importance = max of source importances.
 * Tags = union of source tags (deduplicated).
 * Body = merged text under cfg.maxBodyRatio budget (or sessionEndMaxBodyTokens if provided).
 */
export function summarizeAsCluster(
  memories: MemoryRecord[],
  cfg: CompressionConfig & { maxBodyTokens?: number }
): SessionSummaryResult {
  if (memories.length === 0) {
    return { title: "Session summary", body: "", tags: [], tokens_before: 0, tokens_after: 0, importance: 0.5 };
  }

  const allTags = new Set<string>();
  const facts: string[] = [];

  let tokens_before = 0;
  for (const mem of memories) {
    tokens_before += estimateTokensV2(`${mem.title} ${mem.body ?? ""}`);

    // Collect tags
    for (const t of parseTags(mem.tags)) allTags.add(t);

    // Extract unique sentences (same dedup logic as mergeCluster)
    const sentences = (mem.body ?? "")
      .split(/[.!?\n]+/)
      .map(s => s.trim())
      .filter(s => s.length > 10);
    for (const sentence of sentences) {
      let isNew = true;
      for (const existing of facts) {
        if (jaccardSimilarity(sentence, existing) > 0.6) {
          isNew = false;
          break;
        }
      }
      if (isNew) facts.push(sentence);
    }
  }

  // Title: "Session summary — YYYY-MM-DD — N captures"
  const dateStr = new Date().toISOString().slice(0, 10);
  const title = `Session summary — ${dateStr} — ${memories.length} captures`;

  // Score facts by importance signal (same heuristic as mergeCluster)
  const scoreFact = (fact: string): number => {
    const lengthScore = fact.length;
    const colonBonus = fact.includes(":") ? 1.2 : 1;
    const signalBonus = /error|fix|fail|bug|crash/i.test(fact) ? 1.5 : 1;
    return lengthScore * colonBonus * signalBonus;
  };
  const sortedFacts = [...facts].sort((a, b) => scoreFact(b) - scoreFact(a));

  // Token budget: prefer explicit maxBodyTokens cap, fall back to ratio of total
  const tokenBudget = cfg.maxBodyTokens != null
    ? cfg.maxBodyTokens
    : Math.max(32, Math.floor(tokens_before * cfg.max_body_ratio));

  let body = "";
  let currentTokens = 0;
  for (const fact of sortedFacts) {
    const factTokens = estimateTokensV2(fact);
    if (currentTokens + factTokens > tokenBudget) break;
    body += `- ${fact}\n`;
    currentTokens += factTokens;
  }

  const importance = Math.min(1.0, Math.max(...memories.map(m => m.importance_score)));
  const tokens_after = estimateTokensV2(`${title} ${body.trim()}`);

  return {
    title,
    body: body.trim(),
    tags: [...allTags],
    tokens_before,
    tokens_after,
    importance,
  };
}

export function shouldCompress(
  db: Database.Database,
  projectId: string,
  config: CompressionTriggerConfig,
): boolean {
  const stats = db
    .prepare(
      `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN source = 'auto-capture' AND created_at > datetime('now', '-24 hours') THEN 1 ELSE 0 END) as recent_auto
      FROM memories
      WHERE project_id = ? AND deleted_at IS NULL
    `,
    )
    .get(projectId) as { total: number; recent_auto: number | null };

  const recentAuto = stats.recent_auto ?? 0;
  return stats.total > config.memory_count_threshold || recentAuto > config.auto_capture_batch;
}

/**
 * R5 — applyCompression commits the merge in a single transaction:
 * INSERT compressed memory → INSERT compression_log → soft-delete sources.
 * R6: compression_log.compressed_memory_id binds to memories.id (TEXT UUID),
 * NOT memories.rowid (ephemeral under VACUUM).
 * M4: compressed memory inherits project_id from source memories.
 * K5: tags stored as JSON.
 * C3: FTS sync is handled by memories_ai trigger — do NOT insert explicitly.
 */
export function applyCompression(db: Database.Database, result: CompressionResult): void {
  const tx = db.transaction(() => {
    const id = randomUUID();
    const now = new Date().toISOString();

    const projectRow =
      result.source_memory_ids.length > 0
        ? (db
            .prepare("SELECT project_id FROM memories WHERE id = ? LIMIT 1")
            .get(result.source_memory_ids[0]) as { project_id: string | null } | undefined)
        : undefined;
    const projectId = projectRow?.project_id ?? null;

    db.prepare(
      `
      INSERT INTO memories (id, project_id, memory_type, scope, title, body, tags,
                            importance_score, confidence_score, source,
                            created_at, updated_at)
      VALUES (?, ?, ?, 'project', ?, ?, ?, ?, 1.0, 'compression', ?, ?)
    `,
    ).run(
      id,
      projectId,
      result.compressed_memory.memory_type,
      result.compressed_memory.title,
      result.compressed_memory.body,
      JSON.stringify(result.compressed_memory.tags),
      result.compressed_memory.importance_score,
      now,
      now,
    );

    db.prepare(
      `
      INSERT INTO compression_log (compressed_memory_id, source_memory_ids, tokens_before, tokens_after, compression_ratio, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run(
      id,
      JSON.stringify(result.source_memory_ids),
      result.tokens_before,
      result.tokens_after,
      result.compression_ratio,
      now,
    );

    const softDelete = db.prepare(
      "UPDATE memories SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
    );
    for (const sourceId of result.source_memory_ids) {
      softDelete.run(now, sourceId);
    }
  });

  tx();
}

/**
 * R5 — full compression cycle in a single db.transaction():
 * select candidates → cluster → merge → applyCompression for each cluster.
 * Better-sqlite3 transactions are synchronous, so nesting is safe; the
 * outermost transaction is the actual commit boundary.
 */
/** P0 Task 6: median quality_score of a cluster's memories.
 * Rows without quality_score (older user rows) default to 0.5 so they don't
 * trip the floor. */
function clusterMedianQuality(cluster: CompressionCluster): number {
  const scores = cluster.memories
    .map(m => (typeof m.quality_score === "number" ? m.quality_score : 0.5))
    .sort((a, b) => a - b);
  if (scores.length === 0) return 0.5;
  return scores[Math.floor(scores.length / 2)];
}

export function runCompressionCycle(
  db: Database.Database,
  projectId: string,
  config: CompressionConfig,
): CompressionResult[] {
  const results: CompressionResult[] = [];

  const tx = db.transaction(() => {
    const rows = db
      .prepare(
        `
        SELECT * FROM memories
        WHERE project_id = ? AND deleted_at IS NULL AND source != 'compression'
        ORDER BY created_at DESC LIMIT 200
      `,
      )
      .all(projectId) as MemoryRecord[];

    const clusters = clusterMemories(rows, config);
    const floor = config.qualityFloor ?? 0;
    const softDelete = db.prepare(
      "UPDATE memories SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL",
    );
    for (const cluster of clusters) {
      if (floor > 0 && clusterMedianQuality(cluster) < floor) {
        for (const m of cluster.memories) softDelete.run(m.id);
        continue;
      }
      const merged = mergeCluster(cluster);
      applyCompression(db, merged);
      results.push(merged);
    }
  });

  tx();
  return results;
}
