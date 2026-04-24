import type { MemoriesRepo } from "../db/memories.js";

export async function handleMemoryUpdate(
  repo: MemoriesRepo,
  params: {
    memory_id: string;
    title?: string;
    content?: string;
    tags?: string[];
    importance?: number;
    memory_type?: string;
    pinned?: boolean;
  },
): Promise<string> {
  const patch: Parameters<MemoriesRepo["update"]>[1] = {};
  if (params.title !== undefined) patch.title = params.title;
  if (params.content !== undefined) patch.body = params.content;
  if (params.tags !== undefined) patch.tags = params.tags;
  if (params.importance !== undefined) patch.importance = params.importance;
  if (params.memory_type !== undefined) patch.memoryType = params.memory_type;
  if (params.pinned !== undefined) patch.pinned = params.pinned;

  if (Object.keys(patch).length === 0) {
    return "No fields to update. Pass at least one of: title, content, tags, importance, memory_type, pinned.";
  }

  const current = repo.getById(params.memory_id);
  if (!current) {
    return `Memory not found: ${params.memory_id}`;
  }

  const ok = repo.update(params.memory_id, patch);
  if (!ok) {
    return `Memory not found: ${params.memory_id}`;
  }
  return `Memory updated: ${params.memory_id}`;
}
