import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = (await readFile(resolve(repositoryRoot, "scripts/provision-cloudflare-core.mjs"), "utf8"))
  .replace(/\r\n/gu, "\n");
const start = source.indexOf("function omitUnusedMcpPlaceholderVars(");
const end = source.indexOf("\n}\n", start);
assert.ok(start >= 0 && end > start, "Core maintenance variable filter is missing");
const filter = runInNewContext(`(${source.slice(start, end + 2)})`);

const placeholders = {
  MCP_HOSTNAME: "mcp.replace-me.example",
  MCP_ACCESS_TEAM_DOMAIN: "https://replace-me.cloudflareaccess.com",
  MCP_ACCESS_AUDIENCE: "replace-me",
  MCP_ACCESS_AUTH_PROFILE: "service-token",
  MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: "replace-me.access",
};
const vars = {
  ...placeholders,
  MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS: '["existing-client.access"]',
  MCP_CUSTOM_CONFIGURATION: "preserve-me",
  GOOGLE_EXTERNAL_TRANSPORT: "disabled",
};

const preserved = filter(vars, "disabled", null);
for (const key of Object.keys(placeholders)) {
  assert.equal(Object.hasOwn(preserved, key), false, `${key} placeholder should be omitted for disabled maintenance`);
}
assert.equal(preserved.MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS, vars.MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS,
  "unlisted MCP variables must remain subject to the strict binding comparison");
assert.equal(preserved.MCP_CUSTOM_CONFIGURATION, "preserve-me");
assert.equal(preserved.GOOGLE_EXTERNAL_TRANSPORT, "disabled");
assert.deepEqual(vars, { ...placeholders, MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS: '["existing-client.access"]',
  MCP_CUSTOM_CONFIGURATION: "preserve-me", GOOGLE_EXTERNAL_TRANSPORT: "disabled" },
"maintenance generation must not mutate canonical vars");

assert.equal(filter(vars, undefined), vars,
  "the default/full-release generator must retain canonical variables byte-for-byte");
assert.equal(filter(vars, "gemini-mcp"), vars,
  "non-disabled transport generation must retain canonical variables byte-for-byte");

const configuredMcpVars = {
  ...placeholders,
  MCP_HOSTNAME: "research.example.test",
  MCP_ACCESS_TEAM_DOMAIN: "https://team-example.cloudflareaccess.com",
  MCP_ACCESS_AUDIENCE: "verified-mcp-audience",
  MCP_ACCESS_AUTH_PROFILE: "managed-oauth",
  MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: "verified-client.access",
};
const configured = filter(configuredMcpVars, "disabled", null);
for (const [key, value] of Object.entries(configuredMcpVars)) {
  assert.equal(configured[key], value, `${key} non-placeholder setting must not be silently removed`);
}
assert.equal(filter(vars, "disabled", { source: "verified Access receipt" }), vars,
  "receipt-derived MCP Access vars must never be silently removed");
assert.equal(filter(vars, "disabled", null, { source: "verified Core MCP runtime" }), vars,
  "Core-resolved MCP Access vars must never be silently removed");

console.log("Cloudflare Core maintenance variable generation: PASS");
console.log("- disabled maintenance omits only exact unused MCP placeholder defaults");
console.log("- default/full-release and configured MCP values remain unchanged");
