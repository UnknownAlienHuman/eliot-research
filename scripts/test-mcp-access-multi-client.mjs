import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  applyAccessRuntimeVars,
  applyMcpRuntimeVars,
  resolveAccessRuntimeConfiguration,
  resolveMcpAccessRuntimeConfiguration,
} from "./lib/access-runtime-config.mjs";
import {
  applyMcp,
  buildMcpReceipt,
  createMcpAccessConfig,
  preflightMcp,
  resolveMcpAud,
} from "./lib/cloudflare-access-mcp.mjs";
import {
  mcpAccessServiceBindingSha256,
  readMcpAccessServiceBindings,
} from "./lib/mcp-access-service-bindings.mjs";

const account = "account-test";
const hostname = "research.example.test";
const team = "https://mcp-team.cloudflareaccess.com";
const ordinaryAud = "ordinary-aud";
const mcpAud = "mcp-aud";
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
const tokens = [
  { token_id: tokenB, client_id: clientB },
  { token_id: tokenA, client_id: clientA },
];
const serviceEnvironment = {
  ELIOTR_MCP_ACCESS_ENABLED: "1",
  ELIOTR_MCP_ACCESS_AUTH_PROFILE: "service-token",
  ELIOTR_MCP_ACCESS_SERVICE_TOKENS: JSON.stringify(tokens),
  ELIOTR_MCP_ACCESS_TEAM_DOMAIN: team,
  ELIOTR_MCP_ACCESS_AUDIENCE: mcpAud,
};
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sha256Hex = (value) => createHash("sha256").update(value, "utf8").digest("hex");

const bindings = readMcpAccessServiceBindings(serviceEnvironment);
assert.deepEqual(bindings.map((binding) => binding.client_id), [clientA, clientB]);
const reversedBindings = readMcpAccessServiceBindings({
  ...serviceEnvironment,
  ELIOTR_MCP_ACCESS_SERVICE_TOKENS: JSON.stringify([...tokens].reverse()),
});
assert.equal(mcpAccessServiceBindingSha256(bindings), mcpAccessServiceBindingSha256(reversedBindings));
assert.throws(() => readMcpAccessServiceBindings({
  ELIOTR_MCP_ACCESS_SERVICE_TOKENS: JSON.stringify([
    { token_id: tokenA, client_id: clientA },
    { token_id: tokenB, client_id: clientA },
  ]),
}), /Client IDs must be unique/u);

assert.equal(createMcpAccessConfig({
  enabled: false,
  environment: {},
  desired,
  hostname,
  ownerEmails: ["owner@example.test"],
}), null);
const config = createMcpAcccessConfig({
  enabled: false,
  environment: serviceEnvironment,
  desired,
  hostname,
  ownerEmails: ["owner@example.test"],
});
assert.equal(config.profile, "service-token");
assert.equal(config.serviceBindings.length, 2);
assert.equal(config.serviceTokenId, null);
const legacyConfig = createMcpAcccessConfig({
  enabled: true,
  environment: {
    ELIOTR_MCP_ACCESS_AUTH_PROFILE: "service-token",
    ELIOTR_MCP_ACCESS_SERVICE_TOKEN_ID: tokenA,
    ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: clientA,
  },
  desired,
  hostname,
  ownerEmails: ["owner@example.test"],
});
assert.equal(legacyConfig.serviceTokenId, tokenA);
assert.equal(legacyConfig.clientId, clientA);
assert.equal(legacyConfig.serviceBindings.length, 1);
assert.throws(() => createMcpAccessConfig({
  enabled: false,
  environment: { ...serviceEnvironment, ELIOTR_MCP_ACCESS_ENABLED: "0" },
  desired,
  hostname,
  ownerEmails: ["owner@example.test"],
}), /safe removal/u);
assert.throws(() => createMcpAcccessConfig({
  enabled: false,
  environment: {
    ELIOTR_MCP_ACCESS_ENABLED: "1",
    ELIOTR_MCP_ACCESS_AUTH_PROFILE: "managed-oauth",
    ELIOTR_MCP_ACCESS_SERVICE_TOKENS: JSON.stringify(tokens),
  },
  desired,
  hostname,
  ownerEmails: ["owner@example.test"],
}), /must not configure service-token/u);

const readbacks = new Map([
  [tokenA, { id: tokenA, client_id: clientA }],
  [tokenB, { id: tokenB, client_id: clientB }],
]);
const requestLog = [];
const request = async (method, path) => {
  requestLog.push({ method, path });
  const tokenId = decodeURIComponent(path.split("/").at(-1));
  if (method === "GET" && readbacks.has(tokenId)) return structuredClone(readbacks.get(tokenId));
  throw new Error(`unexpected request ${method} ${path}`);
};
const state = await preflightMcp({
  config,
  applications: [],
  request,
  accountId: account,
  enc: encodeURIComponent,
  teamDomain: team,
  ordinaryApplication: null,
  resolveOrdinaryAud: () => ({ aud: ordinaryAud }),
  equal,
  freshApplication: async () => { throw new Error("unexpected application read"); },
});
assert.equal(state.serviceTokenRecords.length, 2);
assert.deepEqual(requestLog.map((entry) => entry.method), ["GET", "GET"]);

let mcpApplication;
let mcpPolicy;
const ordinaryApplication = { id: "owner-app", aud: ordinaryAud };
const applied = await applyMcp({
  config,
  state,
  ordinaryApplication,
  accountId: account,
  enc: encodeURIComponent,
  equal,
  resolveOrdinaryAud: (application) => ({ aud: application.aud }),
  freshApplication: async (id) => {
    if (id === ordinaryApplication.id) return ordinaryApplication;
    if (id === mcpApplication?.id) return structuredClone(mcpApplication);
    throw new Error(`unknown application ${id}`);
  },
  createApplicationWithReconciliation: async (_name, body) => {
    mcpPolicy = { id: "mcp-policy", ...structuredClone(body.policies[0]), exclude: [], require: [] };
    mcpApplication = {
      id: "mcp-app",
      aud: mcpAud,
      type: body.type,
      name: body.name,
      domain: body.domain,
      destinations: body.destinations,
      session_duration: body.session_duration,
      app_launcher_visible: body.app_launcher_visible,
      path_cookie_attribute: body.path_cookie_attribute,
    };
    return structuredClone(mcpApplication);
  },
  request: async (method, path) => {
    if (method === "GET" && path.endsWith("/policies?per_page=100")) return [structuredClone(mcpPolicy)];
    throw new Error(`unexpected apply request ${method} ${path}`);
  },
});
assert.deepEqual(
  mcpPolicy.include.map((rule) => rule.service_token.token_id).sort(),
  [tokenA, tokenB],
);
assert.equal(applied.liveAud.aud, mcpAud);

const mcpReceipt = buildMcpReceipt({ config, state: applied, teamFinal: team, sha256Hex });
assert.equal(mcpReceipt.service_token_count, 2);
assert.match(mcpReceipt.service_token_bindings_sha256, /^[a-f0-9]{64}$/u);
assert.match(mcpReceipt.service_token_runtime_clients_sha256, /^[a-f0-9]{64}$/u);
assert.equal(Object.hasOwn(mcpReceipt, "service_token_client_id_sha256"), false);
const accessReceipt = {
  protocol: "eliotr.cloudflare-access-receipt.v1",
  account_id: account,
  hostname,
  aud: ordinaryAud,
  team_domain: team,
  application: { id: "owner-app", name: "owner", destination: hostname, disposition: "UNCHANGED" },
  mcp: mcpReceipt,
};
const runtimeEnvironment = {
  ELIOTR_ACCESS_TEAM_DOMAIN: team,
  ELIOTR_ACCESS_AUDIENCE: ordinaryAud,
  ELIOTR_MCP_ACCESS_AUTH_PROFILE: "service-token",
  ELIOTR_MCP_ACCESS_TEAM_DOMAIN: team,
  ELIOTR_MCP_ACCESS_AUDIENCE: mcpAud,
  ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS: JSON.stringify([clientB, clientA]),
};
const mcpRuntime = resolveMcpAccessRuntimeConfiguration(runtimeEnvironment, accessReceipt, {
  ordinaryAudience: ordinaryAud,
  publicHostname: hostname,
});
assert.equal(mcpRuntime.serviceTokenClientCount, 2);
assert.equal(mcpRuntime.legacyClientId, null);
assert.deepEqual(mcpRuntime.additionalClientIds, [clientA, clientB]);
assert.deepEqual(applyMcpRuntimeVars({}, mcpRuntime), {
  MCP_HOSTNAME: hostname,
  MCP_ACCESS_TEAM_DOMAIN: team,
  MCP_ACCESS_AUDIENCE: mcpAud,
  MCP_ACCESS_AUTH_PROFILE: "service-token",
  MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS: JSON.stringify([clientA, clientB]),
});
const ordinaryRuntime = resolveAccessRuntimeConfiguration(runtimeEnvironment, accessReceipt);
assert.equal(ordinaryRuntime.mcpAccessRuntime.serviceTokenClientCount, 2);
const combinedVars = applyAccessRuntimeVars({}, ordinaryRuntime);
assert.equal(combinedVars.MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS, JSON.stringify([clientA, clientB]));

await assert.rejects(() => preflightMcp({
  config,
  applications: [],
  request: async (_method, path) => ({
    id: decodeURIComponent(path.split("/").at(-1)),
    client_id: "wrong-client.access",
  }),
  accountId: account,
  enc: encodeURIComponent,
  teamDomain: team,
  ordinaryApplication: null,
  resolveOrdinaryAud: () => ({ aud: ordinaryAud }),
  equal,
  freshApplication: async () => { throw new Error("unexpected application read"); },
}), /does not match/u);

const legacyClient = "gemini-legacy.access";
const legacyReceipt = structuredClone(accessReceipt);
legacyReceipt.mcp = {
  ...mcpReceipt,
  service_token_count: undefined,
  service_token_bindings_sha256: undefined,
  service_token_runtime_clients_sha256: undefined,
  service_token_id: tokenA,
  service_token_client_id_sha256: sha256Hex(legacyClient),
};
delete legacyReceipt.mcp.service_token_count;
delete legacyReceipt.mcp.service_token_bindings_sha256;
delete legacyReceipt.mcp.service_token_runtime_clients_sha256;
const legacyRuntime = resolveMcpAccessRuntimeConfiguration({
  ELIOTR_MCP_ACCESS_AUTH_PROFILE: "service-token",
  ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: legacyClient,
}, legacyReceipt, { ordinaryAudience: ordinaryAud, publicHostname: hostname });
assert.equal(legacyRuntime.legacyClientId, legacyClient);
assert.deepEqual(legacyRuntime.additionalClientIds, []);

assert.equal(resolveMcpAud({ aud: mcpAud }, undefined).aud, mcpAud);
console.log("MCP Access multi-client fixtures: PASS");
