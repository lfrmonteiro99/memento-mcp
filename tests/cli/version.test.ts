import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("memento-mcp --version", () => {
  const repoRoot = new URL("../../", import.meta.url).pathname;
  const expectedVersion = (
    JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
      version: string;
    }
  ).version;

  it("reports the version from package.json (regression: was hardcoded to v1.0.0)", () => {
    const result = spawnSync(
      "npx",
      ["tsx", join(repoRoot, "src/cli/main.ts"), "--version"],
      { encoding: "utf-8", timeout: 30_000 },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`memento-mcp v${expectedVersion}`);
  });

  it("supports the -v alias", () => {
    const result = spawnSync(
      "npx",
      ["tsx", join(repoRoot, "src/cli/main.ts"), "-v"],
      { encoding: "utf-8", timeout: 30_000 },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`memento-mcp v${expectedVersion}`);
  });
});
