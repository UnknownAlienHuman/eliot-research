import { defineConfig } from "vitest/config";

// ER-34 O2 FIX2 package-local runner: `pnpm --filter @eliotr/backup-o2 test`
// executes the focused @eliotr/backup-o2 suite (actual-migration D1 tests +
// R2-conformance tests through production paths) without the repo-wide run.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
