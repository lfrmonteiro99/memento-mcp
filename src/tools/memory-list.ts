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

export async function handleMemoryList(
  repo: MemoriesRepo,
  config: Config,
  params: {
    project_path?: string; memory_type?: string; scope?: string;
    pinned_only?: boolean; limit?: number; detail?: "index" | "summary" | "full";
    include_file_memories?: boolean;
    // vault-specific filters
    vault_kind?: string; vault_folder?: string;
  },
  db?: Database.Database,
): Promise<string> {
  const detail = params.detail ?? config.search.defaultDetail;
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
  if (db && config.vault.enabled && config.vault.path) {
    let q = "SELECT * FROM vault_notes WHERE vault_path = ? AND routable = 1 AND blocked = 0 AND orphan = 0";
    const bindings: unknown[] = [config.vault.path];

    if (params.vault_kind) { q += " AND kind = ?"; bindings.push(params.vault_kind); }
    if (params.vault_folder) { q += " AND relative_path LIKE ?"; bindings.push(params.vault_folder + "/%"); }

    q += " ORDER BY kind, title";

    const vaultRows = db.prepare(q).all(...bindings) as VaultNoteRow[];

    if (vaultRows.length > 0) {
      const entries = vaultRows.map(vaultNoteToEntry);
      const vaultOutput = detail === "index"
        ? formatVaultIndex(entries)
        : entries.map(formatVaultEntry).join("\n\n");

      return sqliteOutput && sqliteOutput !== "No results found."
        ? sqliteOutput + "\n\n" + vaultOutput
        : vaultOutput;
    }
  }

  return sqliteOutput;
}
