import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/auth.test.ts", "src/blocks.test.ts", "src/url-guard.test.ts", "src/citations.test.ts", "src/quotes.test.ts", "src/context.test.ts", "src/chat-stream.test.ts", "src/cost.test.ts", "src/model-quota.test.ts", "src/model-transport.test.ts", "src/model-catalog.test.ts", "src/native-model-catalog.test.ts", "src/command-code-models.test.ts", "src/understanding.test.ts", "src/workflows/distill-model.test.ts", "src/web/Markdown.test.tsx", "src/web/ui/tokens.test.ts"],
    environment: "node",
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
