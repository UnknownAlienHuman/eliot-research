import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Bound simultaneous SQLite schema builds without relaxing case deadlines.
    maxWorkers: 4,
    include: ["packages/**/*.test.ts", "apps/eliotr-pwa/**/*.test.ts", "apps/eliotr-web/**/*.test.ts", "tests/**/*.test.ts", "infra/ai-search/**/*.test.mjs"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.wrangler/**", "packages/cloudflare-artifacts/test/**"],
    projects: [
      { extends: true, test: { name: 'unit', exclude: [
        '**/node_modules/**', '**/dist/**', '**/.wrangler/**', 'packages/cloudflare-artifacts/test/**',
        'packages/pwa-research-workspace/src/research-changes-forward.browser.test.ts',
        'packages/pwa-research-workspace/src/research-changes-empty-forward.browser.test.ts',
      ] } },
      'packages/ui/vitest.research-history.config.ts',
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
