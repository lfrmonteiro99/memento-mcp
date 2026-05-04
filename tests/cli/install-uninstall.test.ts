// tests/cli/install-uninstall.test.ts
// Coverage for src/cli/install.ts uninstall path. Mocks node:os.homedir() to a
// tempdir so the uninstall mutates a sandboxed settings.json, not the user's.
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

describe("runUninstaller", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fakeHome = join(tmpdir(), `memento-uninstall-${process.pid}-${randomUUID()}`);
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("removes the memento-mcp MCP server entry and hooks", async () => {
    const settingsPath = join(fakeHome, ".claude", "settings.json");
    writeFileSync(settingsPath, JSON.stringify({
      mcpServers: {
        "memento-mcp": { command: "memento-mcp", args: [], type: "stdio" },
        "other-server": { command: "other", args: [] },
      },
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "memento-hook-session", timeout: 5 }] },
          { hooks: [{ type: "command", command: "other-hook", timeout: 5 }] },
        ],
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "memento-hook-search", timeout: 5 }] },
        ],
        SessionEnd: [
          { hooks: [{ type: "command", command: "memento-hook-summarize", timeout: 10 }] },
        ],
      },
    }));

    const { runUninstaller } = await import("../../src/cli/install.js");
    await runUninstaller();

    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(after.mcpServers["memento-mcp"]).toBeUndefined();
    expect(after.mcpServers["other-server"]).toBeDefined();
    expect(after.hooks.SessionStart).toHaveLength(1);
    expect(after.hooks.SessionStart[0].hooks[0].command).toBe("other-hook");
    expect(after.hooks.UserPromptSubmit).toHaveLength(0);
    expect(after.hooks.SessionEnd).toHaveLength(0);
  });

  it("is a no-op when settings.json is missing", async () => {
    // No settings file in fakeHome/.claude
    const { runUninstaller } = await import("../../src/cli/install.js");
    await expect(runUninstaller()).resolves.toBeUndefined();
    // Sanity: the directory should still be there but no settings file was created.
    expect(existsSync(join(fakeHome, ".claude", "settings.json"))).toBe(false);
  });
});
