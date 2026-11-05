import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/web/Proposals.test.tsx", "src/web/Understanding.test.tsx", "src/web/Reader.test.tsx", "src/understanding-retry.test.ts", "src/model-admission.test.ts", "src/auth.test.ts", "src/blocks.test.ts", "src/url-guard.test.ts", "src/citations.test.ts", "src/quotes.test.ts", "src/code-ranges.test.ts", "src/claim-fts.test.ts", "src/context.test.ts", "src/chat-stream.test.ts", "src/chat-usage.test.ts", "src/publication-freshness.test.ts", "src/cost.test.ts", "src/model-quota.test.ts", "src/model-catalog.test.ts", "src/model-transport.test.ts", "src/understanding.test.ts", "src/ocr-usage.test.ts", "src/ocr-admission.test.ts", "src/workflows/distill-model.test.ts", "src/workflows/ingest.test.ts", "src/web/Markdown.test.tsx", "src/web/api.test.ts", "src/web/reader-range.test.ts", "src/web/chat-history.test.ts", "src/web/studio-pages.test.ts", "src/web/ui/tokens.test.ts"],
    environment: "node",
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
