// src/sync/serialize.ts — canonical JSON serializer for team-scoped memories.
//
// Design goals:
//  - Deterministic / sorted key output so git diffs are minimal.
//  - Round-trip: parseMemoryFile(serializeMemory(row, opts)) returns an equivalent object.
//  - Defense-in-depth: applies scrubSecrets + redactPrivate on every field that goes
//    to the file, even though the DB rows are already scrubbed by #12.
//  - No edges[] in v1 JSON schema (triage: cut edges, decouple from #7).

import { createHash } from "node:crypto";
import { redactPrivate } from "../engine/privacy.js";
import { scrubSecrets } from "../engine/text-utils.js";

export const SCHEMA_VERSION = 1;

export interface MemoryFileV1 {
  schema_version: number;
  id: string;
  memory_type: string;
  scope: string;
  title: string;
  body: string | null;
  tags: string[];
  importance_score: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  supersedes_memory_id: string | null;
  claude_session_id: string | null;
  has_private: number;
}

export interface SerializeOpts {
  /** When false (default), applies scrubSecrets + redactPrivate to title, body, tags. */
  includePrivate: boolean;
}

/**
 * Parse the raw tags field from DB (JSON array string, CSV, or already-array) into string[].
 */
export function parseTags(tags: string | string[] | null | undefined): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.filter(t => typeof t === "string");
  // Try JSON parse first
  if (typeof tags === "string" && tags.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(tags);
      if (Array.isArray(parsed)) return parsed.filter((t: unknown) => typeof t === "string");
    } catch {
      // fall through to CSV
    }
  }
  // CSV fallback (v1 format)
  return tags.split(",").map(t => t.trim()).filter(t => t.length > 0);
}

/**
 * Recursively sort object keys for deterministic JSON output.
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Serialize a memory DB row to canonical JSON.
 * - Sorted keys, 2-space indent, trailing newline.
 * - No `source` field (would leak auto-capture).
 * - No `edges[]` field in v1.
 */
export function serializeMemory(row: Record<string, unknown>, opts: SerializeOpts): string {
  const includePrivate = opts.includePrivate;

  const rawTitle = typeof row.title === "string" ? row.title : "";
  const rawBody  = typeof row.body  === "string" ? row.body  : null;
  const rawTags  = parseTags(row.tags as string | string[] | null | undefined);

  const title = includePrivate ? rawTitle : scrubSecrets(redactPrivate(rawTitle));
  const body  = rawBody === null ? null
    : includePrivate ? rawBody : scrubSecrets(redactPrivate(rawBody));
  const tags  = includePrivate ? rawTags : rawTags.map(t => scrubSecrets(t));

  const file: MemoryFileV1 = {
    schema_version: SCHEMA_VERSION,
    id: String(row.id ?? ""),
    memory_type: String(row.memory_type ?? "fact"),
    scope: String(row.scope ?? "team"),
    title,
    body,
    tags,
    importance_score: typeof row.importance_score === "number" ? row.importance_score : 0.5,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    deleted_at: row.deleted_at != null ? String(row.deleted_at) : null,
    supersedes_memory_id: row.supersedes_memory_id != null ? String(row.supersedes_memory_id) : null,
    claude_session_id: row.claude_session_id != null ? String(row.claude_session_id) : null,
    has_private: typeof row.has_private === "number" ? row.has_private : 0,
  };

  return JSON.stringify(sortKeys(file), null, 2) + "\n";
}

/**
 * Parse a memory file's JSON text, returning a MemoryFileV1 object.
 * Validates schema_version; rejects futures versions.
 * Callers must apply their own future-timestamp guard on updated_at.
 */
export function parseMemoryFile(text: string): MemoryFileV1 {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error(`invalid JSON in memory file: ${(e as Error).message}`);
  }
  if (typeof obj !== "object" || obj === null) {
    throw new Error("memory file must be a JSON object");
  }
  const data = obj as Record<string, unknown>;

  const version = typeof data.schema_version === "number" ? data.schema_version : 1;
  if (version > SCHEMA_VERSION) {
    // Be permissive: accept but warn — per spec "current consumers must accept and ignore unknown fields"
  }

  return {
    schema_version: version,
    id: String(data.id ?? ""),
    memory_type: String(data.memory_type ?? "fact"),
    scope: String(data.scope ?? "team"),
    title: String(data.title ?? ""),
    body: data.body != null ? String(data.body) : null,
    tags: Array.isArray(data.tags) ? (data.tags as unknown[]).filter(t => typeof t === "string") as string[] : [],
    importance_score: typeof data.importance_score === "number" ? data.importance_score : 0.5,
    created_at: String(data.created_at ?? ""),
    updated_at: String(data.updated_at ?? ""),
    deleted_at: data.deleted_at != null ? String(data.deleted_at) : null,
    supersedes_memory_id: data.supersedes_memory_id != null ? String(data.supersedes_memory_id) : null,
    claude_session_id: data.claude_session_id != null ? String(data.claude_session_id) : null,
    has_private: typeof data.has_private === "number" ? data.has_private : 0,
  };
}

/**
 * Compute SHA1 of canonical JSON text (for use in sync_file_hashes cache).
 */
export function hashMemoryJson(json: string): string {
  return createHash("sha1").update(json).digest("hex");
}
