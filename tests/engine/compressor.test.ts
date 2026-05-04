import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  clusterMemories,
  mergeCluster,
  shouldCompress,
  DEFAULT_COMPRESSION_CONFIG,
  type CompressionCluster,
  type MemoryRecord,
} from "../../src/engine/compressor.js";
import { createDatabase } from "../../src/db/database.js";
import { setClock, resetClock } from "../../src/lib/decay.js";

const makeMemory = (
  id: string,
  title: string,
  body: string,
  tags: string[],
  createdAt = "2026-04-10T10:00:00Z",
  overrides: Partial<MemoryRecord> = {},
): MemoryRecord => ({
  id,
  project_id: "p1",
  memory_type: "fact",
  scope: "project",
  title,
  body,
  tags: JSON.stringify(tags),
  importance_score: 0.5,
  confidence_score: 1.0,
  access_count: 0,
  last_accessed_at: null,
  is_pinned: 0,
  supersedes_memory_id: null,
  source: "user",
  adaptive_score: 0.5,
  created_at: createdAt,
  updated_at: createdAt,
  deleted_at: null,
  ...overrides,
});

describe("clusterMemories", () => {
  const config = DEFAULT_COMPRESSION_CONFIG;

  it("clusters similar memories together", () => {
    const memories: MemoryRecord[] = [
      makeMemory(
        "1",
        "Edit: UserService.ts - added validate()",
        "Changed validate method in UserService.ts",
        ["edit", "code-change"],
      ),
      makeMemory(
        "2",
        "Edit: UserService.ts - added sanitize()",
        "Changed sanitize method in UserService.ts",
        ["edit", "code-change"],
      ),
      makeMemory(
        "3",
        "Edit: UserService.ts - refactored auth",
        "Refactored auth flow in UserService.ts",
        ["edit", "code-change"],
      ),
      makeMemory(
        "4",
        "Docker: started containers",
        "Started nginx and postgres",
        ["infrastructure"],
      ),
    ];

    const clusters = clusterMemories(memories, config);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    const userServiceCluster = clusters.find(c =>
      c.memories.some(m => m.title.includes("UserService")),
    );
    expect(userServiceCluster).toBeDefined();
    expect(userServiceCluster!.memories.length).toBeGreaterThanOrEqual(2);
  });

  it("does not cluster unrelated memories", () => {
    const memories: MemoryRecord[] = [
      makeMemory("1", "React hooks guide", "useState patterns", ["react"]),
      makeMemory("2", "Docker deployment", "Container orchestration", ["infrastructure"]),
      makeMemory("3", "SQL optimization", "Index tuning strategies", ["database"]),
    ];

    const clusters = clusterMemories(memories, config);
    expect(clusters.length).toBe(0);
  });

  it("requires minimum cluster size", () => {
    const memories: MemoryRecord[] = [
      makeMemory("1", "Single memory", "Only one item", ["test"]),
    ];
    const clusters = clusterMemories(memories, { ...config, min_cluster_size: 2 });
    expect(clusters.length).toBe(0);
  });

  it("returns correct cluster metadata", () => {
    const memories: MemoryRecord[] = [
      makeMemory(
        "1",
        "Edit: auth.ts - fix",
        "Fixed auth.ts bug",
        ["edit", "auth"],
        "2026-04-10T10:00:00Z",
      ),
      makeMemory(
        "2",
        "Edit: auth.ts - refactor",
        "Refactored auth.ts",
        ["edit", "auth"],
        "2026-04-10T12:00:00Z",
      ),
    ];

    const clusters = clusterMemories(memories, config);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    const c = clusters[0];
    expect(c.memories.length).toBe(2);
    expect(c.total_tokens).toBeGreaterThan(0);
    expect(c.date_range.start).toBeDefined();
    expect(c.date_range.end).toBeDefined();
    expect(c.centroid_tags).toContain("edit");
    expect(c.common_files.some(f => f.includes("auth.ts"))).toBe(true);
  });

  it("handles empty input", () => {
    expect(clusterMemories([], config)).toEqual([]);
  });

  it("I1: skips compressed memories (never re-compress)", () => {
    const memories: MemoryRecord[] = [
      makeMemory("1", "Edit: file.ts A", "edit A in file.ts", ["edit"], undefined, {
        source: "compression",
      }),
      makeMemory("2", "Edit: file.ts B", "edit B in file.ts", ["edit"], undefined, {
        source: "compression",
      }),
    ];
    expect(clusterMemories(memories, config).length).toBe(0);
  });

  it("P3 Task 2: excludes memories above decay_floor (recent rows still being iterated)", () => {
    // Freeze clock at 2026-05-04 so daysSince is deterministic.
    setClock(() => new Date("2026-05-04T12:00:00Z").getTime());
    try {
      const recent = [
        makeMemory("r1", "Edit: foo.ts (recent)", "deadlock pattern", ["edit"], "2026-05-01T10:00:00Z"),
        makeMemory("r2", "Edit: foo.ts (recent)", "deadlock pattern again", ["edit"], "2026-05-02T10:00:00Z"),
        makeMemory("r3", "Edit: foo.ts (recent)", "deadlock pattern reappears", ["edit"], "2026-05-03T10:00:00Z"),
      ];
      // Old memories: 50+ days old → exponential decay halflife=14 → ~0.085
      const old = [
        makeMemory("o1", "Edit: foo.ts (old)", "deadlock pattern", ["edit"], "2026-03-10T10:00:00Z"),
        makeMemory("o2", "Edit: foo.ts (old)", "deadlock pattern again", ["edit"], "2026-03-11T10:00:00Z"),
        makeMemory("o3", "Edit: foo.ts (old)", "deadlock pattern reappears", ["edit"], "2026-03-12T10:00:00Z"),
      ];
      const cfg = { ...DEFAULT_COMPRESSION_CONFIG, decay_floor: 0.6 };
      const clusters = clusterMemories([...recent, ...old], cfg);

      // Recents have decay ~0.86 (>0.6) → excluded; only old form a cluster.
      expect(clusters).toHaveLength(1);
      const ids = clusters[0].memories.map(m => m.id).sort();
      expect(ids).toEqual(["o1", "o2", "o3"]);
    } finally {
      resetClock();
    }
  });

  it("decay_floor undefined → no filter (backward compatible)", () => {
    setClock(() => new Date("2026-05-04T12:00:00Z").getTime());
    try {
      const memories = [
        makeMemory("r1", "Edit: foo.ts", "deadlock pattern", ["edit"], "2026-05-01T10:00:00Z"),
        makeMemory("r2", "Edit: foo.ts", "deadlock pattern again", ["edit"], "2026-05-02T10:00:00Z"),
      ];
      const clusters = clusterMemories(memories, DEFAULT_COMPRESSION_CONFIG);
      // The default config no longer carries decay_floor — recent memories still cluster.
      expect(clusters.length).toBeGreaterThanOrEqual(1);
    } finally {
      resetClock();
    }
  });
});

describe("mergeCluster", () => {
  it("produces a single compressed memory from cluster", () => {
    const cluster: CompressionCluster = {
      memories: [
        makeMemory(
          "1",
          "Edit: UserService.ts - added validate()",
          "Added validate method for input checking",
          ["edit"],
        ),
        makeMemory(
          "2",
          "Edit: UserService.ts - added sanitize()",
          "Added sanitize method for XSS prevention",
          ["edit"],
        ),
      ],
      centroid_tags: ["edit"],
      common_files: ["UserService.ts"],
      date_range: { start: new Date("2026-04-10"), end: new Date("2026-04-10") },
      total_tokens: 50,
    };

    const result = mergeCluster(cluster);
    expect(result.compressed_memory.title).toBeDefined();
    expect(result.compressed_memory.body.length).toBeGreaterThan(0);
    expect(result.compressed_memory.tags).toContain("compressed");
    expect(result.source_memory_ids).toEqual(["1", "2"]);
  });

  it("compression ratio is less than 1.0 for realistic input", () => {
    const cluster: CompressionCluster = {
      memories: [
        makeMemory(
          "1",
          "Edit: auth.ts - fix A",
          "Fixed authentication bypass vulnerability in login endpoint. This was critical.",
          ["edit", "security"],
        ),
        makeMemory(
          "2",
          "Edit: auth.ts - fix B",
          "Fixed authentication token refresh mechanism to handle expired tokens gracefully.",
          ["edit", "auth"],
        ),
        makeMemory(
          "3",
          "Edit: auth.ts - fix C",
          "Fixed authentication session expiry handling in the middleware layer.",
          ["edit", "auth"],
        ),
      ],
      centroid_tags: ["edit", "auth"],
      common_files: ["auth.ts"],
      date_range: { start: new Date("2026-04-10"), end: new Date("2026-04-10") },
      total_tokens: 120,
    };

    const result = mergeCluster(cluster);
    expect(result.compression_ratio).toBeLessThan(1.0);
    expect(result.tokens_after).toBeLessThan(result.tokens_before);
  });

  it("preserves importance (max of sources + 0.1, capped at 1.0)", () => {
    const cluster: CompressionCluster = {
      memories: [
        makeMemory("1", "A", "body a", ["t"], undefined, { importance_score: 0.3 }),
        makeMemory("2", "B", "body b", ["t"], undefined, { importance_score: 0.8 }),
      ],
      centroid_tags: ["t"],
      common_files: [],
      date_range: { start: new Date(), end: new Date() },
      total_tokens: 30,
    };

    const result = mergeCluster(cluster);
    expect(result.compressed_memory.importance_score).toBeGreaterThanOrEqual(0.8);
    expect(result.compressed_memory.importance_score).toBeLessThanOrEqual(1.0);
  });

  it("deduplicates similar sentences across memories", () => {
    const cluster: CompressionCluster = {
      memories: [
        makeMemory(
          "1",
          "A",
          "Added validate method for input checking. Fixed auth flow.",
          ["edit"],
        ),
        makeMemory(
          "2",
          "B",
          "Added validate method for input checking. Added sanitize.",
          ["edit"],
        ),
      ],
      centroid_tags: ["edit"],
      common_files: [],
      date_range: { start: new Date(), end: new Date() },
      total_tokens: 60,
    };

    const result = mergeCluster(cluster);
    const occurrences = (result.compressed_memory.body.match(/validate method for input checking/g) || []).length;
    expect(occurrences).toBeLessThanOrEqual(1);
  });
});

describe("shouldCompress", () => {
  let db: ReturnType<typeof createDatabase>;
  const dbPath = join(tmpdir(), `memento-compress-trigger-${process.pid}-${randomUUID()}.sqlite`);

  beforeEach(() => {
    db = createDatabase(dbPath);
    db.prepare("INSERT INTO projects (id, name, root_path) VALUES ('p1', 'test', '/test-p1')").run();
  });
  afterEach(() => {
    db.close();
    rmSync(dbPath, { force: true });
  });

  const triggerCfg = { memory_count_threshold: 150, auto_capture_batch: 50, staleness_days: 7 };

  it("returns true when memory count exceeds threshold", () => {
    const stmt = db.prepare(
      "INSERT INTO memories (id, project_id, title, body, memory_type, scope, source, created_at, updated_at) VALUES (?, 'p1', ?, 'body', 'fact', 'project', 'user', datetime('now'), datetime('now'))",
    );
    for (let i = 0; i < 151; i++) stmt.run(`m${i}`, `memory ${i}`);
    expect(shouldCompress(db, "p1", triggerCfg)).toBe(true);
  });

  it("returns false when memory count is below threshold", () => {
    const stmt = db.prepare(
      "INSERT INTO memories (id, project_id, title, body, memory_type, scope, source, created_at, updated_at) VALUES (?, 'p1', ?, 'body', 'fact', 'project', 'user', datetime('now'), datetime('now'))",
    );
    for (let i = 0; i < 10; i++) stmt.run(`m${i}`, `memory ${i}`);
    expect(shouldCompress(db, "p1", triggerCfg)).toBe(false);
  });

  it("returns true when recent auto-capture batch exceeds threshold", () => {
    const stmt = db.prepare(
      "INSERT INTO memories (id, project_id, title, body, memory_type, scope, source, created_at, updated_at) VALUES (?, 'p1', ?, 'body', 'fact', 'project', 'auto-capture', datetime('now'), datetime('now'))",
    );
    for (let i = 0; i < 60; i++) stmt.run(`ac${i}`, `auto ${i}`);
    expect(shouldCompress(db, "p1", triggerCfg)).toBe(true);
  });
});
