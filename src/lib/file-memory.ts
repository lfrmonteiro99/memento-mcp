// src/lib/file-memory.ts
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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

function parseMemoryFile(filepath: string): FileMemory | null {
  try {
    const content = readFileSync(filepath, "utf-8");
    const basename = filepath.split("/").pop()?.replace(".md", "") ?? "unknown";
    let title = basename;
    let description = "";
    let memoryType = "fact";
    let body = content;

    const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)/);
    if (match) {
      const [, frontmatter, rest] = match;
      body = rest;
      for (const line of frontmatter.split("\n")) {
        if (line.startsWith("name:")) title = line.slice(5).trim();
        else if (line.startsWith("description:")) description = line.slice(12).trim();
        else if (line.startsWith("type:")) memoryType = line.slice(5).trim();
      }
    }

    return { id: `file:${filepath}`, title, description, body: body.trim(), memory_type: memoryType, scope: "project", source: "file", filepath };
  } catch {
    return null;
  }
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

  for (const dir of dirs) {
    try {
      for (const file of readdirSync(dir)) {
        if (file.endsWith(".md") && file !== "MEMORY.md") {
          const parsed = parseMemoryFile(join(dir, file));
          if (parsed) results.push(parsed);
        }
      }
    } catch { /* ignore */ }
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
