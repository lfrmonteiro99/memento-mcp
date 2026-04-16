// src/tools/pitfalls-log.ts
import type { PitfallsRepo } from "../db/pitfalls.js";

export async function handlePitfallsLog(repo: PitfallsRepo, params: {
  action: string; project_path: string; title?: string; body?: string;
  importance?: number; limit?: number; include_resolved?: boolean; pitfall_id?: string;
}): Promise<string> {
  if (params.action === "store") {
    if (!params.title || !params.body) return "title and body are required for action='store'.";
    const id = repo.store(params.project_path, params.title, params.body, params.importance);
    return `Pitfall logged/updated with ID: ${id}`;
  }
  if (params.action === "list") {
    const pitfalls = repo.list(params.project_path, params.limit, params.include_resolved);
    if (!pitfalls.length) return "No pitfalls found.";
    return pitfalls.map(p => {
      const status = p.resolved ? "RESOLVED" : `x${p.occurrence_count}`;
      return `[${status}] ${p.title}\n  ID: ${p.id}\n  ${(p.body as string).slice(0, 300)}\n  Last seen: ${p.last_seen_at}`;
    }).join("\n\n");
  }
  if (params.action === "resolve") {
    if (!params.pitfall_id) return "pitfall_id is required for action='resolve'.";
    return repo.resolve(params.pitfall_id)
      ? `Pitfall ${params.pitfall_id} marked as resolved.`
      : `Pitfall ${params.pitfall_id} not found.`;
  }
  return `Invalid action: ${params.action}. Use 'store', 'list', or 'resolve'.`;
}
