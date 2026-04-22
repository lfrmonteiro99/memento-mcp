import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { parse as parseTOML } from "smol-toml";

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

export interface Config {
  budget: { total: number; floor: number; refill: number; sessionTimeout: number };
  search: { defaultDetail: "index" | "full"; maxResults: number; bodyPreviewChars: number };
  hooks: { trivialSkip: boolean; sessionStartMemories: number; sessionStartPitfalls: number; customTrivialPatterns: string[] };
  pruning: { enabled: boolean; maxAgeDays: number; minImportance: number; intervalHours: number };
  database: { path: string };
  vault: VaultConfig;
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

export const DEFAULT_CONFIG: Config = {
  budget: { total: 8000, floor: 500, refill: 200, sessionTimeout: 1800 },
  search: { defaultDetail: "index", maxResults: 10, bodyPreviewChars: 200 },
  hooks: { trivialSkip: true, sessionStartMemories: 5, sessionStartPitfalls: 5, customTrivialPatterns: [] },
  pruning: { enabled: true, maxAgeDays: 60, minImportance: 0.3, intervalHours: 24 },
  database: { path: "" },
  vault: { ...DEFAULT_VAULT_CONFIG },
};

export function loadConfig(configPath: string): Config {
  const config = structuredClone(DEFAULT_CONFIG);

  // Layer 2: TOML file
  try {
    const raw = readFileSync(configPath, "utf-8");
    const toml = parseTOML(raw) as Record<string, any>;
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
    }
    if (toml.hooks) {
      if (toml.hooks.trivial_skip != null) config.hooks.trivialSkip = Boolean(toml.hooks.trivial_skip);
      if (toml.hooks.session_start_memories != null) config.hooks.sessionStartMemories = Number(toml.hooks.session_start_memories);
      if (toml.hooks.session_start_pitfalls != null) config.hooks.sessionStartPitfalls = Number(toml.hooks.session_start_pitfalls);
      if (Array.isArray(toml.hooks.custom_trivial_patterns)) config.hooks.customTrivialPatterns = toml.hooks.custom_trivial_patterns;
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
  } catch {
    // File not found or invalid TOML — use defaults
  }

  // Layer 3: env vars
  if (process.env.MEMENTO_BUDGET) config.budget.total = Number(process.env.MEMENTO_BUDGET);
  if (process.env.MEMENTO_FLOOR) config.budget.floor = Number(process.env.MEMENTO_FLOOR);
  if (process.env.MEMENTO_REFILL) config.budget.refill = Number(process.env.MEMENTO_REFILL);
  if (process.env.MEMENTO_SESSION_TIMEOUT) config.budget.sessionTimeout = Number(process.env.MEMENTO_SESSION_TIMEOUT);

  return config;
}

// Platform path helpers (used by hooks, cli/main, cli/install)
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
