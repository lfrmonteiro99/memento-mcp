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

export class LocalTransformersProvider implements EmbeddingProvider {
  private extractor: any | null = null;

  constructor(
    public readonly model: string,
    public readonly dim: number,
  ) {}

  private async ensureExtractor(): Promise<any> {
    if (this.extractor) return this.extractor;
    // Lazy import — avoids cold-start cost for users who never use local embeddings.
    let mod: any;
    try {
      mod = await import("@xenova/transformers");
    } catch (e) {
      throw new Error(
        `local embeddings require @xenova/transformers; install with: npm install @xenova/transformers (cause: ${(e as Error).message})`,
      );
    }
    // Allow remote download on first run; cache locally afterwards.
    if (mod.env) {
      mod.env.allowRemoteModels = true;
      mod.env.allowLocalModels = true;
    }
    this.extractor = await mod.pipeline("feature-extraction", this.model);
    return this.extractor;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const extractor = await this.ensureExtractor();
    const out: Float32Array[] = [];
    for (const text of texts) {
      const result = await extractor(text, { pooling: "mean", normalize: true });
      // result.data is a typed array of length `dim`
      out.push(new Float32Array(result.data));
    }
    return out;
  }
}

export function createProvider(
  cfg: Config["search"]["embeddings"],
): EmbeddingProvider | null {
  if (!cfg.enabled) return null;
  if (cfg.provider === "local") {
    return new LocalTransformersProvider(cfg.model, cfg.dim);
  }
  if (cfg.provider === "openai") {
    const key = process.env[cfg.apiKeyEnv];
    if (!key) {
      logger.warn(
        `embeddings: provider=openai but ${cfg.apiKeyEnv} not set; falling back to local provider (Xenova/all-MiniLM-L6-v2)`,
      );
      return new LocalTransformersProvider("Xenova/all-MiniLM-L6-v2", 384);
    }
    return new OpenAIEmbeddingProvider(key, cfg.model, cfg.dim, cfg.requestTimeoutMs);
  }
  throw new Error(`unsupported embedding provider: ${cfg.provider}`);
}
