// src/tools/memory-link.ts
import type { MemoriesRepo } from "../db/memories.js";
import type { EdgesRepo } from "../db/edges.js";
import type { EdgeType } from "../db/edges.js";

export interface MemoryLinkParams {
  from_id: string;
  to_id: string;
  edge_type: EdgeType;
  weight?: number;
}

export async function handleMemoryLink(
  memRepo: MemoriesRepo,
  edgesRepo: EdgesRepo,
  params: MemoryLinkParams
): Promise<string> {
  const from = memRepo.getById(params.from_id);
  if (!from) {
    return `Error: Memory ${params.from_id} not found or has been deleted.`;
  }
  const to = memRepo.getById(params.to_id);
  if (!to) {
    return `Error: Memory ${params.to_id} not found or has been deleted.`;
  }

  try {
    edgesRepo.link(params.from_id, params.to_id, params.edge_type, params.weight ?? 1.0);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }

  return `Linked ${params.from_id} --[${params.edge_type}]--> ${params.to_id}`;
}
