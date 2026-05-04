// src/tools/memory-path.ts
import type { MemoriesRepo } from "../db/memories.js";
import type { EdgesRepo, EdgeType } from "../db/edges.js";

export interface MemoryPathParams {
  from_id: string;
  to_id: string;
  max_hops?: number;
  edge_types?: EdgeType[];
}

/** Structured payload for memory_path's outputSchema. */
export type MemoryPathResult = {
  found: boolean;
  hops: number;
  path: Array<{ id: string; title: string; edge_type_to_next?: EdgeType }>;
  message?: string;
};

export async function findMemoryPath(
  memRepo: MemoriesRepo,
  edgesRepo: EdgesRepo,
  params: MemoryPathParams,
): Promise<{ text: string; structured: MemoryPathResult }> {
  const maxHops = params.max_hops ?? 4;

  const path = edgesRepo.shortestPath(params.from_id, params.to_id, maxHops, params.edge_types);
  if (!path) {
    const message = `No path from ${params.from_id} to ${params.to_id} within ${maxHops} hops`;
    return {
      text: message,
      structured: { found: false, hops: 0, path: [], message },
    };
  }

  if (path.length === 1) {
    const mem = memRepo.getById(path[0]);
    const title = mem ? mem.title : path[0];
    return {
      text: `${path[0]} "${title}"`,
      structured: {
        found: true,
        hops: 0,
        path: [{ id: String(path[0]), title: String(title) }],
      },
    };
  }

  const parts: string[] = [];
  const structuredNodes: MemoryPathResult["path"] = [];

  for (let i = 0; i < path.length; i++) {
    const nodeId = path[i];
    const mem = memRepo.getById(nodeId);
    const title = mem ? mem.title : nodeId;
    parts.push(`${nodeId} "${title}"`);

    let edgeTypeToNext: EdgeType | undefined;
    if (i < path.length - 1) {
      const nextId = path[i + 1];
      const outEdges = edgesRepo.outgoing(nodeId, params.edge_types);
      const matchingOut = outEdges.find(e => e.to_id === nextId);
      if (matchingOut) {
        parts.push(`→ ${matchingOut.edge_type} →`);
        edgeTypeToNext = matchingOut.edge_type;
      } else {
        const inEdges = edgesRepo.incoming(nodeId, params.edge_types);
        const matchingIn = inEdges.find(e => e.from_id === nextId);
        if (matchingIn) {
          parts.push(`→ ${matchingIn.edge_type} →`);
          edgeTypeToNext = matchingIn.edge_type;
        } else {
          parts.push(`→`);
        }
      }
    }

    structuredNodes.push({
      id: String(nodeId),
      title: String(title),
      ...(edgeTypeToNext ? { edge_type_to_next: edgeTypeToNext } : {}),
    });
  }

  return {
    text: parts.join(" "),
    structured: {
      found: true,
      hops: path.length - 1,
      path: structuredNodes,
    },
  };
}

/** Backward-compatible wrapper returning only the rendered text. */
export async function handleMemoryPath(
  memRepo: MemoriesRepo,
  edgesRepo: EdgesRepo,
  params: MemoryPathParams,
): Promise<string> {
  const { text } = await findMemoryPath(memRepo, edgesRepo, params);
  return text;
}
