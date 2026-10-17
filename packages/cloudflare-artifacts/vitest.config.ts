import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import agents from "../../apps/eliotr-core/vite-agents.mjs";

export default defineConfig(async () => {
  const coreRoot = new URL("../../apps/eliotr-core/", import.meta.url);
  return {
  root: fileURLToPath(coreRoot),
  plugins: [agents(), cloudflareTest({
    remoteBindings: false,
    miniflare: {
      bindings: {
        CORE_MIGRATIONS: await readD1Migrations(fileURLToPath(new URL("../../infra/d1/core/migrations", import.meta.url))),
        SEARCH_MIGRATIONS: await readD1Migrations(fileURLToPath(new URL("../../infra/d1/search/migrations", import.meta.url))),
      },
    },
    wrangler: {
      configPath: fileURLToPath(new URL("../../apps/eliotr-core/wrangler.jsonc", import.meta.url)),
      environment: "test",
    },
  })],
  test: {
    include: [`${fileURLToPath(new URL("./test/", import.meta.url)).replaceAll("\\", "/")}**/*.test.ts`],
    maxWorkers: 2,
    globalSetup: [fileURLToPath(new URL("../../scripts/lib/miniflare-port-guard.mjs", import.meta.url))],
  },
  };
});
