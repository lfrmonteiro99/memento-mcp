import { describe, it, expect } from "vitest";
import { estimateTokensV2, classifyTextType } from "../../src/engine/token-estimator.js";

describe("classifyTextType", () => {
  it("classifies plain english prose", () => {
    const text = "The quick brown fox jumps over the lazy dog. This is a simple sentence about animals.";
    expect(classifyTextType(text)).toBe("prose");
  });

  it("classifies code by special character density", () => {
    const text = 'function foo(bar: string): number {\n  return bar.length * 2;\n}\nexport { foo };';
    expect(classifyTextType(text)).toBe("code");
  });

  it("classifies JSON/structured data", () => {
    const text = '{"name": "test", "version": "1.0", "dependencies": {"a": "^1.0"}}';
    expect(classifyTextType(text)).toBe("structured");
  });

  it("classifies whitespace-heavy content", () => {
    const text = "column1     column2     column3\nvalue1      value2      value3\n\n\n  spaced  out  content  ";
    expect(classifyTextType(text)).toBe("whitespace_heavy");
  });

  it("handles empty string", () => {
    expect(classifyTextType("")).toBe("prose");
  });
});

describe("estimateTokensV2", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokensV2("")).toBe(0);
  });

  it("returns 0 for null/undefined", () => {
    expect(estimateTokensV2(null as any)).toBe(0);
    expect(estimateTokensV2(undefined as any)).toBe(0);
  });

  it("estimates prose at ~4.0 chars/token + overhead", () => {
    const text = "The quick brown fox jumps over the lazy dog repeatedly for testing purposes.";
    const estimate = estimateTokensV2(text);
    // 76 chars / 4.0 = 19 + 4 overhead = 23
    expect(estimate).toBeGreaterThan(15);
    expect(estimate).toBeLessThan(30);
  });

  it("estimates code at ~3.2 chars/token + overhead", () => {
    const code = 'export function processData(items: Item[]): Result {\n  return items.map(i => transform(i));\n}';
    const estimate = estimateTokensV2(code);
    // 95 chars / 3.2 = 29.7 + 4 = 33.7 -> ~34
    expect(estimate).toBeGreaterThan(25);
    expect(estimate).toBeLessThan(45);
  });

  it("estimates JSON at ~3.0 chars/token + overhead", () => {
    const json = '{"users": [{"id": 1, "name": "Alice"}, {"id": 2, "name": "Bob"}]}';
    const estimate = estimateTokensV2(json);
    // 66 chars / 3.0 = 22 + 4 = 26
    expect(estimate).toBeGreaterThan(18);
    expect(estimate).toBeLessThan(35);
  });

  it("estimates whitespace-heavy at ~4.5 chars/token + overhead", () => {
    const table = "col1     col2     col3\nval1     val2     val3\n\n  extra   spacing   here  ";
    const estimate = estimateTokensV2(table);
    // 74 chars / 4.5 = 16.4 + 4 = 20.4 -> ~21
    expect(estimate).toBeGreaterThan(14);
    expect(estimate).toBeLessThan(28);
  });

  it("only samples first 500 chars for classification", () => {
    const longCode = "x".repeat(1000) + 'function foo() { return 42; }';
    // Should classify based on first 500 chars (all 'x' = prose-like)
    const estimate = estimateTokensV2(longCode);
    // 1029 chars, classified as prose: 1029/4.0 = 257.25 + 4 = ~262
    expect(estimate).toBeGreaterThan(240);
    expect(estimate).toBeLessThan(280);
  });

  it("always adds framing overhead of 4 tokens", () => {
    const shortText = "hi";
    const estimate = estimateTokensV2(shortText);
    // 2 chars / 4.0 = 0.5 -> ceil = 1 + 4 overhead = 5
    expect(estimate).toBe(5);
  });
});
