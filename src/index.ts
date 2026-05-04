import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createDatabase } from "./db/database.js";
import { MemoriesRepo } from "./db/memories.js";
import { DecisionsRepo } from "./db/decisions.js";
import { PitfallsRepo } from "./db/pitfalls.js";
import { SessionsRepo } from "./db/sessions.js";
import { EmbeddingsRepo } from "./db/embeddings.js";
import { loadConfig, getDefaultConfigPath, getDefaultDbPath } from "./lib/config.js";
import { createLogger, logLevelFromEnv } from "./lib/logger.js";
import { handleMemoryStore } from "./tools/memory-store.js";
import { handleMemorySearch } from "./tools/memory-search.js";
import { handleMemoryGet } from "./tools/memory-get.js";
import { handleMemoryTimeline } from "./tools/memory-timeline.js";
import { handleMemoryList } from "./tools/memory-list.js";
import { handleMemoryDelete } from "./tools/memory-delete.js";
import { handleDecisionsLog } from "./tools/decisions-log.js";
import { handlePitfallsLog } from "./tools/pitfalls-log.js";
import { handleMemoryAnalytics } from "./tools/analytics-tools.js";
import { handleMemoryCompress } from "./tools/memory-compress.js";
import { handleMemoryUpdate } from "./tools/memory-update.js";
import { handleMemoryPin } from "./tools/memory-pin.js";
import { handleMemoryEdgeCreate } from "./tools/memory-edge-create.js";
import { handleMemoryEdgeTraverse } from "./tools/memory-edge-traverse.js";
import { handleMemoryExport, handleMemoryImport } from "./tools/memory-transfer.js";
import { AnalyticsTracker, installFlushOnExit } from "./analytics/tracker.js";
import { cleanupExpiredAnalytics } from "./analytics/retention.js";
import { runCompressionCycle } from "./engine/compressor.js";
import { toCompressionConfig } from "./lib/compression-config.js";
import { configureFileMemoryCache } from "./lib/file-memory.js";
import { promoteImportanceFromUtility } from "./engine/importance-promoter.js";
import { collectPoliciesPerProject } from "./lib/policy.js";
import { logDedupOnFirstUse } from "./engine/embeddings/dedup.js";

const log = createLogger(logLevelFromEnv());
const config = loadConfig(getDefaultConfigPath());
const db = createDatabase(config.database.path || getDefaultDbPath());
const memRepo = new MemoriesRepo(db);
const decRepo = new DecisionsRepo(db);
const pitRepo = new PitfallsRepo(db);
const sessRepo = new SessionsRepo(db);
const embRepo = new EmbeddingsRepo(db);
const analyticsTracker = new AnalyticsTracker(db, { flushThreshold: config.analytics.flushThreshold });
const disposeFlush = installFlushOnExit(analyticsTracker);

// File-memory cache TTL from config (0 disables caching).
configureFileMemoryCache(config.fileMemory.enabled ? config.fileMemory.cacheTtlSeconds : 0);

// Issue #8: one-time startup log when both embeddings.enabled and dedup are true.
logDedupOnFirstUse(config.search.embeddings);

const MIN_VACUUM_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastVacuumAt = 0;

function runMaintenance(): void {
  try {
    const n = memRepo.pruneStale(config.pruning.maxAgeDays, config.pruning.minImportance);
    if (n > 0) log.info(`Pruned ${n} stale memories`);
  } catch (e) {
    log.warn(`Pruning error: ${e}`);
  }

  // Issue #9: apply per-project retention overrides (policy can only tighten global limits)
  try {
    const perProjectPolicies = collectPoliciesPerProject(db);
    for (const { projectId, policy } of perProjectPolicies) {
      const { maxAgeDays, minImportance } = policy.retention;
      if (maxAgeDays !== undefined || minImportance !== undefined) {
        const effectiveMaxAge = Math.min(maxAgeDays ?? config.pruning.maxAgeDays, config.pruning.maxAgeDays);
        const effectiveMinImp = Math.max(minImportance ?? config.pruning.minImportance, config.pruning.minImportance);
        const n2 = memRepo.pruneStaleByProject(projectId, effectiveMaxAge, effectiveMinImp);
        if (n2 > 0) log.info(`Pruned ${n2} stale memories for project ${projectId} (policy override)`);
      }
    }
  } catch (e) {
    log.warn(`Per-project pruning error: ${e}`);
  }

  if (config.analytics.enabled && config.analytics.retentionDays > 0) {
    try {
      const removed = cleanupExpiredAnalytics(db, config.analytics.retentionDays);
      if (removed > 0) log.info(`Pruned ${removed} expired analytics events`);
    } catch (e) {
      log.warn(`Analytics retention error: ${e}`);
    }
  }

  if (config.adaptive.enabled) {
    try {
      const result = promoteImportanceFromUtility(db, {
        minInjections: config.adaptive.minInjectionsForConfidence,
        neutralUtility: config.adaptive.neutralUtilityScore,
        maxDelta: 0.05,
      });
      if (result.adjusted > 0) {
        log.info(
          `Importance re-weighted: ${result.adjusted} memories (${result.promoted} up, ${result.demoted} down)`,
        );
      }
    } catch (e) {
      log.warn(`Importance promotion error: ${e}`);
    }
  }

  // Rotate WAL (cheap, do every maintenance pass)
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch (e) {
    log.warn(`WAL checkpoint error: ${e}`);
  }

  // Reclaim space (expensive; rate-limited to once per 24h)
  const now = Date.now();
  if (now - lastVacuumAt > MIN_VACUUM_INTERVAL_MS) {
    try {
      db.exec("VACUUM");
      lastVacuumAt = now;
      log.info("Database VACUUM completed");
    } catch (e) {
      log.warn(`VACUUM error: ${e}`);
    }
  }

  if (config.compression.enabled) {
    try {
      const projects = db
        .prepare("SELECT id FROM projects")
        .all() as Array<{ id: string }>;
      const compCfg = toCompressionConfig(config);
      for (const { id } of projects) {
        const results = runCompressionCycle(db, id, compCfg);
        if (results.length > 0) {
          log.info(`Compressed ${results.length} cluster(s) in project ${id}`);
        }
      }
    } catch (e) {
      log.warn(`Compression cycle error: ${e}`);
    }
  }
}

// Initial maintenance pass
runMaintenance();

// Periodic maintenance interval (pruning + retention + compression)
let pruneTimer: ReturnType<typeof setInterval> | undefined;
if (config.pruning.enabled) {
  pruneTimer = setInterval(runMaintenance, config.pruning.intervalHours * 3_600_000);
  // Unref so the interval doesn't keep the process alive on its own
  pruneTimer.unref?.();
}

// Graceful shutdown
function shutdown(): void {
  if (pruneTimer) clearInterval(pruneTimer);
  try { analyticsTracker.flush(); } catch { /* ignore */ }
  disposeFlush();
  try { db.close(); } catch { /* ignore */ }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

const server = new McpServer({ name: "memento-mcp", version: "1.0.0" });

server.tool(
  "memory_store",
  "Persist a typed memory in SQLite, with optional promotion to the Obsidian vault.",
  {
    title: z.string(),
    content: z.string(),
    memory_type: z.string().default("fact"),
    scope: z.string().default("project"),
    project_path: z.string().default(""),
    tags: z.array(z.string()).default([]),
    importance: z.number().default(0.5),
    supersedes_id: z.string().default(""),
    pin: z.boolean().default(false),
    persist_to_vault: z.boolean().optional(),
    vault_mode: z.enum(["create", "create_or_update"]).default("create_or_update"),
    vault_kind: z.string().default(""),
    vault_folder: z.string().default(""),
    vault_note_title: z.string().default(""),
    dedup: z.enum(["strict", "warn", "off"]).optional(),
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryStore(memRepo, params, db, config, embRepo) }],
  })
);

server.tool(
  "memory_search",
  [
    "Search memories with progressive disclosure.",
    "Layer 1 (cheapest): detail='index' — titles + scores, ~30t per result. Start here.",
    "Layer 2: detail='summary' — preview body, ~80t per result. Use to shortlist.",
    "Layer 3: detail='full' — full body, ~150-300t per result. Use sparingly.",
    "For chronological context around one hit, prefer memory_timeline(id) — ~200t per neighbor.",
    "For one full body, prefer memory_get(id) — ~300-800t.",
    "include_edges=true also surfaces 1-hop typed neighbours of each hit, useful for tracing causal chains."
  ].join(" "),
  {
    query: z.string(),
    project_path: z.string().default(""),
    memory_type: z.string().default(""),
    limit: z.number().default(10),
    detail: z.enum(["index", "summary", "full"]).default("index"),
    include_file_memories: z.boolean().default(true),
    include_edges: z.boolean().default(false),
    edge_types: z.array(z.enum(["causes", "fixes", "supersedes", "contradicts", "derives_from", "relates_to"])).optional(),
    edge_direction: z.enum(["outgoing", "incoming", "both"]).default("both"),
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemorySearch(memRepo, config, params, db, analyticsTracker, embRepo) }],
  })
);

server.tool(
  "memory_get",
  "Fetch the full body of a single memory by id (~300-800 tokens). Prefer memory_search first to find the right id. Set reveal_private=true to see content inside <private> tags (emits an audit event).",
  {
    memory_id: z.string(),
    reveal_private: z.boolean().default(false),
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryGet(memRepo, db, config, params) }],
  })
);

server.tool(
  "memory_timeline",
  [
    "Return memories created around a given memory id (chronological neighborhood).",
    "Cost: ~200 tokens per neighbor.",
    "Use after memory_search(detail='index') when you need work-session context for one specific hit.",
    "Cheaper than calling memory_get on each neighbor individually."
  ].join(" "),
  {
    id: z.string(),
    window: z.number().int().min(1).max(10).default(3),
    detail: z.enum(["index", "summary"]).default("summary"),
    same_session_only: z.boolean().default(true),
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryTimeline(memRepo, params) }],
  })
);

server.tool(
  "memory_list",
  "List memories with optional filters.",
  {
    project_path: z.string().default(""),
    memory_type: z.string().default(""),
    scope: z.string().default(""),
    pinned_only: z.boolean().default(false),
    limit: z.number().default(20),
    detail: z.enum(["index", "summary", "full"]).default("full"),
    include_file_memories: z.boolean().default(false),
    vault_kind: z.string().default(""),
    vault_folder: z.string().default(""),
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryList(memRepo, config, params, db) }],
  })
);

server.tool(
  "memory_delete",
  "Soft-delete a memory by ID.",
  {
    memory_id: z.string(),
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryDelete(memRepo, params) }],
  })
);

server.tool(
  "decisions_log",
  "Store, list, or search architectural decisions.",
  {
    action: z.string(),
    project_path: z.string(),
    title: z.string().default(""),
    body: z.string().default(""),
    category: z.string().default("general"),
    importance: z.number().default(0.7),
    supersedes_id: z.string().default(""),
    query: z.string().default(""),
    limit: z.number().default(10),
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleDecisionsLog(decRepo, params) }],
  })
);

server.tool(
  "pitfalls_log",
  "Track recurring problems and their resolutions.",
  {
    action: z.string(),
    project_path: z.string(),
    title: z.string().default(""),
    body: z.string().default(""),
    importance: z.number().default(0.6),
    limit: z.number().default(10),
    include_resolved: z.boolean().default(false),
    pitfall_id: z.string().default(""),
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handlePitfallsLog(pitRepo, params) }],
  })
);

server.tool(
  "memory_analytics",
  "View memory effectiveness: utility rates, token costs, auto-capture stats, prune suggestions.",
  {
    period: z.enum(["last_24h", "last_7d", "last_30d", "all"]).default("last_7d"),
    section: z.enum(["all", "injections", "captures", "compression", "memories"]).default("all"),
    project_path: z.string().default(""),
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryAnalytics(db, params) }],
  })
);

server.tool(
  "memory_update",
  "Edit an existing memory in place (title, content, tags, importance, memory_type, pinned).",
  {
    memory_id: z.string(),
    title: z.string().optional(),
    content: z.string().optional(),
    tags: z.array(z.string()).optional(),
    importance: z.number().optional(),
    memory_type: z.string().optional(),
    pinned: z.boolean().optional(),
    dedup: z.enum(["strict", "warn", "off"]).optional(),
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryUpdate(memRepo, params, config, embRepo) }],
  })
);

server.tool(
  "memory_pin",
  "Pin or unpin a memory so it survives pruning and ranks higher.",
  {
    memory_id: z.string(),
    pinned: z.boolean().default(true),
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryPin(memRepo, params) }],
  })
);

server.tool(
  "memory_compress",
  "Run the compression pipeline now (cluster similar memories and merge them). Omit project_path to compress all projects.",
  {
    project_path: z.string().default(""),
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryCompress(db, config, params) }],
  })
);

server.tool(
  "memory_export",
  "Export memories/decisions/pitfalls as portable JSON. Omit project_path to export everything.",
  {
    project_path: z.string().default(""),
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryExport(db, params) }],
  })
);

server.tool(
  "memory_import",
  "Import memories from a JSON file produced by memory_export. Strategy 'skip' (default) keeps existing rows; 'overwrite' replaces them.",
  {
    path: z.string(),
    strategy: z.enum(["skip", "overwrite"]).default("skip"),
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryImport(db, params) }],
  })
);

server.tool(
  "memory_edge_create",
  "Create a typed semantic edge between two memories. Edge types: causes, fixes, supersedes, contradicts, derives_from, relates_to. Useful for linking decisions to pitfalls, fixes to bugs, or marking superseded patterns.",
  {
    from_memory_id: z.string(),
    to_memory_id: z.string(),
    edge_type: z.enum(["causes", "fixes", "supersedes", "contradicts", "derives_from", "relates_to"]),
    weight: z.number().min(0).max(1).default(1.0),
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryEdgeCreate(memRepo, db, params) }],
  })
);

server.tool(
  "memory_edge_traverse",
  "List 1-hop typed neighbours of a memory. Direction: outgoing/incoming/both (default both). Optional edge_types filter narrows by edge type. Skips soft-deleted neighbours. Useful for tracing causal chains and fix relationships.",
  {
    memory_id: z.string(),
    edge_types: z.array(z.enum(["causes", "fixes", "supersedes", "contradicts", "derives_from", "relates_to"])).optional(),
    direction: z.enum(["outgoing", "incoming", "both"]).default("both"),
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryEdgeTraverse(memRepo, db, params) }],
  })
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("memento-mcp server started");
}

main().catch((e) => {
  log.error(`Fatal: ${e}`);
  process.exit(1);
});
