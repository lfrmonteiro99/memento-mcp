// tests/cli/install-installer.test.ts
// Coverage for runInstaller. We sandbox HOME to a tempdir, stub
// child_process.execSync (used by isGloballyInstalled), and override
// MEMENTO_CONFIG_PATH / MEMENTO_DATA_DIR / MEMENTO_DB_PATH so the installer
// only writes to the sandbox.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

let fakeHome: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => fakeHome,
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execSync: vi.fn(() => Buffer.from("memento-mcp v0.0.0")),
  };
});

describe("runInstaller — non-interactive (no TTY)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    fakeHome = join(tmpdir(), `memento-installer-${process.pid}-${randomUUID()}`);
    mkdirSync(fakeHome, { recursive: true });
    // Pre-create .claude so detectClient → "claude-code" path runs.
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    writeFileSync(join(fakeHome, ".claude", "settings.json"), "{}");

    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
    Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("registers MCP server + hooks for claude-code client and creates config", async () => {
    const { runInstaller } = await import("../../src/cli/install.js");
    await runInstaller();

    const settings = JSON.parse(readFileSync(join(fakeHome, ".claude", "settings.json"), "utf-8"));
    expect(settings.mcpServers["memento-mcp"]).toBeDefined();
    expect(settings.mcpServers["memento-mcp"].command).toBe("memento-mcp");
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.UserPromptSubmit).toBeDefined();
    expect(settings.hooks.SessionEnd).toBeDefined();

    const sessionHook = (settings.hooks.SessionStart as any[])[0].hooks[0];
    expect(sessionHook.command).toBe("memento-hook-session");

    // Config + DB created under the fake-home sandbox.
    const configPath = join(fakeHome, ".config", "memento-mcp", "config.toml");
    const dbPath = join(fakeHome, ".local", "share", "memento-mcp", "memento.sqlite");
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(dbPath)).toBe(true);
  });

  it("is idempotent when run twice (no duplicate hooks)", async () => {
    const { runInstaller } = await import("../../src/cli/install.js");
    await runInstaller();
    await runInstaller();

    const settings = JSON.parse(readFileSync(join(fakeHome, ".claude", "settings.json"), "utf-8"));
    const sessionStart = settings.hooks.SessionStart as any[];
    const sessionStartCount = sessionStart.filter(
      h => h.hooks?.some((hh: any) => (hh.command as string)?.includes("memento-hook-session"))
    ).length;
    expect(sessionStartCount).toBe(1);
  });

  it("falls into manual-setup branch when no client detected", async () => {
    rmSync(join(fakeHome, ".claude"), { recursive: true, force: true });
    const { runInstaller } = await import("../../src/cli/install.js");
    await runInstaller();

    const printed = logSpy.mock.calls.map(c => c.join(" ")).join("\n");
    expect(printed).toMatch(/Manual setup required/);
  });

  it("registers cursor MCP entry without hooks for cursor client", async () => {
    rmSync(join(fakeHome, ".claude"), { recursive: true, force: true });
    mkdirSync(join(fakeHome, ".cursor"), { recursive: true });
    writeFileSync(join(fakeHome, ".cursor", "mcp.json"), "{}");

    const { runInstaller } = await import("../../src/cli/install.js");
    await runInstaller();

    const cursorConfig = JSON.parse(readFileSync(join(fakeHome, ".cursor", "mcp.json"), "utf-8"));
    expect(cursorConfig.mcpServers["memento-mcp"]).toBeDefined();
    // No hooks should be registered for cursor.
    expect(existsSync(join(fakeHome, ".claude", "settings.json"))).toBe(false);
  });
});
