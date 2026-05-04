import type Database from "better-sqlite3";
import type { MemoriesRepo } from "../db/memories.js";
import { EdgesRepo, type EdgeType, type Edge } from "../db/edges.js";

export interface MemoryEdgeTraverseParams {
  memory_id: string;
  edge_types?: EdgeType[];
  direction?: "outgoing" | "incoming" | "both";
}

interface NeighbourLine {
  arrow: string;
  edge_type: EdgeType;
  weight: number;
  neighbour_id: string;
  neighbour_title: string;
}

export async function handleMemoryEdgeTraverse(
  memRepo: MemoriesRepo,
  db: Database.Database,
  params: MemoryEdgeTraverseParams,
): Promise<string> {
  const anchor = memRepo.getById(params.memory_id);
  if (!anchor) {
    return `Error: memory not found: ${params.memory_id}`;
  }

  const direction = params.direction ?? "both";
  const filterTypes = params.edge_types;
  const repo = new EdgesRepo(db);

  const lines: NeighbourLine[] = [];

  const collectFromQuery = (edges: Edge[], arrow: "→" | "←", neighbourSide: "from" | "to") => {
    for (const e of edges) {
      const neighbourId = neighbourSide === "to" ? e.to_memory_id : e.from_memory_id;
      const m = memRepo.getById(neighbourId);
      if (!m) continue; // null covers both missing and soft-deleted (getById filters deleted_at)
      lines.push({
        arrow,
        edge_type: e.edge_type,
        weight: e.weight,
        neighbour_id: neighbourId,
        neighbour_title: m.title,
      });
    }
  };

  const queryByTypes = (
    fn: (memId: string, et?: EdgeType) => Edge[],
    arrow: "→" | "←",
    neighbourSide: "from" | "to",
  ) => {
    if (filterTypes && filterTypes.length > 0) {
      for (const t of filterTypes) {
        collectFromQuery(fn(params.memory_id, t), arrow, neighbourSide);
      }
    } else {
      collectFromQuery(fn(params.memory_id), arrow, neighbourSide);
    }
  };

  if (direction === "outgoing" || direction === "both") {
    queryByTypes(repo.outgoing.bind(repo), "→", "to");
  }
  if (direction === "incoming" || direction === "both") {
    queryByTypes(repo.incoming.bind(repo), "←", "from");
  }

  if (lines.length === 0) {
    return `No edges/neighbours for memory ${params.memory_id} (${anchor.title}).`;
  }

  const header = `Memory ${params.memory_id} (${anchor.title}) — ${lines.length} neighbour(s):`;
  const body = lines
    .map(
      (l) =>
        `  ${l.arrow} [${l.edge_type}, w=${l.weight.toFixed(2)}] ${l.neighbour_id} ${l.neighbour_title}`,
    )
    .join("\n");
  return `${header}\n${body}`;
}
