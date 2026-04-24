import { readFileSync, statSync } from "node:fs";

export interface ParsedFileMemory {
  title: string;
  description: string;
  body: string;
  memory_type: string;
  filepath: string;
}

interface CacheEntry {
  mtime: number;
  memories: ParsedFileMemory[];
  cachedAt: number;
}

function parseFileMemory(filepath: string): ParsedFileMemory | null {
  try {
    const content = readFileSync(filepath, "utf-8");
    const basename = filepath.split(/[\\/]/).pop()?.replace(/\.md$/, "") ?? "unknown";
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

    return { title, description, body: body.trim(), memory_type: memoryType, filepath };
  } catch {
    return null;
  }
}

export class FileMemoryCache {
  private entries = new Map<string, CacheEntry>();
  private hitCount = 0;

  constructor(private ttl: number = 60_000) {}

  hits(): number {
    return this.hitCount;
  }

  clear(): void {
    this.entries.clear();
    this.hitCount = 0;
  }

  getFileMemories(paths: string[]): ParsedFileMemory[] {
    const results: ParsedFileMemory[] = [];
    const now = Date.now();

    for (const path of paths) {
      let stat;
      try {
        stat = statSync(path);
      } catch {
        this.entries.delete(path);
        continue;
      }

      const cached = this.entries.get(path);
      if (
        cached &&
        this.ttl > 0 &&
        now - cached.cachedAt < this.ttl &&
        stat.mtimeMs === cached.mtime
      ) {
        this.hitCount++;
        results.push(...cached.memories);
        continue;
      }

      const parsed = parseFileMemory(path);
      const memories = parsed ? [parsed] : [];

      if (this.ttl > 0) {
        this.entries.set(path, { mtime: stat.mtimeMs, memories, cachedAt: now });
      }
      results.push(...memories);
    }

    return results;
  }
}
