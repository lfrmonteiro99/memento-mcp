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

// Lightweight regex set covering the markers the classifier already uses to
// decide capture (errors, fixes, decisions, stack traces, TODOs). Used at the
// auto-capture call site to feed `signalCount` into computeQualityScore.
const SIGNAL_PATTERNS: RegExp[] = [
  /\berrors?\b/gi,
  /\bfix(ed|es|ing)?\b/gi,
  /\bfailed?\b/gi,
  /\bdecided?\b/gi,
  /\bstack( ?trace)?\b/gi,
  /\btodo\b/gi,
];

export function countSignalMarkers(text: string): number {
  let count = 0;
  for (const re of SIGNAL_PATTERNS) {
    const m = text.match(re);
    if (m) count += m.length;
  }
  return count;
}
