// src/engine/llm/provider.ts
// LLM provider abstraction for session summarization.
// Mirrors the EmbeddingProvider pattern from src/engine/embeddings/provider.ts.

import { fetchWithTimeout, extractApiError } from "./http.js";
import type { SessionEndLlmConfig } from "../../lib/config.js";

export interface LlmProvider {
  readonly model: string;
  complete(
    systemPrompt: string,
    userPrompt: string,
    opts: { maxOutputTokens: number; timeoutMs: number }
  ): Promise<string>;
}

const REDACTED_JSON = '"[LlmProvider redacted]"';

export class AnthropicProvider implements LlmProvider {
  constructor(
    private readonly apiKey: string,
    public readonly model: string,
  ) {}

  async complete(
    system: string,
    user: string,
    opts: { maxOutputTokens: number; timeoutMs: number }
  ): Promise<string> {
    const response = await fetchWithTimeout({
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts.maxOutputTokens,
        system,
        messages: [{ role: "user", content: user }],
      }),
      timeoutMs: opts.timeoutMs,
    });

    if (!response.ok) {
      const msg = await extractApiError(response);
      throw new Error(`Anthropic API error ${response.status}: ${msg}`);
    }

    const json = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    const text = json.content?.find((c) => c.type === "text")?.text;
    if (!text) throw new Error("Anthropic response contained no text content");
    return text;
  }

  toJSON(): string {
    return REDACTED_JSON;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED_JSON;
  }
}

export class OpenAIProvider implements LlmProvider {
  constructor(
    private readonly apiKey: string,
    public readonly model: string,
  ) {}

  async complete(
    system: string,
    user: string,
    opts: { maxOutputTokens: number; timeoutMs: number }
  ): Promise<string> {
    const response = await fetchWithTimeout({
      url: "https://api.openai.com/v1/chat/completions",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts.maxOutputTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      timeoutMs: opts.timeoutMs,
    });

    if (!response.ok) {
      const msg = await extractApiError(response);
      throw new Error(`OpenAI API error ${response.status}: ${msg}`);
    }

    const json = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const text = json.choices?.[0]?.message?.content;
    if (!text) throw new Error("OpenAI response contained no content");
    return text;
  }

  toJSON(): string {
    return REDACTED_JSON;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED_JSON;
  }
}

export function createLlmProvider(cfg: SessionEndLlmConfig): LlmProvider | null {
  const key = process.env[cfg.apiKeyEnv];
  if (!key) return null;
  if (cfg.provider === "anthropic") return new AnthropicProvider(key, cfg.model);
  if (cfg.provider === "openai") return new OpenAIProvider(key, cfg.model);
  return null;
}
