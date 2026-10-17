import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const coreRoot = new URL("../../apps/eliotr-core/", import.meta.url);
  const coreRequire = createRequire(new URL("package.json", coreRoot));
  const { default: agents } = await import(pathToFileURL(coreRequire.resolve("agents/vite")).href);
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
