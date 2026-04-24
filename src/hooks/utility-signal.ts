// src/hooks/utility-signal.ts
// K1 — Utility Signal Detector. Runs inside the SAME memento-hook-capture binary
// as auto-capture (NOT a separate process). Called on every PostToolUse event.
//
// Pipeline:
//   1. Ignored sweep: mark expired-window injections (no prior signal) as ignored.
//   2. Query still-open injections in the session's window.
//   3. For each, extract fingerprints from the memory and test against tool_input + tool_response_text.
//   4. Emit tool_reference (or explicit_access) signals as analytics_events rows via tracker.

import type Database from "better-sqlite3";
import type { AnalyticsTracker } from "../analytics/tracker.js";
import { extractFingerprints } from "../engine/text-utils.js";

export interface UtilitySignalInput {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  /** Already-flattened, already-scrubbed text form of tool_response. */
  tool_response_text: string;
  utility_window_minutes: number;
}

/**
 * K1 — Main pipeline. Runs inside the auto-capture binary after the auto-capture step.
 *
 * Sequence:
 *   1. Ignored sweep: mark expired-window injections (no prior signal) as ignored.
 *   2. Query still-open injections in the session's window.
 *   3. For each, extract fingerprints from the memory and test against tool_input + tool_response_text.
 *   4. Emit tool_reference (or explicit_access) signals as analytics_events rows.
 */
export function processUtilitySignals(
  db: Database.Database,
  tracker: AnalyticsTracker,
  input: UtilitySignalInput
): void {
  const { session_id, tool_name, tool_input, tool_response_text, utility_window_minutes } = input;

  // 1. Ignored sweep — done in SQL to avoid round-trips. Insert a synthetic utility_signal
  //    of signal_type='ignored' for every injection older than the window with no signal yet.
  //    Each such row gets the injection's own project_id/memory_id so analytics queries line up.
  //    R9: json_valid guard on event_data is N/A here since we don't inspect event_data contents
  //    in the sweep — we only check event_type which is a column, not JSON.
  db.prepare(`
    INSERT INTO analytics_events (session_id, project_id, memory_id, event_type, event_data, created_at)
    SELECT inj.session_id, inj.project_id, inj.memory_id, 'utility_signal',
           json_object('signal_type', 'ignored', 'signal_strength', 0.0), datetime('now')
    FROM analytics_events inj
    WHERE inj.event_type = 'injection'
      AND inj.session_id = ?
      AND inj.created_at <= datetime('now', '-' || ? || ' minutes')
      AND NOT EXISTS (
        SELECT 1 FROM analytics_events us
        WHERE us.memory_id = inj.memory_id
          AND us.session_id = inj.session_id
          AND us.event_type = 'utility_signal'
          AND us.created_at >= inj.created_at
      )
  `).run(session_id, utility_window_minutes);

  // 2. List injections still inside the window without a signal yet.
  const openInjections = db.prepare(`
    SELECT inj.id as injection_id, inj.memory_id, inj.project_id
    FROM analytics_events inj
    WHERE inj.event_type = 'injection'
      AND inj.session_id = ?
      AND inj.created_at > datetime('now', '-' || ? || ' minutes')
      AND NOT EXISTS (
        SELECT 1 FROM analytics_events us
        WHERE us.memory_id = inj.memory_id
          AND us.session_id = inj.session_id
          AND us.event_type = 'utility_signal'
          AND us.created_at >= inj.created_at
      )
  `).all(session_id, utility_window_minutes) as Array<{
    injection_id: number; memory_id: string; project_id: string | null;
  }>;

  if (openInjections.length === 0) return;

  // 3. Build the call text once (R9: safe against non-object tool_input).
  const callText = `${JSON.stringify(tool_input || {})} ${tool_response_text || ""}`.toLowerCase();

  const getMemory = db.prepare("SELECT id, title, body FROM memories WHERE id = ?");

  for (const inj of openInjections) {
    const memory = getMemory.get(inj.memory_id) as
      | { id: string; title: string; body: string | null }
      | undefined;

    // R9: if the memory has been hard-deleted, mark this injection as ignored rather than skip.
    if (!memory) {
      tracker.track({
        session_id,
        project_id: inj.project_id ?? undefined,
        memory_id: inj.memory_id,
        event_type: "utility_signal",
        event_data: JSON.stringify({ signal_type: "ignored", signal_strength: 0.0, reason: "memory deleted" }),
      });
      continue;
    }

    let matched = false;

    // 4a. Explicit-access detection: tool_name is memory_get / memory_search AND response contains id or title.
    if (tool_name === "memory_get" || tool_name === "memory_search") {
      const resp = (tool_response_text || "").toLowerCase();
      if (resp.includes(memory.id.toLowerCase()) || resp.includes(memory.title.toLowerCase())) {
        tracker.track({
          session_id,
          project_id: inj.project_id ?? undefined,
          memory_id: memory.id,
          event_type: "utility_signal",
          event_data: JSON.stringify({ signal_type: "explicit_access", signal_strength: 1.0 }),
        });
        matched = true;
      }
    }

    // 4b. Fingerprint detection (only if explicit_access didn't already fire).
    if (!matched) {
      const fingerprints = extractFingerprints(`${memory.title} ${memory.body ?? ""}`);
      for (const fp of fingerprints) {
        if (callText.includes(fp.toLowerCase())) {
          tracker.track({
            session_id,
            project_id: inj.project_id ?? undefined,
            memory_id: memory.id,
            event_type: "utility_signal",
            event_data: JSON.stringify({
              signal_type: "tool_reference",
              signal_strength: fp.length > 20 ? 0.8 : 0.5,
              matched_fingerprint: fp,
            }),
          });
          matched = true;
          break;
        }
      }
    }
    // If no match and the window is still open, leave it — the next PostToolUse may match.
    // The ignored-sweep handles the final disposition once the window elapses.
  }
}
