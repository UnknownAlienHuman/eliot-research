import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/eliotr-pwa/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["**/dist/**", "**/.wrangler/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
