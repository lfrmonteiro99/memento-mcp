// tests/lib/config-full-toml.test.ts
// Branch coverage for loadConfig: writes a TOML file that exercises every
// optional override key for every section, then asserts the merged config
// reflects each override. Also drives the env-var override branches.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../../src/lib/config.js";

describe("loadConfig — full TOML override coverage", () => {
  let tmpDir: string;
  let cfgPath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `memento-config-full-${process.pid}-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    cfgPath = join(tmpDir, "config.toml");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.MEMENTO_BUDGET;
    delete process.env.MEMENTO_FLOOR;
    delete process.env.MEMENTO_REFILL;
    delete process.env.MEMENTO_SESSION_TIMEOUT;
  });

  it("applies every documented TOML override", () => {
    writeFileSync(cfgPath, `
[budget]
total = 4321
floor = 321
refill = 21
session_timeout = 999

[search]
default_detail = "summary"
max_results = 17
body_preview_chars = 333
keyword_max_tokens = 11
preserve_phrases = false
fts_prefix_matching = false

[search.embeddings]
enabled = true
provider = "openai"
model = "text-embedding-3-large"
api_key_env = "FOO_KEY"
dim = 768
top_k = 7
similarity_threshold = 0.42
batch_size = 13
request_timeout_ms = 1234
dedup = true
dedup_threshold = 0.91
dedup_default_mode = "warn"
dedup_check_on_update = true
dedup_max_scan = 999

[hooks]
trivial_skip = false
session_start_memories = 9
session_start_pitfalls = 8
custom_trivial_patterns = ["^hi$", "^bye$"]
analytics_reminder_interval_sessions = 50
session_end_summarize = false
session_end_min_captures = 4
session_end_max_body_tokens = 1500
session_end_keep_originals = true
summarize_mode = "llm"

[hooks.session_end_llm]
provider = "openai"
model = "gpt-4o-mini"
api_key_env = "OPENAI_KEY_X"
max_input_tokens = 5000
max_output_tokens = 600
request_timeout_ms = 7777
fallback_to_deterministic = false

[pruning]
enabled = false
max_age_days = 100
min_importance = 0.5
interval_hours = 12

[database]
path = "/tmp/custom.sqlite"

[vault]
enabled = true
path = "/tmp/vault"
include_folders = ["A", "B"]
exclude_folders = ["X", "Y"]
require_publish_flag = false
root_notes = ["root1.md", "root2.md"]
max_hops = 4
max_results = 6
hook_max_results = 3
auto_promote_types = ["fact", "preference"]

[decay]
type = "exponential"
half_life_days = 21

[auto_capture]
enabled = false
min_output_length = 100
max_output_length = 99999
cooldown_seconds = 60
dedup_similarity_threshold = 0.8
max_per_session = 99
default_importance = 0.7
tools = ["Bash"]
session_timeout_seconds = 1800

[compression]
enabled = false
memory_count_threshold = 200
auto_capture_batch_threshold = 75
staleness_days = 14
cluster_similarity_threshold = 0.55
min_cluster_size = 3
max_body_ratio = 0.7
temporal_window_hours = 72

[adaptive]
enabled = false
utility_window_minutes = 20
decay_half_life_days = 28
min_injections_for_confidence = 7
neutral_utility_score = 0.42

[adaptive.score_weights]
fts_relevance = 0.25
importance = 0.25
decay = 0.20
utility = 0.15
recency_bonus = 0.15

[analytics]
enabled = false
flush_threshold = 50
retention_days = 30
prune_check_interval = 6

[file_memory]
cache_ttl_seconds = 120
enabled = false

[sync]
enabled = false
auto_push_on_store = true
folder = ".my-memento"
include_private_in_files = true
max_future_drift_hours = 12
schema_version = 2

[profile]
id = "spanish"
extra_stop_words = ["el", "la"]
extra_trivial_patterns = ["^hola$"]
locale = "es"
`);

    const c = loadConfig(cfgPath);

    expect(c.budget).toEqual({ total: 4321, floor: 321, refill: 21, sessionTimeout: 999 });
    expect(c.search.defaultDetail).toBe("summary");
    expect(c.search.maxResults).toBe(17);
    expect(c.search.bodyPreviewChars).toBe(333);
    expect(c.search.keywordMaxTokens).toBe(11);
    expect(c.search.preservePhrases).toBe(false);
    expect(c.search.ftsPrefixMatching).toBe(false);

    const e = c.search.embeddings;
    expect(e.enabled).toBe(true);
    expect(e.provider).toBe("openai");
    expect(e.model).toBe("text-embedding-3-large");
    expect(e.apiKeyEnv).toBe("FOO_KEY");
    expect(e.dim).toBe(768);
    expect(e.topK).toBe(7);
    expect(e.similarityThreshold).toBeCloseTo(0.42);
    expect(e.batchSize).toBe(13);
    expect(e.requestTimeoutMs).toBe(1234);
    expect(e.dedup).toBe(true);
    expect(e.dedupThreshold).toBeCloseTo(0.91);
    expect(e.dedupDefaultMode).toBe("warn");
    expect(e.dedupCheckOnUpdate).toBe(true);
    expect(e.dedupMaxScan).toBe(999);

    expect(c.hooks.trivialSkip).toBe(false);
    expect(c.hooks.sessionStartMemories).toBe(9);
    expect(c.hooks.sessionStartPitfalls).toBe(8);
    expect(c.hooks.customTrivialPatterns).toEqual(["^hi$", "^bye$"]);
    expect(c.hooks.analyticsReminderIntervalSessions).toBe(50);
    expect(c.hooks.sessionEndSummarize).toBe(false);
    expect(c.hooks.sessionEndMinCaptures).toBe(4);
    expect(c.hooks.sessionEndMaxBodyTokens).toBe(1500);
    expect(c.hooks.sessionEndKeepOriginals).toBe(true);
    expect(c.hooks.summarizeMode).toBe("llm");

    const llm = c.hooks.sessionEndLlm;
    expect(llm.provider).toBe("openai");
    expect(llm.model).toBe("gpt-4o-mini");
    expect(llm.apiKeyEnv).toBe("OPENAI_KEY_X");
    expect(llm.maxInputTokens).toBe(5000);
    expect(llm.maxOutputTokens).toBe(600);
    expect(llm.requestTimeoutMs).toBe(7777);
    expect(llm.fallbackToDeterministic).toBe(false);

    expect(c.pruning).toEqual({ enabled: false, maxAgeDays: 100, minImportance: 0.5, intervalHours: 12 });
    expect(c.database.path).toBe("/tmp/custom.sqlite");

    expect(c.vault.enabled).toBe(true);
    expect(c.vault.path).toBe("/tmp/vault");
    expect(c.vault.includeFolders).toEqual(["A", "B"]);
    expect(c.vault.excludeFolders).toEqual(["X", "Y"]);
    expect(c.vault.requirePublishFlag).toBe(false);
    expect(c.vault.rootNotes).toEqual(["root1.md", "root2.md"]);
    expect(c.vault.maxHops).toBe(4);
    expect(c.vault.maxResults).toBe(6);
    expect(c.vault.hookMaxResults).toBe(3);
    expect(c.vault.autoPromoteTypes).toEqual(["fact", "preference"]);

    expect(c.decay.type).toBe("exponential");
    expect(c.decay.halfLifeDays).toBe(21);

    expect(c.autoCapture.enabled).toBe(false);
    expect(c.autoCapture.minOutputLength).toBe(100);
    expect(c.autoCapture.maxOutputLength).toBe(99999);
    expect(c.autoCapture.cooldownSeconds).toBe(60);
    expect(c.autoCapture.dedupSimilarityThreshold).toBeCloseTo(0.8);
    expect(c.autoCapture.maxPerSession).toBe(99);
    expect(c.autoCapture.defaultImportance).toBeCloseTo(0.7);
    expect(c.autoCapture.tools).toEqual(["Bash"]);
    expect(c.autoCapture.sessionTimeoutSeconds).toBe(1800);

    expect(c.compression.enabled).toBe(false);
    expect(c.compression.memoryCountThreshold).toBe(200);
    expect(c.compression.autoCaptureBatchThreshold).toBe(75);
    expect(c.compression.stalenessDays).toBe(14);
    expect(c.compression.clusterSimilarityThreshold).toBeCloseTo(0.55);
    expect(c.compression.minClusterSize).toBe(3);
    expect(c.compression.maxBodyRatio).toBeCloseTo(0.7);
    expect(c.compression.temporalWindowHours).toBe(72);

    expect(c.adaptive.enabled).toBe(false);
    expect(c.adaptive.utilityWindowMinutes).toBe(20);
    expect(c.adaptive.decayHalfLifeDays).toBe(28);
    expect(c.adaptive.minInjectionsForConfidence).toBe(7);
    expect(c.adaptive.neutralUtilityScore).toBeCloseTo(0.42);
    expect(c.adaptive.scoreWeights).toEqual({
      ftsRelevance: 0.25, importance: 0.25, decay: 0.20, utility: 0.15, recencyBonus: 0.15,
    });

    expect(c.analytics).toEqual({
      enabled: false, flushThreshold: 50, retentionDays: 30, pruneCheckInterval: 6,
    });
    expect(c.fileMemory).toEqual({ cacheTtlSeconds: 120, enabled: false });

    expect(c.sync.enabled).toBe(false);
    expect(c.sync.autoPushOnStore).toBe(true);
    expect(c.sync.folder).toBe(".my-memento");
    expect(c.sync.includePrivateInFiles).toBe(true);
    expect(c.sync.maxFutureDriftHours).toBe(12);
    expect(c.sync.schemaVersion).toBe(2);

    expect(c.profile.id).toBe("spanish");
    expect(c.profile.extraStopWords).toEqual(["el", "la"]);
    expect(c.profile.extraTrivialPatterns).toEqual(["^hola$"]);
    expect(c.profile.locale).toBe("es");
  });

  it("applies all four MEMENTO_* env-var overrides", () => {
    process.env.MEMENTO_BUDGET = "11111";
    process.env.MEMENTO_FLOOR = "222";
    process.env.MEMENTO_REFILL = "33";
    process.env.MEMENTO_SESSION_TIMEOUT = "4444";
    const c = loadConfig("/nonexistent/path.toml");
    expect(c.budget.total).toBe(11111);
    expect(c.budget.floor).toBe(222);
    expect(c.budget.refill).toBe(33);
    expect(c.budget.sessionTimeout).toBe(4444);
  });
});
