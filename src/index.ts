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

/**
 * Wraps a string handler result into the shape the MCP SDK expects when an
 * `outputSchema` is declared. We always return both:
 *   • `content` (text)            — for clients that render plain text
 *   • `structuredContent.message` — validated against `outputSchema`
 * Tools opt into a richer outputSchema by defining their own shape.
 */
function textResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: { message },
  };
}

server.registerTool(
  "memory_store",
  {
    title: "Store a memory",
    description: [
      "Persist a fact, decision, lesson, or pattern so it can be recalled later by `memory_search`/`memory_get` or auto-injected into future sessions.",
      "Use for durable context (decisions, gotchas, preferences, recurring commands). For transient notes or duplicates, prefer `memory_dedup_check` first.",
      "Writes one SQLite row, queues an embedding (when enabled), and optionally creates/updates an Obsidian vault note. `dedup=\"strict\"` refuses duplicates, `\"warn\"` stores with a warning, `\"off\"` bypasses.",
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
    outputSchema: {
      message: z.string().describe("On success: `Memory stored with ID: <id>` (optionally followed by a vault-note path or a dedup `⚠` warning). On rejection: `Memory not stored: <reason>` explaining policy/dedup failure."),
    },
  },
  async (params) => textResult(await handleMemoryStore(memRepo, params, db, config, embRepo))
);

server.registerTool(
  "memory_search",
  {
    title: "Search memories",
    description: [
      "Ranked full-text + decay-weighted search across SQLite, file-memory sources, and (when configured) the Obsidian vault. Read-only.",
      "Use the three-layer progressive-disclosure pattern: `detail=\"index\"` (~30 tok/result, start here), `\"summary\"` (~80 tok), `\"full\"` (~150-300 tok, use sparingly).",
      "Follow-ups: `memory_timeline(id)` for chronological neighbours of one hit, `memory_get(id)` for one full body, `memory_graph(id)` to explore typed edges.",
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
    outputSchema: {
      message: z.string().describe("Markdown-formatted ranked results at the requested `detail` level. Empty result set is rendered as `No results found.` Vault hits, when present, are appended in a separate section."),
    },
  },
  async (params) => textResult(await handleMemorySearch(memRepo, config, params, db, analyticsTracker))
);

server.registerTool(
  "memory_get",
  {
    title: "Get full memory by id",
    description: [
      "Fetch the full body, tags, and metadata of one memory by id (~300-800 tokens). Read-only.",
      "Use after `memory_search(detail=\"index\")` to expand a single hit. Substrings inside `<private>` tags are redacted unless `reveal_private=true` (which emits an audit event).",
      "Returns `not found` if the id does not exist or has been soft-deleted.",
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
    outputSchema: {
      message: z.string().describe("Full memory rendered as markdown (title, metadata, body). Returns `Memory <id> not found.` when missing."),
    },
  },
  async (params) => textResult(await handleMemoryGet(memRepo, db, config, params))
);

server.registerTool(
  "memory_timeline",
  {
    title: "List memories around an id (chronological)",
    description: [
      "Return the chronological neighbourhood of memories around an anchor id (~200 tok/neighbour). Read-only.",
      "Use after `memory_search(detail=\"index\")` to recover work-session context for one hit. Cheaper than calling `memory_get` on each neighbour individually.",
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
    outputSchema: {
      message: z.string().describe("Markdown list of neighbour memories (anchor + window on each side) at the requested `detail` level. Returns `Memory <id> not found.` when the anchor is missing."),
    },
  },
  async (params) => textResult(await handleMemoryTimeline(memRepo, params))
);

server.registerTool(
  "memory_dedup_check",
  {
    title: "Check for near-duplicate memories",
    description: [
      "Cheap pre-flight (~50 tok/match): \"would storing this content duplicate something I already have?\" Read-only.",
      "Use before `memory_store` when overlap is likely, or before bulk imports. Returns up to `limit` existing memories with cosine similarity above the threshold (highest first).",
      "Computing the candidate embedding may make an outbound call to the configured provider (OpenAI, Ollama, etc.). If embeddings are disabled, returns a clear no-op message rather than silently passing.",
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
    outputSchema: {
      message: z.string().describe("Markdown list of near-duplicate matches with similarity scores, or `No near-duplicates found above threshold.` Returns a no-op message when embeddings are disabled in config."),
    },
  },
  async (params) => textResult(await handleMemoryDedupCheck(db, memRepo, embRepo, dedupProvider, config, params))
);

server.registerTool(
  "memory_list",
  {
    title: "List memories (no query)",
    description: [
      "Browse stored memories with optional filters — ordered by recency/importance. Read-only.",
      "Use to enumerate by type/scope/project. Prefer `memory_search` whenever you have keywords (relevance ranking). Use the same `detail` levels to control token cost.",
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
    outputSchema: {
      message: z.string().describe("Markdown-formatted list at the requested `detail` level, or `No memories found.` Vault notes appear in a separate section when included."),
    },
  },
  async (params) => textResult(await handleMemoryList(memRepo, config, params, db))
);

server.registerTool(
  "memory_delete",
  {
    title: "Delete a memory (soft)",
    description: [
      "Soft-delete a memory by id — the row is hidden from search/list/get but retained for audit. Idempotent.",
      "Use for accidental or obsolete memories. To replace one with a corrected version, prefer `memory_store(supersedes_id=...)` so history is linked.",
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
    outputSchema: {
      message: z.string().describe("`Memory <id> deleted.` on success, `Memory <id> not found.` when the id is missing."),
    },
  },
  async (params) => textResult(await handleMemoryDelete(memRepo, params))
);

server.registerTool(
  "decisions_log",
  {
    title: "Architectural decision log",
    description: [
      "Multi-action ADR log. Pick one via `action`:",
      "  • `store` — record a new decision (`title` + `body` required; `supersedes_id` optional). Writes a row.",
      "  • `list` — list recent decisions (read-only).",
      "  • `search` — FTS over decisions (`query` required, read-only).",
      "Decisions outrank free-form memories by default and survive pruning longer. Use `pitfalls_log` for recurring problems.",
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
    outputSchema: {
      message: z.string().describe("For `store`: `Decision stored with ID: <id>`. For `list`/`search`: markdown bullet list of decisions or `No decisions found.` Returns `Invalid action: ...` when `action` is unsupported."),
    },
  },
  async (params) => textResult(await handleDecisionsLog(decRepo, params))
);

server.registerTool(
  "pitfalls_log",
  {
    title: "Recurring pitfalls log",
    description: [
      "Multi-action log of recurring problems and their resolutions. Pick one via `action`:",
      "  • `store` — record a new pitfall (`title` + `body` required). Writes a row.",
      "  • `list` — list open pitfalls (set `include_resolved=true` for all). Read-only.",
      "  • `resolve` — mark a pitfall resolved (`pitfall_id` required).",
      "Use when something keeps biting and you want a queryable problem→resolution log. For one-off design choices, use `decisions_log`.",
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
    outputSchema: {
      message: z.string().describe("For `store`: `Pitfall logged/updated with ID: <id>`. For `list`: markdown list with `[RESOLVED]` or `[xN]` (occurrence count) prefixes, or `No pitfalls found.` For `resolve`: `Pitfall <id> marked as resolved.` or `Pitfall <id> not found.`"),
    },
  },
  async (params) => textResult(await handlePitfallsLog(pitRepo, params))
);

server.registerTool(
  "memory_analytics",
  {
    title: "Memory effectiveness analytics",
    description: [
      "Reports utility rates of injected memories, token costs per search layer, auto-capture stats, compression activity, and prune suggestions. Read-only.",
      "Use to tune importance thresholds, find dead memories worth pruning, and verify that auto-capture/compression are earning their keep. Returns a no-op message when analytics are disabled.",
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
    outputSchema: {
      message: z.string().describe("Markdown report grouped by `section` (`injections` / `captures` / `compression` / `memories`) with totals, percentages, and prune candidates. Returns a no-op message when analytics are disabled in config."),
    },
  },
  async (params) => textResult(await handleMemoryAnalytics(db, params))
);

server.registerTool(
  "memory_update",
  {
    title: "Update a memory in place",
    description: [
      "Edit a memory in place — only the fields you pass are changed. Editable: `title`, `content`, `tags`, `importance`, `memory_type`, `pinned`.",
      "Use for typo fixes, retagging, importance tuning. For meaningful changes you'd want history for (e.g. a reversed decision), prefer `memory_store(supersedes_id=...)` instead.",
      "Side effect: when `content` changes, the embedding is re-queued and dedup may run. Returns `not found` for missing ids.",
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
    outputSchema: {
      message: z.string().describe("`Memory <id> updated.` on success, `Memory <id> not found.` when missing, or a dedup-rejection sentence when `dedup=\"strict\"` blocks the change."),
    },
  },
  async (params) => textResult(await handleMemoryUpdate(memRepo, params, config, embRepo))
);

server.registerTool(
  "memory_pin",
  {
    title: "Pin or unpin a memory",
    description: [
      "Toggle the pinned flag — pinned memories survive pruning and rank higher in search. Idempotent.",
      "Use sparingly: reserve pins for canonical decisions, user preferences, and high-leverage facts. Pinning everything defeats the purpose.",
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
    outputSchema: {
      message: z.string().describe("`Memory <id> pinned.` / `Memory <id> unpinned.` on success, `Memory <id> not found.` when missing."),
    },
  },
  async (params) => textResult(await handleMemoryPin(memRepo, params))
);

server.registerTool(
  "memory_compress",
  {
    title: "Run the compression pipeline now",
    description: [
      "Force one compression cycle now: cluster similar memories by embedding similarity, merge each cluster into a canonical memory, and mark originals as compressed.",
      "Use after a bulk import or to sanity-check compression. Compression normally runs on the maintenance schedule.",
      "Side effects: writes merged memories, updates originals' `compressed_into` pointer, may call embeddings + LLM providers. Requires `compression.enabled=true`; otherwise returns a no-op message.",
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
    outputSchema: {
      message: z.string().describe("Summary line per project, e.g. `Compressed 3 cluster(s) in project <id>`, or `No clusters to compress.` Returns a no-op message when `compression.enabled=false`."),
    },
  },
  async (params) => textResult(await handleMemoryCompress(db, config, params))
);

server.registerTool(
  "memory_export",
  {
    title: "Export memories as JSON",
    description: [
      "Export memories, decisions, and pitfalls as a portable JSON document. Read-only.",
      "Use before destructive maintenance (bulk delete, schema migration) so you have a clean restore point, or to transfer state to another memento-mcp instance via `memory_import`. Includes scope, tags, importance, and supersession links so round-trip preserves structure.",
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
    outputSchema: {
      message: z.string().describe("JSON document (as a string) containing `memories`, `decisions`, and `pitfalls` arrays plus a `meta` object with export timestamp and scope."),
    },
  },
  async (params) => textResult(await handleMemoryExport(db, params))
);

server.registerTool(
  "memory_import",
  {
    title: "Import memories from JSON",
    description: [
      "Import memories, decisions, and pitfalls from a JSON file produced by `memory_export` (server-local path, not a URL).",
      "Conflict handling via `strategy`: `skip` (default, safe to re-run) keeps existing rows on id collision; `overwrite` replaces them — use for authoritative restores.",
      "Side effects: inserts/updates rows in `memories`, `decisions`, `pitfalls`. Embeddings are queued asynchronously.",
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
    outputSchema: {
      message: z.string().describe("Summary line with counts of rows inserted / updated / skipped per table (memories, decisions, pitfalls)."),
    },
  },
  async (params) => textResult(await handleMemoryImport(db, params))
);

const edgeTypeEnum = z.enum(["relates_to", "supersedes", "caused_by", "mitigated_by", "references", "implements"]);

server.registerTool(
  "memory_link",
  {
    title: "Link two memories with a typed edge",
    description: [
      "Create a typed directed edge between two memories. Edge types: `relates_to`, `supersedes`, `caused_by`, `mitigated_by`, `references`, `implements`.",
      "Use after `memory_search` to map dependencies, cause/effect, supersession chains, or references. Re-linking the same `(from_id, to_id, edge_type)` triple updates the weight (idempotent).",
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
    outputSchema: {
      message: z.string().describe("`Edge created/updated: <from> -[<edge_type>:<weight>]-> <to>` on success, or `Memory <id> not found.` when either endpoint is missing."),
    },
  },
  async (params) => textResult(await handleMemoryLink(memRepo, edgesRepo, params))
);

server.registerTool(
  "memory_unlink",
  {
    title: "Remove an edge between two memories",
    description: [
      "Remove a previously created edge — pass the exact `(from_id, to_id, edge_type)` triple used at creation time. No wildcards. Idempotent.",
      "Use to retract incorrect links. To retract a whole memory, prefer `memory_delete` (keeps audit trail).",
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
    outputSchema: {
      message: z.string().describe("`Edge removed: <from> -[<edge_type>]-> <to>` on success, or `Edge not found.` when the triple does not exist."),
    },
  },
  async (params) => textResult(await handleMemoryUnlink(edgesRepo, params))
);

server.registerTool(
  "memory_graph",
  {
    title: "Explore the knowledge graph around a memory",
    description: [
      "BFS walk from one memory id outward, returning neighbour nodes + typed edges. Read-only.",
      "Use after `memory_search` to map related concepts, supersession chains, or the cluster around a decision. `direction` controls edge polarity (`out`/`in`/`both`); depth is capped at 5.",
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
    outputSchema: {
      message: z.string().describe("Markdown rendering of the BFS frontier: root node + per-hop neighbours grouped by depth, each line showing edge type and target title. Returns `Memory <id> not found.` for a missing root."),
    },
  },
  async (params) => textResult(await handleMemoryGraph(memRepo, edgesRepo, params))
);

server.registerTool(
  "memory_path",
  {
    title: "Shortest path between two memories",
    description: [
      "BFS shortest path between two memories — returns the chain of ids + edge types, or a `no path` message when unreachable within `max_hops`. Read-only.",
      "Use after `memory_search` (with both endpoints known) to trace cause-effect chains, supersession history, or dependency lineage.",
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
    outputSchema: {
      message: z.string().describe("Path rendered as `<title-A> -[<edge_type>]-> <title-B> -[<edge_type>]-> ...` along with hop count, or `No path within <max_hops> hops.` Returns `Memory <id> not found.` when an endpoint is missing."),
    },
  },
  async (params) => textResult(await handleMemoryPath(memRepo, edgesRepo, params))
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
