// src/tools/memory-store.ts
import type { MemoriesRepo } from "../db/memories.js";

export async function handleMemoryStore(repo: MemoriesRepo, params: {
  title: string; content: string; memory_type?: string; scope?: string;
  project_path?: string; tags?: string[]; importance?: number;
  supersedes_id?: string; pin?: boolean;
}): Promise<string> {
  const id = repo.store({
    title: params.title, body: params.content,
    memoryType: params.memory_type, scope: params.scope,
    projectPath: params.project_path, tags: params.tags,
    importance: params.importance, supersedesId: params.supersedes_id,
    pin: params.pin,
  });
  return `Memory stored with ID: ${id}`;
}
