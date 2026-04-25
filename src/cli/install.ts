import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, chmodSync, renameSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { getDefaultConfigPath, getDefaultDataDir, getDefaultDbPath } from "../lib/config.js";

function detectClient(): "claude-code" | "cursor" | "manual" {
  if (existsSync(join(homedir(), ".claude", "settings.json"))) return "claude-code";
  if (existsSync(join(homedir(), ".cursor", "mcp.json"))) return "cursor";
  return "manual";
}

function isGloballyInstalled(): boolean {
  try {
    execSync("memento-mcp --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function atomicJsonWrite(path: string, data: unknown): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
}

function registerMcpServer(client: "claude-code" | "cursor"): void {
  const configPath =
    client === "claude-code"
      ? join(homedir(), ".claude", "settings.json")
      : join(homedir(), ".cursor", "mcp.json");

  let config: Record<string, any> = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    /* new file */
  }

  if (client === "claude-code") {
    config.mcpServers = config.mcpServers ?? {};
    config.mcpServers["memento-mcp"] = { command: "memento-mcp", args: [], type: "stdio" };
  } else {
    config.mcpServers = config.mcpServers ?? {};
    config.mcpServers["memento-mcp"] = { command: "memento-mcp", args: [] };
  }

  mkdirSync(dirname(configPath), { recursive: true });
  atomicJsonWrite(configPath, config);
  console.log(`  ✓ MCP server registered in ${configPath}`);
}

function registerHooks(): void {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  let settings: Record<string, any> = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    /* new */
  }

  settings.hooks = settings.hooks ?? {};

  // SessionStart hook
  settings.hooks.SessionStart = settings.hooks.SessionStart ?? [];
  const sessionHookExists = (settings.hooks.SessionStart as any[]).some((h: any) =>
    h.hooks?.some((hh: any) => (hh.command as string)?.includes("memento-hook-session"))
  );
  if (!sessionHookExists) {
    settings.hooks.SessionStart.push({
      hooks: [{ type: "command", command: "memento-hook-session", timeout: 5 }],
    });
  }

  // UserPromptSubmit hook
  settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit ?? [];
  const searchHookExists = (settings.hooks.UserPromptSubmit as any[]).some((h: any) =>
    h.hooks?.some((hh: any) => (hh.command as string)?.includes("memento-hook-search"))
  );
  if (!searchHookExists) {
    settings.hooks.UserPromptSubmit.push({
      hooks: [{ type: "command", command: "memento-hook-search", timeout: 5 }],
    });
  }

  // SessionEnd hook (auto-summarization)
  settings.hooks.SessionEnd = settings.hooks.SessionEnd ?? [];
  const summarizeHookExists = (settings.hooks.SessionEnd as any[]).some((h: any) =>
    h.hooks?.some((hh: any) => (hh.command as string)?.includes("memento-hook-summarize"))
  );
  if (!summarizeHookExists) {
    settings.hooks.SessionEnd.push({
      hooks: [{ type: "command", command: "memento-hook-summarize", timeout: 10 }],
    });
  }

  mkdirSync(dirname(settingsPath), { recursive: true });
  atomicJsonWrite(settingsPath, settings);
  console.log("  ✓ Hooks registered (SessionStart + UserPromptSubmit + SessionEnd)");
}

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

// Search common locations for directories containing .obsidian/
function discoverObsidianVaults(maxDepth = 2): string[] {
  const roots = [
    homedir(),
    join(homedir(), "Documents"),
    join(homedir(), "Documentos"),
    join(homedir(), "Desktop"),
    join(homedir(), "OneDrive"),
  ];
  const found: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = join(dir, e.name);
      if (e.name === ".obsidian") { found.push(dir); return; }
      if (depth < maxDepth) walk(full, depth + 1);
    }
  }

  for (const root of roots) {
    if (existsSync(root)) walk(root, 0);
  }
  return [...new Set(found)];
}

function noteCount(vaultPath: string): number {
  let count = 0;
  function walk(dir: string): void {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory() && e.name !== ".obsidian") walk(join(dir, e.name));
      else if (e.isFile() && e.name.endsWith(".md")) count++;
    }
  }
  walk(vaultPath);
  return count;
}

function appendVaultConfig(configPath: string, vaultPath: string): void {
  const current = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
  if (current.includes("[vault]")) return;
  const block = `
[vault]
enabled = true
path = "${vaultPath}"
require_publish_flag = true
max_hops = 3
max_results = 5
hook_max_results = 2
auto_promote_types = []
`;
  writeFileSync(configPath, current + block, "utf-8");
}

async function runVaultWizard(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const useObsidian = (await ask(rl, "\n  Do you use Obsidian? [y/N] ")).trim().toLowerCase();
    if (useObsidian !== "y" && useObsidian !== "yes") {
      console.log("  Vault support skipped. Enable later by editing your config.");
      return;
    }

    console.log("\n  Searching for Obsidian vaults...");
    const vaults = discoverObsidianVaults();

    let chosenPath = "";

    if (vaults.length === 0) {
      console.log("  No vaults found in common locations.");
      const manual = (await ask(rl, "  Enter vault path (or press Enter to skip): ")).trim();
      if (!manual) { console.log("  Vault setup skipped."); return; }
      chosenPath = manual;
      if (!existsSync(chosenPath)) {
        const create = (await ask(rl, `  Path not found. Create folder? [Y/n] `)).trim().toLowerCase();
        if (create === "n" || create === "no") { console.log("  Vault setup skipped."); return; }
        mkdirSync(chosenPath, { recursive: true });
        console.log(`  ✓ Folder created: ${chosenPath}`);
      }
    } else if (vaults.length === 1) {
      const count = noteCount(vaults[0]);
      const confirm = (await ask(rl, `  Found: ${vaults[0]} (${count} notes). Use this? [Y/n] `)).trim().toLowerCase();
      if (confirm === "n" || confirm === "no") {
        const manual = (await ask(rl, "  Enter vault path (or press Enter to skip): ")).trim();
        if (!manual) { console.log("  Vault setup skipped."); return; }
        chosenPath = manual;
      } else {
        chosenPath = vaults[0];
      }
    } else {
      console.log("  Found:");
      vaults.forEach((v, i) => console.log(`    ${i + 1}) ${v}  (${noteCount(v)} notes)`));
      const pick = (await ask(rl, `  Which vault? [1] `)).trim();
      const idx = pick === "" ? 0 : parseInt(pick, 10) - 1;
      chosenPath = vaults[idx] ?? vaults[0];
    }

    console.log(`\n  ✓ Vault path: ${chosenPath}`);

    // Update config
    appendVaultConfig(getDefaultConfigPath(), chosenPath);
    console.log("  ✓ Config updated with [vault] section");

    // Scaffold root notes
    console.log("\n  Checking vault structure...");
    const { createDatabase } = await import("../db/database.js");
    const { loadConfig } = await import("../lib/config.js");
    const config = loadConfig(getDefaultConfigPath());
    const db = createDatabase(config.database.path || getDefaultDbPath());

    // Inline init (same templates as vault-index init)
    const ME_MD = `---\nmemento_publish: true\nmemento_kind: identity\nmemento_summary: Edit this line — who you are in one sentence.\n---\n\n# About Me\n\nEdit this file to describe yourself, your working style, and constraints.\n`;
    const VAULT_MD = `---\nmemento_publish: true\nmemento_kind: map\nmemento_summary: Vault navigation and routing rules.\n---\n\n# Vault Map\n\nThis file describes the vault layout for memento-mcp routing.\n`;

    for (const [name, content] of [["me.md", ME_MD], ["vault.md", VAULT_MD]] as const) {
      const dest = join(chosenPath, name);
      if (existsSync(dest)) {
        console.log(`  ✓ ${name} already exists`);
      } else {
        writeFileSync(dest, content, "utf-8");
        console.log(`  ✓ ${name} created`);
      }
    }

    // Index
    console.log("\n  Indexing vault...");
    const { rebuildVaultIndex } = await import("../engine/vault-index.js");
    const stats = rebuildVaultIndex(db, config.vault);
    console.log(`  ✓ ${stats.total} notes indexed (${stats.routable} routable, ${stats.orphaned} orphaned)`);
    if (stats.orphaned > 0) console.log("  Run 'memento-mcp vault-index doctor' to review orphaned notes.");
    db.close();

  } finally {
    rl.close();
  }
}

function createDefaultConfig(): void {
  const configPath = getDefaultConfigPath();
  if (existsSync(configPath)) {
    console.log(`  ✓ Config already exists: ${configPath}`);
    return;
  }
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `# Memento MCP Configuration
# Env vars override: MEMENTO_BUDGET, MEMENTO_FLOOR, etc.

[budget]
total = 8000
floor = 500
refill = 200
session_timeout = 1800

[search]
default_detail = "full"
max_results = 10
body_preview_chars = 200

[hooks]
trivial_skip = true
session_start_memories = 5
session_start_pitfalls = 5
custom_trivial_patterns = []

[pruning]
enabled = true
max_age_days = 60
min_importance = 0.3
interval_hours = 24

[database]
path = ""

[vault]
enabled = false
path = ""
require_publish_flag = true
max_hops = 3
max_results = 5
hook_max_results = 2
auto_promote_types = []
`
  );
  try {
    chmodSync(configPath, 0o600);
  } catch {
    /* Windows doesn't support chmod */
  }
  console.log(`  ✓ Config created: ${configPath}`);
}

function checkMigration(): void {
  const oldDb = join(homedir(), ".local", "share", "claude-memory", "context.sqlite");
  if (existsSync(oldDb)) {
    const newDb = getDefaultDbPath();
    if (!existsSync(newDb)) {
      console.log(`\n  Found existing claude-memory database: ${oldDb}`);
      console.log("  Copying to new location...");
      mkdirSync(dirname(newDb), { recursive: true });
      copyFileSync(oldDb, newDb);
      console.log(`  ✓ Migrated to: ${newDb}`);
    }
  }
}

export async function runInstaller(): Promise<void> {
  console.log("\n  memento-mcp installer\n");

  // Check global install
  if (!isGloballyInstalled()) {
    console.log("  ⚠ memento-mcp is not installed globally. Hooks require a global install.");
    console.log("  Run: npm install -g memento-mcp");
    console.log("  Then: memento-mcp install\n");
    process.exit(1);
  }

  // Create data dir
  mkdirSync(getDefaultDataDir(), { recursive: true });
  console.log(`  ✓ Data directory: ${getDefaultDataDir()}`);

  // Check migration from old claude-memory
  checkMigration();

  // Config
  createDefaultConfig();

  // Detect client
  const client = detectClient();
  console.log(`  ✓ Detected client: ${client}`);

  if (client === "manual") {
    console.log("\n  Manual setup required. Add to your MCP client config:");
    console.log('  { "command": "memento-mcp", "args": [], "type": "stdio" }');
  } else {
    registerMcpServer(client);
    if (client === "claude-code") registerHooks();
  }

  // Verify DB
  try {
    const { createDatabase } = await import("../db/database.js");
    const db = createDatabase(getDefaultDbPath());
    db.close();
    console.log(`  ✓ Database verified: ${getDefaultDbPath()}`);
  } catch (e) {
    console.log(`  ✗ Database error: ${e}`);
  }

  // Vault onboarding wizard — requires interactive stdin (not available during npm postinstall)
  if (process.stdin.isTTY) {
    await runVaultWizard();
  } else {
    console.log("  Vault wizard skipped (non-interactive). Run 'memento-mcp install' to set up Obsidian integration.");
  }

  console.log("\n  ✓ Installation complete!\n");
}

export async function runUninstaller(): Promise<void> {
  console.log("\n  memento-mcp uninstaller\n");

  // Remove MCP server from Claude Code settings
  const settingsPath = join(homedir(), ".claude", "settings.json");
  try {
    const settings: Record<string, any> = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (settings.mcpServers?.["memento-mcp"]) {
      delete settings.mcpServers["memento-mcp"];
      console.log("  ✓ MCP server entry removed");
    }
    // Remove hooks
    for (const hookType of ["SessionStart", "UserPromptSubmit", "SessionEnd"]) {
      if (Array.isArray(settings.hooks?.[hookType])) {
        settings.hooks[hookType] = (settings.hooks[hookType] as any[]).filter(
          (h: any) => !h.hooks?.some((hh: any) => (hh.command as string)?.includes("memento-hook"))
        );
      }
    }
    atomicJsonWrite(settingsPath, settings);
    console.log("  ✓ Hooks removed");
  } catch {
    /* no settings file — nothing to remove */
  }

  console.log("  ✓ Data and config preserved. Remove manually if desired:");
  console.log(`    Data: ${getDefaultDataDir()}`);
  console.log(`    Config: ${getDefaultConfigPath()}`);
  console.log("\n  ✓ Uninstall complete!\n");
}
