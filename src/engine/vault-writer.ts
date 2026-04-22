import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import type { VaultConfig } from "../lib/config.js";

interface PersistMemoryToVaultParams {
  memoryId: string;
  title: string;
  content: string;
  memoryType: string;
  tags: string[];
  mode: "create" | "create_or_update";
  vaultKind?: string;
  vaultFolder?: string;
}

export interface PersistedVaultNote {
  action: "created" | "updated";
  relativePath: string;
}

const MANAGED_INDEX_PATH = "10 Maps/memento-store-index.md";

const TYPE_DESTINATIONS: Record<string, { folder: string; kind: string }> = {
  architecture: { folder: "30 Domains/Memento Architecture", kind: "domain" },
  decision: { folder: "40 Decisions/Memento Decisions", kind: "decision" },
  fact: { folder: "30 Domains/Memento Facts", kind: "domain" },
  pattern: { folder: "50 Playbooks/Memento Patterns", kind: "playbook" },
  pitfall: { folder: "50 Playbooks/Memento Pitfalls", kind: "playbook" },
  preference: { folder: "30 Domains/Memento Preferences", kind: "domain" },
};

function slugify(input: string): string {
  const normalized = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "memory";
}

function deriveSummary(content: string): string {
  const condensed = content.replace(/\s+/g, " ").trim();
  return condensed.slice(0, 180) || "Promoted from memory_store.";
}

function escapeYaml(value: string): string {
  return JSON.stringify(value);
}

function recursiveFindBySuffix(dir: string, suffix: string): string | null {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = recursiveFindBySuffix(fullPath, suffix);
      if (nested) return nested;
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(suffix)) {
      return fullPath;
    }
  }
  return null;
}

function buildNoteContent(params: PersistMemoryToVaultParams, noteTitle: string, noteKind: string): string {
  const lines = [
    "---",
    "memento_publish: true",
    `memento_kind: ${noteKind}`,
    `memento_summary: ${escapeYaml(deriveSummary(params.content))}`,
    "memento_body_mode: summary",
    "memento_source: memory_store",
    `memento_memory_id: ${params.memoryId}`,
    "tags:",
    "  - memory-store",
    `  - ${slugify(params.memoryType)}`,
  ];

  for (const tag of params.tags) {
    lines.push(`  - ${slugify(tag)}`);
  }

  lines.push(
    "---",
    "",
    `# ${noteTitle}`,
    "",
    params.content.trim(),
    ""
  );

  return lines.join("\n");
}

function ensureManagedIndex(vaultPath: string, childRelativePath: string): void {
  const indexPath = join(vaultPath, MANAGED_INDEX_PATH);
  mkdirSync(dirname(indexPath), { recursive: true });

  let children: string[] = [];
  if (existsSync(indexPath)) {
    const current = readFileSync(indexPath, "utf-8");
    const match = current.match(/memento_children:\n([\s\S]*?)\n---/);
    if (match) {
      children = match[1]
        .split("\n")
        .map(line => line.trim())
        .filter(line => line.startsWith("- "))
        .map(line => line.slice(2).trim());
    }
  }

  if (!children.includes(childRelativePath)) {
    children.push(childRelativePath);
  }

  const indexContent = [
    "---",
    "memento_publish: true",
    "memento_kind: map",
    `memento_summary: ${escapeYaml("Managed index for notes promoted from memory_store.")}`,
    "memento_children:",
    ...children.map(child => `  - ${child}`),
    "---",
    "",
    "# Memento Store Index",
    "",
    "Managed by memento-mcp. Promoted notes are routed from here.",
    "",
    ...children.map(child => `- [[${child.replace(/\.md$/, "")}]]`),
    "",
  ].join("\n");

  writeFileSync(indexPath, indexContent, "utf-8");
}

function ensureVaultRootLink(vaultPath: string): void {
  const vaultMapPath = join(vaultPath, "vault.md");
  if (!existsSync(vaultMapPath)) return;

  const current = readFileSync(vaultMapPath, "utf-8");
  const wikilink = "[[10 Maps/memento-store-index]]";
  if (current.includes(wikilink)) return;

  const next = current.trimEnd() + `\n\n${wikilink}\n`;
  writeFileSync(vaultMapPath, next, "utf-8");
}

export function persistMemoryToVault(config: VaultConfig, params: PersistMemoryToVaultParams): PersistedVaultNote {
  if (!config.enabled || !config.path) {
    throw new Error("Vault support is not enabled.");
  }

  const destination = TYPE_DESTINATIONS[params.memoryType] ?? TYPE_DESTINATIONS.fact;
  const noteKind = params.vaultKind || destination.kind;
  const folder = params.vaultFolder || destination.folder;
  const suffix = `-${params.memoryId}.md`;
  const existingPath = recursiveFindBySuffix(config.path, suffix);

  if (existingPath && params.mode === "create") {
    throw new Error(`Vault note already exists for memory ${params.memoryId}`);
  }

  const noteTitle = params.title.trim() || "Untitled Memory";
  const targetPath = existingPath || join(config.path, folder, `${slugify(noteTitle)}-${params.memoryId}.md`);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, buildNoteContent(params, noteTitle, noteKind), "utf-8");

  const relativePath = relative(config.path, targetPath).replace(/\\/g, "/");
  ensureManagedIndex(config.path, relativePath);
  ensureVaultRootLink(config.path);

  return {
    action: existingPath ? "updated" : "created",
    relativePath,
  };
}
