import type Database from "better-sqlite3";

export type EdgeType =
  | "causes"
  | "fixes"
  | "supersedes"
  | "contradicts"
  | "derives_from"
  | "relates_to";

const VALID_EDGE_TYPES: ReadonlySet<EdgeType> = new Set([
  "causes",
  "fixes",
  "supersedes",
  "contradicts",
  "derives_from",
  "relates_to",
]);

export interface Edge {
  from_memory_id: string;
  to_memory_id: string;
  edge_type: EdgeType;
  weight: number;
  created_at: string;
}

export interface CreateEdgeInput {
  from: string;
  to: string;
  edge_type: EdgeType;
  weight?: number;
}

export class EdgesRepo {
  constructor(private db: Database.Database) {}

  create(input: CreateEdgeInput): void {
    if (!VALID_EDGE_TYPES.has(input.edge_type)) {
      throw new Error(`invalid edge_type: ${input.edge_type}`);
    }
    if (input.from === input.to) {
      throw new Error("self-loop edges not allowed");
    }
    const weight = input.weight ?? 1.0;
    this.db.prepare(`
      INSERT INTO memory_edges(from_memory_id, to_memory_id, edge_type, weight)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(from_memory_id, to_memory_id, edge_type)
      DO UPDATE SET weight = excluded.weight
    `).run(input.from, input.to, input.edge_type, weight);
  }

  outgoing(memoryId: string, edgeType?: EdgeType): Edge[] {
    if (edgeType !== undefined) {
      return this.db.prepare(
        "SELECT * FROM memory_edges WHERE from_memory_id = ? AND edge_type = ?"
      ).all(memoryId, edgeType) as Edge[];
    }
    return this.db.prepare(
      "SELECT * FROM memory_edges WHERE from_memory_id = ?"
    ).all(memoryId) as Edge[];
  }

  incoming(memoryId: string, edgeType?: EdgeType): Edge[] {
    if (edgeType !== undefined) {
      return this.db.prepare(
        "SELECT * FROM memory_edges WHERE to_memory_id = ? AND edge_type = ?"
      ).all(memoryId, edgeType) as Edge[];
    }
    return this.db.prepare(
      "SELECT * FROM memory_edges WHERE to_memory_id = ?"
    ).all(memoryId) as Edge[];
  }

  delete(from: string, to: string, edge_type: EdgeType): void {
    this.db.prepare(
      "DELETE FROM memory_edges WHERE from_memory_id = ? AND to_memory_id = ? AND edge_type = ?"
    ).run(from, to, edge_type);
  }
}
