import type Database from "better-sqlite3";
import type { MemoriesRepo } from "../db/memories.js";
import { readFileMemories } from "../lib/file-memory.js";
import { formatDetail } from "../lib/formatter.js";
import type { Config } from "../lib/config.js";
import { getVaultNoteById, readVaultNoteBody } from "../engine/vault-index.js";

const BODY_MODE_EXPAND: Set<string> = new Set(["skill", "playbook", "decision"]);

export async function handleMemoryGet(
  repo: MemoriesRepo,
  db: Database.Database,
  config: Config,
  params: { memory_id: string },
): Promise<string> {
  if (params.memory_id.startsWith("file:")) {
    const all = readFileMemories();
    const match = all.find(f => f.id === params.memory_id);
    return match ? formatDetail(match) : "Memory not found.";
  }

  if (params.memory_id.startsWith("vault:")) {
    if (!config.vault.enabled) return "Vault support is not enabled. Add [vault] to your config.";
    const note = getVaultNoteById(db, params.memory_id);
    if (!note) return `Vault note not found: ${params.memory_id}\nRun 'memento-mcp vault-index rebuild' to refresh the index.`;

    const crumb = note.breadcrumb_json ? (JSON.parse(note.breadcrumb_json) as string[]).join(" > ") : null;
    const lines = [
      `[vault:${note.kind}] ${note.title}`,
      `Path: ${note.relative_path}`,
    ];
    if (crumb) lines.push(`Breadcrumb: ${crumb}`);
    if (note.summary) lines.push(`Summary: ${note.summary}`);

    if (note.body_mode === "none") {
      lines.push("", "(body expansion disabled for this note)");
    } else if (BODY_MODE_EXPAND.has(note.kind) || note.body_mode === "full") {
      const body = readVaultNoteBody(note);
      if (body) lines.push("", body);
    } else {
      lines.push("", "(summary-only — request body explicitly if needed)");
    }

    return lines.join("\n");
  }

  const mem = repo.getById(params.memory_id);
  return mem ? formatDetail(mem) : "Memory not found.";
}
