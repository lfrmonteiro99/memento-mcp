import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createDatabase } from "./db/database.js";
import { MemoriesRepo } from "./db/memories.js";
import { DecisionsRepo } from "./db/decisions.js";
import { PitfallsRepo } from "./db/pitfalls.js";
import { SessionsRepo } from "./db/sessions.js";
import { EmbeddingsRepo } from "./db/embeddings.js";
import { EdgesRepo } from "./db/edges.js";
import { loadConfig, getDefaultConfigPath, getDefaultDbPath } from "./lib/config.js";
import { createLogger, logLevelFromEnv } from "./lib/logger.js";
import { handleMemoryStore } from "./tools/memory-store.js";
import { handleMemorySearch } from "./tools/memory-search.js";
import { handleMemoryGet } from "./tools/memory-get.js";
import { handleMemoryTimeline } from "./tools/memory-timeline.js";
import { handleMemoryList } from "./tools/memory-list.js";
import { handleMemoryDelete } from "./tools/memory-delete.js";
import { handleMemoryDedupCheck } from "./tools/memory-dedup-check.js";
import { handleDecisionsLog } from "./tools/decisions-log.js";
import { handlePitfallsLog } from "./tools/pitfalls-log.js";
import { handleMemoryAnalytics } from "./tools/analytics-tools.js";
import { handleMemoryCompress } from "./tools/memory-compress.js";
import { handleMemoryUpdate } from "./tools/memory-update.js";
import { handleMemoryPin } from "./tools/memory-pin.js";
import { handleMemoryExport, handleMemoryImport } from "./tools/memory-transfer.js";
import { handleMemoryLink } from "./tools/memory-link.js";
import { handleMemoryUnlink } from "./tools/memory-unlink.js";
import { handleMemoryGraph } from "./tools/memory-graph.js";
import { handleMemoryPath } from "./tools/memory-path.js";
import { AnalyticsTracker, installFlushOnExit } from "./analytics/tracker.js";
import { cleanupExpiredAnalytics } from "./analytics/retention.js";
import { runCompressionCycle } from "./engine/compressor.js";
import { toCompressionConfig } from "./lib/compression-config.js";
import { configureFileMemoryCache } from "./lib/file-memory.js";
import { promoteImportanceFromUtility } from "./engine/importance-promoter.js";
import { collectPoliciesPerProject } from "./lib/policy.js";
import { logDedupOnFirstUse } from "./engine/embeddings/dedup.js";
import { createProvider } from "./engine/embeddings/provider.js";

const log = createLogger(logLevelFromEnv());
const config = loadConfig(getDefaultConfigPath());
const db = createDatabase(config.database.path || getDefaultDbPath());
const memRepo = new MemoriesRepo(db);
const decRepo = new DecisionsRepo(db);
const pitRepo = new PitfallsRepo(db);
const sessRepo = new SessionsRepo(db);
const embRepo = new EmbeddingsRepo(db);
const edgesRepo = new EdgesRepo(db);
const dedupProvider = createProvider(config.search.embeddings);
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

const server = new McpServer({ name: "memento-mcp", version: "2.1.6" });

server.registerTool(
  "memory_store",
  {
    title: "Store a memory",
    description: [
      "Persist a fact, decision, lesson, or pattern into the local SQLite memory store so it can be recalled later by `memory_search`, `memory_get`, or injected automatically into future sessions.",
      "When to use: capturing a durable piece of context (architecture decision, gotcha, user preference, recurring command, important fact). Use this for anything you'd otherwise have to re-derive from chat history.",
      "When NOT to use: transient debug output, temporary scratch notes, or content that already lives in the codebase — search first with `memory_search` to avoid duplicates, or run `memory_dedup_check` for a cheap pre-flight.",
      "Side effects: writes a row to SQLite (and queues an embedding when enabled); may also create/update an Obsidian vault note when `persist_to_vault=true` or when project policy auto-promotes the type. Returns the new memory id.",
      "Dedup: when embeddings are enabled, near-duplicates are detected; pass `dedup=\"strict\"` to refuse storing duplicates, `\"warn\"` to store with a warning, or `\"off\"` to bypass.",
    ].join(" "),
    inputSchema: {
      title: z.string().min(1).describe("Short human-readable title (1 line). Used as the search label and as the vault note filename when promoted."),
      content: z.string().min(1).describe("The memory body in markdown. Wrap sensitive substrings in `<private>...</private>` tags to redact them from default reads."),
      memory_type: z.string().default("fact").describe("Category tag: `fact`, `decision`, `lesson`, `pattern`, `preference`, `command`, etc. Drives auto-promotion and importance defaults via project policy."),
      scope: z.string().default("project").describe("Visibility scope: `project` (default, scoped to the project at `project_path`), `global` (all projects), or `team` (synced via git when sync is enabled)."),
      project_path: z.string().default("").describe("Absolute filesystem path of the project this memory belongs to. Empty string defaults to the server's current working directory."),
      tags: z.array(z.string()).default([]).describe("Free-form tag list, e.g. `[\"auth\", \"oauth2\"]`. Project policies may require certain tags or ban others."),
      importance: z.number().min(0).max(1).default(0.5).describe("Importance score in [0, 1]. Higher values rank earlier in search and survive pruning longer. Default 0.5."),
      supersedes_id: z.string().default("").describe("Optional id of an older memory that this one replaces. The older memory is marked superseded and de-prioritised in search."),
      pin: z.boolean().default(false).describe("If true, pin the memory so it is exempt from automatic pruning and ranks higher."),
      persist_to_vault: z.boolean().optional().describe("If true, also write an Obsidian vault note. If omitted, the project's policy decides based on `memory_type`."),
      vault_mode: z.enum(["create", "create_or_update"]).default("create_or_update").describe("`create` fails if the note exists; `create_or_update` (default) overwrites an existing note with the same title."),
      vault_kind: z.string().default("").describe("Optional vault subtype (e.g. `architecture`, `runbook`) used to pick a folder per `vault.kindFolders` config."),
      vault_folder: z.string().default("").describe("Optional explicit vault subfolder, relative to the vault root. Overrides `vault_kind` routing."),
      vault_note_title: z.string().default("").describe("Optional override for the vault note title. Defaults to `title` when empty."),
      dedup: z.enum(["strict", "warn", "off"]).optional().describe("Per-call override for duplicate handling. Defaults to the server's `search.embeddings.dedupDefaultMode` when omitted."),
    },
    annotations: {
      title: "Store a memory",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryStore(memRepo, params, db, config, embRepo) }],
  })
);

server.registerTool(
  "memory_search",
  {
    title: "Search memories",
    description: [
      "Ranked full-text + decay-weighted search across the local memory store, optional file-memory sources, and (when configured) the Obsidian vault.",
      "Use the three-layer progressive-disclosure pattern to keep token costs low:",
      "  • `detail=\"index\"` (default, cheapest) — titles + scores only, ~30 tokens per result. Start here to triage candidates.",
      "  • `detail=\"summary\"` — title + short body preview, ~80 tokens per result. Use to shortlist.",
      "  • `detail=\"full\"` — full body, ~150-300 tokens per result. Use sparingly, ideally on a single id.",
      "Follow-ups: for chronological context around one hit, prefer `memory_timeline(id)` (~200 tokens per neighbour). For the full body of a known id, prefer `memory_get(id)` (~300-800 tokens).",
      "Read-only — no rows are modified. Records an analytics event when analytics are enabled.",
    ].join(" "),
    inputSchema: {
      query: z.string().min(1).describe("Free-text query. Tokenised by FTS5; phrases match individual terms. Examples: `\"oauth refresh\"`, `\"why we picked postgres\"`."),
      project_path: z.string().default("").describe("Optional absolute project path to scope results. Empty string searches across all projects (subject to scope rules)."),
      memory_type: z.string().default("").describe("Optional type filter, e.g. `decision`, `lesson`. Empty string returns all types."),
      limit: z.number().int().min(1).max(50).default(10).describe("Maximum number of results to return (1-50). Default 10."),
      detail: z.enum(["index", "summary", "full"]).default("index").describe("Disclosure level — `index` (cheapest), `summary`, or `full`. Always start at `index` and escalate only if needed."),
      include_file_memories: z.boolean().default(true).describe("If true (default), also search markdown memory files registered as sources. Set false to limit to SQLite + vault."),
    },
    annotations: {
      title: "Search memories",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemorySearch(memRepo, config, params, db, analyticsTracker) }],
  })
);

server.registerTool(
  "memory_get",
  {
    title: "Get full memory by id",
    description: [
      "Fetch the full body, tags, and metadata of a single memory by its id (~300-800 tokens). Read-only.",
      "Workflow: call `memory_search` first (with `detail=\"index\"`) to find the id, then call this for the full content.",
      "Privacy: substrings inside `<private>...</private>` tags are redacted by default. Pass `reveal_private=true` to unmask them; this emits an audit event when analytics are enabled.",
      "Returns a clear `not found` message if the id does not exist or has been soft-deleted.",
    ].join(" "),
    inputSchema: {
      memory_id: z.string().min(1).describe("The memory id, as returned by `memory_store` or shown in `memory_search` results (e.g. `mem_01HXYZ...`)."),
      reveal_private: z.boolean().default(false).describe("If true, include content inside `<private>` tags. Use only when explicitly necessary — emits an audit event."),
    },
    annotations: {
      title: "Get full memory by id",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryGet(memRepo, db, config, params) }],
  })
);

server.registerTool(
  "memory_timeline",
  {
    title: "List memories around an id (chronological)",
    description: [
      "Return the chronological neighbourhood of memories created around the given memory id — a cheap way to recover work-session context (~200 tokens per neighbour).",
      "Workflow: run `memory_search(detail=\"index\")` first to pick a hit, then call `memory_timeline(id)` to see what was being captured around the same time. Cheaper than calling `memory_get` on each neighbour.",
      "Read-only.",
    ].join(" "),
    inputSchema: {
      id: z.string().min(1).describe("The anchor memory id to centre the window on. Get this from `memory_search` or `memory_store`."),
      window: z.number().int().min(1).max(10).default(3).describe("Number of neighbours to return on each side (1-10). Default 3 → up to 6 neighbours total."),
      detail: z.enum(["index", "summary"]).default("summary").describe("Disclosure level — `index` (titles only) or `summary` (titles + short preview, default). `full` is intentionally not offered here; use `memory_get` for that."),
      same_session_only: z.boolean().default(true).describe("If true (default), only include neighbours captured in the same session as the anchor. Set false to span sessions."),
    },
    annotations: {
      title: "List memories around an id (chronological)",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryTimeline(memRepo, params) }],
  })
);

server.registerTool(
  "memory_dedup_check",
  {
    title: "Check for near-duplicate memories",
    description: [
      "Cheap pre-flight (~50 tokens per match) that asks: \"if I were to store this content, would it duplicate something I already have?\"",
      "Returns up to `limit` existing memories whose cosine similarity to the candidate text is above the threshold, sorted by similarity descending.",
      "Use before `memory_store` when you suspect overlap, or before bulk imports. If embeddings are disabled in config, returns a clear no-op message — it does not silently skip the check.",
      "Read-only — no rows are written. Computing the candidate embedding may make an outbound call to the embeddings provider (OpenAI, Ollama, etc.) when one is configured.",
    ].join(" "),
    inputSchema: {
      content: z.string().min(1).describe("Candidate memory body to check, exactly as you would pass to `memory_store`."),
      title: z.string().optional().describe("Optional candidate title; concatenated with `content` to match how `memory_store` builds its embedding."),
      project_path: z.string().optional().describe("Optional absolute project path to scope the search to a single project's memories."),
      threshold: z.number().min(0).max(1).optional().describe("Cosine similarity threshold in [0, 1]. Defaults to `search.embeddings.dedupThreshold` from config (typically ~0.85)."),
      limit: z.number().int().min(1).max(20).default(5).describe("Maximum number of matches to return (1-20). Default 5."),
    },
    annotations: {
      title: "Check for near-duplicate memories",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryDedupCheck(db, memRepo, embRepo, dedupProvider, config, params) }]
  })
);

server.registerTool(
  "memory_list",
  {
    title: "List memories (no query)",
    description: [
      "Browse stored memories with optional filters — use this when you want to enumerate by type/scope/project rather than run a search query.",
      "Differs from `memory_search`: there is no text query and ordering is by recency/importance rather than relevance. Prefer `memory_search` whenever you have keywords.",
      "Use the same `detail` progressive-disclosure levels as `memory_search` to control token cost.",
      "Read-only.",
    ].join(" "),
    inputSchema: {
      project_path: z.string().default("").describe("Optional absolute project path filter. Empty string lists across all projects."),
      memory_type: z.string().default("").describe("Optional type filter (e.g. `decision`). Empty string returns all types."),
      scope: z.string().default("").describe("Optional scope filter — `project`, `global`, or `team`. Empty string returns all scopes."),
      pinned_only: z.boolean().default(false).describe("If true, only return pinned memories."),
      limit: z.number().int().min(1).max(200).default(20).describe("Maximum number of memories to return (1-200). Default 20."),
      detail: z.enum(["index", "summary", "full"]).default("full").describe("Disclosure level — `index` (cheapest), `summary`, or `full` (default). Drop to `index` when listing many rows to keep token cost down."),
      include_file_memories: z.boolean().default(false).describe("If true, also include markdown file-memory sources. Off by default since lists are usually about SQLite-backed memories."),
      vault_kind: z.string().default("").describe("Optional vault subtype filter when listing vault notes."),
      vault_folder: z.string().default("").describe("Optional vault subfolder filter (relative to vault root)."),
    },
    annotations: {
      title: "List memories (no query)",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryList(memRepo, config, params, db) }],
  })
);

server.registerTool(
  "memory_delete",
  {
    title: "Delete a memory (soft)",
    description: [
      "Soft-delete a single memory by id. The row is marked deleted (and excluded from search/list/get) but is retained in the database for audit and recovery.",
      "Use when a memory is wrong, obsolete, or accidental. To replace one memory with a corrected version, prefer `memory_store(supersedes_id=...)` instead so the history is linked.",
      "Idempotent: deleting an already-deleted id returns a clear message and is a no-op.",
    ].join(" "),
    inputSchema: {
      memory_id: z.string().min(1).describe("Id of the memory to soft-delete (e.g. `mem_01HXYZ...`)."),
    },
    annotations: {
      title: "Delete a memory (soft)",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryDelete(memRepo, params) }],
  })
);

server.registerTool(
  "decisions_log",
  {
    title: "Architectural decision log",
    description: [
      "Multi-action endpoint for the project's architectural decision record (ADR) log. Pick one of the following via `action`:",
      "  • `store` — record a new decision; requires `title` and `body` (and optionally `supersedes_id` to mark a previous decision as superseded).",
      "  • `list` — list recent decisions; respects `limit`.",
      "  • `search` — full-text search over decisions; requires `query`.",
      "Decisions are higher-importance by default than free-form memories and are intended to outlive normal pruning. Use `pitfalls_log` for recurring problems instead of decisions.",
      "Side effects: `store` writes to the decisions table (and links a `supersedes` edge when `supersedes_id` is provided). `list` and `search` are read-only.",
    ].join(" "),
    inputSchema: {
      action: z.enum(["store", "list", "search"]).describe("Which sub-operation to perform: `store`, `list`, or `search`."),
      project_path: z.string().describe("Absolute project path the decision belongs to (or to scope `list`/`search`). Required."),
      title: z.string().default("").describe("Decision title (required for `store`, ignored otherwise). One short line — e.g. `\"Use Postgres over MySQL\"`."),
      body: z.string().default("").describe("Decision body in markdown (required for `store`). Should explain context, options considered, and rationale."),
      category: z.string().default("general").describe("Free-form category tag for filtering, e.g. `architecture`, `infra`, `process`. Default `general`."),
      importance: z.number().min(0).max(1).default(0.7).describe("Importance score in [0, 1] for `store`. Default 0.7 — decisions outrank typical facts (0.5)."),
      supersedes_id: z.string().default("").describe("For `store`: optional id of an earlier decision this one replaces. The older decision is marked superseded."),
      query: z.string().default("").describe("Search text (required for `action=\"search\"`). Tokenised by FTS5."),
      limit: z.number().int().min(1).max(50).default(10).describe("Maximum rows to return for `list`/`search` (1-50). Default 10."),
    },
    annotations: {
      title: "Architectural decision log",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleDecisionsLog(decRepo, params) }],
  })
);

server.registerTool(
  "pitfalls_log",
  {
    title: "Recurring pitfalls log",
    description: [
      "Multi-action endpoint for tracking recurring problems and their resolutions. Pick one via `action`:",
      "  • `store` — record a new pitfall; requires `title` and `body` describing the symptom and the fix.",
      "  • `list` — list open pitfalls (or all when `include_resolved=true`).",
      "  • `resolve` — mark a pitfall as resolved; requires `pitfall_id`.",
      "Use this instead of `memory_store` when something keeps biting and you want a dedicated, queryable log of \"problem → resolution\" pairs. For one-off design choices, use `decisions_log`.",
      "Side effects: `store` and `resolve` write to the pitfalls table; `list` is read-only.",
    ].join(" "),
    inputSchema: {
      action: z.enum(["store", "list", "resolve"]).describe("Which sub-operation to perform: `store`, `list`, or `resolve`."),
      project_path: z.string().describe("Absolute project path the pitfall belongs to (or to scope `list`). Required."),
      title: z.string().default("").describe("Short symptom title (required for `store`). E.g. `\"esbuild fails on M1 when using esm + node-gyp\"`."),
      body: z.string().default("").describe("Markdown body (required for `store`). Should describe the problem and the resolution / workaround."),
      importance: z.number().min(0).max(1).default(0.6).describe("Importance score in [0, 1] for `store`. Default 0.6."),
      limit: z.number().int().min(1).max(50).default(10).describe("Maximum pitfalls to return for `list` (1-50). Default 10."),
      include_resolved: z.boolean().default(false).describe("For `list`: if true, also include resolved pitfalls. Default false (open only)."),
      pitfall_id: z.string().default("").describe("Required for `action=\"resolve\"` — the id of the pitfall to mark resolved."),
    },
    annotations: {
      title: "Recurring pitfalls log",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handlePitfallsLog(pitRepo, params) }],
  })
);

server.registerTool(
  "memory_analytics",
  {
    title: "Memory effectiveness analytics",
    description: [
      "Report on how the memory system is performing: utility rates of injected memories, token costs of search layers, auto-capture statistics, compression activity, and prune suggestions.",
      "Use to tune importance thresholds, find dead memories worth pruning, and verify that auto-capture/compression are pulling their weight.",
      "Read-only. Returns an empty/no-op-style report when analytics are disabled in config.",
    ].join(" "),
    inputSchema: {
      period: z.enum(["last_24h", "last_7d", "last_30d", "all"]).default("last_7d").describe("Time window to summarise. `all` covers the full retention period configured in `analytics.retentionDays`."),
      section: z.enum(["all", "injections", "captures", "compression", "memories"]).default("all").describe("Which sub-report to render — `injections` (utility), `captures` (auto-capture), `compression`, `memories` (prune suggestions), or `all` (default)."),
      project_path: z.string().default("").describe("Optional absolute project path to scope the report. Empty string aggregates across all projects."),
    },
    annotations: {
      title: "Memory effectiveness analytics",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryAnalytics(db, params) }],
  })
);

server.registerTool(
  "memory_update",
  {
    title: "Update a memory in place",
    description: [
      "Edit a single memory in place. Only the fields you pass are changed; omitted fields are left untouched.",
      "Editable fields: `title`, `content`, `tags`, `importance`, `memory_type`, `pinned`. Side effects when the textual content changes: the embedding is re-queued and dedup may run.",
      "Prefer `memory_store(supersedes_id=...)` instead of in-place edits when the change is significant enough that you'd want history (e.g. a reversed decision). Use this tool for typo fixes, retagging, importance tuning, and similar minor edits.",
      "Returns a clear `not found` message if the id does not exist.",
    ].join(" "),
    inputSchema: {
      memory_id: z.string().min(1).describe("Id of the memory to update (e.g. `mem_01HXYZ...`)."),
      title: z.string().optional().describe("New title (single line). Omit to leave unchanged."),
      content: z.string().optional().describe("New body in markdown. Omit to leave unchanged. When changed, the embedding is re-computed asynchronously."),
      tags: z.array(z.string()).optional().describe("Replacement tag list. Omit to leave unchanged. Pass `[]` to clear all tags."),
      importance: z.number().min(0).max(1).optional().describe("New importance score in [0, 1]. Omit to leave unchanged."),
      memory_type: z.string().optional().describe("New memory_type (e.g. `fact`, `decision`). Omit to leave unchanged."),
      pinned: z.boolean().optional().describe("New pinned state. Omit to leave unchanged. Equivalent to calling `memory_pin` separately."),
      dedup: z.enum(["strict", "warn", "off"]).optional().describe("Per-call override for duplicate handling when `content` changes. Mirrors `memory_store.dedup`."),
    },
    annotations: {
      title: "Update a memory in place",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryUpdate(memRepo, params, config, embRepo) }],
  })
);

server.registerTool(
  "memory_pin",
  {
    title: "Pin or unpin a memory",
    description: [
      "Toggle the pinned flag on a memory. Pinned memories are exempt from automatic pruning and rank higher in search.",
      "Use sparingly — pinning everything defeats the purpose. Reserve pins for canonical decisions, user preferences, and high-leverage facts you want to survive even long retention windows.",
      "Idempotent: pinning an already-pinned memory (or unpinning an already-unpinned one) is a no-op.",
    ].join(" "),
    inputSchema: {
      memory_id: z.string().min(1).describe("Id of the memory to pin or unpin."),
      pinned: z.boolean().default(true).describe("`true` (default) to pin, `false` to unpin."),
    },
    annotations: {
      title: "Pin or unpin a memory",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryPin(memRepo, params) }],
  })
);

server.registerTool(
  "memory_compress",
  {
    title: "Run the compression pipeline now",
    description: [
      "Run an on-demand compression cycle: cluster similar memories by embedding similarity, merge each cluster into a single canonical memory, and mark the originals as compressed.",
      "Normally compression runs automatically on the maintenance schedule. Call this tool when you want to force a pass — e.g. right after a bulk import, or to sanity-check compression behaviour.",
      "Side effects: writes new merged memories and updates the originals' `compressed_into` pointer. Requires `compression.enabled=true` in config; otherwise returns a clear no-op message. May call the configured embeddings + LLM providers.",
      "Returns a summary of how many clusters were compressed in each project.",
    ].join(" "),
    inputSchema: {
      project_path: z.string().default("").describe("Absolute project path to compress. Empty string (default) compresses every project."),
    },
    annotations: {
      title: "Run the compression pipeline now",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryCompress(db, config, params) }],
  })
);

server.registerTool(
  "memory_export",
  {
    title: "Export memories as JSON",
    description: [
      "Export memories, decisions, and pitfalls as a portable JSON document, suitable for backup, transfer to another machine, or import into another memento-mcp instance via `memory_import`.",
      "Use before any destructive maintenance (bulk delete, schema migration) so you have a clean restore point. The export includes scope, tags, importance, and supersession links so a round-trip preserves structure.",
      "Read-only — does not modify any rows. Returns the JSON inline in the tool response.",
    ].join(" "),
    inputSchema: {
      project_path: z.string().default("").describe("Absolute project path to export. Empty string (default) exports memories across all projects."),
    },
    annotations: {
      title: "Export memories as JSON",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryExport(db, params) }],
  })
);

server.registerTool(
  "memory_import",
  {
    title: "Import memories from JSON",
    description: [
      "Import memories, decisions, and pitfalls from a JSON file previously produced by `memory_export`. The file must be readable from the path given (server-local filesystem, not a URL).",
      "Conflict handling via `strategy`:",
      "  • `skip` (default) — keep existing rows when ids collide; only insert missing ones. Safe to re-run.",
      "  • `overwrite` — replace existing rows on id collisions. Use for authoritative restores.",
      "Side effects: inserts/updates rows in `memories`, `decisions`, and `pitfalls`. Embeddings are queued asynchronously after import.",
      "Returns counts of rows inserted, updated, and skipped.",
    ].join(" "),
    inputSchema: {
      path: z.string().min(1).describe("Absolute path on the server's filesystem to a JSON file produced by `memory_export` (e.g. `/tmp/memento-backup.json`)."),
      strategy: z.enum(["skip", "overwrite"]).default("skip").describe("`skip` (default) preserves existing rows on id collision; `overwrite` replaces them."),
    },
    annotations: {
      title: "Import memories from JSON",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryImport(db, params) }],
  })
);

const edgeTypeEnum = z.enum(["relates_to", "supersedes", "caused_by", "mitigated_by", "references", "implements"]);

server.registerTool(
  "memory_link",
  {
    title: "Link two memories with a typed edge",
    description: [
      "Create a typed directed edge from one memory to another in the knowledge graph. Use the resulting graph to map dependencies, supersession chains, cause/effect, and references.",
      "Supported edge types: `relates_to`, `supersedes`, `caused_by`, `mitigated_by`, `references`, `implements`.",
      "Workflow: call `memory_search` (or `memory_list`) first to find the two ids, then `memory_link` to connect them. Re-linking the same `(from_id, to_id, edge_type)` triple updates its weight rather than creating a duplicate.",
      "Side effects: writes a row to the edges table.",
    ].join(" "),
    inputSchema: {
      from_id: z.string().min(1).describe("Source memory id (the edge points outward from this memory)."),
      to_id: z.string().min(1).describe("Target memory id."),
      edge_type: edgeTypeEnum.describe("Relationship type. `supersedes` is the same notion used by `memory_store.supersedes_id`."),
      weight: z.number().min(0).max(1).default(1.0).describe("Edge strength in [0, 1]. Default 1.0. Lower values can be used to weaken weak \"relates_to\" hints."),
    },
    annotations: {
      title: "Link two memories with a typed edge",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryLink(memRepo, edgesRepo, params) }],
  })
);

server.registerTool(
  "memory_unlink",
  {
    title: "Remove an edge between two memories",
    description: [
      "Remove a previously created edge from the knowledge graph. You must pass the exact `(from_id, to_id, edge_type)` triple used when the edge was created — `memory_unlink` does not remove arbitrary or wildcard edges.",
      "Idempotent: removing a non-existent edge returns a clear message and is a no-op.",
      "Use this to retract incorrect links; for retracting an entire memory, prefer `memory_delete` (which leaves the audit trail intact).",
    ].join(" "),
    inputSchema: {
      from_id: z.string().min(1).describe("Source memory id of the edge to remove."),
      to_id: z.string().min(1).describe("Target memory id of the edge to remove."),
      edge_type: edgeTypeEnum.describe("Edge type that was used when the edge was created. Must match exactly."),
    },
    annotations: {
      title: "Remove an edge between two memories",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryUnlink(edgesRepo, params) }],
  })
);

server.registerTool(
  "memory_graph",
  {
    title: "Explore the knowledge graph around a memory",
    description: [
      "Breadth-first walk of the knowledge graph rooted at one memory id. Returns the root plus its neighbour nodes (titles + ids) and the typed edges between them.",
      "Use to map related concepts, surface supersession chains, or visualise the cluster around a decision. Chain pattern: `memory_search` → `memory_graph` to expand the most relevant hit.",
      "Direction control: `out` follows outgoing edges only, `in` follows incoming, `both` (default) follows all.",
      "Depth 0 returns just the root node; max depth is 5 to keep results bounded. Read-only.",
    ].join(" "),
    inputSchema: {
      id: z.string().min(1).describe("Memory id to use as the root of the BFS walk."),
      depth: z.number().int().min(0).max(5).default(2).describe("How many hops to traverse from the root (0-5). Default 2."),
      edge_types: z.array(edgeTypeEnum).optional().describe("Optional whitelist of edge types to follow. Omit to follow all types."),
      direction: z.enum(["out", "in", "both"]).default("both").describe("`out` follows outgoing edges only, `in` incoming only, `both` (default) follows all."),
    },
    annotations: {
      title: "Explore the knowledge graph around a memory",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryGraph(memRepo, edgesRepo, params) }],
  })
);

server.registerTool(
  "memory_path",
  {
    title: "Shortest path between two memories",
    description: [
      "Find the shortest path (smallest number of hops) between two memories in the knowledge graph using BFS. Returns the chain of memory ids and the edge types that connect them, or a clear `no path` message.",
      "Use to trace cause-effect chains, supersession history, or dependency lineage. Chain pattern: `memory_search` → `memory_path` once you know both endpoints.",
      "Read-only.",
    ].join(" "),
    inputSchema: {
      from_id: z.string().min(1).describe("Starting memory id."),
      to_id: z.string().min(1).describe("Destination memory id."),
      max_hops: z.number().int().min(1).max(10).default(4).describe("Maximum BFS depth (1-10). Default 4. Returns `no path` if the destination is further than `max_hops` from the start."),
      edge_types: z.array(edgeTypeEnum).optional().describe("Optional whitelist of edge types to follow. Omit to allow all types."),
    },
    annotations: {
      title: "Shortest path between two memories",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryPath(memRepo, edgesRepo, params) }],
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
