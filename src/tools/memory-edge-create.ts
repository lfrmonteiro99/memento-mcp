import type Database from "better-sqlite3";
import type { MemoriesRepo } from "../db/memories.js";
import { EdgesRepo, type EdgeType } from "../db/edges.js";

export interface MemoryEdgeCreateParams {
  from_memory_id: string;
  to_memory_id: string;
  edge_type: EdgeType;
  weight?: number;
}

export async function handleMemoryEdgeCreate(
  memRepo: MemoriesRepo,
  db: Database.Database,
  params: MemoryEdgeCreateParams,
): Promise<string> {
  const fromMem = memRepo.getById(params.from_memory_id);
  if (!fromMem) {
    return `Error: from_memory_id not found: ${params.from_memory_id}`;
  }
  const toMem = memRepo.getById(params.to_memory_id);
  if (!toMem) {
    return `Error: to_memory_id not found: ${params.to_memory_id}`;
  }
  const repo = new EdgesRepo(db);
  try {
    repo.create({
      from: params.from_memory_id,
      to: params.to_memory_id,
      edge_type: params.edge_type,
      weight: params.weight,
    });
    return `Edge created: ${params.from_memory_id} --[${params.edge_type}]--> ${params.to_memory_id} (weight=${params.weight ?? 1.0})`;
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}
