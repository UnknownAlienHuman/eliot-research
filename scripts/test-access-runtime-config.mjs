import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  applyAccessRuntimeVars,
  applyMcpRuntimeVars,
  resolveMcpAccessRuntimeConfiguration,
  validateAccessRuntimeConfiguration,
} from "./lib/access-runtime-config.mjs";

const valid = validateAccessRuntimeConfiguration({
  ELIOTR_ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
  ELIOTR_ACCESS_AUDIENCE: "0123456789abcdef",
  ELIOTR_ACCESS_SERVICE_PRINCIPALS: "eliotr-agent,eliotr-federation",
});
assert.equal(valid.teamDomain, "https://example.cloudflareaccess.com");
assert.deepEqual(valid.servicePrincipals, ["eliotr-agent", "eliotr-federation"]);
assert.deepEqual(applyAccessRuntimeVars({ ENVIRONMENT: "test" }, valid), {
  ENVIRONMENT: "test",
  ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
  ACCESS_AUDIENCE: "0123456789abcdef",
  ACCESS_SERVICE_PRINCIPALS: "eliotr-agent,eliotr-federation",
});

for (const fixture of [
  { ELIOTR_ACCESS_TEAM_DOMAIN: "http://example.cloudflareaccess.com", ELIOTR_ACCESS_AUDIENCE: "aud" },
  { ELIOTR_ACCESS_TEAM_DOMAIN: "https://example.invalid", ELIOTR_ACCESS_AUDIENCE: "aud" },
  { ELIOTR_ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com/path", ELIOTR_ACCESS_AUDIENCE: "aud" },
  { ELIOTR_ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com", ELIOTR_ACCESS_AUDIENCE: "" },
  { ELIOTR_ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com", ELIOTR_ACCESS_AUDIENCE: "bad audience" },
  { ELIOTR_ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com", ELIOTR_ACCESS_AUDIENCE: "aud", ELIOTR_ACCESS_SERVICE_PRINCIPALS: "duplicate,duplicate" },
]) {
  assert.throws(() => validateAccessRuntimeConfiguration(fixture));
}

const mcpClientId = "mcp-client.access";
const mcpReceipt = {
  protocol: "eliotr.cloudflare-access-receipt.v1",
  account_id: "account-1",
  hostname: "research.example.test",
  aud: valid.audience,
  team_domain: valid.teamDomain,
  mcp: {
    hostname: "research.example.test",
    path: "/mcp",
    path_cookie_attribute: true,
    team_domain: valid.teamDomain,
    aud: "mcp-audience",
    auth_profile: "service-token",
    oauth_configuration_enabled: false,
    application: {
      id: "mcp-app-1",
      name: "Eliot Research MCP",
      destination: "research.example.test/mcp",
      disposition: "UNCHANGED",
    },
    service_token_client_id_sha256: createHash("sha256").update(mcpClientId, "utf8").digest("hex"),
  },
};
const mcpRuntime = resolveMcpAccessRuntimeConfiguration({
  ELIOTR_MCP_ACCESS_TEAM_DOMAIN: valid.teamDomain,
  ELIOTR_MCP_ACCESS_AUDIENCE: "mcp-audience",
  ELIOTR_MCP_ACCESS_AUTH_PROFILE: "service-token",
  ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: mcpClientId,
}, mcpReceipt, { ordinaryAudience: valid.audience, publicHostname: "research.example.test" });
assert.equal(mcpRuntime.source, "RECEIPT");
assert.equal(mcpRuntime.hostname, "research.example.test");
assert.equal(mcpRuntime.path, "/mcp");
assert.equal(mcpRuntime.audience, "mcp-audience");
assert.throws(() => resolveMcpAccessRuntimeConfiguration({
  ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: "mcp-client",
}, mcpReceipt, { ordinaryAudience: valid.audience, publicHostname: "research.example.test" }), /exact Cloudflare Access service-token Client ID/u);
assert.deepEqual(applyMcpRuntimeVars({ MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: "placeholder" }, mcpRuntime), {
  MCP_HOSTNAME: "research.example.test",
  MCP_ACCESS_TEAM_DOMAIN: valid.teamDomain,
  MCP_ACCESS_AUDIENCE: "mcp-audience",
  MCP_ACCESS_AUTH_PROFILE: "service-token",
  MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: mcpClientId,
});

const managedReceipt = structuredClone(mcpReceipt);
managedReceipt.mcp.auth_profile = "managed-oauth";
managedReceipt.mcp.oauth_configuration_enabled = true;
delete managedReceipt.mcp.service_token_client_id_sha256;
const managedRuntime = resolveMcpAccessRuntimeConfiguration({}, managedReceipt, {
  ordinaryAudience: valid.audience,
  publicHostname: "research.example.test",
});
assert.equal(managedRuntime.authProfile, "managed-oauth");
assert.equal(Object.hasOwn(applyMcpRuntimeVars({ MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: "stale" }, managedRuntime), "MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID"), false);
assert.throws(() => resolveMcpAccessRuntimeConfiguration({ ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: mcpClientId }, managedReceipt, {
  ordinaryAudience: valid.audience,
  publicHostname: "research.example.test",
}), /must not configure/u);
assert.throws(() => resolveMcpAccessRuntimeConfiguration({}, mcpReceipt, {
  ordinaryAudience: "mcp-audience",
  publicHostname: "research.example.test",
}), /must differ/u);
assert.throws(() => resolveMcpAccessRuntimeConfiguration({
  ELIOTR_MCP_HOSTNAME: "other.example.test",
  ELIOTR_MCP_ACCESS_TEAM_DOMAIN: valid.teamDomain,
  ELIOTR_MCP_ACCESS_AUDIENCE: "mcp-audience",
}, null, { ordinaryAudience: valid.audience, publicHostname: "research.example.test" }), /one-host/u);

console.log("Access runtime configuration fixtures: PASS");
