// src/engine/llm/http.ts
// Shared HTTP helper: timeout/AbortController/error-extraction pattern.
// Used by LLM providers and can be used by embedding providers.

export interface FetchWithTimeoutOptions {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface FetchResult {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/**
 * Perform a JSON POST with AbortController-based timeout.
 * Throws if the request is aborted (timeout) or a network error occurs.
 */
export async function fetchWithTimeout(opts: FetchWithTimeoutOptions): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const response = await fetch(opts.url, {
      method: opts.method ?? "POST",
      signal: controller.signal,
      headers: opts.headers,
      body: opts.body,
    });
    return response as FetchResult;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract a human-readable error message from a failed API response body.
 * Tries JSON .error.message, .message, .detail — falls back to raw text.
 */
export async function extractApiError(response: FetchResult): Promise<string> {
  const bodyText = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    // Anthropic error shape: { error: { message: string } }
    if (parsed.error && typeof (parsed.error as Record<string, unknown>).message === "string") {
      return (parsed.error as Record<string, unknown>).message as string;
    }
    // OpenAI error shape: { error: { message: string } } (same)
    // Generic .message
    if (typeof parsed.message === "string") return parsed.message;
    // Generic .detail
    if (typeof parsed.detail === "string") return parsed.detail;
  } catch {
    // not JSON
  }
  return bodyText || `HTTP ${response.status}`;
}
