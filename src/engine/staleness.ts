// src/engine/staleness.ts
// Pure verdict over (lines changed, range size, file existence).
// Used by P4 anchors-check CLI and the opt-in PostToolUse hook.

import type { AnchorStatus } from "../db/anchors.js";

export interface StalenessInput {
  linesChanged: number;
  /** line_end - line_start + 1; use 0 for file-only anchors. */
  rangeSize: number;
  fileExists: boolean;
}

export interface StalenessVerdict {
  status: AnchorStatus;
  reason: string | null;
  changeFraction: number;
}

const STALE_THRESHOLD = 0.3;

export function computeStaleness(input: StalenessInput): StalenessVerdict {
  if (!input.fileExists) {
    return { status: "anchor-deleted", reason: "file removed since anchor", changeFraction: 1 };
  }
  // -1 sentinel from linesChangedSince: anchor range overflows current file
  // (file shrunk past the anchor). Treat as stale rather than fresh.
  if (input.linesChanged < 0) {
    return { status: "stale", reason: "anchor range no longer present in file", changeFraction: 1 };
  }
  if (input.rangeSize <= 0) {
    return { status: "fresh", reason: null, changeFraction: 0 };
  }
  if (input.linesChanged === 0) {
    return { status: "fresh", reason: null, changeFraction: 0 };
  }
  const fraction = input.linesChanged / input.rangeSize;
  if (input.rangeSize === 1 || fraction >= STALE_THRESHOLD) {
    return {
      status: "stale",
      reason: `${input.linesChanged}/${input.rangeSize} lines modified (${(fraction * 100).toFixed(0)}%)`,
      changeFraction: fraction,
    };
  }
  return { status: "fresh", reason: null, changeFraction: fraction };
}
