// src/hooks/quality-score.ts
// Heuristic quality score for auto-captured memories.
// Used by P0 Task 6 compressor to prune low-value entries before merge.

export interface QualityInput {
  text: string;
  /** 0..1 confidence from src/engine/classifier.ts */
  classifierConfidence: number;
  /** Number of utility-signal markers found in the text. */
  signalCount: number;
}

export function computeQualityScore(input: QualityInput): number {
  const lengthFactor = Math.min(input.text.length / 500, 1.0);
  const signalFactor = Math.min(input.signalCount / 3, 1.0);
  const confidence = Math.max(0, Math.min(1, input.classifierConfidence));
  return lengthFactor * 0.3 + signalFactor * 0.3 + confidence * 0.4;
}
