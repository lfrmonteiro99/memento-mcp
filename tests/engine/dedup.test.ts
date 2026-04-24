// tests/engine/dedup.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isDuplicate, CooldownTracker } from "../../src/engine/dedup.js";
import { createDatabase } from "../../src/db/database.js";
import { MemoriesRepo } from "../../src/db/memories.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("isDuplicate", () => {
  let db: ReturnType<typeof createDatabase>;
  let memRepo: MemoriesRepo;
  const dbPath = join(tmpdir(), `memento-dedup-test-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    memRepo = new MemoriesRepo(db);
    // Store some memories to dedup against
    memRepo.store({
      title: "Git log snapshot: main branch",
      body: "abc1234 fix: resolve null pointer\ndef5678 feat: add user auth",
      memoryType: "fact", scope: "global",
    });
    memRepo.store({
      title: "Project config: package.json",
      body: "Keys: name, version, dependencies, devDependencies",
      memoryType: "architecture", scope: "global",
    });
  });
  afterEach(() => { db.close(); rmSync(dbPath, { force: true }); });

  it("detects duplicate with high similarity", () => {
    const result = isDuplicate(db, {
      title: "Git log snapshot: main branch",
      body: "abc1234 fix: resolve null pointer\ndef5678 feat: add user auth",
    }, 0.7);
    expect(result.duplicate).toBe(true);
    expect(result.mergeTargetId).toBeDefined();
  });

  it("allows sufficiently different content", () => {
    const result = isDuplicate(db, {
      title: "Docker compose configuration",
      body: "Services: web, db, redis. Ports: 3000, 5432, 6379.",
    }, 0.7);
    expect(result.duplicate).toBe(false);
  });

  it("uses configurable threshold", () => {
    // With very low threshold, even slightly similar content is a duplicate.
    // "Git log" vs "Git log snapshot: main branch" yields ~0.07 combined score;
    // threshold must be below that value to confirm a match.
    const result = isDuplicate(db, {
      title: "Git log",
      body: "some git history",
    }, 0.05);
    expect(result.duplicate).toBe(true);
  });

  it("does not cross-project deduplicate (I3)", () => {
    // Memory in project A; candidate in project B should NOT be a dup
    const projectADbPath = join(tmpdir(), `memento-dedup-projA-${process.pid}-${randomUUID()}.sqlite`);
    const projectADb = createDatabase(projectADbPath);
    projectADb.prepare("INSERT INTO projects (id, name, root_path) VALUES ('pA', 'A', '/a')").run();
    projectADb.prepare(
      "INSERT INTO memories (id, project_id, title, body, memory_type, scope, created_at, updated_at) VALUES ('m1', 'pA', 'Git log snapshot: main branch', 'abc1234 fix: resolve null pointer', 'fact', 'global', datetime('now'), datetime('now'))"
    ).run();
    const result = isDuplicate(projectADb, {
      title: "Git log snapshot: main branch",
      body: "abc1234 fix: resolve null pointer",
      projectId: "pB", // different project — should not match
    }, 0.7);
    expect(result.duplicate).toBe(false);
    projectADb.close();
    rmSync(projectADbPath, { force: true });
  });

  it("returns false for empty DB", () => {
    const freshDbPath = join(tmpdir(), `memento-dedup-fresh-${process.pid}-${randomUUID()}.sqlite`);
    const freshDb = createDatabase(freshDbPath);
    const result = isDuplicate(freshDb, {
      title: "New memory",
      body: "Brand new content",
    }, 0.7);
    expect(result.duplicate).toBe(false);
    freshDb.close();
    rmSync(freshDbPath, { force: true });
  });
});

describe("CooldownTracker", () => {
  it("allows first event", () => {
    const tracker = new CooldownTracker(30);
    expect(tracker.isOnCooldown("Bash:git log")).toBe(false);
  });

  it("blocks events within cooldown window", () => {
    const tracker = new CooldownTracker(30);
    tracker.record("Bash:git log");
    expect(tracker.isOnCooldown("Bash:git log")).toBe(true);
  });

  it("allows events after cooldown expires", () => {
    const tracker = new CooldownTracker(0); // 0 second cooldown
    tracker.record("Bash:git log");
    expect(tracker.isOnCooldown("Bash:git log")).toBe(false);
  });

  it("tracks different keys independently", () => {
    const tracker = new CooldownTracker(30);
    tracker.record("Bash:git log");
    expect(tracker.isOnCooldown("Bash:npm test")).toBe(false);
  });

  it("respects max captures per session", () => {
    const tracker = new CooldownTracker(0, 3);
    tracker.record("k1");
    tracker.record("k2");
    tracker.record("k3");
    expect(tracker.hasReachedMaxCaptures()).toBe(true);
  });

  it("does not exceed max captures", () => {
    const tracker = new CooldownTracker(0, 2);
    tracker.record("k1");
    tracker.record("k2");
    expect(tracker.hasReachedMaxCaptures()).toBe(true);
  });
});
