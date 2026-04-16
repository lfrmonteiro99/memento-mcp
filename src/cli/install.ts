import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, chmodSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
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

  mkdirSync(dirname(settingsPath), { recursive: true });
  atomicJsonWrite(settingsPath, settings);
  console.log("  ✓ Hooks registered (SessionStart + UserPromptSubmit)");
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
    for (const hookType of ["SessionStart", "UserPromptSubmit"]) {
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
