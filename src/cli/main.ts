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

  } else if (sub === "init") {
    const { writeFileSync, existsSync: fsExists } = await import("node:fs");
    const { join: pathJoin } = await import("node:path");

    const templates: Record<string, string> = {
      "me.md": `---
memento_publish: true
memento_kind: identity
memento_summary: Edit this line — who you are in one sentence.
---

# About Me

Edit this file to describe yourself, your working style, and constraints.
This is the first thing memento-mcp reads to understand who you are.

## Role


## Working style


## Constraints and preferences

`,
      "vault.md": `---
memento_publish: true
memento_kind: map
memento_summary: Vault navigation and routing rules.
memento_children:
  - 10 Maps
  - 30 Domains
  - 50 Playbooks
  - 55 Skills
---

# Vault Map

This file describes the vault layout for memento-mcp routing.

## Routable folders

- \`10 Maps\` — navigation and index notes
- \`20 Projects\` — repo and project-specific context
- \`30 Domains\` — cross-project topic knowledge
- \`40 Decisions\` — architectural decisions and rationale
- \`50 Playbooks\` — human-oriented procedures
- \`55 Skills\` — machine-oriented repeatable instructions

## Excluded from default retrieval

- \`00 Inbox\` — scratch and unprocessed notes
- \`15 Calendar\` — daily notes and meetings
- \`25 Efforts\` — active temporary workstreams
- \`60 Sources\` — raw material and references
- \`70 Templates\` — note templates
- \`90 Archive\` — archived notes
`,
    };

    let created = 0;
    for (const [filename, content] of Object.entries(templates)) {
      const dest = pathJoin(config.vault.path, filename);
      if (fsExists(dest)) {
        console.log(`  ✓ ${filename} already exists — skipped`);
      } else {
        writeFileSync(dest, content, "utf-8");
        console.log(`  ✓ ${filename} created`);
        created++;
      }
    }
    if (created > 0) {
      console.log(`\nEdit these files, then run: memento-mcp vault-index rebuild`);
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

} else if (command === "profile") {
  const { loadConfig, getDefaultConfigPath } = await import("../lib/config.js");
  const { resolveProfile } = await import("../lib/profiles.js");

  const config = loadConfig(getDefaultConfigPath());
  const profile = resolveProfile(config);

  if (sub === "--dump") {
    console.log(`Profile: ${profile.id}`);
    console.log(`Stop-words: ${profile.stopWords.size}`);
    console.log("");
    console.log("Stop-word list:");
    const sortedStopWords = Array.from(profile.stopWords).sort();
    for (let i = 0; i < sortedStopWords.length; i += 5) {
      console.log(`  ${sortedStopWords.slice(i, i + 5).join(", ")}`);
    }
    console.log("");
    console.log("Trivial patterns:");
    for (const pattern of profile.trivialPatterns) {
      console.log(`  ${pattern}`);
    }
    if (profile.locale) {
      console.log("");
      console.log(`Locale: ${profile.locale}`);
    }
  } else {
    console.log(`id: ${profile.id}`);
    console.log(`stop-words: ${profile.stopWords.size}`);
    console.log(`trivial-patterns: ${profile.trivialPatterns.length}`);
  }

} else if (command === "--version" || command === "-v") {
  console.log("memento-mcp v1.0.0");

} else {
  await import("../index.js");
}
