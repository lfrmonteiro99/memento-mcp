// src/hooks/auto-capture.ts
// Core auto-capture logic — reusable, testable without stdin.
// Called by auto-capture-bin.ts (the Claude Code PostToolUse hook binary).

import type Database from "better-sqlite3";
import type { MemoriesRepo } from "../db/memories.js";
import { classify } from "../engine/classifier.js";
import { isDuplicate, CooldownTracker } from "../engine/dedup.js";
import { computeQualityScore, countSignalMarkers } from "./quality-score.js";

export interface AutoCaptureConfig {
  enabled: boolean;
  min_output_length: number;
  max_output_length: number;
  cooldown_seconds: number;
  dedup_similarity_threshold: number;
  max_per_session: number;
  default_importance: number;
  tools: string[];
  session_timeout_seconds: number; // C5: used for TTL eviction
}

export interface AutoCaptureInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  /** K2: flattened text form of tool_response (object → string via stringifyToolResponse). */
  tool_response_text: string;
  session_id: string;
  project_id?: string; // I3: passed to isDuplicate for project-scoped dedup
  claude_session_id?: string; // Issue #3: Claude Code session ID for linking memories to sessions
}

export interface AutoCaptureResult {
  captured: boolean;
  memoryId?: string;
  reason?: string;
}

interface TrackerEntry {
  tracker: CooldownTracker;
  lastUsed: number; // epoch ms
}

// C5: Per-session state (keyed by session_id) with TTL-based eviction.
// Max 100 sessions; oldest evicted when limit exceeded.
const MAX_SESSION_TRACKERS = 100;
const sessionTrackers = new Map<string, TrackerEntry>();

function evictOldestIfNeeded(): void {
  if (sessionTrackers.size < MAX_SESSION_TRACKERS) return;
  // Find the entry with the smallest lastUsed timestamp
  let oldestKey: string | undefined;
  let oldestTime = Infinity;
  for (const [key, entry] of sessionTrackers) {
    if (entry.lastUsed < oldestTime) {
      oldestTime = entry.lastUsed;
      oldestKey = key;
    }
  }
  if (oldestKey) sessionTrackers.delete(oldestKey);
}

function getTracker(sessionId: string, config: AutoCaptureConfig): CooldownTracker {
  const now = Date.now();

  // C5: Evict entries whose session timeout has expired
  for (const [key, entry] of sessionTrackers) {
    if ((now - entry.lastUsed) > config.session_timeout_seconds * 1000) {
      sessionTrackers.delete(key);
    }
  }

  let entry = sessionTrackers.get(sessionId);
  if (!entry) {
    evictOldestIfNeeded();
    entry = {
      tracker: new CooldownTracker(config.cooldown_seconds, config.max_per_session),
      lastUsed: now,
    };
    sessionTrackers.set(sessionId, entry);
  }
  entry.lastUsed = now;
  return entry.tracker;
}

export function processAutoCapture(
  db: Database.Database,
  memRepo: MemoriesRepo,
  input: AutoCaptureInput,
  config: AutoCaptureConfig
): AutoCaptureResult {
  if (!config.enabled) {
    return { captured: false, reason: "auto-capture disabled" };
  }

  if (!config.tools.includes(input.tool_name)) {
    return { captured: false, reason: `tool '${input.tool_name}' not in capture list` };
  }

  const tracker = getTracker(input.session_id, config);

  if (tracker.hasReachedMaxCaptures()) {
    return { captured: false, reason: "max captures reached for session" };
  }

  const cooldownKey = `${input.tool_name}:${String(
    input.tool_input.command ?? input.tool_input.file_path ?? input.tool_input.pattern ?? "default"
  )}`;
  if (tracker.isOnCooldown(cooldownKey)) {
    return { captured: false, reason: "cooldown active" };
  }

  // Classify. K2: classifier receives the already-flattened text string.
  // G2: text has already been scrubbed by the bin entry point (scrubSecrets()).
  // classifier.ts also calls scrubSecrets internally for defense in depth.
  const decision = classify({
    tool_name: input.tool_name,
    tool_input: input.tool_input,
    tool_output: input.tool_response_text, // classifier's internal field name is tool_output
  }, {
    min_output_length: config.min_output_length,
    max_output_length: config.max_output_length,
    cooldown_seconds: config.cooldown_seconds,
    dedup_similarity_threshold: config.dedup_similarity_threshold,
  });

  if (decision.action === "skip" || !decision.memory) {
    return { captured: false, reason: decision.reason };
  }

  // Dedup check — pass project_id so dedup is scoped to this project (I3)
  const dupCheck = isDuplicate(db, {
    title: decision.memory.title,
    body: decision.memory.body,
    projectId: input.project_id,
  }, config.dedup_similarity_threshold);

  if (dupCheck.duplicate) {
    return { captured: false, reason: `duplicate of memory ${dupCheck.mergeTargetId}` };
  }

  // P0 Task 4: heuristic quality score used by compressor (Task 6) to prune noise.
  // classifier.ts has no `confidence` field; importance_score is its 0..1 strength proxy.
  const qualityScore = computeQualityScore({
    text: input.tool_response_text,
    classifierConfidence: decision.memory.importance_score,
    signalCount: countSignalMarkers(input.tool_response_text),
  });

  // M5: Pass source directly to store() — no two-step INSERT+UPDATE.
  // Also thread projectId through so the memory is scoped correctly (K2/I3).
  // Issue #3: propagate claude_session_id so memories are linked to their session.
  const memoryId = memRepo.store({
    title: decision.memory.title,
    body: decision.memory.body,
    memoryType: decision.memory.memory_type,
    scope: "project",
    projectId: input.project_id,
    tags: decision.memory.tags,
    importance: decision.memory.importance_score,
    source: "auto-capture",
    claudeSessionId: input.claude_session_id,
    qualityScore,
  });

  tracker.record(cooldownKey);

  return { captured: true, memoryId };
}

/** Clean up session trackers (call on session end or for testing). */
export function clearSessionTracker(sessionId: string): void {
  sessionTrackers.delete(sessionId);
}
