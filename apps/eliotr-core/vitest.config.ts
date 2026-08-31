import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.jsonc",
        environment: "test",
      },
    }),
  ],
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
