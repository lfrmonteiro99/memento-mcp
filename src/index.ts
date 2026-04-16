import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createDatabase } from "./db/database.js";
import { MemoriesRepo } from "./db/memories.js";
import { DecisionsRepo } from "./db/decisions.js";
import { PitfallsRepo } from "./db/pitfalls.js";
import { SessionsRepo } from "./db/sessions.js";
import { loadConfig, getDefaultConfigPath, getDefaultDbPath } from "./lib/config.js";
import { createLogger, logLevelFromEnv } from "./lib/logger.js";
import { handleMemoryStore } from "./tools/memory-store.js";
import { handleMemorySearch } from "./tools/memory-search.js";
import { handleMemoryGet } from "./tools/memory-get.js";
import { handleMemoryList } from "./tools/memory-list.js";
import { handleMemoryDelete } from "./tools/memory-delete.js";
import { handleDecisionsLog } from "./tools/decisions-log.js";
import { handlePitfallsLog } from "./tools/pitfalls-log.js";

const log = createLogger(logLevelFromEnv());
const config = loadConfig(getDefaultConfigPath());
const db = createDatabase(config.database.path || getDefaultDbPath());
const memRepo = new MemoriesRepo(db);
const decRepo = new DecisionsRepo(db);
const pitRepo = new PitfallsRepo(db);
const sessRepo = new SessionsRepo(db);

// Initial prune
const pruned = memRepo.pruneStale(config.pruning.maxAgeDays, config.pruning.minImportance);
if (pruned > 0) log.info(`Pruned ${pruned} stale memories`);

// Pruning interval
let pruneTimer: ReturnType<typeof setInterval> | undefined;
if (config.pruning.enabled) {
  pruneTimer = setInterval(() => {
    try {
      const n = memRepo.pruneStale(config.pruning.maxAgeDays, config.pruning.minImportance);
      if (n > 0) log.info(`Pruned ${n} stale memories`);
    } catch (e) {
      log.warn(`Pruning error: ${e}`);
    }
  }, config.pruning.intervalHours * 3_600_000);
  // Unref so the interval doesn't keep the process alive on its own
  pruneTimer.unref?.();
}

// Graceful shutdown
function shutdown(): void {
  if (pruneTimer) clearInterval(pruneTimer);
  try { db.close(); } catch { /* ignore */ }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

const server = new McpServer({ name: "memento-mcp", version: "1.0.0" });

server.tool(
  "memory_store",
  "Store a memory. Types: fact, decision, preference, pattern, architecture, pitfall. Scope: project or global. Pin to protect from pruning. Use supersedes_id to replace an existing memory.",
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
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryStore(memRepo, params) }],
  })
);

server.tool(
  "memory_search",
  "Search memories using full-text search. detail='index': titles + scores only (~30 tokens/result). detail='full': titles + body preview (~120 tokens/result). Use memory_get(id) for complete body.",
  {
    query: z.string(),
    project_path: z.string().default(""),
    memory_type: z.string().default(""),
    limit: z.number().default(10),
    detail: z.enum(["index", "full"]).default("full"),
    include_file_memories: z.boolean().default(true),
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemorySearch(memRepo, config, params) }],
  })
);

server.tool(
  "memory_get",
  "Retrieve full content of a specific memory by ID. Use after memory_search(detail='index') to get complete body.",
  {
    memory_id: z.string(),
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryGet(memRepo, params) }],
  })
);

server.tool(
  "memory_list",
  "List memories with optional filters. No search query needed.",
  {
    project_path: z.string().default(""),
    memory_type: z.string().default(""),
    scope: z.string().default(""),
    pinned_only: z.boolean().default(false),
    limit: z.number().default(20),
    detail: z.enum(["index", "full"]).default("full"),
    include_file_memories: z.boolean().default(false),
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryList(memRepo, config, params) }],
  })
);

server.tool(
  "memory_delete",
  "Soft-delete a memory by ID. Only works for SQLite memories (not file-based).",
  {
    memory_id: z.string(),
  },
  async (params) => ({
    content: [{ type: "text" as const, text: await handleMemoryDelete(memRepo, params) }],
  })
);

server.tool(
  "decisions_log",
  "Log, list, or search architectural decisions. action: 'store' (title+body), 'list', 'search' (query). Categories: general, architecture, tooling, convention, performance.",
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
  "Track recurring problems. action: 'store' (title+body, auto-increments on duplicate), 'list' (unresolved by default), 'resolve' (pitfall_id).",
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

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("memento-mcp server started");
}

main().catch((e) => {
  log.error(`Fatal: ${e}`);
  process.exit(1);
});

