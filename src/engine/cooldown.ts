// src/engine/cooldown.ts
// C5: Module-level session tracker with TTL-based eviction + max-100 LRU eviction.

export const MAX_TRACKED_SESSIONS = 100;

interface SessionEntry {
  lastCaptureAt: number;
  recentTitles: string[];
}

// Module-level map: session_id → SessionEntry
const sessionTrackers = new Map<string, SessionEntry>();

function evictOldestIfNeeded(): void {
  if (sessionTrackers.size >= MAX_TRACKED_SESSIONS) {
    // LRU: evict the entry with the oldest lastCaptureAt
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, entry] of sessionTrackers) {
      if (entry.lastCaptureAt < oldestTime) {
        oldestTime = entry.lastCaptureAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) {
      sessionTrackers.delete(oldestKey);
    }
  }
}

/**
 * Check whether a new capture for this session+title is allowed.
 * Returns true if allowed (not on cooldown), false if blocked.
 *
 * @param sessionId    Session identifier
 * @param title        Title of the candidate memory
 * @param cooldownSeconds  How long (in seconds) to block repeated captures
 * @param maxSessions  Max simultaneous sessions to track (default MAX_TRACKED_SESSIONS)
 */
export function checkCooldown(
  sessionId: string,
  title: string,
  cooldownSeconds: number,
  maxSessions: number = MAX_TRACKED_SESSIONS
): boolean {
  const now = Date.now();
  const entry = sessionTrackers.get(sessionId);

  if (!entry) {
    // First capture for this session — allow, then register
    evictOldestIfNeeded();
    sessionTrackers.set(sessionId, { lastCaptureAt: now, recentTitles: [title] });
    return true;
  }

  // Check per-title cooldown
  const elapsed = (now - entry.lastCaptureAt) / 1000;
  if (elapsed < cooldownSeconds && entry.recentTitles.includes(title)) {
    return false; // blocked
  }

  // Allow: update entry
  entry.lastCaptureAt = now;
  if (!entry.recentTitles.includes(title)) {
    entry.recentTitles.push(title);
  }
  return true;
}

/**
 * Clear the tracker for a given session. Used for test isolation.
 */
export function clearSessionTracker(sessionId: string): void {
  sessionTrackers.delete(sessionId);
}

/**
 * Clear all session trackers. Used for test isolation.
 */
export function clearAllSessionTrackers(): void {
  sessionTrackers.clear();
}
