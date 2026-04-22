#!/usr/bin/env node
import { argv } from "node:process";
import { existsSync } from "node:fs";

const [, , command, sub] = argv;

if (command === "install") {
  const { runInstaller } = await import("./install.js");
  await runInstaller();

} else if (command === "uninstall") {
  const { runUninstaller } = await import("./install.js");
  await runUninstaller();

} else if (command === "vault-index") {
  const { loadConfig, getDefaultConfigPath, getDefaultDbPath } = await import("../lib/config.js");
  const { createDatabase } = await import("../db/database.js");

  const config = loadConfig(getDefaultConfigPath());

  if (!config.vault.enabled || !config.vault.path) {
    console.error("Vault not configured. Add [vault] to ~/.config/memento-mcp/config.toml and set enabled = true.");
    process.exit(1);
  }

  if (!existsSync(config.vault.path)) {
    console.error(`Vault path not found: ${config.vault.path}`);
    process.exit(1);
  }

  const db = createDatabase(config.database.path || getDefaultDbPath());

  if (sub === "rebuild") {
    const { rebuildVaultIndex } = await import("../engine/vault-index.js");
    console.log(`Indexing vault: ${config.vault.path}`);
    const stats = rebuildVaultIndex(db, config.vault);
    console.log(`  ${stats.total} notes scanned`);
    console.log(`  ${stats.routable} routable`);
    console.log(`  ${stats.orphaned} orphaned`);
    console.log(`  ${stats.edges} edges`);
    console.log(`  ${stats.roots} root notes`);
    if (stats.orphaned > 0) console.log(`  Run 'memento-mcp vault-index doctor' for details on orphaned notes.`);
    console.log("Done.");
    db.close();

  } else if (sub === "doctor") {
    const { runVaultDoctor } = await import("../engine/vault-index.js");
    const issues = runVaultDoctor(db, config.vault);
    if (issues.length === 0) {
      console.log("No issues found.");
    } else {
      console.log(`${issues.length} issue(s) found:\n`);
      for (const issue of issues) {
        const label = issue.kind === "missing_root" ? "✗ Missing root note" : "⚠ Orphaned note";
        console.log(`  ${label}: ${issue.path}`);
        console.log(`    ${issue.detail}`);
      }
    }
    db.close();

  } else if (sub === "stats") {
    const { getVaultStats } = await import("../engine/vault-index.js");
    const s = getVaultStats(db, config.vault.path);
    console.log(`Vault: ${config.vault.path}\n`);
    console.log(`  Total:    ${s.totals.total}`);
    console.log(`  Reachable: ${s.totals.reachable}`);
    console.log(`  Orphaned: ${s.totals.orphaned}`);
    console.log(`  Edges:    ${s.edgeCount}`);
    console.log(`  Roots:    ${s.rootCount}`);
    if (s.byKind.length > 0) {
      console.log("\n  By kind:");
      for (const row of s.byKind) {
        console.log(`    ${row.kind.padEnd(12)} ${row.count}`);
      }
    }
    db.close();

  } else {
    console.error(`Unknown vault-index command: ${sub ?? "(none)"}`);
    console.error("Usage: memento-mcp vault-index <rebuild|doctor|stats>");
    process.exit(1);
  }

} else if (command === "--version" || command === "-v") {
  console.log("memento-mcp v1.0.0");

} else {
  await import("../index.js");
}
