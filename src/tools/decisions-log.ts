// src/tools/decisions-log.ts
import type { DecisionsRepo } from "../db/decisions.js";

export async function handleDecisionsLog(repo: DecisionsRepo, params: {
  action: string; project_path: string; title?: string; body?: string;
  category?: string; importance?: number; supersedes_id?: string;
  query?: string; limit?: number;
}): Promise<string> {
  if (params.action === "store") {
    if (!params.title || !params.body) return "title and body are required for action='store'.";
    const id = repo.store(params.project_path, params.title, params.body, params.category, params.importance, params.supersedes_id);
    return `Decision stored with ID: ${id}`;
  }
  if (params.action === "list") {
    const decisions = repo.list(params.project_path, params.limit);
    if (!decisions.length) return "No decisions found.";
    return decisions.map(d =>
      `[${d.category}] ${d.title}\n  ID: ${d.id}\n  ${(d.body as string).slice(0, 300)}\n  Importance: ${d.importance_score} | Created: ${d.created_at}`
    ).join("\n\n");
  }
  if (params.action === "search") {
    if (!params.query) return "query is required for action='search'.";
    const results = repo.search(params.query, params.project_path, params.limit);
    if (!results.length) return "No decisions found.";
    return results.map(d =>
      `[${d.category}] ${d.title}\n  ID: ${d.id}\n  ${(d.body as string).slice(0, 300)}`
    ).join("\n\n");
  }
  return `Invalid action: ${params.action}. Use 'store', 'list', or 'search'.`;
}
