// src/db/embeddings.ts
import type Database from "better-sqlite3";
import { floatToBlob, blobToFloat, cosineSimilarity } from "../engine/embeddings/cosine.js";

export class EmbeddingsRepo {
  constructor(private db: Database.Database) {}

  upsert(memoryId: string, model: string, vector: Float32Array): void {
    const blob = floatToBlob(vector);
    this.db.prepare(`
      INSERT OR REPLACE INTO embeddings (memory_id, model, dim, vector, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(memoryId, model, vector.length, blob);
  }

  get(memoryId: string): { model: string; dim: number; vector: Float32Array } | null {
    const row = this.db.prepare(
      "SELECT model, dim, vector FROM embeddings WHERE memory_id = ?"
    ).get(memoryId) as { model: string; dim: number; vector: Buffer } | undefined;
    if (!row) return null;
    return {
      model: row.model,
      dim: row.dim,
      vector: blobToFloat(row.vector),
    };
  }

  deleteByMemory(memoryId: string): void {
    this.db.prepare("DELETE FROM embeddings WHERE memory_id = ?").run(memoryId);
  }

  getByProject(
    projectId: string | null,
    model: string,
  ): Array<{ memoryId: string; vector: Float32Array }> {
    let rows: Array<{ memory_id: string; vector: Buffer }>;
    if (projectId === null) {
      rows = this.db.prepare(`
        SELECT e.memory_id, e.vector
        FROM embeddings e
        JOIN memories m ON e.memory_id = m.id
        WHERE m.deleted_at IS NULL
          AND (m.project_id IS NULL OR m.scope = 'global')
          AND e.model = ?
      `).all(model) as Array<{ memory_id: string; vector: Buffer }>;
    } else {
      rows = this.db.prepare(`
        SELECT e.memory_id, e.vector
        FROM embeddings e
        JOIN memories m ON e.memory_id = m.id
        WHERE m.deleted_at IS NULL
          AND (m.project_id = ? OR m.scope = 'global')
          AND e.model = ?
      `).all(projectId, model) as Array<{ memory_id: string; vector: Buffer }>;
    }
    return rows.map((r) => ({
      memoryId: r.memory_id,
      vector: blobToFloat(r.vector),
    }));
  }

  topKByCosine(
    queryVec: Float32Array,
    projectId: string | null,
    model: string,
    k: number,
  ): Array<{ id: string; score: number }> {
    const candidates = this.getByProject(projectId, model);
    const scored = candidates.map((c) => ({
      id: c.memoryId,
      score: cosineSimilarity(queryVec, c.vector),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  countMissing(model: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM memories m
      LEFT JOIN embeddings e ON e.memory_id = m.id AND e.model = ?
      WHERE m.deleted_at IS NULL AND e.memory_id IS NULL
    `).get(model) as { cnt: number };
    return row.cnt;
  }

  *iterateMissing(
    model: string,
    batchSize: number,
  ): IterableIterator<{ id: string; title: string; body: string }> {
    let offset = 0;
    while (true) {
      const batch = this.db.prepare(`
        SELECT m.id, m.title, COALESCE(m.body, '') AS body
        FROM memories m
        LEFT JOIN embeddings e ON e.memory_id = m.id AND e.model = ?
        WHERE m.deleted_at IS NULL AND e.memory_id IS NULL
        ORDER BY m.created_at ASC
        LIMIT ? OFFSET ?
      `).all(model, batchSize, offset) as Array<{ id: string; title: string; body: string }>;

      if (batch.length === 0) break;
      yield* batch;
      offset += batch.length;
      if (batch.length < batchSize) break;
    }
  }
}
