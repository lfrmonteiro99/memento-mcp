// src/tools/memory-get.ts
import type { MemoriesRepo } from "../db/memories.js";
import { readFileMemories } from "../lib/file-memory.js";
import { formatDetail } from "../lib/formatter.js";

export async function handleMemoryGet(repo: MemoriesRepo, params: { memory_id: string }): Promise<string> {
  // Handle file-based memories
  if (params.memory_id.startsWith("file:")) {
    const allFiles = readFileMemories();
    const match = allFiles.find(f => f.id === params.memory_id);
    return match ? formatDetail(match) : "Memory not found.";
  }
  const mem = repo.getById(params.memory_id);
  return mem ? formatDetail(mem) : "Memory not found.";
}
