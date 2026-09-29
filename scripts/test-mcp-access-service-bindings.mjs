import assert from "node:assert/strict";
import { createMcpAccessConfig } from "./lib/cloudflare-access-mcp.mjs";
import {
  mcpAccessServiceBindingSha256,
  readMcpAccessServiceBindings,
} from "./lib/mcp-access-service-bindings.mjs";

const tokenA = "123e4567-e89b-12d3-a456-426614174000";
const tokenB = "123e4567-e89b-12d3-a456-426614174001";
const clientA = "muse-client.access";
const clientB = "worker-client.access";
const desired = {
  path: "/mcp",
  path_cookie_attribute: true,
  application: {
    name_prefix: "Eliot Research MCP",
    type: "self_hosted",
    session_duration: "24h",
    app_launcher_visible: false,
  },
  policy: {
    name_prefix: "Eliot Research MCP",
    decision: "allow",
    service_token_decision: "non_identity",
  },
};
const additional = [
  { token_id: tokenB, client_id: clientB },
  { token_id: tokenA, client_id: clientA },
];
const environment = {
  ELIOTR_MCP_ACCESS_AUTH_PROFILE: "service-token",
  ELIOTR_MCP_ACCESS_SERVICE_TOKENS: JSON.stringify(additional),
};
const bindings = readMcpAccessServiceBindings(environment);
assert.deepEqual(bindings.map((binding) => binding.client_id), [clientA, clientB]);
assert.equal(
  mcpAccessServiceBindingSha256(bindings),
  mcpAccessServiceBindingSha256(readMcpAccessServiceBindings({
    ...environment,
    ELIOTR_MCP_ACCESS_SERVICE_TOKENS: JSON.stringify([...additional].reverse()),
  })),
);
assert.throws(() => readMcpAccessServiceBindings({
  ELIOTR_MCP_ACCESS_SERVICE_TOKENS: JSON.stringify([
    { token_id: tokenA, client_id: clientA },
    { token_id: tokenB, client_id: clientA },
  ]),
}), /Client IDs must be unique/u);

const config = createMcpAccessConfig({
  enabled: false,
  environment,
  desired,
  hostname: "research.example.test",
  ownerEmails: ["owner@example.test"],
});
assert.equal(config.profile, "service-token");
assert.equal(config.serviceBindings.length, 2);
assert.equal(config.serviceTokenId, null);

const legacy = createMcpAccessConfig({
  enabled: true,
  environment: {
    ELIOTR_MCP_ACCESS_SERVICE_TOKEN_ID: tokenA,
    ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: clientA,
  },
  desired,
  hostname: "research.example.test",
  ownerEmails: ["owner@example.test"],
});
assert.equal(legacy.serviceTokenId, tokenA);
assert.equal(legacy.clientId, clientA);
assert.equal(legacy.serviceBindings[0].legacy, true);

assert.throws(() => createMcpAccessConfig({
  enabled: false,
  environment: {
    ELIOTR_MCP_ACCESS_ENABLED: "1",
    ELIOTR_MCP_ACCESS_AUTH_PROFILE: "managed-oauth",
    ELIOTR_MCP_ACCESS_SERVICE_TOKENS: JSON.stringify(additional),
  },
  desired,
  hostname: "research.example.test",
  ownerEmails: ["owner@example.test"],
}), /must not configure service-token/u);
assert.throws(() => createMcpAccessConfig({
  enabled: false,
  environment: { ELIOTR_MCP_ACCESS_ENABLED: "0" },
  desired,
  hostname: "research.example.test",
  ownerEmails: ["owner@example.test"],
}), /safe removal/u);

console.log("MCP Access service binding fixtures: PASS");
