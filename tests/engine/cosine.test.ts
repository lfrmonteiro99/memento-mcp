// tests/engine/cosine.test.ts
import { describe, it, expect } from "vitest";
import { cosineSimilarity, floatToBlob, blobToFloat } from "../../src/engine/embeddings/cosine.js";

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1.0, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it("returns -1 for opposite vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  it("returns 0 for zero vector", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("returns 0 for mismatched lengths", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("correctly computes known cosine value", () => {
    // a = [1, 0], b = [1, 1]/sqrt(2) => cos = 1/sqrt(2) ≈ 0.707
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(Math.SQRT1_2, 4);
  });
});

describe("floatToBlob / blobToFloat round-trip", () => {
  it("round-trips a Float32Array", () => {
    const original = new Float32Array([0.1, 0.5, -0.3, 1.0, -1.0, 0.0]);
    const blob = floatToBlob(original);
    const restored = blobToFloat(blob);
    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 5);
    }
  });

  it("returns a Buffer from floatToBlob", () => {
    const v = new Float32Array([1, 2, 3]);
    const b = floatToBlob(v);
    expect(Buffer.isBuffer(b)).toBe(true);
    expect(b.byteLength).toBe(v.byteLength);
  });

  it("returns a Float32Array from blobToFloat", () => {
    const v = new Float32Array([1, 2, 3]);
    const b = floatToBlob(v);
    const out = blobToFloat(b);
    expect(out instanceof Float32Array).toBe(true);
    expect(out.length).toBe(3);
  });

  it("handles single-element vector", () => {
    const v = new Float32Array([42.5]);
    const restored = blobToFloat(floatToBlob(v));
    expect(restored[0]).toBeCloseTo(42.5, 4);
  });
});
