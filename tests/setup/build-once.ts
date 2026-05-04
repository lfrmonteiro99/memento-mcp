// tests/setup/build-once.ts
//
// Vitest globalSetup: builds the MCP server bundle once before any spec runs.
// Integration specs (mcp-server-smoke, tool-descriptions) spawn `dist/index.js`
// directly. Without this single-shot build, each spec would race the others to
// rebuild + `--clean` the same directory.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export default function build(): void {
  const distEntry = join(process.cwd(), "dist/index.js");

  const result = spawnSync(
    "./node_modules/.bin/tsup",
    [
      "src/index.ts",
      "src/cli/main.ts",
      "src/hooks/search-context.ts",
      "src/hooks/session-context.ts",
      "src/hooks/auto-capture-bin.ts",
      "src/hooks/session-summarize-bin.ts",
      "--format", "esm", "--dts", "--clean",
    ],
    { cwd: process.cwd(), encoding: "utf-8", timeout: 120_000 },
  );

  if (result.status !== 0) {
    throw new Error(
      `globalSetup build failed.\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
  }
  if (!existsSync(distEntry)) {
    throw new Error(`globalSetup completed but ${distEntry} is missing.`);
  }
}
