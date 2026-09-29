import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  applyMcp,
  buildMcpReceipt,
  createMcpAccessConfig,
  preflightMcp,
} from "./lib/cloudflare-access-mcp.mjs";
import {
  applyMcpRuntimeVars,
  resolveMcpAccessRuntimeConfiguration,
} from "./lib/access-runtime-config.mjs";

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
  application: { name_prefix: "Eliot Research MCP", type: "self_hosted", session_duration: "24h", app_launcher_visible: false },
  policy: { name_prefix: "Eliot Research MCP", decision: "allow", service_token_decision: "non_identity" },
};
const environment = {
  ELIOTR_MCP_ACCESS_AUTH_PROFILE: "service-token",
  ELIOTR_MCP_ACCESS_TEAM_DOMAIN: team,
  ELIOTR_MCP_ACCESS_AUDIENCE: mcpAud,
  ELIOTR_MCP_ACCESS_SERVICE_TOKENS: JSON.stringify([
    { token_id: tokenB, client_id: clientB },
    { token_id: tokenA, client_id: clientA },
  ]),
};
const config = createMcpAccessConfig({
  enabled: false,
  environment,
  desired,
  hostname,
  ownerEmails: ["owner@example.test"],
});
const tokenRecords = new Map([
  [tokenA, { id: tokenA, client_id: clientA }],
  [tokenB, { id: tokenB, client_id: clientB }],
]);
const requestLog = [];
let mcpApplication;
let mcpPolicy;
const request = async (method, path) => {
  requestLog.push({ method, path });
  if (method === "GET" && path.includes("/service_tokens/")) {
    const tokenId = decodeURIComponent(path.split("/").at(-1));
    return structuredClone(tokenRecords.get(tokenId));
  }
  if (method === "GET" && path.endsWith("/policies?per_page=100")) {
    return mcpPolicy === undefined ? [] : [structuredClone(mcpPolicy)];
  }
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
  equal: (left, right) => JSON.stringify(left) === JSON.stringify(right),
  freshApplication: async () => { throw new Error("unexpected application read"); },
});
assert.equal(state.serviceTokenRecords.length, 2);
assert.equal(requestLog.filter((entry) => entry.path.includes("/service_tokens/")).length, 2);

const ownerApplication = { id: "owner-app", aud: ordinaryAud };
const applied = await applyMcp({
  config,
  state,
  ordinaryApplication: ownerApplication,
  accountId: account,
  enc: encodeURIComponent,
  equal: (left, right) => JSON.stringify(left) === JSON.stringify(right),
  resolveOrdinaryAud: (application) => ({ aud: application.aud }),
  freshApplication: async (id) => id === ownerApplication.id
    ? ownerApplication
    : structuredClone(mcpApplication),
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
      path_cookie_attribute: true,
    };
    return structuredClone(mcpApplication);
  },
  request,
});
assert.deepEqual(
  mcpPolicy.include.map((rule) => rule.service_token.token_id).sort(),
  [tokenA, tokenB],
);
assert.equal(applied.liveAud.aud, mcpAud);

const sha256Hex = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const mcpReceipt = buildMcpReceipt({ config, state: applied, teamFinal: team, sha256Hex });
assert.equal(mcpReceipt.service_token_count, 2);
assert.match(mcpReceipt.service_token_bindings_sha256, /^[a-f0-9]{64}$/u);
assert.equal(Object.hasOwn(mcpReceipt, "service_token_client_id_sha256"), false);

const accessReceipt = {
  protocol: "eliotr.cloudflare-access-receipt.v1",
  account_id: account,
  hostname,
  aud: ordinaryAud,
  team_domain: team,
  mcp: mcpReceipt,
};
const runtime = resolveMcpAccessRuntimeConfiguration({
  ELIOTR_MCP_ACCESS_AUTH_PROFILE: "service-token",
  ELIOTR_MCP_ACCESS_TEAM_DOMAIN: team,
  ELIOTR_MCP_ACCESS_AUDIENCE: mcpAud,
  ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS: JSON.stringify([clientB, clientA]),
}, accessReceipt, { ordinaryAudience: ordinaryAud, publicHostname: hostname });
assert.deepEqual(runtime.additionalClientIds, [clientA, clientB]);
assert.deepEqual(applyMcpRuntimeVars({}, runtime), {
  MCP_HOSTNAME: hostname,
  MCP_ACCESS_TEAM_DOMAIN: team,
  MCP_ACCESS_AUDIENCE: mcpAud,
  MCP_ACCESS_AUTH_PROFILE: "service-token",
  MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS: JSON.stringify([clientA, clientB]),
});

tokenRecords.set(tokenB, { id: tokenB, client_id: "wrong-client.access" });
await assert.rejects(() => preflightMcp({
  config,
  applications: [],
  request,
  accountId: account,
  enc: encodeURIComponent,
  teamDomain: team,
  ordinaryApplication: null,
  resolveOrdinaryAud: () => ({ aud: ordinaryAud }),
  equal: (left, right) => JSON.stringify(left) === JSON.stringify(right),
  freshApplication: async () => null,
}), /does not match/u);

console.log("MCP Access provisioning flow fixtures: PASS");
