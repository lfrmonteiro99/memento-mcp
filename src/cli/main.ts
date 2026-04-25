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

} else if (command === "backfill-embeddings") {
  const { loadConfig, getDefaultConfigPath, getDefaultDbPath } = await import("../lib/config.js");
  const { createDatabase } = await import("../db/database.js");
  const { EmbeddingsRepo } = await import("../db/embeddings.js");
  const { createProvider } = await import("../engine/embeddings/provider.js");

  const config = loadConfig(getDefaultConfigPath());

  // Parse flags
  const args = argv.slice(3);
  let model = config.search.embeddings.model;
  let limit: number | undefined;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model" && args[i + 1]) { model = args[++i]; }
    else if (args[i] === "--limit" && args[i + 1]) { limit = Number(args[++i]); }
    else if (args[i] === "--dry-run") { dryRun = true; }
  }

  const db = createDatabase(config.database.path || getDefaultDbPath());
  const embRepo = new EmbeddingsRepo(db);
  const missing = embRepo.countMissing(model);

  if (dryRun) {
    console.log(`Would embed ${missing} memories (model: ${model}).`);
    db.close();
    process.exit(0);
  }

  const provider = createProvider({ ...config.search.embeddings, model, enabled: true });
  if (!provider) {
    console.error(`Embedding provider misconfigured: ensure ${config.search.embeddings.apiKeyEnv} is set and provider is supported.`);
    db.close();
    process.exit(1);
  }

  const batchSize = config.search.embeddings.batchSize;
  let processed = 0;
  const total = limit !== undefined ? Math.min(limit, missing) : missing;
  const batch: Array<{ id: string; title: string; body: string }> = [];

  for (const mem of embRepo.iterateMissing(model, batchSize)) {
    if (limit !== undefined && processed >= limit) break;
    batch.push(mem);
    if (batch.length >= batchSize) {
      const texts = batch.map(m => `${m.title}\n\n${m.body}`);
      try {
        const vectors = await provider.embed(texts);
        for (let i = 0; i < batch.length; i++) {
          embRepo.upsert(batch[i].id, provider.model, vectors[i]);
        }
      } catch (err) {
        console.error(`Batch embed failed:`, err);
      }
      processed += batch.length;
      console.log(`Processed ${processed}/${total}`);
      batch.length = 0;
    }
  }

  // Flush remaining
  if (batch.length > 0) {
    const texts = batch.map(m => `${m.title}\n\n${m.body}`);
    try {
      const vectors = await provider.embed(texts);
      for (let i = 0; i < batch.length; i++) {
        embRepo.upsert(batch[i].id, provider.model, vectors[i]);
      }
    } catch (err) {
      console.error(`Batch embed failed:`, err);
    }
    processed += batch.length;
    console.log(`Processed ${processed}/${total}`);
  }

  console.log(`Done. Embedded ${processed} memories.`);
  db.close();

} else if (command === "ui") {
  const { loadConfig, getDefaultConfigPath, getDefaultDbPath } = await import("../lib/config.js");
  const { createDatabase } = await import("../db/database.js");
  const { startWebServer } = await import("../server/web.js");

  const args = argv.slice(3);
  let port = 37778;
  let host = "127.0.0.1";
  let enableEdit = false;
  let openBrowser = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) { port = Number(args[++i]); }
    else if (args[i] === "--host" && args[i + 1]) { host = args[++i]; }
    else if (args[i] === "--enable-edit") { enableEdit = true; }
    else if (args[i] === "--open") { openBrowser = true; }
  }

  const config = loadConfig(getDefaultConfigPath());
  const db = createDatabase(config.database.path || getDefaultDbPath());

  const server = startWebServer({ port, host, enableEdit, db, config });

  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const url = `http://${host}:${actualPort}`;
  console.log(`memento-mcp UI: ${url}`);
  if (enableEdit) console.log(`  edit mode enabled (pin/delete available)`);
  else console.log(`  read-only (pass --enable-edit to allow pin/delete)`);

  if (openBrowser) {
    const { spawn } = await import("node:child_process");
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try { spawn(opener, [url], { stdio: "ignore", detached: true }).unref(); } catch { /* ignore */ }
  }

  const shutdown = () => {
    console.log("\nShutting down…");
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

} else if (command === "policy") {
  // Issue #9: per-project policy management
  const { findPolicyFile, loadProjectPolicy, compileSafeRegex, POLICY_INIT_TEMPLATE } = await import("../lib/policy.js");
  const { parse: parseTOML } = await import("smol-toml");
  const { readFileSync, writeFileSync, mkdirSync, existsSync } = await import("node:fs");
  const { join: pathJoin, resolve: pathResolve } = await import("node:path");

  if (!sub || sub === "show") {
    // Show the resolved policy for cwd
    const cwd = process.cwd();
    const policyFile = findPolicyFile(cwd);
    if (!policyFile) {
      console.log(`No policy found at ${cwd}`);
      console.log("  (looked for .memento/policy.toml and .memento.toml walking up to home dir)");
      process.exit(0);
    }
    const policy = loadProjectPolicy(cwd);
    if (!policy) {
      console.log(`Policy file found (${policyFile}) but failed to parse — run 'memento-mcp policy validate' for details.`);
      process.exit(1);
    }
    console.log(`Policy file: ${policyFile}`);
    console.log(`Schema version: ${policy.schemaVersion}`);
    console.log(`Root path: ${policy.rootPath}`);
    if (policy.requiredTagsAnyOf.length > 0) {
      console.log(`Required tags (any_of): ${policy.requiredTagsAnyOf.join(", ")}`);
    }
    if (policy.requiredTagsAllOf.length > 0) {
      console.log(`Required tags (all_of groups): ${policy.requiredTagsAllOf.map(g => `[${g.join(", ")}]`).join(", ")}`);
    }
    if (policy.bannedContent.length > 0) {
      console.log(`Banned content patterns (${policy.bannedContent.length}): ${policy.bannedContent.map(r => r.source).join(", ")}`);
    }
    if (policy.retention.maxAgeDays !== undefined) {
      console.log(`Retention max_age_days: ${policy.retention.maxAgeDays}`);
    }
    if (policy.retention.minImportance !== undefined) {
      console.log(`Retention min_importance: ${policy.retention.minImportance}`);
    }
    const importanceTypes = Object.entries(policy.defaultImportanceByType);
    if (importanceTypes.length > 0) {
      console.log(`Default importance by type: ${importanceTypes.map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
    if (policy.autoPromoteToVaultTypes.length > 0) {
      console.log(`Auto-promote to vault: ${policy.autoPromoteToVaultTypes.join(", ")}`);
    }
    if (policy.extraStopWords.length > 0) {
      console.log(`Extra stop words: ${policy.extraStopWords.join(", ")}`);
    }

  } else if (sub === "validate") {
    // Validate a policy file — uses argv[4] as optional path, defaults to cwd resolution
    const targetPath = argv[4] ? pathResolve(argv[4]) : findPolicyFile(process.cwd());
    if (!targetPath) {
      console.error("No policy file found. Pass a path: memento-mcp policy validate <path>");
      process.exit(1);
    }
    let raw: string;
    try {
      raw = readFileSync(targetPath, "utf-8");
    } catch (e) {
      console.error(`Cannot read file: ${targetPath}`);
      console.error(String(e));
      process.exit(1);
    }
    let parsed: any;
    try {
      parsed = parseTOML(raw);
    } catch (e) {
      console.error(`TOML parse error in ${targetPath}:`);
      console.error(String(e));
      process.exit(1);
    }
    // Validate known sections
    const errors: string[] = [];
    const warnings: string[] = [];
    const sv = Number(parsed.schema_version ?? 1);
    if (sv > 1) warnings.push(`schema_version=${sv} > 1; only v1 is supported`);
    if (parsed.required_tags) {
      if (parsed.required_tags.any_of !== undefined && !Array.isArray(parsed.required_tags.any_of)) {
        errors.push("required_tags.any_of must be an array of strings");
      }
      if (parsed.required_tags.all_of !== undefined && !Array.isArray(parsed.required_tags.all_of)) {
        errors.push("required_tags.all_of must be an array of arrays");
      }
    }
    if (parsed.banned_content?.patterns !== undefined) {
      if (!Array.isArray(parsed.banned_content.patterns)) {
        errors.push("banned_content.patterns must be an array");
      } else {
        for (const p of parsed.banned_content.patterns) {
          if (typeof p !== "string") {
            errors.push(`banned_content.patterns: each entry must be a string, got ${typeof p}`);
          } else {
            const re = compileSafeRegex(p);
            if (re === null) {
              warnings.push(`banned_content pattern will be skipped (too long, invalid, or nested quantifiers): ${p}`);
            }
          }
        }
      }
    }
    if (parsed.retention) {
      if (parsed.retention.max_age_days !== undefined && typeof parsed.retention.max_age_days !== "number") {
        errors.push("retention.max_age_days must be a number");
      }
      if (parsed.retention.min_importance !== undefined && typeof parsed.retention.min_importance !== "number") {
        errors.push("retention.min_importance must be a number");
      }
    }
    if (errors.length > 0) {
      console.error(`Validation FAILED for ${targetPath}:`);
      for (const e of errors) console.error(`  ERROR: ${e}`);
      for (const w of warnings) console.warn(`  WARNING: ${w}`);
      process.exit(1);
    }
    if (warnings.length > 0) {
      for (const w of warnings) console.warn(`  WARNING: ${w}`);
    }
    console.log(`OK: ${targetPath}`);
    process.exit(0);

  } else if (sub === "init") {
    // Write a richly-commented template to .memento/policy.toml in cwd
    const cwd = process.cwd();
    const mementoDir = pathJoin(cwd, ".memento");
    const dest = pathJoin(mementoDir, "policy.toml");
    if (!existsSync(mementoDir)) {
      mkdirSync(mementoDir, { recursive: true });
    }
    if (existsSync(dest)) {
      console.error(`Policy file already exists: ${dest}`);
      console.error("Remove it first or edit it directly.");
      process.exit(1);
    }
    writeFileSync(dest, POLICY_INIT_TEMPLATE, "utf-8");
    console.log(`Created: ${dest}`);
    console.log("All sections are commented out. Uncomment and edit as needed.");

  } else {
    console.error(`Unknown policy command: ${sub}`);
    console.error("Usage: memento-mcp policy [show|validate|init]");
    process.exit(1);
  }

} else if (command === "--version" || command === "-v") {
  console.log("memento-mcp v1.0.0");

} else {
  await import("../index.js");
}
