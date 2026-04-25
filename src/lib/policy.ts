// src/lib/policy.ts — per-project .memento/policy.toml discovery, parsing, and caching.
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { createLogger, logLevelFromEnv } from "./logger.js";

const logger = createLogger(logLevelFromEnv());

export interface ProjectPolicy {
  schemaVersion: number;
  rootPath: string;
  requiredTagsAnyOf: string[];           // empty array = no requirement
  requiredTagsAllOf: string[][];         // each inner group: at least one must match
  bannedContent: RegExp[];
  retention: { maxAgeDays?: number; minImportance?: number };
  defaultImportanceByType: Record<string, number>;
  autoPromoteToVaultTypes: string[];
  extraStopWords: string[];
  policyFilePath: string;               // path to the policy file that was loaded
}

interface CacheEntry {
  policy: ProjectPolicy | null;
  mtimeMs: number;
  cachedAt: number;
}

// Cache keyed by resolved file path (for existing files)
const fileCache = new Map<string, CacheEntry>();
// Cache keyed by startDir (for "no file found" results)
const noFileCache = new Map<string, { cachedAt: number }>();

const CACHE_TTL_MS = 60_000;

/**
 * ReDoS guard: compile a user-provided regex pattern safely.
 * Rejects patterns longer than 200 chars OR containing nested quantifiers.
 * Returns null if invalid (caller should log warning and skip).
 */
export function compileSafeRegex(p: string): RegExp | null {
  if (typeof p !== "string" || p.length === 0 || p.length > 200) return null;
  // Reject patterns with nested quantifiers (catastrophic backtrack risk):
  // matches things like (a+)+ or (a){n,}+
  if (/(\([^)]*[+*][^)]*\)[+*]|\([^)]*\)\{[^}]*,\s*\}[+*])/.test(p)) return null;
  try {
    return new RegExp(p);
  } catch {
    return null;
  }
}

/**
 * Find the policy file starting from `startDir`, walking up to stopAt (default: home dir).
 * Tries `.memento/policy.toml` first, then `.memento.toml` at each level.
 * Applies symlink safety: aborts if resolved path is outside home dir AND /tmp.
 */
export function findPolicyFile(startDir: string, stopAt?: string): string | null {
  const home = os.homedir();
  const stop = stopAt ?? home;

  let resolvedStart: string;
  try {
    resolvedStart = fs.realpathSync(startDir);
  } catch {
    return null;
  }

  // Symlink safety: only allow walks within home dir or /tmp (for tests)
  if (!resolvedStart.startsWith(home) && !resolvedStart.startsWith("/tmp")) {
    return null;
  }

  let dir = resolvedStart;
  for (let i = 0; i < 50; i++) {
    // Try .memento/policy.toml first (primary)
    const primary = join(dir, ".memento", "policy.toml");
    try {
      fs.statSync(primary);
      return primary;
    } catch { /* not found */ }

    // Try .memento.toml fallback
    const fallback = join(dir, ".memento.toml");
    try {
      fs.statSync(fallback);
      return fallback;
    } catch { /* not found */ }

    if (dir === stop || dir === "/" || dir === ".") return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Load the project policy for a given directory.
 * Uses mtime-aware cache with 60s TTL.
 * "No file found" results are also cached per startDir.
 */
export function loadProjectPolicy(startDir: string): ProjectPolicy | null {
  // Check "no file found" cache first
  const noFile = noFileCache.get(startDir);
  if (noFile && Date.now() - noFile.cachedAt < CACHE_TTL_MS) {
    return null;
  }

  const file = findPolicyFile(startDir);
  if (!file) {
    noFileCache.set(startDir, { cachedAt: Date.now() });
    return null;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    noFileCache.set(startDir, { cachedAt: Date.now() });
    return null;
  }

  const cached = fileCache.get(file);
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    Date.now() - cached.cachedAt < CACHE_TTL_MS
  ) {
    return cached.policy;
  }

  try {
    const raw = parseToml(fs.readFileSync(file, "utf-8")) as Record<string, any>;
    const rootPath = dirname(file).endsWith(".memento")
      ? dirname(dirname(file))
      : dirname(file);
    const policy = parseProjectPolicy(raw, rootPath, file);
    fileCache.set(file, { policy, mtimeMs: stat.mtimeMs, cachedAt: Date.now() });
    return policy;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Failed to parse policy file ${file}: ${msg}`);
    fileCache.set(file, { policy: null, mtimeMs: stat.mtimeMs, cachedAt: Date.now() });
    return null;
  }
}

function parseProjectPolicy(raw: Record<string, any>, rootPath: string, policyFilePath: string): ProjectPolicy {
  const schemaVersion = Number(raw.schema_version ?? 1);
  if (schemaVersion > 1) {
    logger.warn(`Policy file ${policyFilePath} has schema_version=${schemaVersion} > 1; falling back to v1 parsing.`);
  }

  const bannedPatterns: RegExp[] = [];
  if (Array.isArray(raw.banned_content?.patterns)) {
    for (const p of raw.banned_content.patterns) {
      if (typeof p !== "string") continue;
      const re = compileSafeRegex(p);
      if (re === null) {
        logger.warn(`Policy file ${policyFilePath}: skipping invalid/unsafe regex pattern: ${p}`);
      } else {
        bannedPatterns.push(re);
      }
    }
  }

  const defaultImportanceByType: Record<string, number> = {};
  if (typeof raw.default_importance_by_type === "object" && raw.default_importance_by_type !== null) {
    for (const [k, v] of Object.entries(raw.default_importance_by_type)) {
      if (typeof v === "number") defaultImportanceByType[k] = v;
    }
  }

  return {
    schemaVersion,
    rootPath,
    policyFilePath,
    requiredTagsAnyOf: Array.isArray(raw.required_tags?.any_of)
      ? raw.required_tags.any_of.map(String)
      : [],
    requiredTagsAllOf: Array.isArray(raw.required_tags?.all_of)
      ? raw.required_tags.all_of.filter(Array.isArray).map((g: unknown[]) => g.map(String))
      : [],
    bannedContent: bannedPatterns,
    retention: {
      maxAgeDays: typeof raw.retention?.max_age_days === "number" ? raw.retention.max_age_days : undefined,
      minImportance: typeof raw.retention?.min_importance === "number" ? raw.retention.min_importance : undefined,
    },
    defaultImportanceByType,
    autoPromoteToVaultTypes: Array.isArray(raw.auto_promote_to_vault?.types)
      ? raw.auto_promote_to_vault.types.map(String)
      : [],
    extraStopWords: Array.isArray(raw.profile?.extra_stop_words)
      ? raw.profile.extra_stop_words.map(String)
      : [],
  };
}

/**
 * Collect policies for all projects in the DB.
 * Reads root_path from each project row, loads policy if the path still exists.
 * Used by the maintenance loop for per-project pruning.
 */
export function collectPoliciesPerProject(
  db: import("better-sqlite3").Database
): Array<{ projectId: string; rootPath: string; policy: ProjectPolicy }> {
  const results: Array<{ projectId: string; rootPath: string; policy: ProjectPolicy }> = [];
  try {
    const rows = db.prepare("SELECT id, root_path FROM projects WHERE root_path IS NOT NULL").all() as Array<{ id: string; root_path: string }>;
    for (const row of rows) {
      if (!row.root_path) continue;
      // Skip if path no longer exists
      try {
        fs.statSync(row.root_path);
      } catch {
        continue;
      }
      const policy = loadProjectPolicy(row.root_path);
      if (policy) {
        results.push({ projectId: row.id, rootPath: row.root_path, policy });
      }
    }
  } catch (e) {
    logger.warn(`collectPoliciesPerProject error: ${e}`);
  }
  return results;
}

/** Clear caches — useful in tests */
export function clearPolicyCache(): void {
  fileCache.clear();
  noFileCache.clear();
}

/** The rich-commented template for `policy init` */
export const POLICY_INIT_TEMPLATE = `# Project-scoped memento policy. Check this file into version control.
# Generated by: memento-mcp policy init
# Documentation: https://github.com/lfrmonteiro99/memento-mcp#per-project-policy
#
# Primary location: .memento/policy.toml
# Fallback location (back-compat): .memento.toml
#
# ALL sections are optional. Missing keys use the global default.
# Policy can ONLY tighten global settings — it cannot loosen them.

schema_version = 1

# ---------------------------------------------------------------------------
# [required_tags]
# Enforce that every new memory includes at least one tag from a list.
# any_of: at least one tag from this flat list must be present.
# all_of: array of groups — at least one tag from EACH group must be present.
# ---------------------------------------------------------------------------
# [required_tags]
# any_of = ["area:auth", "area:db", "area:ui", "area:infra"]
# all_of = [["env:dev", "env:prod", "env:staging"]]

# ---------------------------------------------------------------------------
# [banned_content]
# Refuse memories whose title, body, OR tags match any of these regex patterns.
# Patterns are ECMAScript (JavaScript) regex syntax.
# For case-insensitive matching, use (?i:...) inline groups or write patterns in lowercase.
# Note: Node.js v22 supports (?i:pattern) inline flag syntax.
# Patterns longer than 200 chars or with nested quantifiers are rejected for safety.
# ---------------------------------------------------------------------------
# [banned_content]
# patterns = [
#   'internal-tool-name-x',
#   '\\bcustomer\\s+data\\b',
# ]

# ---------------------------------------------------------------------------
# [retention]
# Per-project retention overrides (can only tighten, not loosen, global limits).
# max_age_days: delete memories older than this many days (if importance < min_importance).
# min_importance: memories below this score are candidates for pruning.
# ---------------------------------------------------------------------------
# [retention]
# max_age_days = 180
# min_importance = 0.4

# ---------------------------------------------------------------------------
# [default_importance_by_type]
# Default importance score for new memories by memory_type, when not explicitly set.
# Supported types: decision, architecture, pattern, fact, preference, pitfall, etc.
# ---------------------------------------------------------------------------
# [default_importance_by_type]
# decision = 0.7
# architecture = 0.7
# pattern = 0.6
# fact = 0.4
# preference = 0.5

# ---------------------------------------------------------------------------
# [auto_promote_to_vault]
# Automatically set persist_to_vault = true for memories of these types.
# Requires vault to be enabled in global config.
# ---------------------------------------------------------------------------
# [auto_promote_to_vault]
# types = ["architecture", "decision"]

# ---------------------------------------------------------------------------
# [profile]
# extra_stop_words: additional words to exclude from keyword extraction for this project.
# Useful for suppressing project-specific jargon that would otherwise dominate search.
# ---------------------------------------------------------------------------
# [profile]
# extra_stop_words = ["myproject", "internal", "deprecated"]
`;
