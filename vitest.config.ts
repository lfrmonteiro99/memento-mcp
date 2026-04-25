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
  },
});
