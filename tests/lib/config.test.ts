import { describe, it, expect, vi, afterEach } from "vitest";
import { loadConfig, DEFAULT_CONFIG } from "../../src/lib/config.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("config", () => {
  const tmpDir = join(tmpdir(), "memento-config-test-" + Date.now());

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.MEMENTO_BUDGET;
  });

  it("returns defaults when no config file exists", () => {
    const config = loadConfig("/nonexistent/path/config.toml");
    expect(config.budget.total).toBe(DEFAULT_CONFIG.budget.total);
    expect(config.budget.floor).toBe(500);
    expect(config.pruning.maxAgeDays).toBe(60);
  });

  it("merges TOML overrides with defaults", () => {
    mkdirSync(tmpDir, { recursive: true });
    const cfgPath = join(tmpDir, "config.toml");
    writeFileSync(cfgPath, '[budget]\ntotal = 5000\n');
    const config = loadConfig(cfgPath);
    expect(config.budget.total).toBe(5000);
    expect(config.budget.floor).toBe(500); // default preserved
  });

  it("env vars override TOML and defaults", () => {
    process.env.MEMENTO_BUDGET = "3000";
    const config = loadConfig("/nonexistent/path/config.toml");
    expect(config.budget.total).toBe(3000);
  });

  it("custom trivial patterns load from TOML", () => {
    mkdirSync(tmpDir, { recursive: true });
    const cfgPath = join(tmpDir, "config.toml");
    writeFileSync(cfgPath, '[hooks]\ncustom_trivial_patterns = ["roger", "ack"]\n');
    const config = loadConfig(cfgPath);
    expect(config.hooks.customTrivialPatterns).toEqual(["roger", "ack"]);
  });
});
