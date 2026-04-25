import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/cli/main.ts",
    "src/hooks/search-context.ts",
    "src/hooks/session-context.ts",
    "src/hooks/auto-capture-bin.ts",
    "src/hooks/session-summarize-bin.ts",
  ],
  format: "esm",
  dts: true,
  clean: true,
  loader: { ".html": "text" },
});
