import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { parse as parseTOML } from "smol-toml";
import { createLogger, logLevelFromEnv } from "./logger.js";

export interface ProfileConfig {
  id: string;
  extraStopWords: string[];
  extraTrivialPatterns: string[];
  locale: string;
}

export interface VaultConfig {
  enabled: boolean;
  path: string;
  includeFolders: string[];
  excludeFolders: string[];
  requirePublishFlag: boolean;
  rootNotes: string[];
  maxHops: number;
  maxResults: number;
  hookMaxResults: number;
  autoPromoteTypes: string[];
}

export interface SessionEndLlmConfig {
  provider: "anthropic" | "openai";
  model: string;
  apiKeyEnv: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  fallbackToDeterministic: boolean;
}

export interface SyncConfig {
  enabled: boolean;
  autoPushOnStore: boolean;
  folder: string;
  includePrivateInFiles: boolean;
  maxFutureDriftHours: number;
  schemaVersion: number;
}

export interface Config {
  budget: { total: number; floor: number; refill: number; sessionTimeout: number };
  sync: SyncConfig;
  search: {
    defaultDetail: "index" | "summary" | "full";
    maxResults: number;
    bodyPreviewChars: number;
    keywordMaxTokens: number;
    preservePhrases: boolean;
    ftsPrefixMatching: boolean;
    embeddings: {
      enabled: boolean;
      provider: "openai" | "ollama" | "local";
      model: string;
      apiKeyEnv: string;
      dim: number;
      topK: number;
      similarityThreshold: number;
      batchSize: number;
      requestTimeoutMs: number;
      dedup: boolean;
      dedupThreshold: number;
      dedupDefaultMode: "strict" | "warn" | "off";
      dedupCheckOnUpdate: boolean;
      dedupMaxScan: number;
    };
  };
  hooks: {
    trivialSkip: boolean;
    sessionStartMemories: number;
    sessionStartPitfalls: number;
    customTrivialPatterns: string[];
    analyticsReminderIntervalSessions: number;
    sessionEndSummarize: boolean;
    sessionEndMinCaptures: number;
    sessionEndMaxBodyTokens: number;
    sessionEndKeepOriginals: boolean;
    summarizeMode: "deterministic" | "llm";
    sessionEndLlm: SessionEndLlmConfig;
  };
  pruning: { enabled: boolean; maxAgeDays: number; minImportance: number; intervalHours: number };
  database: { path: string };
  profile: ProfileConfig;
  vault: VaultConfig;
  decay: { type: "exponential" | "step"; halfLifeDays: number };
  autoCapture: {
    enabled: boolean;
    minOutputLength: number;
    maxOutputLength: number;
    cooldownSeconds: number;
    dedupSimilarityThreshold: number;
    maxPerSession: number;
    defaultImportance: number;
    tools: string[];
    sessionTimeoutSeconds: number;
  };
  compression: {
    enabled: boolean;
    memoryCountThreshold: number;
    autoCaptureBatchThreshold: number;
    stalenessDays: number;
    clusterSimilarityThreshold: number;
    minClusterSize: number;
    maxBodyRatio: number;
    temporalWindowHours: number;
  };
  adaptive: {
    enabled: boolean;
    utilityWindowMinutes: number;
    decayHalfLifeDays: number;
    minInjectionsForConfidence: number;
    neutralUtilityScore: number;
    scoreWeights: {
      ftsRelevance: number;
      importance: number;
      decay: number;
      utility: number;
      recencyBonus: number;
    };
  };
  analytics: {
    enabled: boolean;
    flushThreshold: number;
    retentionDays: number;
    pruneCheckInterval: number;
  };
  fileMemory: {
    cacheTtlSeconds: number;
    enabled: boolean;
  };
}

export const DEFAULT_VAULT_CONFIG: VaultConfig = {
  enabled: false,
  path: "",
  includeFolders: ["10 Maps", "20 Projects", "30 Domains", "40 Decisions", "50 Playbooks", "55 Skills"],
  excludeFolders: [".obsidian", "00 Inbox", "00 Inbox/attachments", "15 Calendar", "25 Efforts", "60 Sources", "70 Templates", "90 Archive"],
  requirePublishFlag: true,
  rootNotes: ["me.md", "vault.md"],
  maxHops: 3,
  maxResults: 5,
  hookMaxResults: 2,
  autoPromoteTypes: [],
};

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  enabled: true,
  autoPushOnStore: false,
  folder: ".memento",
  includePrivateInFiles: false,
  maxFutureDriftHours: 24,
  schemaVersion: 1,
};

export const DEFAULT_CONFIG: Config = {
  budget: { total: 8000, floor: 500, refill: 200, sessionTimeout: 1800 },
  sync: { ...DEFAULT_SYNC_CONFIG },
  search: {
    defaultDetail: "index",
    maxResults: 10,
    bodyPreviewChars: 200,
    keywordMaxTokens: 8,
    preservePhrases: true,
    ftsPrefixMatching: true,
    embeddings: {
      enabled: false,
      provider: "openai",
      model: "text-embedding-3-small",
      apiKeyEnv: "OPENAI_API_KEY",
      dim: 1536,
      topK: 20,
      similarityThreshold: 0.5,
      batchSize: 32,
      requestTimeoutMs: 10000,
      dedup: false,
      dedupThreshold: 0.92,
      dedupDefaultMode: "warn" as "strict" | "warn" | "off",
      dedupCheckOnUpdate: true,
      dedupMaxScan: 2000,
    },
  },
  hooks: {
    trivialSkip: true,
    sessionStartMemories: 5,
    sessionStartPitfalls: 5,
    customTrivialPatterns: [],
    analyticsReminderIntervalSessions: 20,
    sessionEndSummarize: true,
    sessionEndMinCaptures: 2,
    sessionEndMaxBodyTokens: 1500,
    sessionEndKeepOriginals: false,
    summarizeMode: "deterministic" as "deterministic" | "llm",
    sessionEndLlm: {
      provider: "anthropic" as "anthropic" | "openai",
      // Default model uses an alias (not a dated ID) to avoid 404s when models retire.
      model: "claude-haiku-3-5",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      maxInputTokens: 4000,
      maxOutputTokens: 800,
      // Must be less than the SessionEnd hook subprocess timeout (10s in Claude Code today).
      // If the LLM call exceeds this, the hook falls back to the deterministic summary.
      requestTimeoutMs: 8000,
      fallbackToDeterministic: true,
    },
  },
  pruning: { enabled: true, maxAgeDays: 60, minImportance: 0.3, intervalHours: 24 },
  database: { path: "" },
  profile: {
    id: "english",
    extraStopWords: [],
    extraTrivialPatterns: [],
    locale: "",
  },
  vault: { ...DEFAULT_VAULT_CONFIG },
  decay: { type: "exponential", halfLifeDays: 14 },
  autoCapture: {
    enabled: true,
    minOutputLength: 200,
    maxOutputLength: 50000,
    cooldownSeconds: 30,
    dedupSimilarityThreshold: 0.7,
    maxPerSession: 20,
    defaultImportance: 0.3,
    tools: ["Bash", "Read", "Grep", "Edit"],
    sessionTimeoutSeconds: 3600,
  },
  compression: {
    enabled: true,
    memoryCountThreshold: 150,
    autoCaptureBatchThreshold: 50,
    stalenessDays: 7,
    clusterSimilarityThreshold: 0.45,
    minClusterSize: 2,
    maxBodyRatio: 0.6,
    temporalWindowHours: 48,
  },
  adaptive: {
    enabled: true,
    utilityWindowMinutes: 10,
    decayHalfLifeDays: 14,
    minInjectionsForConfidence: 5,
    neutralUtilityScore: 0.5,
    scoreWeights: {
      ftsRelevance: 0.3,
      importance: 0.2,
      decay: 0.15,
      utility: 0.25,
      recencyBonus: 0.1,
    },
  },
  analytics: {
    enabled: true,
    flushThreshold: 20,
    retentionDays: 90,
    pruneCheckInterval: 24,
  },
  fileMemory: {
    cacheTtlSeconds: 60,
    enabled: true,
  },
};

export function loadConfig(configPath: string): Config {
  const config = structuredClone(DEFAULT_CONFIG);

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    return applyEnvOverrides(config);
  }

  let toml: Record<string, any>;
  try {
    toml = parseTOML(raw) as Record<string, any>;
  } catch (e) {
    // N1: surface parse errors via the shared logger so misconfigurations
    // are visible in stderr, then fall back to defaults.
    const log = createLogger(logLevelFromEnv());
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(`Config parse error at ${configPath}: ${msg}; using defaults.`);
    return applyEnvOverrides(config);
  }

  if (toml.budget) {
    if (toml.budget.total != null) config.budget.total = Number(toml.budget.total);
    if (toml.budget.floor != null) config.budget.floor = Number(toml.budget.floor);
    if (toml.budget.refill != null) config.budget.refill = Number(toml.budget.refill);
    if (toml.budget.session_timeout != null) config.budget.sessionTimeout = Number(toml.budget.session_timeout);
  }
  if (toml.search) {
    if (toml.search.default_detail) config.search.defaultDetail = toml.search.default_detail;
    if (toml.search.max_results != null) config.search.maxResults = Number(toml.search.max_results);
    if (toml.search.body_preview_chars != null) config.search.bodyPreviewChars = Number(toml.search.body_preview_chars);
    if (toml.search.keyword_max_tokens != null) config.search.keywordMaxTokens = Number(toml.search.keyword_max_tokens);
    if (toml.search.preserve_phrases != null) config.search.preservePhrases = Boolean(toml.search.preserve_phrases);
    if (toml.search.fts_prefix_matching != null) config.search.ftsPrefixMatching = Boolean(toml.search.fts_prefix_matching);
    if (toml.search.embeddings && typeof toml.search.embeddings === "object") {
      const emb = toml.search.embeddings;
      if (emb.enabled != null) config.search.embeddings.enabled = Boolean(emb.enabled);
      if (emb.provider) config.search.embeddings.provider = String(emb.provider) as "openai" | "ollama" | "local";
      if (emb.model) config.search.embeddings.model = String(emb.model);
      if (emb.api_key_env) config.search.embeddings.apiKeyEnv = String(emb.api_key_env);
      if (emb.dim != null) config.search.embeddings.dim = Number(emb.dim);
      if (emb.top_k != null) config.search.embeddings.topK = Number(emb.top_k);
      if (emb.similarity_threshold != null) config.search.embeddings.similarityThreshold = Number(emb.similarity_threshold);
      if (emb.batch_size != null) config.search.embeddings.batchSize = Number(emb.batch_size);
      if (emb.request_timeout_ms != null) config.search.embeddings.requestTimeoutMs = Number(emb.request_timeout_ms);
      if (emb.dedup != null) config.search.embeddings.dedup = Boolean(emb.dedup);
      if (emb.dedup_threshold != null) config.search.embeddings.dedupThreshold = Number(emb.dedup_threshold);
      if (emb.dedup_default_mode) config.search.embeddings.dedupDefaultMode = String(emb.dedup_default_mode) as "strict" | "warn" | "off";
      if (emb.dedup_check_on_update != null) config.search.embeddings.dedupCheckOnUpdate = Boolean(emb.dedup_check_on_update);
      if (emb.dedup_max_scan != null) config.search.embeddings.dedupMaxScan = Number(emb.dedup_max_scan);
    }
  }
  if (toml.hooks) {
    if (toml.hooks.trivial_skip != null) config.hooks.trivialSkip = Boolean(toml.hooks.trivial_skip);
    if (toml.hooks.session_start_memories != null) config.hooks.sessionStartMemories = Number(toml.hooks.session_start_memories);
    if (toml.hooks.session_start_pitfalls != null) config.hooks.sessionStartPitfalls = Number(toml.hooks.session_start_pitfalls);
    if (Array.isArray(toml.hooks.custom_trivial_patterns)) config.hooks.customTrivialPatterns = toml.hooks.custom_trivial_patterns.map(String);
    if (toml.hooks.analytics_reminder_interval_sessions != null) {
      config.hooks.analyticsReminderIntervalSessions = Number(toml.hooks.analytics_reminder_interval_sessions);
    }
    if (toml.hooks.session_end_summarize != null) config.hooks.sessionEndSummarize = Boolean(toml.hooks.session_end_summarize);
    if (toml.hooks.session_end_min_captures != null) config.hooks.sessionEndMinCaptures = Number(toml.hooks.session_end_min_captures);
    if (toml.hooks.session_end_max_body_tokens != null) config.hooks.sessionEndMaxBodyTokens = Number(toml.hooks.session_end_max_body_tokens);
    if (toml.hooks.session_end_keep_originals != null) config.hooks.sessionEndKeepOriginals = Boolean(toml.hooks.session_end_keep_originals);
    if (toml.hooks.summarize_mode) config.hooks.summarizeMode = String(toml.hooks.summarize_mode) as "deterministic" | "llm";
    if (toml.hooks.session_end_llm && typeof toml.hooks.session_end_llm === "object") {
      const llm = toml.hooks.session_end_llm;
      if (llm.provider) config.hooks.sessionEndLlm.provider = String(llm.provider) as "anthropic" | "openai";
      if (llm.model) config.hooks.sessionEndLlm.model = String(llm.model);
      if (llm.api_key_env) config.hooks.sessionEndLlm.apiKeyEnv = String(llm.api_key_env);
      if (llm.max_input_tokens != null) config.hooks.sessionEndLlm.maxInputTokens = Number(llm.max_input_tokens);
      if (llm.max_output_tokens != null) config.hooks.sessionEndLlm.maxOutputTokens = Number(llm.max_output_tokens);
      if (llm.request_timeout_ms != null) config.hooks.sessionEndLlm.requestTimeoutMs = Number(llm.request_timeout_ms);
      if (llm.fallback_to_deterministic != null) config.hooks.sessionEndLlm.fallbackToDeterministic = Boolean(llm.fallback_to_deterministic);
    }
  }
  if (toml.pruning) {
    if (toml.pruning.enabled != null) config.pruning.enabled = Boolean(toml.pruning.enabled);
    if (toml.pruning.max_age_days != null) config.pruning.maxAgeDays = Number(toml.pruning.max_age_days);
    if (toml.pruning.min_importance != null) config.pruning.minImportance = Number(toml.pruning.min_importance);
    if (toml.pruning.interval_hours != null) config.pruning.intervalHours = Number(toml.pruning.interval_hours);
  }
  if (toml.database) {
    if (toml.database.path) config.database.path = String(toml.database.path);
  }
  if (toml.vault) {
    const v = toml.vault;
    if (v.enabled != null) config.vault.enabled = Boolean(v.enabled);
    if (v.path) config.vault.path = String(v.path);
    if (Array.isArray(v.include_folders)) config.vault.includeFolders = v.include_folders.map(String);
    if (Array.isArray(v.exclude_folders)) config.vault.excludeFolders = v.exclude_folders.map(String);
    if (v.require_publish_flag != null) config.vault.requirePublishFlag = Boolean(v.require_publish_flag);
    if (Array.isArray(v.root_notes)) config.vault.rootNotes = v.root_notes.map(String);
    if (v.max_hops != null) config.vault.maxHops = Number(v.max_hops);
    if (v.max_results != null) config.vault.maxResults = Number(v.max_results);
    if (v.hook_max_results != null) config.vault.hookMaxResults = Number(v.hook_max_results);
    if (Array.isArray(v.auto_promote_types)) config.vault.autoPromoteTypes = v.auto_promote_types.map(String);
  }
  if (toml.decay) {
    if (toml.decay.type) config.decay.type = toml.decay.type;
    if (toml.decay.half_life_days != null) config.decay.halfLifeDays = Number(toml.decay.half_life_days);
  }
  if (toml.auto_capture) {
    const a = toml.auto_capture;
    if (a.enabled != null) config.autoCapture.enabled = Boolean(a.enabled);
    if (a.min_output_length != null) config.autoCapture.minOutputLength = Number(a.min_output_length);
    if (a.max_output_length != null) config.autoCapture.maxOutputLength = Number(a.max_output_length);
    if (a.cooldown_seconds != null) config.autoCapture.cooldownSeconds = Number(a.cooldown_seconds);
    if (a.dedup_similarity_threshold != null) config.autoCapture.dedupSimilarityThreshold = Number(a.dedup_similarity_threshold);
    if (a.max_per_session != null) config.autoCapture.maxPerSession = Number(a.max_per_session);
    if (a.default_importance != null) config.autoCapture.defaultImportance = Number(a.default_importance);
    if (Array.isArray(a.tools)) config.autoCapture.tools = a.tools.map(String);
    if (a.session_timeout_seconds != null) config.autoCapture.sessionTimeoutSeconds = Number(a.session_timeout_seconds);
  }
  if (toml.compression) {
    const c = toml.compression;
    if (c.enabled != null) config.compression.enabled = Boolean(c.enabled);
    if (c.memory_count_threshold != null) config.compression.memoryCountThreshold = Number(c.memory_count_threshold);
    if (c.auto_capture_batch_threshold != null) config.compression.autoCaptureBatchThreshold = Number(c.auto_capture_batch_threshold);
    if (c.staleness_days != null) config.compression.stalenessDays = Number(c.staleness_days);
    if (c.cluster_similarity_threshold != null) config.compression.clusterSimilarityThreshold = Number(c.cluster_similarity_threshold);
    if (c.min_cluster_size != null) config.compression.minClusterSize = Number(c.min_cluster_size);
    if (c.max_body_ratio != null) config.compression.maxBodyRatio = Number(c.max_body_ratio);
    if (c.temporal_window_hours != null) config.compression.temporalWindowHours = Number(c.temporal_window_hours);
  }
  if (toml.adaptive) {
    const ad = toml.adaptive;
    if (ad.enabled != null) config.adaptive.enabled = Boolean(ad.enabled);
    if (ad.utility_window_minutes != null) config.adaptive.utilityWindowMinutes = Number(ad.utility_window_minutes);
    if (ad.decay_half_life_days != null) config.adaptive.decayHalfLifeDays = Number(ad.decay_half_life_days);
    if (ad.min_injections_for_confidence != null) config.adaptive.minInjectionsForConfidence = Number(ad.min_injections_for_confidence);
    if (ad.neutral_utility_score != null) config.adaptive.neutralUtilityScore = Number(ad.neutral_utility_score);
    if (ad.score_weights && typeof ad.score_weights === "object") {
      const w = ad.score_weights;
      if (w.fts_relevance != null) config.adaptive.scoreWeights.ftsRelevance = Number(w.fts_relevance);
      if (w.importance != null) config.adaptive.scoreWeights.importance = Number(w.importance);
      if (w.decay != null) config.adaptive.scoreWeights.decay = Number(w.decay);
      if (w.utility != null) config.adaptive.scoreWeights.utility = Number(w.utility);
      if (w.recency_bonus != null) config.adaptive.scoreWeights.recencyBonus = Number(w.recency_bonus);
    }
  }
  if (toml.analytics) {
    const an = toml.analytics;
    if (an.enabled != null) config.analytics.enabled = Boolean(an.enabled);
    if (an.flush_threshold != null) config.analytics.flushThreshold = Number(an.flush_threshold);
    if (an.retention_days != null) config.analytics.retentionDays = Number(an.retention_days);
    if (an.prune_check_interval != null) config.analytics.pruneCheckInterval = Number(an.prune_check_interval);
  }
  if (toml.file_memory) {
    if (toml.file_memory.cache_ttl_seconds != null) config.fileMemory.cacheTtlSeconds = Number(toml.file_memory.cache_ttl_seconds);
    if (toml.file_memory.enabled != null) config.fileMemory.enabled = Boolean(toml.file_memory.enabled);
  }
  if (toml.sync) {
    const s = toml.sync;
    if (s.enabled != null) config.sync.enabled = Boolean(s.enabled);
    if (s.auto_push_on_store != null) config.sync.autoPushOnStore = Boolean(s.auto_push_on_store);
    if (s.folder) config.sync.folder = String(s.folder);
    if (s.include_private_in_files != null) config.sync.includePrivateInFiles = Boolean(s.include_private_in_files);
    if (s.max_future_drift_hours != null) config.sync.maxFutureDriftHours = Number(s.max_future_drift_hours);
    if (s.schema_version != null) config.sync.schemaVersion = Number(s.schema_version);
  }
  if (toml.profile) {
    const p = toml.profile;
    if (p.id) config.profile.id = String(p.id);
    if (Array.isArray(p.extra_stop_words)) config.profile.extraStopWords = p.extra_stop_words.map(String);
    if (Array.isArray(p.extra_trivial_patterns)) config.profile.extraTrivialPatterns = p.extra_trivial_patterns.map(String);
    if (p.locale) config.profile.locale = String(p.locale);
  }

  return applyEnvOverrides(config);
}

function applyEnvOverrides(config: Config): Config {
  if (process.env.MEMENTO_BUDGET) config.budget.total = Number(process.env.MEMENTO_BUDGET);
  if (process.env.MEMENTO_FLOOR) config.budget.floor = Number(process.env.MEMENTO_FLOOR);
  if (process.env.MEMENTO_REFILL) config.budget.refill = Number(process.env.MEMENTO_REFILL);
  if (process.env.MEMENTO_SESSION_TIMEOUT) config.budget.sessionTimeout = Number(process.env.MEMENTO_SESSION_TIMEOUT);
  return config;
}

export function getDefaultDataDir(): string {
  const p = platform();
  if (p === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "memento-mcp");
  if (p === "darwin") return join(homedir(), "Library", "Application Support", "memento-mcp");
  return join(homedir(), ".local", "share", "memento-mcp");
}

export function getDefaultConfigPath(): string {
  const p = platform();
  if (p === "win32") return join(getDefaultDataDir(), "config.toml");
  if (p === "darwin") return join(getDefaultDataDir(), "config.toml");
  return join(homedir(), ".config", "memento-mcp", "config.toml");
}

export function getDefaultDbPath(): string {
  return join(getDefaultDataDir(), "memento.sqlite");
}
