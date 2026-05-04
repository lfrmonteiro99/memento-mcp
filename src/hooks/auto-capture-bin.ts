#!/usr/bin/env node
// src/hooks/auto-capture-bin.ts
// Claude Code hook binary for auto-capture (K1 utility-signal detection in Task 13b).
// Registered as a PostToolUse hook in .claude/settings.json:
//   { "hooks": { "PostToolUse": [{ "matcher": "", "hooks": [{ "type": "command", "command": "memento-hook-capture" }] }] } }
//
// Reads a PostToolUse event JSON from stdin, runs the auto-capture pipeline,
// then exits. No MCP server involvement.
//
// K7: This binary is dist/hooks/auto-capture-bin.js → registered as "memento-hook-capture".
//     v1 bins (memento-hook-search, memento-hook-session) are unaffected.

import { createDatabase } from "../db/database.js";
import { MemoriesRepo } from "../db/memories.js";
import { AnalyticsTracker } from "../analytics/tracker.js";
import { loadConfig, getDefaultConfigPath, getDefaultDbPath } from "../lib/config.js";
import { processAutoCapture, AutoCaptureConfig } from "./auto-capture.js";
import { stringifyToolResponse, scrubSecrets } from "../engine/text-utils.js";
import { processUtilitySignals } from "./utility-signal.js";
import { processAnchorStaleness } from "./anchor-staleness.js";

async function main(): Promise<void> {
  // Read the PostToolUse event from stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) process.exit(0);

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(raw);
  } catch {
    // Not valid JSON — exit silently (non-matching hook events)
    process.exit(0);
  }

  const dbPath = process.env.MEMENTO_DB_PATH ?? getDefaultDbPath();
  const configPath = process.env.MEMENTO_CONFIG_PATH ?? getDefaultConfigPath();

  const rawConfig = loadConfig(configPath);

  // R1: hooks are short-lived; give writer-lock plenty of time to succeed.
  const db = createDatabase(dbPath);
  db.pragma("busy_timeout = 30000");

  const memRepo = new MemoriesRepo(db);
  const tracker = new AnalyticsTracker(db, { flushThreshold: 20 });

  try {
    // K2 — Narrow tool_response (N2).
    // N2: if string, use as-is; if object, stringify via per-tool extractor; otherwise skip.
    const rawResp = event.tool_response;
    let toolResponseText = "";
    if (typeof rawResp === "string") {
      toolResponseText = rawResp;
    } else if (rawResp !== null && rawResp !== undefined && typeof rawResp === "object") {
      toolResponseText = stringifyToolResponse(rawResp);
    } else {
      // null/undefined/number/other → no classifiable text; skip classification.
      toolResponseText = "";
    }

    // G2: scrub secrets BEFORE anything else touches the text.
    toolResponseText = scrubSecrets(toolResponseText);

    // K2 — Resolve cwd → project_id (UUID). Claude Code does not send project_id.
    const cwd = typeof event.cwd === "string" ? event.cwd : "";
    const projectId = cwd ? memRepo.ensureProject(cwd) : undefined;

    const sessionId = String(event.session_id ?? "unknown");
    const toolName = String(event.tool_name ?? "");
    const toolInput = (event.tool_input ?? {}) as Record<string, unknown>;

    // Build auto-capture config from loaded config (with safe defaults for v1 configs
    // that don't yet have [auto_capture] section).
    const acRaw = (rawConfig as any).autoCapture;
    const autoCaptureConfig: AutoCaptureConfig = {
      enabled: acRaw?.enabled !== false, // default: enabled
      min_output_length: acRaw?.minOutputLength ?? 200,
      max_output_length: acRaw?.maxOutputLength ?? 50000,
      cooldown_seconds: acRaw?.cooldownSeconds ?? 30,
      dedup_similarity_threshold: acRaw?.dedupSimilarityThreshold ?? 0.7,
      max_per_session: acRaw?.maxPerSession ?? 20,
      default_importance: acRaw?.defaultImportance ?? 0.3,
      tools: acRaw?.tools ?? ["Bash", "Read", "Grep", "Edit", "Write", "WebSearch", "WebFetch", "Glob"],
      session_timeout_seconds: acRaw?.sessionTimeoutSeconds ?? 3600,
    };

    // Pipeline 1: auto-capture. Skip silently if disabled or no text.
    if (autoCaptureConfig.enabled && toolResponseText.length > 0) {
      processAutoCapture(db, memRepo, {
        tool_name: toolName,
        tool_input: toolInput,
        tool_response_text: toolResponseText,
        session_id: sessionId,
        project_id: projectId,
      }, autoCaptureConfig);
    }

    // Pipeline 2: utility-signal detection (K1).
    // Runs unconditionally on every PostToolUse event — the ignored sweep and open-injection
    // query are cheap SQL ops; skip is fine if there are no injection events in the session.
    processUtilitySignals(db, tracker, {
      session_id: sessionId,
      tool_name: toolName,
      tool_input: toolInput,
      tool_response_text: toolResponseText,
      utility_window_minutes: (rawConfig as any).adaptive?.utility_window_minutes ?? 10,
    });

    // Pipeline 3 (P4 Task 8): opt-in anchor-staleness check.
    // OFF by default — `processAnchorStaleness` is a no-op when enabled=false.
    const filePath = typeof toolInput.file_path === "string" ? toolInput.file_path : undefined;
    processAnchorStaleness(db, {
      enabled: rawConfig.anchorStaleness?.enabled === true,
      cwd,
      toolName,
      filePath,
    });
  } finally {
    // R2: flush analytics before exit so no events are lost to SIGKILL.
    try { tracker.flush(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
  }

  process.exit(0);
}

main().catch(() => process.exit(0)); // Never crash the hook — Claude Code will show errors
