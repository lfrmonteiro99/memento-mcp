// src/lib/import-shared.ts — shared helpers for `memento-mcp import <format>`.
// Hosts: argv flag parser, YAML-frontmatter stripper (flat scalars + simple lists),
// frontmatter→tags mapper, alphabetical directory walker, and the policy/dedup/store
// pipeline that every format subcommand drives.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import type { ImportSection } from "./import-claude-md.js";

export interface ImportFlags {
  importPath?: string;
  scope: "global" | "project";
  defaultType: string;
  dryRun: boolean;
  noConfirm: boolean;
}

export function parseImportFlags(args: string[]): ImportFlags {
  let importPath: string | undefined;
  let scope: "global" | "project" = "project";
  let defaultType = "fact";
  let dryRun = false;
  let noConfirm = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--scope" && args[i + 1]) {
      scope = args[++i] as "global" | "project";
    } else if (args[i] === "--type" && args[i + 1]) {
      defaultType = args[++i];
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--no-confirm") {
      noConfirm = true;
    } else if (!importPath && !args[i].startsWith("--")) {
      importPath = args[i];
    }
  }

  return { importPath, scope, defaultType, dryRun, noConfirm };
}

export interface FrontmatterResult {
  fm: Record<string, string>;
  body: string;
}

/**
 * Strip a leading `---\n...\n---\n` YAML frontmatter block.
 * Parses only flat `key: value` lines. Values may be:
 *   - plain scalars
 *   - quoted strings ("..." or '...')
 *   - bracketed lists: `[a, b, "c"]` (stored as a single comma-joined string)
 *   - bare comma-separated lists: `a, b, c`
 * Lines beginning with `#` are ignored.
 *
 * If the frontmatter is malformed (no closing `---`), returns the original
 * content as body and an empty fm — never throws.
 */
export function stripFrontmatter(content: string): FrontmatterResult {
  // Normalize CRLF for the leading-marker check; preserve the source body otherwise.
  const normalized = content.replace(/^﻿/, "");
  if (!/^---\s*\r?\n/.test(normalized)) {
    return { fm: {}, body: content };
  }

  // Find the closing `---` on its own line.
  const lines = normalized.split(/\r?\n/);
  if (lines[0].trim() !== "---") return { fm: {}, body: content };

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { endIdx = i; break; }
  }
  if (endIdx === -1) return { fm: {}, body: content };

  const fm: Record<string, string> = {};
  for (let i = 1; i < endIdx; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = raw.indexOf(":");
    if (colon < 0) continue;
    const key = raw.slice(0, colon).trim();
    if (!key) continue;
    let value = raw.slice(colon + 1).trim();
    let strippedBrackets = false;
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value.slice(1, -1).trim();
      strippedBrackets = true;
    }
    // Unquote whole-value quoted scalars (single tokens only — never strip
    // outer quotes of a comma-separated list, since each item carries its own).
    if (
      !strippedBrackets &&
      !value.includes(",") &&
      ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2))
    ) {
      value = value.slice(1, -1);
    }
    fm[key] = value;
  }

  const body = lines.slice(endIdx + 1).join("\n");
  return { fm, body };
}

/**
 * Map well-known frontmatter keys to memento tags.
 *   - globs / applyTo → glob:<value> tags (max 5, lowercased, slashes stripped)
 *   - alwaysApply: true → cursor:always
 *
 * Other keys (description, etc.) are routed by the format `read()` itself,
 * not here.
 */
export function frontmatterToTags(fm: Record<string, string>): string[] {
  const tags: string[] = [];

  const globRaw = fm.globs ?? fm.applyTo ?? fm.apply_to;
  if (globRaw) {
    const parts = globRaw
      .split(",")
      .map(p => p.trim().replace(/^["']|["']$/g, "").replace(/\//g, ""))
      .filter(p => p.length > 0)
      .slice(0, 5);
    for (const p of parts) tags.push(`glob:${p.toLowerCase()}`);
  }

  const always = fm.alwaysApply ?? fm.always_apply;
  if (always === "true" || always === "True" || always === "TRUE") {
    tags.push("cursor:always");
  }

  return tags;
}

/**
 * List files in `dir` whose extension is in `exts` (e.g. [".md", ".mdc"]).
 * Returned paths are absolute and sorted alphabetically.
 * If `recursive` is true, descends into subdirectories.
 * Skips dotfiles (basenames starting with `.`).
 * Returns [] if `dir` does not exist.
 */
export function walkRulesDir(dir: string, exts: string[], recursive: boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];

  function walk(d: string) {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (name.startsWith(".")) continue;
      const full = join(d, name);
      let s;
      try { s = statSync(full); } catch { continue; }
      if (s.isDirectory()) {
        if (recursive) walk(full);
        continue;
      }
      if (!s.isFile()) continue;
      const lower = name.toLowerCase();
      if (exts.some(ext => lower.endsWith(ext.toLowerCase()))) {
        out.push(full);
      }
    }
  }

  walk(dir);
  return out.sort();
}

/**
 * Prefix every section title with `[<basename(path)>]` so identical headings
 * across multiple files in a directory don't collide on the title-dedup query.
 */
export function prefixSectionTitles(sections: ImportSection[], path: string): ImportSection[] {
  const tag = `[${basename(path)}]`;
  return sections.map(s => ({ ...s, title: `${tag} ${s.title}` }));
}

export interface PipelineInput {
  sections: ImportSection[];
  skipped: { reason: string; preview: string }[];
  scope: "global" | "project";
  source: string;
  dryRun: boolean;
  noConfirm: boolean;
  sourceLabel: string;
}

export interface PipelineCounts {
  created: number;
  dupes: number;
  policyBlocked: number;
}

/**
 * Drive the print → confirm → policy → dedup → store loop.
 * Each format subcommand calls this once per source file/dir.
 *
 * Behavior (kept identical to the original `import claude-md` handler):
 *   - Prints a section table and skipped lines.
 *   - In dry-run mode, opens no DB and writes nothing.
 *   - Without --no-confirm, prompts on stdin.
 *   - Loads project policy from cwd (required_tags + banned_content).
 *   - Skips by title-in-scope dedup.
 *   - Stores with the supplied `source` and importance 0.6.
 *   - Prints final counts and closes the DB.
 */
export async function runImportPipeline(input: PipelineInput): Promise<PipelineCounts> {
  const { sections, skipped, scope, source, dryRun, noConfirm, sourceLabel } = input;

  console.log(`\nFound ${sections.length} sections (${skipped.length} skipped) in ${sourceLabel}\n`);
  for (const s of sections) {
    console.log(`  [${s.inferredType}] ${s.title}`);
    if (s.inferredTags.length) console.log(`    tags: ${s.inferredTags.join(", ")}`);
  }
  if (skipped.length) {
    console.log(`\nSkipped ${skipped.length}:`);
    for (const sk of skipped) console.log(`  (${sk.reason}) ${sk.preview.slice(0, 60)}...`);
  }

  if (dryRun) {
    console.log("\nDry run — nothing imported.");
    return { created: 0, dupes: 0, policyBlocked: 0 };
  }

  if (!noConfirm) {
    const ok = await (async () => {
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ans = await rl.question(`\nImport ${sections.length} memories? [y/N] `);
      rl.close();
      return /^y(es)?$/i.test(ans.trim());
    })();
    if (!ok) return { created: 0, dupes: 0, policyBlocked: 0 };
  }

  const { loadConfig, getDefaultConfigPath, getDefaultDbPath } = await import("./config.js");
  const { createDatabase } = await import("../db/database.js");
  const { MemoriesRepo } = await import("../db/memories.js");
  const { loadProjectPolicy } = await import("./policy.js");

  const projectRoot = process.cwd();
  const policy = loadProjectPolicy(projectRoot);

  const config = loadConfig(getDefaultConfigPath());
  const db = createDatabase(process.env.MEMENTO_DB_PATH ?? (config.database.path || getDefaultDbPath()));
  const repo = new MemoriesRepo(db);

  let created = 0;
  let dupes = 0;
  let policyBlocked = 0;

  try {
    for (const s of sections) {
      const existing = db.prepare(
        "SELECT id FROM memories WHERE title = ? AND scope = ? AND deleted_at IS NULL LIMIT 1"
      ).get(s.title, scope) as { id: string } | undefined;
      if (existing) { dupes++; continue; }

      if (policy && policy.requiredTagsAnyOf.length > 0) {
        const hasAny = policy.requiredTagsAnyOf.some(t => s.inferredTags.includes(t));
        if (!hasAny) {
          policyBlocked++;
          console.log(`  POLICY SKIP (required_tags.any_of not met): ${s.title}`);
          continue;
        }
      }

      if (policy && policy.bannedContent.length > 0) {
        const combined = `${s.title}\n${s.body}\n${s.inferredTags.join(" ")}`;
        const banned = policy.bannedContent.some(re => re.test(combined));
        if (banned) {
          policyBlocked++;
          console.log(`  POLICY SKIP (banned content): ${s.title}`);
          continue;
        }
      }

      repo.store({
        title: s.title,
        body: s.body,
        memoryType: s.inferredType,
        scope,
        tags: s.inferredTags,
        importance: 0.6,
        source,
      });
      created++;
    }
  } finally {
    db.close();
  }

  console.log(`\nImported ${created} memories (${dupes} duplicate(s) skipped${policyBlocked > 0 ? `, ${policyBlocked} blocked by policy` : ""}).`);
  return { created, dupes, policyBlocked };
}
