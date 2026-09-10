import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      // env.test declares only local D1/R2/Queue/Workflow bindings. Keep the
      // test profile from starting an unnecessary remote bindings proxy.
      remoteBindings: false,
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
    // Bound concurrent runtime startup and D1 load locally and on CI. Four
    // runtime pools caused otherwise unchanged storage tests to miss deadlines.
    // Keep file parallelism and the existing per-test deadlines.
    maxWorkers: 2,
    // Windows may allocate a local Workers runtime on a WHATWG Fetch
    // forbidden port. Reserve those loopback endpoints before pool workers
    // start; the global setup owns teardown and never touches other listeners.
    globalSetup: [fileURLToPath(new URL("../../scripts/lib/miniflare-port-guard.mjs", import.meta.url))],
  },
}));
