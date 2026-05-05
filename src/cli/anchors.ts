// src/cli/anchors.ts
// Implementation of `memento-mcp anchors check` (P4 Task 6).
// Walks every fresh anchor in the project, runs git introspection, and
// transitions each to stale / anchor-deleted as appropriate.

import type Database from "better-sqlite3";
import { MemoriesRepo } from "../db/memories.js";
import { AnchorsRepo, type Anchor } from "../db/anchors.js";
import {
  hasGit,
  fileExistsAtCommit,
  linesChangedSince,
} from "../engine/git-introspect.js";
import { computeStaleness } from "../engine/staleness.js";

export interface AnchorsCheckSummary {
  scanned: number;
  stale: number;
  deleted: number;
  fresh: number;
  notGitRepo: boolean;
}

export interface AnchorsCheckOptions {
  db: Database.Database;
  projectPath: string;
}

export function runAnchorsCheck(opts: AnchorsCheckOptions): AnchorsCheckSummary {
  const summary: AnchorsCheckSummary = {
    scanned: 0,
    stale: 0,
    deleted: 0,
    fresh: 0,
    notGitRepo: false,
  };
  if (!hasGit(opts.projectPath)) {
    summary.notGitRepo = true;
    return summary;
  }

  const memRepo = new MemoriesRepo(opts.db);
  const projectId = memRepo.ensureProject(opts.projectPath);
  const anchorRepo = new AnchorsRepo(opts.db);

  const anchors = opts.db
    .prepare(
      `SELECT a.* FROM memory_anchors a
       JOIN memories m ON m.id = a.memory_id
       WHERE m.project_id = ? AND a.status = 'fresh' AND m.deleted_at IS NULL`,
    )
    .all(projectId) as Anchor[];

  summary.scanned = anchors.length;

  for (const a of anchors) {
    const exists = fileExistsAtCommit(opts.projectPath, a.file_path, "HEAD");
    if (!exists) {
      anchorRepo.markAnchorDeleted(a.id, "file removed since anchor");
      summary.deleted++;
      continue;
    }
    if (a.line_start == null || a.line_end == null || !a.commit_sha) {
      // file-only anchors are fresh as long as the file exists
      summary.fresh++;
      continue;
    }
    const linesChanged = linesChangedSince(
      opts.projectPath,
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
      summary.stale++;
    } else if (verdict.status === "anchor-deleted") {
      anchorRepo.markAnchorDeleted(a.id, verdict.reason ?? "");
      summary.deleted++;
    } else {
      summary.fresh++;
    }
  }

  return summary;
}
