// src/hooks/anchor-staleness.ts
// P4 Task 8: opt-in PostToolUse pipeline that marks anchors stale on the fly
// when their file is touched by Edit/Write. OFF by default — heavy users
// running `memento-mcp anchors check` on a schedule should not pay for it.

import type Database from "better-sqlite3";
import { AnchorsRepo, type Anchor } from "../db/anchors.js";
import {
  hasGit,
  fileExistsAtCommit,
  linesChangedSince,
} from "../engine/git-introspect.js";
import { computeStaleness } from "../engine/staleness.js";

export interface AnchorStalenessInput {
  enabled: boolean;
  cwd: string;
  toolName: string;
  filePath: string | undefined;
}

const ELIGIBLE_TOOLS = new Set(["Edit", "Write"]);

export function processAnchorStaleness(
  db: Database.Database,
  input: AnchorStalenessInput,
): void {
  if (!input.enabled) return;
  if (!ELIGIBLE_TOOLS.has(input.toolName)) return;
  if (!input.filePath || !input.cwd) return;
  if (!hasGit(input.cwd)) return;

  const anchorRepo = new AnchorsRepo(db);

  // Match anchors both by relative path (typical) and any file_path that ends
  // with the edited file — defensive for tools that pass absolute paths.
  const candidates: Anchor[] = anchorRepo.listByFile(input.filePath);
  const fresh = candidates.filter(a => a.status === "fresh");
  if (fresh.length === 0) return;

  for (const a of fresh) {
    const exists = fileExistsAtCommit(input.cwd, a.file_path, "HEAD");
    if (!exists) {
      anchorRepo.markAnchorDeleted(a.id, "file removed since anchor");
      continue;
    }
    if (a.line_start == null || a.line_end == null || !a.commit_sha) {
      // file-only anchor: nothing to compute, file still exists → stays fresh
      continue;
    }
    const linesChanged = linesChangedSince(
      input.cwd,
      a.file_path,
      a.commit_sha,
      a.line_start,
      a.line_end,
    );
    const verdict = computeStaleness({
      linesChanged,
      rangeSize: a.line_end - a.line_start + 1,
      fileExists: true,
    });
    if (verdict.status === "stale") {
      anchorRepo.markStale(a.id, verdict.reason ?? "");
    } else if (verdict.status === "anchor-deleted") {
      anchorRepo.markAnchorDeleted(a.id, verdict.reason ?? "");
    }
  }
}
