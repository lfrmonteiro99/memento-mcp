// src/lib/formatter.ts
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

export function formatDetail(memory: MemoryRow): string {
  if (!memory) return "Memory not found.";
  return `[${memory.memory_type}] ${memory.title}\nID: ${memory.id}\n\n${memory.body ?? "(no body)"}`;
}
