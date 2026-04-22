import type Database from "better-sqlite3";
import type { VaultConfig } from "../lib/config.js";
import type { VaultNoteRow } from "./vault-index.js";
import type { SourceIndexEntry } from "../sources/source.js";

type IntentType = "procedure" | "decision" | "project" | "domain" | "identity" | "navigation" | "general";

const PROCEDURE_TOKENS = new Set(["how", "steps", "do", "run", "deploy", "merge", "build", "setup", "install", "create", "configure"]);
const DECISION_TOKENS = new Set(["why", "decision", "rationale", "architecture", "chose", "choice", "tradeoff", "approach"]);
const IDENTITY_TOKENS = new Set(["me", "who", "my", "style", "preferences", "i am", "about me"]);

const KIND_WEIGHT: Record<IntentType, Record<string, number>> = {
  procedure: { skill: 1.5, playbook: 1.5, decision: 1.0, map: 0.8, domain: 0.9, project: 0.8, effort: 0.7, source: 0.4, identity: 0.4 },
  decision:  { decision: 1.5, domain: 1.2, playbook: 1.0, skill: 0.9, map: 0.8, project: 0.8, effort: 0.7, source: 0.4, identity: 0.4 },
  project:   { project: 1.5, effort: 1.2, map: 1.0, domain: 0.9, decision: 0.8, playbook: 0.8, skill: 0.8, source: 0.5, identity: 0.4 },
  domain:    { domain: 1.5, decision: 1.2, playbook: 1.0, skill: 1.0, map: 0.8, project: 0.8, effort: 0.7, source: 0.5, identity: 0.4 },
  identity:  { identity: 2.0, map: 0.9, domain: 0.7, project: 0.6, decision: 0.6, playbook: 0.6, skill: 0.6, effort: 0.5, source: 0.3 },
  navigation:{ map: 1.5, skill: 1.2, playbook: 1.0, domain: 0.9, project: 0.8, decision: 0.7, effort: 0.6, identity: 0.5, source: 0.3 },
  general:   { skill: 1.0, playbook: 1.0, decision: 1.0, domain: 1.0, project: 1.0, map: 0.9, effort: 0.8, identity: 0.7, source: 0.5 },
};

function classifyIntent(query: string): IntentType {
  const lower = query.toLowerCase();
  const tokens = new Set(lower.split(/\s+/));
  if ([...tokens].some(t => IDENTITY_TOKENS.has(t))) return "identity";
  const procedureHits = [...tokens].filter(t => PROCEDURE_TOKENS.has(t)).length;
  const decisionHits = [...tokens].filter(t => DECISION_TOKENS.has(t)).length;
  if (procedureHits > decisionHits && procedureHits > 0) return "procedure";
  if (decisionHits > procedureHits && decisionHits > 0) return "decision";
  return "general";
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[\s\-_/.,;:!?()[\]{}'"]+/).filter(t => t.length > 2));
}

function relevanceScore(note: VaultNoteRow, queryTokens: Set<string>): number {
  const fields = [
    note.title,
    note.summary ?? "",
    note.aliases_json ? (JSON.parse(note.aliases_json) as string[]).join(" ") : "",
    note.tags_json ? (JSON.parse(note.tags_json) as string[]).join(" ") : "",
  ].join(" ");

  const noteTokens = tokenize(fields);
  let overlap = 0;
  for (const qt of queryTokens) {
    if (noteTokens.has(qt)) overlap++;
    // Also partial match: query token is substring of a note token
    else if ([...noteTokens].some(nt => nt.includes(qt) || qt.includes(nt))) overlap += 0.5;
  }
  return queryTokens.size > 0 ? Math.min(1, overlap / queryTokens.size) : 0;
}

function parseBreadcrumb(note: VaultNoteRow): string[] {
  if (!note.breadcrumb_json) return ["vault", note.title];
  try { return JSON.parse(note.breadcrumb_json) as string[]; } catch { return ["vault", note.title]; }
}

// Step 1: find entry notes — roots + notes matching query tokens + kind-fitting notes
function selectEntryNotes(
  db: Database.Database,
  vaultPath: string,
  queryTokens: Set<string>,
  intent: IntentType,
  kindWeights: Record<string, number>,
): VaultNoteRow[] {
  const all = db.prepare(
    "SELECT * FROM vault_notes WHERE vault_path = ? AND routable = 1 AND blocked = 0"
  ).all(vaultPath) as VaultNoteRow[];

  const rootIds = new Set(
    (db.prepare("SELECT note_id FROM vault_roots").all() as Array<{ note_id: string }>).map(r => r.note_id)
  );

  return all.filter(n => {
    if (rootIds.has(n.id)) return true;
    if ((kindWeights[n.kind] ?? 0.5) >= 1.0) return relevanceScore(n, queryTokens) > 0;
    return relevanceScore(n, queryTokens) >= 0.3;
  });
}

// Step 2: bounded traversal from entries (BFS, max_hops)
function traverseFromEntries(
  db: Database.Database,
  entries: VaultNoteRow[],
  allNotes: Map<string, VaultNoteRow>,
  maxHops: number,
): Map<string, { note: VaultNoteRow; hops: number }> {
  const edges = db.prepare("SELECT from_id, to_id, weight FROM vault_edges").all() as Array<{ from_id: string; to_id: string; weight: number }>;
  const adj = new Map<string, Array<{ to: string; w: number }>>();
  for (const e of edges) {
    const arr = adj.get(e.from_id) ?? [];
    arr.push({ to: e.to_id, w: e.weight });
    adj.set(e.from_id, arr);
  }

  const visited = new Map<string, { note: VaultNoteRow; hops: number }>();
  const queue: Array<{ id: string; hops: number }> = [];

  for (const entry of entries) {
    if (!visited.has(entry.id)) {
      visited.set(entry.id, { note: entry, hops: 0 });
      queue.push({ id: entry.id, hops: 0 });
    }
  }

  while (queue.length > 0) {
    const { id, hops } = queue.shift()!;
    if (hops >= maxHops) continue;
    for (const { to } of adj.get(id) ?? []) {
      if (!visited.has(to)) {
        const note = allNotes.get(to);
        if (note && note.routable && !note.blocked) {
          visited.set(to, { note, hops: hops + 1 });
          queue.push({ id: to, hops: hops + 1 });
        }
      }
    }
  }

  return visited;
}

export function searchVault(
  db: Database.Database,
  config: VaultConfig,
  query: string,
): SourceIndexEntry[] {
  if (!config.enabled || !config.path) return [];

  const intent = classifyIntent(query);
  const kindWeights = KIND_WEIGHT[intent];
  const queryTokens = tokenize(query);

  const all = db.prepare(
    "SELECT * FROM vault_notes WHERE vault_path = ? AND routable = 1 AND blocked = 0"
  ).all(config.path) as VaultNoteRow[];

  if (all.length === 0) return [];

  const allByIdMap = new Map(all.map(n => [n.id, n]));

  // Step 1: entry notes
  const entries = selectEntryNotes(db, config.path, queryTokens, intent, kindWeights);

  // Step 2: bounded traversal to candidate set
  const candidates = traverseFromEntries(db, entries, allByIdMap, config.maxHops);

  // If no candidates from routing, fall back to all non-orphaned notes
  const pool = candidates.size > 0
    ? [...candidates.values()]
    : all.filter(n => n.orphan === 0).map(n => ({ note: n, hops: 3 }));

  // Step 3: score candidates
  const scored = pool.map(({ note, hops }) => {
    const rel = relevanceScore(note, queryTokens);
    const routingBonus = Math.pow(0.8, hops); // 1.0 at 0 hops, 0.8 at 1, 0.64 at 2, ...
    const kw = kindWeights[note.kind] ?? 0.8;
    const score = rel * routingBonus * kw * note.weight;
    return { note, score };
  });

  // Step 4: filter out zero-score unless orphan=0 and score > 0
  const nonZero = scored.filter(s => s.score > 0);
  nonZero.sort((a, b) => b.score - a.score);

  return nonZero.slice(0, config.maxResults).map(({ note, score }) => ({
    id: note.id,
    source: "vault" as const,
    title: note.title,
    kind: note.kind,
    summary: note.summary ?? undefined,
    path: note.relative_path,
    aliases: note.aliases_json ? JSON.parse(note.aliases_json) : [],
    breadcrumb: parseBreadcrumb(note),
    weight: note.weight,
    score,
  }));
}
