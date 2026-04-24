// tests/engine/cooldown.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  checkCooldown,
  clearSessionTracker,
  clearAllSessionTrackers,
  MAX_TRACKED_SESSIONS,
} from "../../src/engine/cooldown.js";

describe("checkCooldown", () => {
  beforeEach(() => {
    clearAllSessionTrackers();
  });

  afterEach(() => {
    clearAllSessionTrackers();
  });

  it("allows the first capture for a new session", () => {
    const allowed = checkCooldown("session-1", "Git log snapshot", 30);
    expect(allowed).toBe(true);
  });

  it("blocks a repeated title within cooldown window", () => {
    checkCooldown("session-1", "Git log snapshot", 30);
    const allowed = checkCooldown("session-1", "Git log snapshot", 30);
    expect(allowed).toBe(false);
  });

  it("allows a different title within the cooldown window", () => {
    checkCooldown("session-1", "Git log snapshot", 30);
    const allowed = checkCooldown("session-1", "Docker compose config", 30);
    expect(allowed).toBe(true);
  });

  it("allows repeat title when cooldown is 0", () => {
    checkCooldown("session-1", "Git log snapshot", 0);
    const allowed = checkCooldown("session-1", "Git log snapshot", 0);
    expect(allowed).toBe(true);
  });

  it("tracks different sessions independently", () => {
    checkCooldown("session-A", "Git log snapshot", 30);
    const allowed = checkCooldown("session-B", "Git log snapshot", 30);
    expect(allowed).toBe(true);
  });

  it("evicts oldest session when MAX_TRACKED_SESSIONS is reached (C5)", () => {
    // Fill up to MAX_TRACKED_SESSIONS
    for (let i = 0; i < MAX_TRACKED_SESSIONS; i++) {
      checkCooldown(`session-${i}`, "some title", 30);
    }
    // Adding one more should not throw — oldest is evicted
    expect(() => {
      checkCooldown("session-overflow", "new title", 30);
    }).not.toThrow();
  });

  it("MAX_TRACKED_SESSIONS constant is 100", () => {
    expect(MAX_TRACKED_SESSIONS).toBe(100);
  });
});

describe("clearSessionTracker", () => {
  beforeEach(() => {
    clearAllSessionTrackers();
  });

  afterEach(() => {
    clearAllSessionTrackers();
  });

  it("removes a tracked session so it is treated as new", () => {
    checkCooldown("session-x", "title", 30);
    // Should be blocked
    expect(checkCooldown("session-x", "title", 30)).toBe(false);

    // Clear and retry — should be allowed again
    clearSessionTracker("session-x");
    expect(checkCooldown("session-x", "title", 30)).toBe(true);
  });

  it("does not affect other sessions when clearing one", () => {
    checkCooldown("session-a", "title", 30);
    checkCooldown("session-b", "title", 30);

    clearSessionTracker("session-a");

    // session-b should still be on cooldown
    expect(checkCooldown("session-b", "title", 30)).toBe(false);
    // session-a should be allowed again
    expect(checkCooldown("session-a", "title", 30)).toBe(true);
  });
});
