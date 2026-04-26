// src/tools/memory-unlink.ts
import type { EdgesRepo } from "../db/edges.js";
import type { EdgeType } from "../db/edges.js";

export interface MemoryUnlinkParams {
  from_id: string;
  to_id: string;
  edge_type: EdgeType;
}

export async function handleMemoryUnlink(
  edgesRepo: EdgesRepo,
  params: MemoryUnlinkParams
): Promise<string> {
  const removed = edgesRepo.unlink(params.from_id, params.to_id, params.edge_type);
  if (!removed) {
    return `No edge found: ${params.from_id} --[${params.edge_type}]--> ${params.to_id}`;
  }
  return `Unlinked ${params.from_id} --[${params.edge_type}]--> ${params.to_id}`;
}
