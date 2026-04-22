import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import { createHash } from "node:crypto";
import type { VaultConfig } from "../lib/config.js";

export interface ParsedNote {
  id: string;
  vaultPath: string;
  relativePath: string;
  absolutePath: string;
  title: string;
  kind: string;
  summary?: string;
  aliases: string[];
  tags: string[];
  bodyMode: "none" | "summary" | "full";
  weight: number;
  publish: boolean;
  children: string[];
  wikilinks: string[];
  bodyHash: string;
  mtimeMs: number;
}

const FOLDER_KIND_MAP: Record<string, string> = {
  "10 Maps": "map",
  "20 Projects": "project",
  "25 Efforts": "effort",
  "30 Domains": "domain",
  "40 Decisions": "decision",
  "50 Playbooks": "playbook",
  "55 Skills": "skill",
  "60 Sources": "source",
};

function inferKindFromPath(relativePath: string): string {
  const topFolder = relativePath.split("/")[0] ?? "";
  return FOLDER_KIND_MAP[topFolder] ?? "source";
}

// Minimal YAML-subset parser for Obsidian frontmatter fields.
// Handles: simple key: value, booleans, quoted strings, block lists (- item).
function parseFrontmatter(content: string): { fields: Record<string, unknown>; body: string } {
  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)/);
  if (!match) return { fields: {}, body: content };

  const [, fm, rest] = match;
  const fields: Record<string, unknown> = {};
  let currentKey: string | null = null;

  for (const raw of fm.split(/\r?\n/)) {
    const kvMatch = raw.match(/^([a-zA-Z][\w_-]*)\s*:\s*(.*)/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const val = kvMatch[2].trim();
      if (val === "" || val === "~" || val === "null") {
        fields[currentKey] = null;
      } else if (val === "true") {
        fields[currentKey] = true;
      } else if (val === "false") {
        fields[currentKey] = false;
      } else if (/^-?\d+(\.\d+)?$/.test(val)) {
        fields[currentKey] = Number(val);
      } else {
        fields[currentKey] = val.replace(/^["']|["']$/g, "");
      }
      continue;
    }

    const listItemMatch = raw.match(/^\s+-\s+(.*)/);
    if (listItemMatch && currentKey) {
      const item = listItemMatch[1].trim().replace(/^["']|["']$/g, "");
      const existing = fields[currentKey];
      if (Array.isArray(existing)) {
        existing.push(item);
      } else {
        fields[currentKey] = [item];
      }
    }
  }

  return { fields, body: rest.trim() };
}

function extractWikilinks(body: string): string[] {
  const links: string[] = [];
  const re = /\[\[([^\]|#\n]+)(?:[|#][^\]]*)?]]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    links.push(m[1].trim());
  }
  return [...new Set(links)];
}

function deriveFirstParagraph(body: string): string {
  const stripped = body.replace(/^#+\s+.+/gm, "").trim();
  const first = stripped.split(/\n\n+/)[0]?.trim() ?? "";
  return first.slice(0, 200);
}

function isExcluded(relativePath: string, excludeFolders: string[]): boolean {
  return excludeFolders.some(f => {
    const prefix = f.endsWith("/") ? f : f + "/";
    return relativePath.startsWith(prefix) || relativePath === f;
  });
}

function isIncluded(relativePath: string, includeFolders: string[], rootNotes: string[]): boolean {
  if (rootNotes.includes(relativePath)) return true;
  if (includeFolders.length === 0) return true;
  return includeFolders.some(f => {
    const prefix = f.endsWith("/") ? f : f + "/";
    return relativePath.startsWith(prefix);
  });
}

export function parseNote(absolutePath: string, vaultPath: string, config: VaultConfig): ParsedNote | null {
  try {
    const relativePath = relative(vaultPath, absolutePath).replace(/\\/g, "/");

    if (isExcluded(relativePath, config.excludeFolders)) return null;
    if (!isIncluded(relativePath, config.includeFolders, config.rootNotes)) return null;

    const stat = statSync(absolutePath);
    const content = readFileSync(absolutePath, "utf-8");
    const { fields, body } = parseFrontmatter(content);

    const publish = fields.memento_publish === true;
    if (config.requirePublishFlag && !publish) return null;

    const kind = fields.memento_kind
      ? String(fields.memento_kind)
      : inferKindFromPath(relativePath);

    const title = fields.title
      ? String(fields.title)
      : basename(relativePath, ".md");

    const rawSummary = fields.memento_summary ? String(fields.memento_summary) : deriveFirstParagraph(body);
    const summary = rawSummary || undefined;

    const aliases = Array.isArray(fields.aliases)
      ? (fields.aliases as string[]).map(String)
      : fields.aliases ? [String(fields.aliases)] : [];

    const tags = Array.isArray(fields.tags)
      ? (fields.tags as string[]).map(String)
      : fields.tags ? [String(fields.tags)] : [];

    let bodyMode: "none" | "summary" | "full" = "summary";
    if (fields.memento_body_mode === "none") bodyMode = "none";
    else if (fields.memento_body_mode === "full") bodyMode = "full";

    const weight = fields.memento_weight != null ? Number(fields.memento_weight) : 1.0;

    const children = Array.isArray(fields.memento_children)
      ? (fields.memento_children as string[]).map(String)
      : [];

    const wikilinks = extractWikilinks(body);
    const bodyHash = createHash("md5").update(content).digest("hex");

    return {
      id: `vault:${relativePath}`,
      vaultPath,
      relativePath,
      absolutePath,
      title,
      kind,
      summary,
      aliases,
      tags,
      bodyMode,
      weight,
      publish,
      children,
      wikilinks,
      bodyHash,
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return null;
  }
}

export function scanVault(config: VaultConfig): ParsedNote[] {
  if (!config.enabled || !config.path) return [];
  if (!existsSync(config.path)) return [];

  const notes: ParsedNote[] = [];

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const rel = relative(config.path, fullPath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (isExcluded(rel, config.excludeFolders)) continue;
        walk(fullPath);
      } else if (entry.isFile() && extname(entry.name) === ".md") {
        const note = parseNote(fullPath, config.path, config);
        if (note) notes.push(note);
      }
    }
  }

  walk(config.path);
  return notes;
}
