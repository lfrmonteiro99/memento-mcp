import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

export default defineConfig({
  plugins: [
    {
      name: "html-as-text",
      transform(_code, id) {
        if (id.endsWith(".html")) {
          const text = readFileSync(id, "utf-8");
          return {
            code: `export default ${JSON.stringify(text)};`,
            map: null,
          };
        }
        return null;
      },
    },
  ],
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    testTimeout: 10000,
    // Built once before any spec runs; integration specs that spawn the MCP
    // server consume `dist/index.js` directly and would otherwise race each
    // other when each tried to rebuild + clean the same directory.
    globalSetup: ["tests/setup/build-once.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/**/*.test.ts",
        // Process entry points: tested via spawnSync in tests/hooks/*.test.ts
        // and tests/cli/*.test.ts. v8 coverage does not track child processes,
        // so they show as 0% even though they have integration tests. The
        // logic they invoke (handlers, repos, processSearchHook,
        // processSessionHook, runInstaller, etc.) is fully covered.
        "src/index.ts",
        "src/cli/main.ts",
        "src/hooks/auto-capture-bin.ts",
        "src/hooks/session-summarize-bin.ts",
        // Type-only declaration file with no runtime code.
        "src/sources/source.ts",
      ],
    },
  },
});
