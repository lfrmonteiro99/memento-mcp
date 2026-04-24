import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";

const SUPPORTED_SCHEMA_VERSIONS = new Set([2]);
const CURRENT_SCHEMA_VERSION = 2;

interface ExportPayload {
  schema_version: number;
  exported_at: string;
  projects: any[];
  memories: any[];
  decisions: any[];
  pitfalls: any[];
}

export async function handleMemoryExport(
  db: Database.Database,
  params: { project_path?: string },
): Promise<string> {
  let projectId: string | null = null;
  if (params.project_path) {
    const row = db
      .prepare("SELECT id FROM projects WHERE root_path = ?")
      .get(params.project_path) as { id: string } | undefined;
    projectId = row?.id ?? null;
    if (!projectId) {
      return JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        exported_at: new Date().toISOString(),
        projects: [],
        memories: [],
        decisions: [],
        pitfalls: [],
      });
    }
  }

  const projectsQuery = projectId
    ? db.prepare("SELECT * FROM projects WHERE id = ?").all(projectId)
    : db.prepare("SELECT * FROM projects").all();

  const memoriesQuery = projectId
    ? db
        .prepare(
          "SELECT * FROM memories WHERE (project_id = ? OR scope = 'global') AND deleted_at IS NULL",
        )
        .all(projectId)
    : db.prepare("SELECT * FROM memories WHERE deleted_at IS NULL").all();

  const decisionsQuery = projectId
    ? db
        .prepare("SELECT * FROM decisions WHERE project_id = ? AND deleted_at IS NULL")
        .all(projectId)
    : db.prepare("SELECT * FROM decisions WHERE deleted_at IS NULL").all();

  const pitfallsQuery = projectId
    ? db
        .prepare("SELECT * FROM pitfalls WHERE project_id = ? AND deleted_at IS NULL")
        .all(projectId)
    : db.prepare("SELECT * FROM pitfalls WHERE deleted_at IS NULL").all();

  const payload: ExportPayload = {
    schema_version: CURRENT_SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    projects: projectsQuery,
    memories: memoriesQuery,
    decisions: decisionsQuery,
    pitfalls: pitfallsQuery,
  };

  return JSON.stringify(payload, null, 2);
}

export async function handleMemoryImport(
  db: Database.Database,
  params: { path: string; strategy?: "skip" | "overwrite" },
): Promise<string> {
  const strategy = params.strategy ?? "skip";

  let raw: string;
  try {
    raw = readFileSync(params.path, "utf-8");
  } catch (e) {
    return `Failed to read import file: ${e instanceof Error ? e.message : String(e)}`;
  }

  let payload: ExportPayload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    return `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`;
  }

  if (!SUPPORTED_SCHEMA_VERSIONS.has(payload.schema_version)) {
    return `Unsupported schema_version ${payload.schema_version}. This build accepts: ${[...SUPPORTED_SCHEMA_VERSIONS].join(", ")}.`;
  }

  let imported = 0;
  let skipped = 0;
  let overwritten = 0;

  const tx = db.transaction(() => {
    const selectMem = db.prepare("SELECT id FROM memories WHERE id = ?");
    const insertMem = db.prepare(`
      INSERT INTO memories (id, project_id, memory_type, scope, title, body, tags,
                            importance_score, confidence_score, access_count, last_accessed_at,
                            is_pinned, supersedes_memory_id, source, adaptive_score,
                            created_at, updated_at, deleted_at)
      VALUES (@id, @project_id, @memory_type, @scope, @title, @body, @tags,
              @importance_score, @confidence_score, @access_count, @last_accessed_at,
              @is_pinned, @supersedes_memory_id, @source, @adaptive_score,
              @created_at, @updated_at, @deleted_at)
    `);
    const updateMem = db.prepare(`
      UPDATE memories SET
        project_id = @project_id, memory_type = @memory_type, scope = @scope,
        title = @title, body = @body, tags = @tags,
        importance_score = @importance_score, confidence_score = @confidence_score,
        access_count = @access_count, last_accessed_at = @last_accessed_at,
        is_pinned = @is_pinned, supersedes_memory_id = @supersedes_memory_id,
        source = @source, adaptive_score = @adaptive_score,
        updated_at = @updated_at, deleted_at = @deleted_at
      WHERE id = @id
    `);

    for (const mem of payload.memories ?? []) {
      const row = {
        id: mem.id,
        project_id: mem.project_id ?? null,
        memory_type: mem.memory_type ?? "fact",
        scope: mem.scope ?? "project",
        title: mem.title,
        body: mem.body ?? "",
        tags: mem.tags ?? null,
        importance_score: mem.importance_score ?? 0.5,
        confidence_score: mem.confidence_score ?? 1.0,
        access_count: mem.access_count ?? 0,
        last_accessed_at: mem.last_accessed_at ?? null,
        is_pinned: mem.is_pinned ?? 0,
        supersedes_memory_id: mem.supersedes_memory_id ?? null,
        source: mem.source ?? "user",
        adaptive_score: mem.adaptive_score ?? 0.5,
        created_at: mem.created_at ?? new Date().toISOString(),
        updated_at: mem.updated_at ?? new Date().toISOString(),
        deleted_at: mem.deleted_at ?? null,
      };

      const existing = selectMem.get(row.id);
      if (existing) {
        if (strategy === "overwrite") {
          updateMem.run(row);
          overwritten++;
        } else {
          skipped++;
        }
      } else {
        insertMem.run(row);
        imported++;
      }
    }
  });

  tx();

  return (
    `Import complete: ${imported} imported, ${skipped} skipped, ${overwritten} overwritten. ` +
    `Strategy=${strategy}.`
  );
}
