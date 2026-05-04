import { describe, it, expect } from "vitest";
import { retryWithBackoff } from "../../src/engine/llm/http.js";

describe("retryWithBackoff", () => {
  it("retries 3 times on transient error and returns on the third call", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 3) throw new Error("ETIMEDOUT");
      return "summary text";
    };
    const result = await retryWithBackoff(fn, { attempts: 3, baseDelayMs: 1 });
    expect(calls).toBe(3);
    expect(result).toBe("summary text");
  });

  it("rethrows the last error after exhausting attempts", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new Error(`fail-${calls}`);
    };
    await expect(retryWithBackoff(fn, { attempts: 3, baseDelayMs: 1 }))
      .rejects.toThrow("fail-3");
    expect(calls).toBe(3);
  });

  it("succeeds on first attempt without retrying", async () => {
    let calls = 0;
    const fn = async () => { calls++; return "ok"; };
    const result = await retryWithBackoff(fn, { attempts: 3, baseDelayMs: 1 });
    expect(calls).toBe(1);
    expect(result).toBe("ok");
  });
});
