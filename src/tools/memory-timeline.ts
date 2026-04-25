import type { MemoriesRepo } from "../db/memories.js";
import { formatTimeline } from "../lib/formatter.js";

export interface MemoryTimelineParams {
  id: string;
  window?: number;
  detail?: "index" | "summary";
  same_session_only?: boolean;
}

export async function handleMemoryTimeline(
  repo: MemoriesRepo,
  params: MemoryTimelineParams
): Promise<string> {
  const focus = repo.getById(params.id);
  if (!focus) {
    return `Memory ${params.id} not found.`;
  }

  const neighbors = repo.getNeighbors(focus, params.window ?? 3, params.same_session_only ?? true);

  if (neighbors.length === 0) {
    return `Memory: ${focus.title}\nNo neighbors found in the ±2h session window.`;
  }

  return formatTimeline(focus, neighbors, params.detail ?? "summary");
}
