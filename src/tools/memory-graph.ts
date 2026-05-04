// src/tools/memory-graph.ts
import type { MemoriesRepo } from "../db/memories.js";
import type { EdgesRepo, EdgeType } from "../db/edges.js";
import { estimateTokensV2 } from "../engine/token-estimator.js";

export interface MemoryGraphParams {
  id: string;
  depth?: number;
  edge_types?: EdgeType[];
  direction?: "out" | "in" | "both";
}

/** Structured payload for memory_graph's outputSchema. */
export type MemoryGraphResult = {
  found: boolean;
  root?: { id: string; title: string; memory_type: string };
  edges: Array<{
    direction: "out" | "in";
    edge_type: EdgeType;
    weight?: number;
    other: { id: string; title: string; memory_type: string };
    token_cost: number;
  }>;
};

export async function walkMemoryGraph(
  memRepo: MemoriesRepo,
  edgesRepo: EdgesRepo,
  params: MemoryGraphParams,
): Promise<{ text: string; structured: MemoryGraphResult }> {
  const depth = params.depth ?? 2;
  const direction = params.direction ?? "both";

  const root = memRepo.getById(params.id);
  if (!root) {
    return {
      text: `Memory ${params.id} not found.`,
      structured: { found: false, edges: [] },
    };
  }

  const { edges } = edgesRepo.subgraph(params.id, depth, params.edge_types, direction);

  const header = `Memory: "${root.title}" (${root.memory_type})`;

  if (edges.length === 0) {
    return {
      text: header,
      structured: {
        found: true,
        root: { id: String(root.id), title: String(root.title), memory_type: String(root.memory_type) },
        edges: [],
      },
    };
  }

  const sorted = [...edges].sort((a, b) => {
    if (a.edge_type !== b.edge_type) return a.edge_type.localeCompare(b.edge_type);
    const aOther = a.from_id === params.id ? a.to_id : a.from_id;
    const bOther = b.from_id === params.id ? b.to_id : b.from_id;
    return aOther.localeCompare(bOther);
  });

  const lines: string[] = [header];
  const structuredEdges: MemoryGraphResult["edges"] = [];

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

    structuredEdges.push({
      direction: isOutgoing ? "out" : "in",
      edge_type: edge.edge_type,
      ...(typeof (edge as any).weight === "number" ? { weight: Number((edge as any).weight) } : {}),
      other: { id: String(otherId), title: String(otherTitle), memory_type: String(otherType) },
      token_cost: tokenCost,
    });
  }

  return {
    text: lines.join("\n"),
    structured: {
      found: true,
      root: { id: String(root.id), title: String(root.title), memory_type: String(root.memory_type) },
      edges: structuredEdges,
    },
  };
}

/** Backward-compatible wrapper returning only the rendered text. */
export async function handleMemoryGraph(
  memRepo: MemoriesRepo,
  edgesRepo: EdgesRepo,
  params: MemoryGraphParams,
): Promise<string> {
  const { text } = await walkMemoryGraph(memRepo, edgesRepo, params);
  return text;
}
