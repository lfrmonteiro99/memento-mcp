// src/sync/git-sync.ts — git-backed sync for team-scoped memories.
//
// Design:
//  - No edges[] in v1 JSON schema (triage).
//  - Atomic writes via <id>.json.tmp + rename.
//  - Path traversal guard via assertSafeOutputPath().
//  - Future-timestamp guard on pull (configurable drift).
//  - Hash cache in sync_file_hashes to skip re-reading unchanged files.

import * as fs from "node:fs";
import * as path from "node:path";
import type Database from "better-sqlite3";
import type { SyncConfig } from "../lib/config.js";
import { nowIso } from "../db/database.js";
import { SyncStateRepo } from "../db/sync-state.js";
import { serializeMemory, parseMemoryFile, hashMemoryJson } from "./serialize.js";
import { createLogger, logLevelFromEnv } from "../lib/logger.js";

const logger = createLogger(logLevelFromEnv());

export interface SyncStatus {
  fileOnly: string[];         // memory ids in files but not in DB
  dbOnly: string[];           // in DB (scope=team) but no file
  conflicting: Array<{ id: string; dbUpdatedAt: string; fileUpdatedAt: string }>;
  inSync: number;
}

export interface PushResult {
  written: number;
  deleted: number;
  skipped: number;
}

export interface PullResult {
  created: number;
  updated: number;
  skipped: number;
  warnings: string[];
}

/**
 * Path traversal guard.
 * Returns the resolved target file path.
 * Throws if either targetDir is outside projectRoot or targetFile is outside targetDir.
 */
export function assertSafeOutputPath(
  projectRoot: string,
  syncFolder: string,
  memoryId: string,
): string {
  const root = path.resolve(projectRoot);
  const targetDir = path.resolve(root, syncFolder, "memories");
  const targetFile = path.resolve(targetDir, `${memoryId}.json`);

  if (!targetDir.startsWith(root + path.sep)) {
    throw new Error(`unsafe sync folder: ${targetDir} is outside project root ${root}`);
  }
  if (!targetFile.startsWith(targetDir + path.sep)) {
    throw new Error(`unsafe sync path: ${targetFile} is outside ${targetDir}`);
  }
  return targetFile;
}

/**
 * Initialize .memento/ structure in projectRoot.
 * Creates .memento/memories/, .memento/README.md and .memento/.gitignore.
 * Does NOT touch existing .memento/policy.toml.
 */
export function init(projectRoot: string, syncFolder = ".memento"): void {
  const root = path.resolve(projectRoot);
  const mementoDir = path.join(root, syncFolder);
  const memoriesDir = path.join(mementoDir, "memories");

  fs.mkdirSync(memoriesDir, { recursive: true });

  // Write README.md (always overwrite to get latest content)
  const readmePath = path.join(mementoDir, "README.md");
  const readmeContent = `# .memento — Team Memory Store

This folder is managed by [memento-mcp](https://github.com/lfrmonteiro99/memento-mcp).

Files under \`memories/\` are JSON snapshots of team-scoped memories. They are
intended to be committed and shared via git so the whole team benefits from
accumulated project knowledge.

## Workflow

\`\`\`sh
# Store a team memory (use scope="team" in your MCP client)
# Then sync to files:
memento-mcp sync push

# Commit and push to share:
git add .memento && git commit -m "memory: <summary>" && git push

# On another machine, pull new memories:
git pull
memento-mcp sync pull
\`\`\`

## Before you commit

> **Warning**
> Files under \`.memento/memories/\` contain content from your team-shared memories.
> Review them before pushing to a public remote. Set \`[sync].include_private_in_files = false\`
> (default) in your memento-mcp config to redact \`<private>\` regions on write.

To copy-paste when staging:

\`\`\`sh
git add .memento
\`\`\`

## Conflict policy

Last-write-wins by \`updated_at\`. Tiebreaker: the file wins (you just \`git pull\`ed it).

\`pull\` does NOT delete DB memories that have no corresponding file — only modifications
are mirrored. Deletions propagate via the soft-delete field: a file with \`deleted_at\`
set will mark the DB row as deleted on pull.

## Schema

Each \`memories/<id>.json\` file is canonical JSON (sorted keys, 2-space indent, trailing
newline) — minimal diffs. Schema version 1 contains memory fields only (no edges).
`;
  fs.writeFileSync(readmePath, readmeContent, "utf-8");

  // Write .gitignore for the .memento folder (placeholder — no files are ignored by default)
  const gitignorePath = path.join(mementoDir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    const gitignoreContent = `# memento-mcp sync folder
# By default all files here are tracked by git.
# Add entries below if you want to exclude specific files.
# Example: *.tmp
*.tmp
`;
    fs.writeFileSync(gitignorePath, gitignoreContent, "utf-8");
  }
}

/**
 * Push all team-scoped memories from DB to files.
 */
export async function push(opts: {
  db: Database.Database;
  projectRoot: string;
  dryRun: boolean;
  config: SyncConfig;
}): Promise<PushResult> {
  const { db, projectRoot, dryRun, config } = opts;
  const root = path.resolve(projectRoot);
  const memoriesDir = path.resolve(root, config.folder, "memories");

  if (!dryRun) {
    fs.mkdirSync(memoriesDir, { recursive: true });
  }

  // Find the project_id for this root
  const projectRow = db.prepare("SELECT id FROM projects WHERE root_path = ?").get(root) as { id: string } | undefined;
  if (!projectRow) {
    logger.warn(`sync push: no project found for root ${root}`);
    return { written: 0, deleted: 0, skipped: 0 };
  }
  const projectId = projectRow.id;
  const syncRepo = new SyncStateRepo(db);

  const rows = db.prepare(
    "SELECT * FROM memories WHERE project_id = ? AND scope = 'team'"
  ).all(projectId) as Array<Record<string, unknown>>;

  let written = 0;
  let deleted = 0;
  let skipped = 0;

  for (const row of rows) {
    const memId = String(row.id ?? "");
    if (!memId) continue;

    const json = serializeMemory(row, { includePrivate: config.includePrivateInFiles });
    const hash = hashMemoryJson(json);

    // Check cache — skip if hash unchanged
    const cachedHash = syncRepo.getFileHash(projectId, memId);
    if (cachedHash === hash) {
      skipped++;
      continue;
    }

    if (dryRun) {
      written++;
      continue;
    }

    // Use assertSafeOutputPath for path traversal guard
    const targetFile = assertSafeOutputPath(root, config.folder, memId);
    const tmpFile = targetFile + ".tmp";

    // Verify tmpFile is also safe (same directory, just with .tmp suffix)
    const safeDir = path.resolve(root, config.folder, "memories");
    if (!tmpFile.startsWith(safeDir + path.sep)) {
      throw new Error(`unsafe tmp path: ${tmpFile}`);
    }

    try {
      fs.writeFileSync(tmpFile, json, "utf-8");
      fs.renameSync(tmpFile, targetFile);
      syncRepo.setFileHash(projectId, memId, hash);
      written++;
    } catch (e) {
      // Clean up tmp file on error
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      throw e;
    }
  }

  if (!dryRun) {
    syncRepo.setLastPush(projectId, nowIso());
  }

  return { written, deleted, skipped };
}

/**
 * Pull memory files from disk into DB.
 * Last-write-wins by updated_at. Tiebreaker: file wins.
 */
export async function pull(opts: {
  db: Database.Database;
  projectRoot: string;
  dryRun: boolean;
  config: SyncConfig;
}): Promise<PullResult> {
  const { db, projectRoot, dryRun, config } = opts;
  const root = path.resolve(projectRoot);
  const memoriesDir = path.resolve(root, config.folder, "memories");

  const warnings: string[] = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;

  if (!fs.existsSync(memoriesDir)) {
    return { created, updated, skipped, warnings };
  }

  const projectRow = db.prepare("SELECT id FROM projects WHERE root_path = ?").get(root) as { id: string } | undefined;
  // If no project exists yet, we'll create it when inserting
  const syncRepo = new SyncStateRepo(db);
  const nowMs = Date.now();
  const maxDriftMs = config.maxFutureDriftHours * 60 * 60 * 1000;

  const files = fs.readdirSync(memoriesDir).filter(f => f.endsWith(".json"));

  for (const filename of files) {
    const memId = filename.replace(/\.json$/, "");
    // Basic id validation — must look like a UUID or simple alphanumeric
    if (!/^[a-zA-Z0-9-]+$/.test(memId)) {
      warnings.push(`skipping ${filename}: id contains invalid characters`);
      continue;
    }

    const filePath = path.join(memoriesDir, filename);

    let fileData: ReturnType<typeof parseMemoryFile>;
    let rawText: string;
    try {
      rawText = fs.readFileSync(filePath, "utf-8");
      fileData = parseMemoryFile(rawText);
    } catch (e) {
      warnings.push(`skipping ${filename}: parse error — ${(e as Error).message}`);
      continue;
    }

    // Future-timestamp guard
    const fileTime = Date.parse(fileData.updated_at);
    if (Number.isNaN(fileTime) || fileTime > nowMs + maxDriftMs) {
      warnings.push(
        `skipping ${fileData.id}: updated_at is more than ${config.maxFutureDriftHours}h in the future (${fileData.updated_at})`
      );
      continue;
    }

    // Compute hash for cache
    const hash = hashMemoryJson(rawText);

    // Find existing DB row (including soft-deleted)
    const existing = db.prepare("SELECT * FROM memories WHERE id = ?").get(memId) as Record<string, unknown> | undefined;

    if (!existing) {
      if (dryRun) {
        created++;
        continue;
      }

      // Resolve or create project
      let projId: string;
      if (projectRow) {
        projId = projectRow.id;
      } else {
        const existingProject = db.prepare("SELECT id FROM projects WHERE root_path = ?").get(root) as { id: string } | undefined;
        if (existingProject) {
          projId = existingProject.id;
        } else {
          const { randomUUID } = await import("node:crypto");
          projId = randomUUID();
          const name = root.split("/").pop() ?? root;
          db.prepare("INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)").run(projId, name, root);
        }
      }

      db.prepare(`
        INSERT INTO memories (
          id, project_id, memory_type, scope, title, body, tags,
          importance_score, is_pinned, supersedes_memory_id, source,
          claude_session_id, has_private, created_at, updated_at, deleted_at,
          last_accessed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'team-sync', ?, ?, ?, ?, ?, ?)
      `).run(
        fileData.id,
        projId,
        fileData.memory_type,
        fileData.scope,
        fileData.title,
        fileData.body,
        fileData.tags.length > 0 ? JSON.stringify(fileData.tags) : null,
        fileData.importance_score,
        fileData.supersedes_memory_id ?? null,
        fileData.claude_session_id ?? null,
        fileData.has_private,
        fileData.created_at,
        fileData.updated_at,
        fileData.deleted_at ?? null,
        fileData.updated_at,
      );

      syncRepo.setFileHash(projId, memId, hash);
      created++;
    } else {
      // Compare updated_at — last-write-wins, tiebreaker: file wins
      const dbUpdatedAt = String(existing.updated_at ?? "");
      const fileUpdatedAt = fileData.updated_at;

      // Check cache — if hash unchanged and times match, skip
      const projId = String(existing.project_id ?? (projectRow?.id ?? ""));
      const cachedHash = projId ? syncRepo.getFileHash(projId, memId) : null;
      if (cachedHash === hash && dbUpdatedAt === fileUpdatedAt) {
        skipped++;
        continue;
      }

      // File wins if fileUpdatedAt >= dbUpdatedAt
      if (fileUpdatedAt >= dbUpdatedAt) {
        if (dryRun) {
          updated++;
          continue;
        }

        db.prepare(`
          UPDATE memories SET
            memory_type = ?, scope = ?, title = ?, body = ?, tags = ?,
            importance_score = ?, supersedes_memory_id = ?, claude_session_id = ?,
            has_private = ?, updated_at = ?, deleted_at = ?
          WHERE id = ?
        `).run(
          fileData.memory_type,
          fileData.scope,
          fileData.title,
          fileData.body,
          fileData.tags.length > 0 ? JSON.stringify(fileData.tags) : null,
          fileData.importance_score,
          fileData.supersedes_memory_id ?? null,
          fileData.claude_session_id ?? null,
          fileData.has_private,
          fileData.updated_at,
          fileData.deleted_at ?? null,
          memId,
        );

        if (projId) syncRepo.setFileHash(projId, memId, hash);
        updated++;
      } else {
        // DB is newer — skip
        skipped++;
      }
    }
  }

  if (!dryRun) {
    const resolvedProjId = projectRow?.id
      ?? (db.prepare("SELECT id FROM projects WHERE root_path = ?").get(root) as { id: string } | undefined)?.id;
    if (resolvedProjId) {
      syncRepo.setLastPull(resolvedProjId, nowIso());
    }
  }

  return { created, updated, skipped, warnings };
}

/**
 * Compute drift between DB state and file state (read-only).
 */
export function status(db: Database.Database, projectRoot: string, syncFolder = ".memento"): SyncStatus {
  const root = path.resolve(projectRoot);
  const memoriesDir = path.resolve(root, syncFolder, "memories");

  const projectRow = db.prepare("SELECT id FROM projects WHERE root_path = ?").get(root) as { id: string } | undefined;
  const projectId = projectRow?.id;

  // Get all team memories from DB
  const dbMemories = new Map<string, string>(); // id -> updated_at
  if (projectId) {
    const rows = db.prepare(
      "SELECT id, updated_at FROM memories WHERE project_id = ? AND scope = 'team'"
    ).all(projectId) as Array<{ id: string; updated_at: string }>;
    for (const r of rows) dbMemories.set(r.id, r.updated_at);
  }

  // Get all memory files on disk
  const fileMemories = new Map<string, string>(); // id -> updated_at
  if (fs.existsSync(memoriesDir)) {
    const files = fs.readdirSync(memoriesDir).filter(f => f.endsWith(".json"));
    for (const filename of files) {
      const memId = filename.replace(/\.json$/, "");
      const filePath = path.join(memoriesDir, filename);
      try {
        const text = fs.readFileSync(filePath, "utf-8");
        const data = parseMemoryFile(text);
        fileMemories.set(memId, data.updated_at);
      } catch {
        // Skip unparseable files in status
      }
    }
  }

  const fileOnly: string[] = [];
  const dbOnly: string[] = [];
  const conflicting: Array<{ id: string; dbUpdatedAt: string; fileUpdatedAt: string }> = [];
  let inSync = 0;

  for (const [id, fileUpdatedAt] of fileMemories) {
    const dbUpdatedAt = dbMemories.get(id);
    if (!dbUpdatedAt) {
      fileOnly.push(id);
    } else if (dbUpdatedAt === fileUpdatedAt) {
      inSync++;
    } else {
      conflicting.push({ id, dbUpdatedAt, fileUpdatedAt });
    }
  }

  for (const [id] of dbMemories) {
    if (!fileMemories.has(id)) {
      dbOnly.push(id);
    }
  }

  return { fileOnly, dbOnly, conflicting, inSync };
}

/**
 * Push a single memory to its file (called from memory-store / update / delete hooks).
 * Wraps in try/catch — filesystem errors log a warning but do NOT propagate.
 */
export async function pushSingleMemory(
  db: Database.Database,
  projectRoot: string,
  memoryId: string,
  config: SyncConfig,
): Promise<void> {
  const root = path.resolve(projectRoot);

  const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(memoryId) as Record<string, unknown> | null;
  if (!row) {
    logger.warn(`pushSingleMemory: memory ${memoryId} not found`);
    return;
  }

  const projectId = String(row.project_id ?? "");
  const syncRepo = new SyncStateRepo(db);
  const memoriesDir = path.resolve(root, config.folder, "memories");
  fs.mkdirSync(memoriesDir, { recursive: true });

  const json = serializeMemory(row, { includePrivate: config.includePrivateInFiles });
  const hash = hashMemoryJson(json);

  const targetFile = assertSafeOutputPath(root, config.folder, memoryId);
  const tmpFile = targetFile + ".tmp";

  // tmpFile safety check
  const safeDir = path.resolve(root, config.folder, "memories");
  if (!tmpFile.startsWith(safeDir + path.sep)) {
    throw new Error(`unsafe tmp path: ${tmpFile}`);
  }

  try {
    fs.writeFileSync(tmpFile, json, "utf-8");
    fs.renameSync(tmpFile, targetFile);
    if (projectId) syncRepo.setFileHash(projectId, memoryId, hash);
  } catch (e) {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    throw e;
  }
}
