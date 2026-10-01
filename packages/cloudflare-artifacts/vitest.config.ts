import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [cloudflareTest({
    remoteBindings: false,
    miniflare: {
      bindings: {
        CORE_MIGRATIONS: await readD1Migrations(fileURLToPath(new URL("../../infra/d1/core/migrations", import.meta.url))),
      },
    },
    wrangler: {
      configPath: fileURLToPath(new URL("../../apps/eliotr-core/wrangler.jsonc", import.meta.url)),
      environment: "test",
    },
  })],
  test: {
    include: ["test/**/*.test.ts"],
    maxWorkers: 2,
    globalSetup: [fileURLToPath(new URL("../../scripts/lib/miniflare-port-guard.mjs", import.meta.url))],
  },
}));
