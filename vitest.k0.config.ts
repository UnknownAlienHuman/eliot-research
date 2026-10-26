import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/auth.test.ts", "src/blocks.test.ts", "src/url-guard.test.ts", "src/citations.test.ts", "src/quotes.test.ts", "src/context.test.ts", "src/cost.test.ts", "src/model-transport.test.ts", "src/web/Markdown.test.tsx", "src/web/ui/tokens.test.ts"],
    environment: "node",
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
