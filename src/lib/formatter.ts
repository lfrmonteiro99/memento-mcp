// src/lib/formatter.ts
import type { SourceIndexEntry } from "../sources/source.js";

export interface MemoryRow {
  id: string;
  title: string;
  body?: string;
  memory_type: string;
  source?: string;
  score?: number;
  importance_score?: number;
  created_at?: string;
  [key: string]: any;
}

export function formatIndex(memories: MemoryRow[]): string {
  if (!memories.length) return "No results found.";
  return memories.map(m => {
    const score = typeof m.score === "number" ? m.score.toFixed(2) : "-";
    return `- [${m.memory_type}] ${m.title} (score:${score}, id:${m.id})`;
  }).join("\n");
}

export function formatFull(memories: MemoryRow[], bodyPreviewChars = 200): string {
  if (!memories.length) return "No results found.";
  return memories.map(m => {
    const src = m.source ?? "sqlite";
    const score = typeof m.score === "number" ? m.score.toFixed(2) : "-";
    const lines = [
      `[${src}] (${m.memory_type}) ${m.title}`,
      `  ID: ${m.id}`,
    ];
    if (m.body) {
      const preview = m.body.length > bodyPreviewChars
        ? m.body.slice(0, bodyPreviewChars) + "..."
        : m.body;
      lines.push(`  ${preview}`);
    }
    lines.push(`  Score: ${score} | Created: ${m.created_at ?? "?"}`);
    return lines.join("\n");
  }).join("\n\n");
}

export function formatVaultEntry(entry: SourceIndexEntry): string {
  const score = typeof entry.score === "number" ? entry.score.toFixed(2) : "-";
  const crumb = entry.breadcrumb?.join(" > ") ?? entry.path ?? entry.id;
  const lines = [
    `[vault:${entry.kind ?? "note"}] ${entry.title}`,
    `  Path: ${entry.path ?? entry.id.replace("vault:", "")}`,
    `  Breadcrumb: ${crumb}`,
  ];
  if (entry.summary) lines.push(`  ${entry.summary}`);
  lines.push(`  Score: ${score}`);
  return lines.join("\n");
}

export function formatVaultIndex(entries: SourceIndexEntry[]): string {
  if (!entries.length) return "";
  return entries.map(e => {
    const score = typeof e.score === "number" ? e.score.toFixed(2) : "-";
    return `- [vault:${e.kind ?? "note"}] ${e.title} (score:${score}, id:${e.id})`;
  }).join("\n");
}

export function formatDetail(memory: MemoryRow): string {
  if (!memory) return "Memory not found.";
  return `[${memory.memory_type}] ${memory.title}\nID: ${memory.id}\n\n${memory.body ?? "(no body)"}`;
}

function extractFirstSentences(text: string, count: number): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  return sentences.slice(0, count).join(" ");
}

function parseTags(tags: string | string[] | undefined): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags;
  try { return JSON.parse(tags); } catch { return tags.split(",").map(t => t.trim()); }
}

export function formatSummary(memories: MemoryRow[], maxSentences = 2): string {
  if (!memories.length) return "No results found.";
  return memories.map(m => {
    const lines: string[] = [];
    const score = typeof m.score === "number" ? m.score.toFixed(2) : "-";
    lines.push(`[${m.id}] ${m.title} (score:${score})`);
    if (m.body) {
      lines.push(`  ${extractFirstSentences(m.body, maxSentences)}`);
    }
    const tags = parseTags(m.tags);
    if (tags.length > 0) {
      lines.push(`  Tags: ${tags.slice(0, 5).join(", ")}`);
    }
    return lines.join("\n");
  }).join("\n\n");
}
