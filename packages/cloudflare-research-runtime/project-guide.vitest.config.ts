import { defineConfig } from "vitest/config";
// Uses the registered public package exports; no test-only source-resolution overrides.
export default defineConfig({ test: { include: [
  "packages/contracts/src/project-guide.test.ts",
  "packages/cloudflare-research-runtime/src/project-guide.test.ts",
  "packages/owner-api-client/src/research/project-guide.test.ts",
  "apps/eliotr-web/src/query/projectGuide.test.ts",
  "apps/eliotr-core/src/project-guide-composition.test.ts",
  "apps/eliotr-core/src/project-guide-http.test.ts",
], maxWorkers: 2 } });
