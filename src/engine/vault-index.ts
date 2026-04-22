import type Database from "better-sqlite3";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { nowIso } from "../db/database.js";
import { scanVault, type ParsedNote } from "./vault-parser.js";
import type { VaultConfig } from "../lib/config.js";

export interface VaultNoteRow {
  id: string;
  vault_path: string;
  relative_path: string;
  title: string;
  kind: string;
  summary: string | null;
  aliases_json: string | null;
  tags_json: string | null;
  body_mode: string;
  weight: number;
  routable: number;
  blocked: number;
  orphan: number;
  mtime_ms: number;
  body_hash: string | null;
  breadcrumb_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface RebuildStats {
  total: number;
  routable: number;
  orphaned: number;
  edges: number;
  roots: number;
}

export function rebuildVaultIndex(db: Database.Database, config: VaultConfig): RebuildStats {
  const notes = scanVault(config);
  const now = nowIso();

  const stmts = {
    deleteNotes: db.prepare("DELETE FROM vault_notes WHERE vault_path = ?"),
    deleteEdges: db.prepare("DELETE FROM vault_edges"),
    deleteRoots: db.prepare("DELETE FROM vault_roots"),
    upsert: db.prepare(`
      INSERT INTO vault_notes
        (id, vault_path, relative_path, title, kind, summary, aliases_json, tags_json,
         body_mode, weight, routable, blocked, orphan, mtime_ms, body_hash, breadcrumb_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 1, ?, ?, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, kind = excluded.kind, summary = excluded.summary,
        aliases_json = excluded.aliases_json, tags_json = excluded.tags_json,
        body_mode = excluded.body_mode, weight = excluded.weight,
        mtime_ms = excluded.mtime_ms, body_hash = excluded.body_hash,
        updated_at = excluded.updated_at
    `),
    insertEdge: db.prepare(`
      INSERT OR REPLACE INTO vault_edges (from_id, to_id, edge_type, weight)
      VALUES (?, ?, ?, ?)
    `),
    insertRoot: db.prepare("INSERT OR REPLACE INTO vault_roots (note_id, root_type) VALUES (?, ?)"),
    updateOrphan: db.prepare("UPDATE vault_notes SET orphan = ?, breadcrumb_json = ?, updated_at = ? WHERE id = ?"),
  };

  db.transaction(() => {
    stmts.deleteNotes.run(config.path);
    stmts.deleteEdges.run();
    stmts.deleteRoots.run();

    // Build lookup maps for edge resolution
    const idByRelPath = new Map<string, string>();
    const idByBasename = new Map<string, string>();
    for (const note of notes) {
      idByRelPath.set(note.relativePath, note.id);
      idByRelPath.set(note.relativePath.replace(/\.md$/, ""), note.id);
      const base = note.relativePath.replace(/\.md$/, "").split("/").pop() ?? "";
      if (!idByBasename.has(base)) idByBasename.set(base, note.id);
      // also index aliases
      for (const alias of note.aliases) {
        if (!idByBasename.has(alias.toLowerCase())) idByBasename.set(alias.toLowerCase(), note.id);
      }
    }

    const resolveLink = (ref: string): string | undefined =>
      idByRelPath.get(ref) ?? idByRelPath.get(ref + ".md") ??
      idByBasename.get(ref.split("/").pop()?.replace(/\.md$/, "") ?? "");

    // Upsert notes
    for (const note of notes) {
      stmts.upsert.run(
        note.id, note.vaultPath, note.relativePath, note.title, note.kind,
        note.summary ?? null,
        note.aliases.length ? JSON.stringify(note.aliases) : null,
        note.tags.length ? JSON.stringify(note.tags) : null,
        note.bodyMode, note.weight, note.mtimeMs, note.bodyHash, now, now,
      );
    }

    // Build edges
    for (const note of notes) {
      for (const child of note.children) {
        const cid = resolveLink(child);
        if (cid) stmts.insertEdge.run(note.id, cid, "explicit_child", 1.5);
      }
      for (const link of note.wikilinks) {
        const lid = resolveLink(link);
        if (lid && lid !== note.id) stmts.insertEdge.run(note.id, lid, "wikilink", 1.0);
      }
    }

    // Mark root notes
    for (const rootPath of config.rootNotes) {
      const rootId = resolveLink(rootPath);
      if (!rootId) continue;
      const noteKind = notes.find(n => n.id === rootId)?.kind ?? "map";
      const rootType = noteKind === "identity" ? "identity" : noteKind === "map" ? "map" : "vault";
      stmts.insertRoot.run(rootId, rootType);
    }

    // BFS for reachability and breadcrumbs
    const rootRows = db.prepare("SELECT note_id FROM vault_roots").all() as Array<{ note_id: string }>;
    const edgeRows = db.prepare("SELECT from_id, to_id FROM vault_edges").all() as Array<{ from_id: string; to_id: string }>;

    const adj = new Map<string, string[]>();
    for (const e of edgeRows) {
      const arr = adj.get(e.from_id) ?? [];
      arr.push(e.to_id);
      adj.set(e.from_id, arr);
    }

    const noteByIdMap = new Map(notes.map(n => [n.id, n]));
    const breadcrumbs = new Map<string, string[]>();
    const queue: Array<{ id: string; crumb: string[] }> = [];

    for (const { note_id } of rootRows) {
      const title = noteByIdMap.get(note_id)?.title ?? note_id;
      breadcrumbs.set(note_id, ["vault", title]);
      queue.push({ id: note_id, crumb: ["vault", title] });
    }

    while (queue.length > 0) {
      const { id, crumb } = queue.shift()!;
      for (const childId of adj.get(id) ?? []) {
        if (!breadcrumbs.has(childId)) {
          const title = noteByIdMap.get(childId)?.title ?? childId;
          const childCrumb = [...crumb, title];
          breadcrumbs.set(childId, childCrumb);
          queue.push({ id: childId, crumb: childCrumb });
        }
      }
    }

    for (const note of notes) {
      const crumb = breadcrumbs.get(note.id);
      stmts.updateOrphan.run(crumb ? 0 : 1, crumb ? JSON.stringify(crumb) : null, now, note.id);
    }
  })();

  const row = (q: string, ...args: unknown[]) =>
    (db.prepare(q).get(...args) as Record<string, number>);

  return {
    total: notes.length,
    routable: row("SELECT COUNT(*) as c FROM vault_notes WHERE vault_path = ? AND routable = 1 AND blocked = 0", config.path).c,
    orphaned: row("SELECT COUNT(*) as c FROM vault_notes WHERE vault_path = ? AND orphan = 1", config.path).c,
    edges: row("SELECT COUNT(*) as c FROM vault_edges").c,
    roots: row("SELECT COUNT(*) as c FROM vault_roots").c,
  };
}

export function getVaultNoteById(db: Database.Database, id: string): VaultNoteRow | null {
  return db.prepare("SELECT * FROM vault_notes WHERE id = ?").get(id) as VaultNoteRow | null;
}

export function readVaultNoteBody(note: VaultNoteRow): string | null {
  const fullPath = join(note.vault_path, note.relative_path);
  if (!existsSync(fullPath)) return null;
  try {
    const content = readFileSync(fullPath, "utf-8");
    const m = content.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?([\s\S]*)/);
    return (m ? m[1] : content).trim();
  } catch {
    return null;
  }
}

export interface DoctorIssue {
  kind: "missing_root" | "orphaned_published";
  path: string;
  detail: string;
}

export function runVaultDoctor(db: Database.Database, config: VaultConfig): DoctorIssue[] {
  const issues: DoctorIssue[] = [];

  for (const rootPath of config.rootNotes) {
    const found = db.prepare("SELECT id FROM vault_notes WHERE relative_path = ? OR relative_path = ?")
      .get(rootPath, rootPath.replace(/\.md$/, ""));
    if (!found) {
      const fullPath = join(config.path, rootPath);
      const detail = existsSync(fullPath)
        ? "file exists but was not indexed (missing memento_publish: true?)"
        : "file does not exist — create it";
      issues.push({ kind: "missing_root", path: rootPath, detail });
    }
  }

  const orphans = db.prepare("SELECT relative_path FROM vault_notes WHERE vault_path = ? AND orphan = 1")
    .all(config.path) as Array<{ relative_path: string }>;
  for (const o of orphans) {
    issues.push({ kind: "orphaned_published", path: o.relative_path, detail: "published but unreachable from any root note" });
  }

  return issues;
}

export function getVaultStats(db: Database.Database, vaultPath: string) {
  const byKind = db.prepare(
    "SELECT kind, COUNT(*) as count FROM vault_notes WHERE vault_path = ? GROUP BY kind ORDER BY count DESC"
  ).all(vaultPath) as Array<{ kind: string; count: number }>;

  const totals = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN orphan = 0 THEN 1 ELSE 0 END) as reachable,
      SUM(CASE WHEN orphan = 1 THEN 1 ELSE 0 END) as orphaned
    FROM vault_notes WHERE vault_path = ?
  `).get(vaultPath) as { total: number; reachable: number; orphaned: number };

  const edgeCount = (db.prepare("SELECT COUNT(*) as c FROM vault_edges").get() as { c: number }).c;
  const rootCount = (db.prepare("SELECT COUNT(*) as c FROM vault_roots").get() as { c: number }).c;

  return { byKind, totals, edgeCount, rootCount };
}
