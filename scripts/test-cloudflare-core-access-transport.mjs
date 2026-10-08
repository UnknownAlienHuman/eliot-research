import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = (await readFile(resolve(repositoryRoot, "scripts/provision-cloudflare-core.mjs"), "utf8"))
  .replace(/\r\n/gu, "\n");
const start = source.indexOf("async function readAccessApplications()");
const end = source.indexOf("\n}\n", start);
assert.ok(start >= 0 && end > start, "Core Access inventory reader is missing");
const readAccessApplicationsSource = source.slice(start, end + 2);

const calls = { factories: 0, verifyAccount: 0, accessRequests: [], closes: 0, directRequests: 0 };
const inventory = [{ id: "verified-owner-app" }];
const injectedEnv = {
  ELIOTR_CLOUDFLARE_MCP_CWD: "C:\\Development\\Cloudflare",
  CLOUDFLARE_API_TOKEN: "ephemeral-child-bearer",
  KEEP_FOR_WRANGLER_REST: "present",
};
let factoryOptions;
const readMcp = runInNewContext(`(${readAccessApplicationsSource})`, {
  accessTransport: "cloudflare-mcp",
  CLOUDFLARE_MCP_TRANSPORT: "cloudflare-mcp",
  accountId: "fixture-account",
  enc: encodeURIComponent,
  process: { env: injectedEnv },
  scrubTokenEnv(env) {
    const safe = { ...env };
    delete safe.CLOUDFLARE_API_TOKEN;
    return safe;
  },
  createCloudflareMcpTransport(options) {
    calls.factories += 1;
    factoryOptions = options;
    return {
      async verifyAccount() { calls.verifyAccount += 1; },
      async request(method, path) {
        calls.accessRequests.push({ method, path });
        return inventory;
      },
      close() { calls.closes += 1; },
    };
  },
  async request() {
    calls.directRequests += 1;
    throw new Error("MCP-selected Access inventory must not use direct REST");
  },
});

assert.equal(await readMcp(), inventory);
assert.equal(calls.factories, 1, "MCP mode must create one scoped transport");
assert.equal(factoryOptions.cwd, "C:\\Development\\Cloudflare");
assert.equal(factoryOptions.accountId, "fixture-account");
assert.equal(factoryOptions.env.CLOUDFLARE_API_TOKEN, undefined,
  "MCP child environment must not inherit the core's ephemeral Wrangler bearer");
assert.equal(factoryOptions.env.KEEP_FOR_WRANGLER_REST, "present");
assert.equal(calls.verifyAccount, 1, "MCP inventory read must verify its account scope");
assert.deepEqual(calls.accessRequests, [{
  method: "GET",
  path: "/accounts/fixture-account/access/apps?per_page=100",
}]);
assert.equal(calls.directRequests, 0, "MCP Access inventory must not fall back to Wrangler REST");
assert.equal(calls.closes, 1, "MCP transport must close after the GET read");

const failedCalls = { closed: 0 };
const readMcpFailure = runInNewContext(`(${readAccessApplicationsSource})`, {
  accessTransport: "cloudflare-mcp",
  CLOUDFLARE_MCP_TRANSPORT: "cloudflare-mcp",
  accountId: "fixture-account",
  enc: encodeURIComponent,
  process: { env: { ELIOTR_CLOUDFLARE_MCP_CWD: "C:\\Development\\Cloudflare" } },
  scrubTokenEnv: (env) => ({ ...env }),
  createCloudflareMcpTransport: () => ({
    async verifyAccount() {},
    async request() { throw new Error("fixture MCP read failed"); },
    close() { failedCalls.closed += 1; },
  }),
  request: async () => { throw new Error("unexpected direct request"); },
});
await assert.rejects(readMcpFailure(), /fixture MCP read failed/u);
assert.equal(failedCalls.closed, 1, "MCP transport must close after a failed GET read");

const directCalls = [];
const readWrangler = runInNewContext(`(${readAccessApplicationsSource})`, {
  accessTransport: "wrangler",
  CLOUDFLARE_MCP_TRANSPORT: "cloudflare-mcp",
  accountId: "fixture-account",
  enc: encodeURIComponent,
  process: { env: {} },
  scrubTokenEnv: (env) => env,
  createCloudflareMcpTransport: () => { throw new Error("default Wrangler path must not create MCP"); },
  async request(method, path) {
    directCalls.push({ method, path });
    return inventory;
  },
});
assert.equal(await readWrangler(), inventory);
assert.deepEqual(directCalls, [{
  method: "GET",
  path: "/accounts/fixture-account/access/apps?per_page=100",
}], "default Wrangler Access read path must remain unchanged");

console.log("Cloudflare Core Access inventory transport: PASS");
console.log("- managed MCP path: account-pinned complete-list GET, bearer-scrubbed environment, guaranteed close");
console.log("- default Wrangler path: direct GET unchanged");
