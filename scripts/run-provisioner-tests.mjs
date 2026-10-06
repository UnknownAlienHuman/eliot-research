import { spawnSync } from "node:child_process";

process.env.ELIOTR_ACCESS_TEAM_DOMAIN ??= "https://mock-team-example.cloudflareaccess.com";
process.env.ELIOTR_ACCESS_AUDIENCE ??= "mock-access-audience";
process.env.ELIOTR_ACCESS_SERVICE_PRINCIPALS ??= "eliotr-federation,eliotr-agent";
await import("./test-cloudflare-mcp-oauth.mjs");
await import("./test-mcp-access-service-bindings.mjs");
await import("./test-mcp-access-provisioning-flow.mjs");
await import("./test-launch-code.mjs");
await import("./test-staging-isolation.mjs");
await import("./test-deployment-migrations.mjs");
await import("./test-deployment-assets.mjs");
await import("./test-local-runtime.mjs");
await import("./test-deployment-verification.mjs");
await import("./test-research-backend-fingerprint.mjs");
await import("./test-research-deployment-authority.mjs");
await import("./test-deployment-orchestration.mjs");
await import("./test-deployment-apply-ordering.mjs");
await import("./test-deployment-maintenance.mjs");
await import("./test-deployment-ai-search-bootstrap.mjs");
await import("./test-deployment-mcp-access-transition.mjs");
await import("./test-deployment-migration-operation.mjs");
await import("./test-backup-trigger-parser-compatibility.mjs");
await import("./test-deployment-build-inputs.mjs");
await import("./test-primary-writer-qualification-operator.mjs");
await import("./test-cloudflare-provisioners.mjs");
await import("./test-ai-search-provisioning-readback.mjs");
await import("./test-ai-search-provisioning-reconciliation.mjs");

const build = spawnSync(
  "pnpm",
  [
    "exec",
    "tsc",
    "-b",
    "packages/cloudflare-ai/tsconfig.json",
    "--pretty",
    "false",
    "--force",
  ],
  {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);
if (build.error !== undefined) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

await import("./test-ai-search-generation-operator.mjs");
await import("./test-provisioner-exit-regression.mjs");
await import("./test-cloudflare-usage-providers.mjs");
await import("./test-usage-aggregation-trust.mjs");
await import("./test-privacy-large-line-regression.mjs");
await import("./test-queues-chunk-accounting.mjs");
await import("./test-cloudflare-usage-billing.mjs");
await import("./test-cloudflare-usage-billing-collector.mjs");
await import("./test-cloudflare-usage-source-decoder.mjs");
await import("./test-cloudflare-usage-source-collection.mjs");
await import("./test-cloudflare-usage-source-analytics.mjs");
await import("./test-cloudflare-usage-pagination.mjs");
await import("./test-usage-envelope-receipt.mjs");
await import("./test-usage-preflight-children.mjs");
await import("./test-usage-admission-capability.mjs");
await import("./test-usage-metric-immutability.mjs");
