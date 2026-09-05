import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      miniflare: { bindings: {
        CORE_MIGRATIONS: await readD1Migrations(fileURLToPath(new URL("../../infra/d1/core/migrations", import.meta.url))),
        SEARCH_MIGRATIONS: await readD1Migrations(fileURLToPath(new URL("../../infra/d1/search/migrations", import.meta.url))),
      } },
      wrangler: {
        configPath: "./wrangler.jsonc",
        environment: "test",
      },
    }),
  ],
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
}));
