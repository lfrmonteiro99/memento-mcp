import { describe, it, expect, vi, afterEach } from "vitest";
import { loadConfig, DEFAULT_CONFIG } from "../../src/lib/config.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("config", () => {
  const tmpDir = join(tmpdir(), `memento-config-test-${process.pid}-${randomUUID()}`);

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.MEMENTO_BUDGET;
  });

  it("returns defaults when no config file exists", () => {
    const config = loadConfig("/nonexistent/path/config.toml");
    expect(config.budget.total).toBe(DEFAULT_CONFIG.budget.total);
    expect(config.budget.floor).toBe(500);
    expect(config.pruning.maxAgeDays).toBe(60);
  });

  it("merges TOML overrides with defaults", () => {
    mkdirSync(tmpDir, { recursive: true });
    const cfgPath = join(tmpDir, "config.toml");
    writeFileSync(cfgPath, '[budget]\ntotal = 5000\n');
    const config = loadConfig(cfgPath);
    expect(config.budget.total).toBe(5000);
    expect(config.budget.floor).toBe(500); // default preserved
  });

  it("env vars override TOML and defaults", () => {
    process.env.MEMENTO_BUDGET = "3000";
    const config = loadConfig("/nonexistent/path/config.toml");
    expect(config.budget.total).toBe(3000);
  });

  it("custom trivial patterns load from TOML", () => {
    mkdirSync(tmpDir, { recursive: true });
    const cfgPath = join(tmpDir, "config.toml");
    writeFileSync(cfgPath, '[hooks]\ncustom_trivial_patterns = ["roger", "ack"]\n');
    const config = loadConfig(cfgPath);
    expect(config.hooks.customTrivialPatterns).toEqual(["roger", "ack"]);
  });

  it("defaultDetail is 'index' in DEFAULT_CONFIG", () => {
    expect(DEFAULT_CONFIG.search.defaultDetail).toBe("index");
  });

  it("loads vault auto-promote types from TOML", () => {
    mkdirSync(tmpDir, { recursive: true });
    const cfgPath = join(tmpDir, "config.toml");
    writeFileSync(cfgPath, '[vault]\nauto_promote_types = ["preference", "decision"]\n');
    const config = loadConfig(cfgPath);
    expect(config.vault.autoPromoteTypes).toEqual(["preference", "decision"]);
  });
});

describe("v2 config fields", () => {
  const tmpDir = join(tmpdir(), `memento-config-v2-${process.pid}-${randomUUID()}`);

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("DEFAULT_CONFIG includes autoCapture section with sensible defaults", () => {
    expect(DEFAULT_CONFIG.autoCapture).toBeDefined();
    expect(DEFAULT_CONFIG.autoCapture.enabled).toBe(true);
    expect(DEFAULT_CONFIG.autoCapture.tools).toContain("Bash");
    expect(DEFAULT_CONFIG.autoCapture.maxPerSession).toBe(20);
  });

  it("includes Write, WebSearch, WebFetch, Glob in addition to Bash/Read/Grep/Edit", () => {
    const tools = DEFAULT_CONFIG.autoCapture.tools;
    expect(tools).toEqual(expect.arrayContaining(["Bash", "Read", "Grep", "Edit", "Write", "WebSearch", "WebFetch", "Glob"]));
  });

  it("DEFAULT_CONFIG includes compression section with threshold=150", () => {
    expect(DEFAULT_CONFIG.compression).toBeDefined();
    expect(DEFAULT_CONFIG.compression.enabled).toBe(true);
    expect(DEFAULT_CONFIG.compression.memoryCountThreshold).toBe(150);
  });

  it("DEFAULT_CONFIG includes adaptive section with score weights", () => {
    expect(DEFAULT_CONFIG.adaptive).toBeDefined();
    expect(DEFAULT_CONFIG.adaptive.enabled).toBe(true);
    expect(DEFAULT_CONFIG.adaptive.scoreWeights.ftsRelevance).toBe(0.3);
  });

  it("DEFAULT_CONFIG includes analytics section with flushThreshold=20", () => {
    expect(DEFAULT_CONFIG.analytics).toBeDefined();
    expect(DEFAULT_CONFIG.analytics.enabled).toBe(true);
    expect(DEFAULT_CONFIG.analytics.flushThreshold).toBe(20);
  });

  it("DEFAULT_CONFIG includes fileMemory section", () => {
    expect(DEFAULT_CONFIG.fileMemory).toBeDefined();
    expect(DEFAULT_CONFIG.fileMemory.cacheTtlSeconds).toBe(60);
    expect(DEFAULT_CONFIG.fileMemory.enabled).toBe(true);
  });

  it("DEFAULT_CONFIG.search.defaultDetail is 'index' (Task 7)", () => {
    expect(DEFAULT_CONFIG.search.defaultDetail).toBe("index");
    expect(DEFAULT_CONFIG.search.ftsPrefixMatching).toBe(true);
    expect(DEFAULT_CONFIG.search.keywordMaxTokens).toBe(8);
  });

  it("DEFAULT_CONFIG.hooks.analyticsReminderIntervalSessions default is 20 (G6)", () => {
    expect(DEFAULT_CONFIG.hooks.analyticsReminderIntervalSessions).toBe(20);
  });

  it("DEFAULT_CONFIG.decay uses exponential type with 14d half-life", () => {
    expect(DEFAULT_CONFIG.decay.type).toBe("exponential");
    expect(DEFAULT_CONFIG.decay.halfLifeDays).toBe(14);
  });

  it("loadConfig parses [auto_capture] TOML section", () => {
    mkdirSync(tmpDir, { recursive: true });
    const cfgPath = join(tmpDir, "config.toml");
    writeFileSync(
      cfgPath,
      '[auto_capture]\nenabled = false\nmax_per_session = 5\ntools = ["Bash"]\n',
    );
    const config = loadConfig(cfgPath);
    expect(config.autoCapture.enabled).toBe(false);
    expect(config.autoCapture.maxPerSession).toBe(5);
    expect(config.autoCapture.tools).toEqual(["Bash"]);
  });

  it("loadConfig parses [compression] TOML section", () => {
    mkdirSync(tmpDir, { recursive: true });
    const cfgPath = join(tmpDir, "config.toml");
    writeFileSync(
      cfgPath,
      '[compression]\nenabled = true\nmemory_count_threshold = 200\ncluster_similarity_threshold = 0.5\n',
    );
    const config = loadConfig(cfgPath);
    expect(config.compression.memoryCountThreshold).toBe(200);
    expect(config.compression.clusterSimilarityThreshold).toBe(0.5);
  });

  it("loadConfig parses [adaptive.score_weights] subsection", () => {
    mkdirSync(tmpDir, { recursive: true });
    const cfgPath = join(tmpDir, "config.toml");
    writeFileSync(
      cfgPath,
      '[adaptive]\nenabled = true\n\n[adaptive.score_weights]\nfts_relevance = 0.4\nutility = 0.3\n',
    );
    const config = loadConfig(cfgPath);
    expect(config.adaptive.scoreWeights.ftsRelevance).toBe(0.4);
    expect(config.adaptive.scoreWeights.utility).toBe(0.3);
    expect(config.adaptive.scoreWeights.importance).toBe(0.2); // default preserved
  });

  it("loadConfig parses [analytics] and [file_memory] TOML sections", () => {
    mkdirSync(tmpDir, { recursive: true });
    const cfgPath = join(tmpDir, "config.toml");
    writeFileSync(
      cfgPath,
      '[analytics]\nflush_threshold = 50\nretention_days = 30\n\n[file_memory]\ncache_ttl_seconds = 120\n',
    );
    const config = loadConfig(cfgPath);
    expect(config.analytics.flushThreshold).toBe(50);
    expect(config.analytics.retentionDays).toBe(30);
    expect(config.fileMemory.cacheTtlSeconds).toBe(120);
  });

  it("N1: logs WARN when TOML is malformed, falls back to defaults", () => {
    mkdirSync(tmpDir, { recursive: true });
    const cfgPath = join(tmpDir, "bad.toml");
    writeFileSync(cfgPath, "this is [[[ not valid TOML");
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const cfg = loadConfig(cfgPath);
      expect(cfg.budget.total).toBe(DEFAULT_CONFIG.budget.total);
      const combined = spy.mock.calls.map(call => String(call[0])).join("");
      expect(combined).toContain("Config parse error");
    } finally {
      spy.mockRestore();
    }
  });

  it("v1 config file still parses correctly (backward compat)", () => {
    mkdirSync(tmpDir, { recursive: true });
    const cfgPath = join(tmpDir, "v1.toml");
    writeFileSync(
      cfgPath,
      '[budget]\ntotal = 12000\n\n[search]\nmax_results = 25\n\n[hooks]\ntrivial_skip = false\n',
    );
    const config = loadConfig(cfgPath);
    expect(config.budget.total).toBe(12000);
    expect(config.search.maxResults).toBe(25);
    expect(config.hooks.trivialSkip).toBe(false);
    // New v2 defaults still present
    expect(config.autoCapture.enabled).toBe(true);
    expect(config.compression.enabled).toBe(true);
  });
});

describe("config defaults", () => {
  it("default embeddings provider is 'local' with MiniLM-L6 384-dim", () => {
    const cfg = loadConfig("/nonexistent/path/that/does/not/exist.toml");
    expect(cfg.search.embeddings.enabled).toBe(true);
    expect(cfg.search.embeddings.provider).toBe("local");
    expect(cfg.search.embeddings.model).toBe("Xenova/all-MiniLM-L6-v2");
    expect(cfg.search.embeddings.dim).toBe(384);
  });

  it("user TOML can override provider back to openai", () => {
    const { writeFileSync: wfs, mkdtempSync } = require("node:fs");
    const { tmpdir: td } = require("node:os");
    const { join: pjoin } = require("node:path");
    const dir = mkdtempSync(pjoin(td(), "memento-cfg-"));
    const path = pjoin(dir, "config.toml");
    wfs(
      path,
      `[search.embeddings]\nenabled = true\nprovider = "openai"\nmodel = "text-embedding-3-small"\ndim = 1536\n`,
    );
    const cfg = loadConfig(path);
    expect(cfg.search.embeddings.provider).toBe("openai");
    expect(cfg.search.embeddings.model).toBe("text-embedding-3-small");
    expect(cfg.search.embeddings.dim).toBe(1536);
  });
});

describe("embeddings config", () => {
  const tmpDir = join(tmpdir(), `memento-config-emb-${process.pid}-${randomUUID()}`);

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("DEFAULT_CONFIG has embeddings enabled=true, provider=local, MiniLM-L6-v2, dim=384 by default", () => {
    expect(DEFAULT_CONFIG.search.embeddings.enabled).toBe(true);
    expect(DEFAULT_CONFIG.search.embeddings.provider).toBe("local");
    expect(DEFAULT_CONFIG.search.embeddings.model).toBe("Xenova/all-MiniLM-L6-v2");
    expect(DEFAULT_CONFIG.search.embeddings.dim).toBe(384);
    expect(DEFAULT_CONFIG.search.embeddings.topK).toBe(20);
    expect(DEFAULT_CONFIG.search.embeddings.similarityThreshold).toBe(0.5);
    expect(DEFAULT_CONFIG.search.embeddings.batchSize).toBe(32);
    expect(DEFAULT_CONFIG.search.embeddings.requestTimeoutMs).toBe(10000);
  });

  it("loads [search.embeddings] TOML section", () => {
    mkdirSync(tmpDir, { recursive: true });
    const cfgPath = join(tmpDir, "config.toml");
    writeFileSync(
      cfgPath,
      '[search.embeddings]\nenabled = true\nmodel = "text-embedding-ada-002"\ntop_k = 10\nsimilarity_threshold = 0.7\n',
    );
    const config = loadConfig(cfgPath);
    expect(config.search.embeddings.enabled).toBe(true);
    expect(config.search.embeddings.model).toBe("text-embedding-ada-002");
    expect(config.search.embeddings.topK).toBe(10);
    expect(config.search.embeddings.similarityThreshold).toBe(0.7);
    // Other defaults preserved
    expect(config.search.embeddings.batchSize).toBe(32);
  });

  it("preserves all other search defaults when only embeddings is set", () => {
    mkdirSync(tmpDir, { recursive: true });
    const cfgPath = join(tmpDir, "config.toml");
    writeFileSync(cfgPath, '[search.embeddings]\nenabled = false\n');
    const config = loadConfig(cfgPath);
    expect(config.search.maxResults).toBe(10); // default
    expect(config.search.ftsPrefixMatching).toBe(true); // default
  });

  it("DEFAULT_CONFIG has dedup=false by default (issue #8)", () => {
    expect(DEFAULT_CONFIG.search.embeddings.dedup).toBe(false);
    expect(DEFAULT_CONFIG.search.embeddings.dedupThreshold).toBe(0.92);
    expect(DEFAULT_CONFIG.search.embeddings.dedupDefaultMode).toBe("warn");
    expect(DEFAULT_CONFIG.search.embeddings.dedupCheckOnUpdate).toBe(true);
    expect(DEFAULT_CONFIG.search.embeddings.dedupMaxScan).toBe(2000);
  });

  it("TOML round-trip: dedup, dedup_threshold, dedup_default_mode, dedup_check_on_update, dedup_max_scan", () => {
    mkdirSync(tmpDir, { recursive: true });
    const cfgPath = join(tmpDir, "config.toml");
    writeFileSync(
      cfgPath,
      [
        "[search.embeddings]",
        "enabled = true",
        "dedup = true",
        "dedup_threshold = 0.85",
        'dedup_default_mode = "strict"',
        "dedup_check_on_update = false",
        "dedup_max_scan = 500",
      ].join("\n"),
    );
    const config = loadConfig(cfgPath);
    expect(config.search.embeddings.dedup).toBe(true);
    expect(config.search.embeddings.dedupThreshold).toBe(0.85);
    expect(config.search.embeddings.dedupDefaultMode).toBe("strict");
    expect(config.search.embeddings.dedupCheckOnUpdate).toBe(false);
    expect(config.search.embeddings.dedupMaxScan).toBe(500);
  });

  it("embeddings.enabled=true alone does NOT enable dedup (must be explicit)", () => {
    mkdirSync(tmpDir, { recursive: true });
    const cfgPath = join(tmpDir, "config.toml");
    writeFileSync(cfgPath, "[search.embeddings]\nenabled = true\n");
    const config = loadConfig(cfgPath);
    expect(config.search.embeddings.enabled).toBe(true);
    expect(config.search.embeddings.dedup).toBe(false); // separate opt-in
  });
});
