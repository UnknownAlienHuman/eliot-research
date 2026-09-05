import { spawnSync } from "node:child_process";

process.env.ELIOTR_ACCESS_TEAM_DOMAIN ??= "https://mock-team.cloudflareaccess.com";
process.env.ELIOTR_ACCESS_AUDIENCE ??= "mock-access-audience";
process.env.ELIOTR_ACCESS_SERVICE_PRINCIPALS ??= "eliotr-federation,eliotr-agent";
await import("./test-launch-code.mjs");
await import("./test-local-runtime.mjs");
await import("./test-deployment-verification.mjs");
await import("./test-deployment-orchestration.mjs");
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
