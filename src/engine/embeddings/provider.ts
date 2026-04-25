// src/engine/embeddings/provider.ts
import { createLogger, logLevelFromEnv } from "../../lib/logger.js";
import type { Config } from "../../lib/config.js";

const logger = createLogger(logLevelFromEnv());

export interface EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private apiKey: string,
    public readonly model: string,
    public readonly dim: number,
    private timeoutMs: number,
  ) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ input: texts, model: this.model }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`OpenAI embeddings API error ${response.status}: ${body}`);
      }

      const json = (await response.json()) as { data: Array<{ embedding: number[] }> };
      return json.data.map((d) => Float32Array.from(d.embedding));
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createProvider(
  cfg: Config["search"]["embeddings"],
): EmbeddingProvider | null {
  if (!cfg.enabled) return null;
  const key = process.env[cfg.apiKeyEnv];
  if (!key) {
    logger.warn(`embeddings enabled but ${cfg.apiKeyEnv} not set; disabling`);
    return null;
  }
  if (cfg.provider === "openai") {
    return new OpenAIEmbeddingProvider(key, cfg.model, cfg.dim, cfg.requestTimeoutMs);
  }
  throw new Error(`unsupported embedding provider: ${cfg.provider}`);
}
