import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const result = spawnSync(
  process.execPath,
  [resolve("scripts/provision-cloudflare-core.mjs"), "--check-only"],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: "mock-account",
      CLOUDFLARE_API_TOKEN: "mock-token",
      CLOUDFLARE_API_BASE_URL: "http://127.0.0.1:1/client/v4",
      ELIOTR_ACCESS_HOSTNAME: "research.example.test",
      ELIOTR_CUSTOM_DOMAIN: "1",
      ELIOTR_DEPLOYMENT_GENERATION: "mock-generation",
      ELIOTR_ACCESS_TEAM_DOMAIN: "http://invalid.cloudflareaccess.com",
      ELIOTR_ACCESS_AUDIENCE: "mock-access-audience",
    },
  },
);

assert.notEqual(result.status, 0, "invalid Access runtime input unexpectedly passed");
assert.match(result.stderr, /ELIOTR_ACCESS_TEAM_DOMAIN/u);
assert.doesNotMatch(result.stderr, /ECONNREFUSED|fetch failed/u);
console.log("Access runtime preflight ordering fixture: PASS");
