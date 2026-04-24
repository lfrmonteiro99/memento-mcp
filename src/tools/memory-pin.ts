import type { MemoriesRepo } from "../db/memories.js";

export async function handleMemoryPin(
  repo: MemoriesRepo,
  params: { memory_id: string; pinned: boolean },
): Promise<string> {
  const ok = repo.setPinned(params.memory_id, params.pinned);
  if (!ok) {
    return `Memory not found: ${params.memory_id}`;
  }
  return params.pinned
    ? `Memory pinned: ${params.memory_id}`
    : `Memory unpinned: ${params.memory_id}`;
}
