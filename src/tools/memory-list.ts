import type Database from "better-sqlite3";
import type { MemoriesRepo } from "../db/memories.js";
import type { Config } from "../lib/config.js";
import { readFileMemories } from "../lib/file-memory.js";
import { formatIndex, formatFull, formatSummary, formatVaultIndex, formatVaultEntry } from "../lib/formatter.js";
import type { VaultNoteRow } from "../engine/vault-index.js";
import type { SourceIndexEntry } from "../sources/source.js";

function vaultNoteToEntry(note: VaultNoteRow): SourceIndexEntry {
  const breadcrumb: string[] = note.breadcrumb_json
    ? JSON.parse(note.breadcrumb_json) : ["vault", note.title];
  return {
    id: note.id,
    source: "vault",
    title: note.title,
    kind: note.kind,
    summary: note.summary ?? undefined,
    path: note.relative_path,
    aliases: note.aliases_json ? JSON.parse(note.aliases_json) : [],
    breadcrumb,
    weight: note.weight,
  };
}

/** Structured payload for memory_list's outputSchema. */
export type MemoryListResult = {
  detail: "index" | "summary" | "full";
  count: number;
  memories: Array<{
    id: string;
    title: string;
    source: "sqlite" | "file";
    memory_type?: string;
    importance?: number;
    pinned?: boolean;
    body?: string;
  }>;
  vault_results: Array<{ id: string; title: string; relativePath: string; kind?: string }>;
};

export async function listMemories(
  repo: MemoriesRepo,
  config: Config,
  params: {
    project_path?: string; memory_type?: string; scope?: string;
    pinned_only?: boolean; limit?: number; detail?: "index" | "summary" | "full";
    include_file_memories?: boolean;
    vault_kind?: string; vault_folder?: string;
  },
  db?: Database.Database,
): Promise<{ text: string; structured: MemoryListResult }> {
  const detail = (params.detail ?? config.search.defaultDetail) as "index" | "summary" | "full";
  const results: any[] = repo.list({
    projectPath: params.project_path, memoryType: params.memory_type,
    scope: params.scope, pinnedOnly: params.pinned_only, limit: params.limit,
  });
  for (const r of results) r.source = "sqlite";

  if (params.include_file_memories) {
    const fileResults = readFileMemories(params.project_path);
    for (const r of fileResults) {
      (r as any).importance_score = 1.0;
      (r as any).created_at = "(file)";
      results.push(r);
    }
  }

  let sqliteOutput = "";
  if (detail === "index") sqliteOutput = formatIndex(results);
  else if (detail === "summary") sqliteOutput = formatSummary(results);
  else sqliteOutput = formatFull(results, config.search.bodyPreviewChars);

  // Vault listing
  let vaultEntries: SourceIndexEntry[] = [];
  let vaultOutput = "";
  if (db && config.vault.enabled && config.vault.path) {
    let q = "SELECT * FROM vault_notes WHERE vault_path = ? AND routable = 1 AND blocked = 0 AND orphan = 0";
    const bindings: unknown[] = [config.vault.path];

    if (params.vault_kind) { q += " AND kind = ?"; bindings.push(params.vault_kind); }
    if (params.vault_folder) { q += " AND relative_path LIKE ?"; bindings.push(params.vault_folder + "/%"); }

    q += " ORDER BY kind, title";

    const vaultRows = db.prepare(q).all(...bindings) as VaultNoteRow[];

    if (vaultRows.length > 0) {
      vaultEntries = vaultRows.map(vaultNoteToEntry);
      vaultOutput = detail === "index"
        ? formatVaultIndex(vaultEntries)
        : vaultEntries.map(formatVaultEntry).join("\n\n");
    }
  }

  const text = vaultOutput
    ? (sqliteOutput && sqliteOutput !== "No results found."
        ? sqliteOutput + "\n\n" + vaultOutput
        : vaultOutput)
    : sqliteOutput;

  const structured: MemoryListResult = {
    detail,
    count: results.length,
    memories: results.map(r => ({
      id: String(r.id),
      title: String(r.title ?? ""),
      source: r.source as "sqlite" | "file",
      ...(r.memory_type ? { memory_type: String(r.memory_type) } : {}),
      ...(r.importance_score !== undefined ? { importance: Number(r.importance_score) } : {}),
      ...(r.pinned !== undefined ? { pinned: Boolean(r.pinned) } : {}),
      ...(detail !== "index" && r.body ? { body: String(r.body) } : {}),
    })),
    vault_results: vaultEntries.map(v => ({
      id: String(v.id),
      title: String(v.title),
      relativePath: String(v.path ?? ""),
      ...(v.kind ? { kind: String(v.kind) } : {}),
    })),
  };

  return { text, structured };
}

/** Backward-compatible wrapper returning only the rendered text. */
export async function handleMemoryList(
  repo: MemoriesRepo,
  config: Config,
  params: {
    project_path?: string; memory_type?: string; scope?: string;
    pinned_only?: boolean; limit?: number; detail?: "index" | "summary" | "full";
    include_file_memories?: boolean;
    vault_kind?: string; vault_folder?: string;
  },
  db?: Database.Database,
): Promise<string> {
  const { text } = await listMemories(repo, config, params, db);
  return text;
}
