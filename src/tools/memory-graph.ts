// src/tools/memory-graph.ts
import type { MemoriesRepo } from "../db/memories.js";
import type { EdgesRepo, EdgeRow, EdgeType } from "../db/edges.js";
import { estimateTokensV2 } from "../engine/token-estimator.js";

export interface MemoryGraphParams {
  id: string;
  depth?: number;
  edge_types?: EdgeType[];
  direction?: "out" | "in" | "both";
}

export async function handleMemoryGraph(
  memRepo: MemoriesRepo,
  edgesRepo: EdgesRepo,
  params: MemoryGraphParams
): Promise<string> {
  const depth = params.depth ?? 2;
  const direction = params.direction ?? "both";

  const root = memRepo.getById(params.id);
  if (!root) {
    return `Memory ${params.id} not found.`;
  }

  const { edges } = edgesRepo.subgraph(params.id, depth, params.edge_types, direction);

  const header = `Memory: "${root.title}" (${root.memory_type})`;

  if (edges.length === 0) {
    return header;
  }

  // Sort edges by edge_type then by the other node id
  const sorted = [...edges].sort((a, b) => {
    if (a.edge_type !== b.edge_type) return a.edge_type.localeCompare(b.edge_type);
    const aOther = a.from_id === params.id ? a.to_id : a.from_id;
    const bOther = b.from_id === params.id ? b.to_id : b.from_id;
    return aOther.localeCompare(bOther);
  });

  const lines: string[] = [header];
  for (const edge of sorted) {
    const otherId = edge.from_id === params.id ? edge.to_id : edge.from_id;
    const isOutgoing = edge.from_id === params.id;
    const dirMarker = isOutgoing ? `->${edge.edge_type}` : `<-${edge.edge_type}`;

    const otherMem = memRepo.getById(otherId);
    const otherTitle = otherMem ? otherMem.title : otherId;
    const otherType = otherMem ? otherMem.memory_type : "unknown";

    const lineContent = `  ${dirMarker} "${otherTitle}" (${otherType})`;
    const tokenCost = estimateTokensV2(lineContent);
    lines.push(`${lineContent} [${tokenCost}t]`);
  }

  return lines.join("\n");
}
