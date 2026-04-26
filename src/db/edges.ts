// src/db/edges.ts
import type Database from "better-sqlite3";
import { nowIso } from "./database.js";

export type EdgeType =
  | "relates_to"
  | "supersedes"
  | "caused_by"
  | "mitigated_by"
  | "references"
  | "implements";

export const ALLOWED_EDGE_TYPES: EdgeType[] = [
  "relates_to",
  "supersedes",
  "caused_by",
  "mitigated_by",
  "references",
  "implements",
];

export interface EdgeRow {
  from_id: string;
  to_id: string;
  edge_type: EdgeType;
  weight: number;
  created_at: string;
}

export class EdgesRepo {
  constructor(private db: Database.Database) {}

  link(fromId: string, toId: string, type: EdgeType, weight: number = 1.0): void {
    if (fromId === toId) {
      throw new Error("Self-edges are not allowed");
    }
    if (!ALLOWED_EDGE_TYPES.includes(type)) {
      throw new Error(`Unknown edge type: ${type}`);
    }
    this.db.prepare(`
      INSERT OR REPLACE INTO memory_edges (from_id, to_id, edge_type, weight, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(fromId, toId, type, weight, nowIso());
  }

  unlink(fromId: string, toId: string, type: EdgeType): boolean {
    const result = this.db.prepare(`
      DELETE FROM memory_edges WHERE from_id = ? AND to_id = ? AND edge_type = ?
    `).run(fromId, toId, type);
    return result.changes > 0;
  }

  outgoing(id: string, types?: EdgeType[]): EdgeRow[] {
    if (types && types.length > 0) {
      const placeholders = types.map(() => "?").join(",");
      return this.db.prepare(`
        SELECT * FROM memory_edges WHERE from_id = ? AND edge_type IN (${placeholders})
        ORDER BY edge_type, to_id
      `).all(id, ...types) as EdgeRow[];
    }
    return this.db.prepare(`
      SELECT * FROM memory_edges WHERE from_id = ? ORDER BY edge_type, to_id
    `).all(id) as EdgeRow[];
  }

  incoming(id: string, types?: EdgeType[]): EdgeRow[] {
    if (types && types.length > 0) {
      const placeholders = types.map(() => "?").join(",");
      return this.db.prepare(`
        SELECT * FROM memory_edges WHERE to_id = ? AND edge_type IN (${placeholders})
        ORDER BY edge_type, from_id
      `).all(id, ...types) as EdgeRow[];
    }
    return this.db.prepare(`
      SELECT * FROM memory_edges WHERE to_id = ? ORDER BY edge_type, from_id
    `).all(id) as EdgeRow[];
  }

  subgraph(
    rootId: string,
    depth: number,
    types?: EdgeType[],
    direction: "out" | "in" | "both" = "both"
  ): { nodes: string[]; edges: EdgeRow[] } {
    const visited = new Set<string>();
    const allEdges: EdgeRow[] = [];
    visited.add(rootId);

    let frontier = [rootId];

    for (let d = 0; d < depth; d++) {
      const nextFrontier: string[] = [];
      for (const nodeId of frontier) {
        const outEdges = direction !== "in" ? this.outgoing(nodeId, types) : [];
        const inEdges = direction !== "out" ? this.incoming(nodeId, types) : [];

        for (const edge of outEdges) {
          allEdges.push(edge);
          if (!visited.has(edge.to_id)) {
            visited.add(edge.to_id);
            nextFrontier.push(edge.to_id);
          }
        }
        for (const edge of inEdges) {
          allEdges.push(edge);
          if (!visited.has(edge.from_id)) {
            visited.add(edge.from_id);
            nextFrontier.push(edge.from_id);
          }
        }
      }
      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }

    return { nodes: Array.from(visited), edges: allEdges };
  }

  shortestPath(
    fromId: string,
    toId: string,
    maxHops: number,
    types?: EdgeType[]
  ): string[] | null {
    if (fromId === toId) return [fromId];

    const visited = new Map<string, string | null>();
    visited.set(fromId, null);
    let frontier = [fromId];

    for (let hop = 0; hop < maxHops; hop++) {
      const nextFrontier: string[] = [];
      for (const nodeId of frontier) {
        const outEdges = this.outgoing(nodeId, types);
        const inEdges = this.incoming(nodeId, types);
        const neighbors = [
          ...outEdges.map(e => e.to_id),
          ...inEdges.map(e => e.from_id),
        ];
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            visited.set(neighbor, nodeId);
            if (neighbor === toId) {
              // Reconstruct path
              const path: string[] = [];
              let cur: string | null = toId;
              while (cur !== null) {
                path.unshift(cur);
                cur = visited.get(cur) ?? null;
              }
              return path;
            }
            nextFrontier.push(neighbor);
          }
        }
      }
      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }

    return null;
  }
}
