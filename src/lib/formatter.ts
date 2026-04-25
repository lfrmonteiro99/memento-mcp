// src/lib/formatter.ts
import type { SourceIndexEntry } from "../sources/source.js";
import { estimateTokensV2 } from "../engine/token-estimator.js";
import { redactPrivate, hasPrivate } from "../engine/privacy.js";
import { createLogger, logLevelFromEnv } from "./logger.js";

const log = createLogger(logLevelFromEnv());

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

/** Apply privacy redaction to a memory body. Warn once if the title contains private tags. */
function safeBody(m: MemoryRow): string | undefined {
  if (m.title && hasPrivate(m.title)) {
    log.warn(`Memory ${m.id} title contains <private> tags — titles are not redacted in output`);
  }
  return m.body !== undefined ? redactPrivate(m.body) : undefined;
}

function formatIndexLine(m: MemoryRow): string {
  const score = typeof m.score === "number" ? m.score.toFixed(2) : "-";
  return `[${m.memory_type}] ${m.title} (score:${score}, id:${m.id})`;
}

export function formatIndex(memories: MemoryRow[]): string {
  if (!memories.length) return "No results found.";
  const lines = memories.map(m => {
    const line = formatIndexLine(m);
    const cost = estimateTokensV2(line);
    return `[${cost}t] ${line}`;
  });

  const totalTokens = memories.reduce((sum, m) => {
    const line = formatIndexLine(m);
    return sum + estimateTokensV2(line);
  }, 0);

  const output = lines.join("\n");
  const hints: string[] = [];

  // Check if any memory has neighbors (rough heuristic: assume memories created within 2h window have neighbors)
  const hasNeighbors = memories.length > 0; // Could refine this, but for now show hint always
  if (hasNeighbors) {
    hints.push("Use memory_timeline(id) for chronological context (~200t each)");
  }

  // Check if any memory has substantial body
  if (memories.some(m => (m.body?.length ?? 0) > 200)) {
    hints.push("or memory_get(id) for full body (~400t each)");
  }

  const footer = `\nFound ${memories.length} memories (total: ${totalTokens} tokens).\n${hints.join(" ")}.`;

  return output + footer;
}

export function formatFull(memories: MemoryRow[], bodyPreviewChars = 200): string {
  if (!memories.length) return "No results found.";

  const resultLines = memories.map(m => {
    const src = m.source ?? "sqlite";
    const score = typeof m.score === "number" ? m.score.toFixed(2) : "-";
    const body = safeBody(m);
    const lines = [
      `[${src}] (${m.memory_type}) ${m.title}`,
      `  ID: ${m.id}`,
    ];
    if (body) {
      const preview = body.length > bodyPreviewChars
        ? body.slice(0, bodyPreviewChars) + "..."
        : body;
      lines.push(`  ${preview}`);
    }
    lines.push(`  Score: ${score} | Created: ${m.created_at ?? "?"}`);
    const blockText = lines.join("\n");
    const cost = estimateTokensV2(blockText);
    return `[${cost}t] ${blockText}`;
  }).join("\n\n");

  const totalTokens = memories.reduce((sum, m) => {
    const src = m.source ?? "sqlite";
    const score = typeof m.score === "number" ? m.score.toFixed(2) : "-";
    const body = safeBody(m);
    const lines = [
      `[${src}] (${m.memory_type}) ${m.title}`,
      `  ID: ${m.id}`,
    ];
    if (body) {
      const preview = body.length > bodyPreviewChars
        ? body.slice(0, bodyPreviewChars) + "..."
        : body;
      lines.push(`  ${preview}`);
    }
    lines.push(`  Score: ${score} | Created: ${m.created_at ?? "?"}`);
    return sum + estimateTokensV2(lines.join("\n"));
  }, 0);

  const hints: string[] = [];
  if (memories.length > 0) {
    hints.push("Use memory_timeline(id) for chronological context (~200t each)");
  }
  if (memories.some(m => (m.body?.length ?? 0) > 200)) {
    hints.push("or memory_get(id) for full body (~400t each)");
  }

  const footer = `\nFound ${memories.length} memories (total: ${totalTokens} tokens).\n${hints.join(" ")}.`;

  return resultLines + footer;
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

export function formatDetail(memory: MemoryRow, revealPrivate = false): string {
  if (!memory) return "Memory not found.";
  const body = revealPrivate ? (memory.body ?? "(no body)") : redactPrivate(memory.body ?? "(no body)");
  return `[${memory.memory_type}] ${memory.title}\nID: ${memory.id}\n\n${body}`;
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

export function formatTimeline(
  focus: MemoryRow,
  neighbors: MemoryRow[],
  detail: "index" | "summary" = "summary"
): string {
  if (neighbors.length === 0) {
    return `Memory: ${focus.title}\nNo neighbors found in the ±2h session window.`;
  }

  const allMemories = [...neighbors];
  const focusIndex = allMemories.findIndex(m => m.id === focus.id);
  const isFocusInList = focusIndex !== -1;

  const lines = allMemories.map((m, idx) => {
    const time = m.created_at ? new Date(m.created_at).toLocaleTimeString() : "?";
    const marker = m.id === focus.id ? "★" : (allMemories[idx]?.created_at ?? "" < (focus.created_at ?? "") ? "«" : "»");

    if (detail === "index") {
      return `${marker} ${time}  ${m.title} (id=${m.id})`;
    } else {
      // summary mode
      const body = safeBody(m);
      const summary = body ? extractFirstSentences(body, 1) : "(no body)";
      return `${marker} ${time}  ${m.title}\n    ${summary}`;
    }
  }).join("\n");

  return lines;
}

export function formatSummary(memories: MemoryRow[], maxSentences = 2): string {
  if (!memories.length) return "No results found.";

  const resultLines = memories.map(m => {
    const lines: string[] = [];
    const score = typeof m.score === "number" ? m.score.toFixed(2) : "-";
    lines.push(`[${m.id}] ${m.title} (score:${score})`);
    const body = safeBody(m);
    if (body) {
      lines.push(`  ${extractFirstSentences(body, maxSentences)}`);
    }
    const tags = parseTags(m.tags);
    if (tags.length > 0) {
      lines.push(`  Tags: ${tags.slice(0, 5).join(", ")}`);
    }
    const blockText = lines.join("\n");
    const cost = estimateTokensV2(blockText);
    return `[${cost}t] ${blockText}`;
  }).join("\n\n");

  const totalTokens = memories.reduce((sum, m) => {
    const lines: string[] = [];
    const score = typeof m.score === "number" ? m.score.toFixed(2) : "-";
    lines.push(`[${m.id}] ${m.title} (score:${score})`);
    const body = safeBody(m);
    if (body) {
      lines.push(`  ${extractFirstSentences(body, maxSentences)}`);
    }
    const tags = parseTags(m.tags);
    if (tags.length > 0) {
      lines.push(`  Tags: ${tags.slice(0, 5).join(", ")}`);
    }
    return sum + estimateTokensV2(lines.join("\n"));
  }, 0);

  const hints: string[] = [];
  if (memories.length > 0) {
    hints.push("Use memory_timeline(id) for chronological context (~200t each)");
  }
  if (memories.some(m => (m.body?.length ?? 0) > 200)) {
    hints.push("or memory_get(id) for full body (~400t each)");
  }

  const footer = `\nFound ${memories.length} memories (total: ${totalTokens} tokens).\n${hints.join(" ")}.`;

  return resultLines + footer;
}
