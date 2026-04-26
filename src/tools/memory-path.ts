// src/tools/memory-path.ts
import type { MemoriesRepo } from "../db/memories.js";
import type { EdgesRepo, EdgeType } from "../db/edges.js";

export interface MemoryPathParams {
  from_id: string;
  to_id: string;
  max_hops?: number;
  edge_types?: EdgeType[];
}

export async function handleMemoryPath(
  memRepo: MemoriesRepo,
  edgesRepo: EdgesRepo,
  params: MemoryPathParams
): Promise<string> {
  const maxHops = params.max_hops ?? 4;

  const path = edgesRepo.shortestPath(params.from_id, params.to_id, maxHops, params.edge_types);
  if (!path) {
    return `No path from ${params.from_id} to ${params.to_id} within ${maxHops} hops`;
  }

  if (path.length === 1) {
    const mem = memRepo.getById(path[0]);
    const title = mem ? mem.title : path[0];
    return `${path[0]} "${title}"`;
  }

  const parts: string[] = [];
  for (let i = 0; i < path.length; i++) {
    const nodeId = path[i];
    const mem = memRepo.getById(nodeId);
    const title = mem ? mem.title : nodeId;
    parts.push(`${nodeId} "${title}"`);

    if (i < path.length - 1) {
      const nextId = path[i + 1];
      // Find edge type between nodeId and nextId
      const outEdges = edgesRepo.outgoing(nodeId, params.edge_types);
      const matchingOut = outEdges.find(e => e.to_id === nextId);
      if (matchingOut) {
        parts.push(`→ ${matchingOut.edge_type} →`);
      } else {
        const inEdges = edgesRepo.incoming(nodeId, params.edge_types);
        const matchingIn = inEdges.find(e => e.from_id === nextId);
        if (matchingIn) {
          parts.push(`→ ${matchingIn.edge_type} →`);
        } else {
          parts.push(`→`);
        }
      }
    }
  }

  return parts.join(" ");
}
