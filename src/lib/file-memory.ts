// src/lib/file-memory.ts
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { FileMemoryCache } from "../engine/file-memory-cache.js";

const DEFAULT_CLAUDE_PROJECTS = join(homedir(), ".claude", "projects");

function sanitizePath(projectPath: string): string {
  return projectPath.replace(/\//g, "-");
}

interface FileMemory {
  id: string;
  title: string;
  description: string;
  body: string;
  memory_type: string;
  scope: string;
  source: string;
  filepath: string;
  score?: number;
}

// Module-level cache singleton. TTL defaults to 60s; server configures it at
// startup via configureFileMemoryCache() so the user-facing file_memory.cache_ttl_seconds
// TOML key flows through.
let cache = new FileMemoryCache(60_000);

export function configureFileMemoryCache(ttlSeconds: number): void {
  cache = new FileMemoryCache(Math.max(0, ttlSeconds) * 1000);
}

export function clearFileMemoryCache(): void {
  cache.clear();
}

function toFileMemory(parsed: { title: string; description: string; body: string; memory_type: string; filepath: string }): FileMemory {
  return {
    id: `file:${parsed.filepath}`,
    title: parsed.title,
    description: parsed.description,
    body: parsed.body,
    memory_type: parsed.memory_type,
    scope: "project",
    source: "file",
    filepath: parsed.filepath,
  };
}

export function readFileMemories(projectPath?: string, claudeProjectsDir?: string): FileMemory[] {
  const baseDir = claudeProjectsDir ?? DEFAULT_CLAUDE_PROJECTS;
  if (!existsSync(baseDir)) return [];

  const results: FileMemory[] = [];
  const dirs: string[] = [];

  if (projectPath) {
    const sanitized = sanitizePath(projectPath);
    const memDir = join(baseDir, sanitized, "memory");
    if (existsSync(memDir)) dirs.push(memDir);
  } else {
    try {
      for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const memDir = join(baseDir, entry.name, "memory");
          if (existsSync(memDir)) dirs.push(memDir);
        }
      }
    } catch { /* ignore */ }
  }

  const paths: string[] = [];
  for (const dir of dirs) {
    try {
      for (const file of readdirSync(dir)) {
        if (file.endsWith(".md") && file !== "MEMORY.md") {
          paths.push(join(dir, file));
        }
      }
    } catch { /* ignore */ }
  }

  for (const parsed of cache.getFileMemories(paths)) {
    results.push(toFileMemory(parsed));
  }

  return results;
}

export function searchFileMemories(query: string, projectPath?: string, claudeProjectsDir?: string): FileMemory[] {
  const memories = readFileMemories(projectPath, claudeProjectsDir);
  const queryTokens = new Set(query.toLowerCase().split(/\s+/).filter(Boolean));
  if (!queryTokens.size) return [];

  const scored: FileMemory[] = [];
  for (const mem of memories) {
    const text = `${mem.title} ${mem.body}`.toLowerCase();
    const textTokens = new Set(text.split(/\s+/));
    let overlap = 0;
    for (const qt of queryTokens) {
      if (textTokens.has(qt)) overlap++;
    }
    if (overlap > 0) {
      mem.score = overlap / queryTokens.size;
      scored.push(mem);
    }
  }

  return scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}
