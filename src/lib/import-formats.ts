// src/lib/import-formats.ts — registry of supported LLM instruction-file formats.
// Each format spec knows how to: resolve default candidate paths from the user's
// scope+cwd+home, and how to read its candidate path into ImportSection[].
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import type { ImportResult } from "./import-claude-md.js";
import { parseClaudeMd } from "./import-claude-md.js";
import {
  stripFrontmatter,
  frontmatterToTags,
  walkRulesDir,
  prefixSectionTitles,
} from "./import-shared.js";

export interface FormatSpec {
  key: string;
  source: string;                // value stored in memories.source
  /**
   * Candidate paths to try, in priority order. First existing path wins.
   * For formats that aggregate (e.g. copilot pulls both a single file AND a dir),
   * the format's read() handles aggregation; resolve() still returns the primary
   * candidate so the dispatcher can decide whether anything's there at all.
   */
  resolve(scope: "global" | "project", cwd: string, home: string): string[];
  /** Parse the resolved path into ImportSections; supports both file and dir paths. */
  read(path: string, defaultType: string): ImportResult & { label: string };
}

// ---------------------------------------------------------------------------
// Helpers shared between specs
// ---------------------------------------------------------------------------

/** Walk up from `start` looking for a file named `fname`, stopping at the git root or fs root. */
function walkUpForFile(start: string, fname: string): string | null {
  let dir = start;
  for (let i = 0; i < 50; i++) {
    const candidate = join(dir, fname);
    if (existsSync(candidate)) {
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch { /* continue */ }
    }
    // Stop at git root
    if (existsSync(join(dir, ".git"))) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Read a single markdown file → ImportResult. */
function readMarkdownFile(path: string, defaultType: string): ImportResult & { label: string } {
  const content = readFileSync(path, "utf-8");
  const { sections, skipped } = parseClaudeMd(content, defaultType);
  return { sections, skipped, label: path };
}

/**
 * Read every .md/.mdc file under `dir` (alphabetical, optionally recursive),
 * stripping frontmatter, prepending `description` to body so type/tag inference
 * can see it, and merging frontmatter-derived tags into each section.
 * Section titles are prefixed with `[basename]` so cross-file headings don't
 * collide on the title-dedup query.
 */
function readRulesDir(
  dir: string,
  exts: string[],
  recursive: boolean,
  defaultType: string
): ImportResult & { label: string } {
  const files = walkRulesDir(dir, exts, recursive);
  const allSections: ImportResult["sections"] = [];
  const allSkipped: ImportResult["skipped"] = [];

  for (const f of files) {
    const raw = readFileSync(f, "utf-8");
    const { fm, body } = stripFrontmatter(raw);
    const fmTags = frontmatterToTags(fm);

    let effectiveBody = body;
    if (fm.description && !/^#{1,6}\s/m.test(body)) {
      // Use description as a heading so parseClaudeMd treats it as the title.
      effectiveBody = `## ${fm.description}\n${body}`;
    } else if (fm.description) {
      effectiveBody = `${fm.description}\n\n${body}`;
    }

    const { sections, skipped } = parseClaudeMd(effectiveBody, defaultType);
    const prefixed = prefixSectionTitles(sections, f);
    for (const s of prefixed) {
      // Merge frontmatter tags (deduped).
      const merged = new Set([...s.inferredTags, ...fmTags]);
      allSections.push({ ...s, inferredTags: [...merged] });
    }
    allSkipped.push(...skipped);
  }

  // Label is the dir, with a count of files that contributed.
  const label = `${dir} (${files.length} file${files.length === 1 ? "" : "s"})`;
  return { sections: allSections, skipped: allSkipped, label };
}

// ---------------------------------------------------------------------------
// Format specs
// ---------------------------------------------------------------------------

const claudeMd: FormatSpec = {
  key: "claude-md",
  source: "import-claude-md",
  resolve: (scope, cwd, home) =>
    scope === "global" ? [join(home, ".claude", "CLAUDE.md")] : [join(cwd, "CLAUDE.md")],
  read: readMarkdownFile,
};

const cursor: FormatSpec = {
  key: "cursor",
  source: "import-cursor",
  resolve: (_scope, cwd) => [join(cwd, ".cursor", "rules"), join(cwd, ".cursorrules")],
  read: (path, defaultType) => {
    let stat;
    try { stat = statSync(path); } catch {
      return { sections: [], skipped: [], label: path };
    }
    if (stat.isDirectory()) {
      return readRulesDir(path, [".mdc", ".md"], false, defaultType);
    }
    return readMarkdownFile(path, defaultType);
  },
};

const copilot: FormatSpec = {
  key: "copilot",
  source: "import-copilot",
  resolve: (_scope, cwd) => {
    const dir = join(cwd, ".github");
    const candidates: string[] = [];
    if (existsSync(join(dir, "instructions"))) candidates.push(join(dir, "instructions"));
    if (existsSync(join(dir, "copilot-instructions.md"))) candidates.push(join(dir, "copilot-instructions.md"));
    return candidates.length ? candidates : [join(dir, "copilot-instructions.md")];
  },
  read: (path, defaultType) => {
    // Aggregate behavior: if path is the .github/instructions/ dir, also pull in
    // the sibling copilot-instructions.md file when present. Vice-versa for the
    // single-file path.
    const sectionsAcc: ImportResult["sections"] = [];
    const skippedAcc: ImportResult["skipped"] = [];
    const labels: string[] = [];

    let stat;
    try { stat = statSync(path); } catch { return { sections: [], skipped: [], label: path }; }

    if (stat.isDirectory()) {
      const { sections, skipped, label } = readRulesDir(path, [".md"], false, defaultType);
      sectionsAcc.push(...sections); skippedAcc.push(...skipped); labels.push(label);
      const sibling = join(dirname(path), "copilot-instructions.md");
      if (existsSync(sibling)) {
        const { sections: s2, skipped: sk2 } = readMarkdownFile(sibling, defaultType);
        sectionsAcc.push(...s2); skippedAcc.push(...sk2); labels.push(sibling);
      }
    } else {
      const { sections, skipped } = readMarkdownFile(path, defaultType);
      sectionsAcc.push(...sections); skippedAcc.push(...skipped); labels.push(path);
      const siblingDir = join(dirname(path), "instructions");
      if (existsSync(siblingDir)) {
        const { sections: s2, skipped: sk2, label } = readRulesDir(siblingDir, [".md"], false, defaultType);
        sectionsAcc.push(...s2); skippedAcc.push(...sk2); labels.push(label);
      }
    }

    return { sections: sectionsAcc, skipped: skippedAcc, label: labels.join(" + ") };
  },
};

const agentsMd: FormatSpec = {
  key: "agents-md",
  source: "import-agents-md",
  resolve: (_scope, cwd) => {
    const direct = join(cwd, "AGENTS.md");
    if (existsSync(direct)) return [direct];
    const found = walkUpForFile(cwd, "AGENTS.md");
    return found ? [found] : [direct];
  },
  read: readMarkdownFile,
};

const geminiMd: FormatSpec = {
  key: "gemini-md",
  source: "import-gemini-md",
  resolve: (scope, cwd, home) => {
    if (scope === "global") return [join(home, ".gemini", "GEMINI.md")];
    const direct = join(cwd, "GEMINI.md");
    if (existsSync(direct)) return [direct];
    const found = walkUpForFile(cwd, "GEMINI.md");
    return found ? [found] : [direct];
  },
  read: readMarkdownFile,
};

const windsurf: FormatSpec = {
  key: "windsurf",
  source: "import-windsurf",
  resolve: (scope, cwd, home) => {
    if (scope === "global") {
      return [join(home, ".codeium", "windsurf", "memories", "global_rules.md")];
    }
    return [join(cwd, ".windsurfrules"), join(cwd, "global_rules.md")];
  },
  read: readMarkdownFile,
};

const cline: FormatSpec = {
  key: "cline",
  source: "import-cline",
  resolve: (_scope, cwd) => [join(cwd, ".clinerules")],
  read: (path, defaultType) => {
    let stat;
    try { stat = statSync(path); } catch { return { sections: [], skipped: [], label: path }; }
    if (stat.isDirectory()) {
      return readRulesDir(path, [".md"], false, defaultType);
    }
    return readMarkdownFile(path, defaultType);
  },
};

const roo: FormatSpec = {
  key: "roo",
  source: "import-roo",
  resolve: (_scope, cwd) => [join(cwd, ".roo", "rules"), join(cwd, ".roorules")],
  read: (path, defaultType) => {
    let stat;
    try { stat = statSync(path); } catch { return { sections: [], skipped: [], label: path }; }
    if (stat.isDirectory()) {
      return readRulesDir(path, [".md"], true, defaultType);
    }
    return readMarkdownFile(path, defaultType);
  },
};

export const FORMATS: Record<string, FormatSpec> = {
  "claude-md": claudeMd,
  "cursor": cursor,
  "copilot": copilot,
  "agents-md": agentsMd,
  "gemini-md": geminiMd,
  "windsurf": windsurf,
  "cline": cline,
  "roo": roo,
};

/**
 * Resolve the first existing candidate path for a format. Returns null if none exist.
 * If the user already passed an explicit path, the caller skips this and uses that.
 */
export function firstExistingPath(spec: FormatSpec, scope: "global" | "project", cwd: string, home: string): string | null {
  for (const c of spec.resolve(scope, cwd, home)) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Detect which formats have a present file/dir in the project. Returns hits in
 * the canonical priority order so cross-format dedup in `import auto` is stable.
 *
 * Priority order: claude-md, cursor, copilot, agents-md, gemini-md, windsurf, cline, roo.
 */
export function detectAllInProject(cwd: string, home: string): Array<{ spec: FormatSpec; path: string }> {
  const order = ["claude-md", "cursor", "copilot", "agents-md", "gemini-md", "windsurf", "cline", "roo"];
  const hits: Array<{ spec: FormatSpec; path: string }> = [];
  for (const key of order) {
    const spec = FORMATS[key];
    const path = firstExistingPath(spec, "project", cwd, home);
    if (path) hits.push({ spec, path });
  }
  return hits;
}

/** Format names available for `--help` style printing. */
export const FORMAT_KEYS = Object.keys(FORMATS);

/** Used by `import auto` to label progress lines compactly. */
export function shortLabel(path: string, cwd: string): string {
  if (path.startsWith(cwd + "/")) return path.slice(cwd.length + 1);
  if (path === cwd) return ".";
  return basename(path);
}
