// src/engine/git-introspect.ts
// Thin wrappers around git via child_process.
// Used by P4 anchor-staleness pipeline (CLI `anchors check` and the opt-in hook).
//
// Design: every helper is independent and never throws on missing git or
// missing files — callers get a boolean / number / string they can branch on,
// not exceptions. This keeps the staleness check tolerant of repos that have
// been moved, branches that have been pruned, or files that have been deleted.

import { execFileSync } from "node:child_process";
import { createLogger, logLevelFromEnv } from "../lib/logger.js";

const logger = createLogger(logLevelFromEnv());

interface RunOpts {
  allowFail?: boolean;
}

/** Run git with argv-array form (no shell quoting bugs).
 * On failure with allowFail=true, captures stderr to the debug log so silently-wrong
 * staleness verdicts can be diagnosed without re-running. */
function git(cwd: string, args: string[], opts: RunOpts = {}): string {
  try {
    return execFileSync("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString("utf-8");
  } catch (e) {
    if (opts.allowFail) {
      const err = e as { stderr?: Buffer; status?: number };
      const stderr = err.stderr?.toString("utf-8").trim() ?? "";
      logger.debug(`git ${args.join(" ")} failed in ${cwd} (exit ${err.status}): ${stderr || "(no stderr)"}`);
      return "";
    }
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
 * then `git merge-base --is-ancestor <chunk> <sinceSha>` to filter.
 *
 * Return semantics:
 * - >0   : that many lines changed
 * - 0    : range is unchanged (all blame chunks are ancestors of sinceSha)
 * - -1   : range no longer exists (file shrunk past the anchor); caller
 *          should treat this as "stale" rather than "fresh".
 *
 * `sinceSha` is the upper bound for "changes that count": lines authored
 * at-or-before this sha are considered fresh.
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
  if (!blame) {
    // Could be: range exceeds file (file shrunk) OR file missing OR git error.
    // Distinguish: if file exists at HEAD, it's a range overflow → stale signal.
    if (fileExistsAtCommit(repoDir, filePath, "HEAD")) return -1;
    return 0; // caller will independently detect fileExists=false → anchor-deleted
  }

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
