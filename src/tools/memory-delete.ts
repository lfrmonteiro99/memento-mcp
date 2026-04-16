// src/tools/memory-delete.ts
import type { MemoriesRepo } from "../db/memories.js";

export async function handleMemoryDelete(repo: MemoriesRepo, params: { memory_id: string }): Promise<string> {
  if (params.memory_id.startsWith("file:")) return "Cannot delete file-based memories.";
  return repo.delete(params.memory_id)
    ? `Memory ${params.memory_id} deleted.`
    : `Memory ${params.memory_id} not found or already deleted.`;
}
