// src/engine/git-introspect.ts
// Thin wrappers around git via child_process.
// Used by P4 anchor-staleness pipeline (CLI `anchors check` and the opt-in hook).
//
// Design: every helper is independent and never throws on missing git or
// missing files — callers get a boolean / number / string they can branch on,
// not exceptions. This keeps the staleness check tolerant of repos that have
// been moved, branches that have been pruned, or files that have been deleted.

import { execFileSync } from "node:child_process";

interface RunOpts {
  allowFail?: boolean;
}

/** Run git with argv-array form (no shell quoting bugs). */
function git(cwd: string, args: string[], opts: RunOpts = {}): string {
  try {
    return execFileSync("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString("utf-8");
  } catch (e) {
    if (opts.allowFail) return "";
    throw e;
  }
}

export function hasGit(repoDir: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repoDir,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function currentCommitSha(repoDir: string): string {
  return git(repoDir, ["rev-parse", "HEAD"]).trim();
}

export function fileExistsAtCommit(
  repoDir: string,
  filePath: string,
  sha: string,
): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}:${filePath}`], {
      cwd: repoDir,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Count how many lines in the [start..end] range (1-based inclusive) of
 * `filePath` were last touched by a commit that is NOT an ancestor of
 * `sinceSha` — i.e. commits newer than the anchor's pinned sha.
 *
 * Uses `git blame --line-porcelain` to get the originating sha for each line,
 * then `git merge-base --is-ancestor <chunk> <sinceSha>` to filter. Returns 0
 * on any git failure (file missing, range out of bounds, etc.).
 */
export function linesChangedSince(
  repoDir: string,
  filePath: string,
  sinceSha: string,
  start: number,
  end: number,
): number {
  const blame = git(
    repoDir,
    ["blame", "--line-porcelain", "-L", `${start},${end}`, filePath],
    { allowFail: true },
  );
  if (!blame) return 0;

  const chunkShas = new Set<string>();
  for (const line of blame.split("\n")) {
    const m = line.match(/^([a-f0-9]{40})\s/);
    if (m) chunkShas.add(m[1]);
  }
  if (chunkShas.size === 0) return 0;

  // For each distinct chunk-originating sha, check whether it is an ancestor
  // of sinceSha. If yes → line is at-or-before the anchor, not "changed".
  // If no → line was introduced after the anchor, count once per affected line.
  let changedLines = 0;
  for (const chunk of chunkShas) {
    let ancestor = false;
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", chunk, sinceSha], {
        cwd: repoDir,
        stdio: "ignore",
      });
      ancestor = true;
    } catch {
      ancestor = false;
    }
    if (!ancestor) {
      // Count lines in the blame output that originated from this chunk.
      // Each line in the requested range produces one porcelain header that
      // begins with `<sha> orig cur [n]` and is followed by metadata lines.
      const re = new RegExp(`^${chunk}\\s\\d+\\s\\d+`, "gm");
      const matches = blame.match(re);
      if (matches) changedLines += matches.length;
    }
  }
  return changedLines;
}
