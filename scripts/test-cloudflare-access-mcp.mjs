import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { digestAccountId } from "./lib/cloudflare-usage-envelope.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const account = "mcp-apply-account";
const hostname = "research.example.test";
const owner = "owner@example.test";
const team = "https://mcp-team-example.cloudflareaccess.com";
const tokenId = "123e4567-e89b-12d3-a456-426614174000";
const clientId = "mcp-client.access";
const state = { apps: new Map(), policies: new Map(), serviceTokens: new Map(), requests: [], mutations: [], sequence: 0,
  dropNextAppId: false, throwNextAppPost: false, omitMcpAud: false };
function reset() { state.apps.clear(); state.policies.clear(); state.serviceTokens.clear(); state.requests.length = 0; state.mutations.length = 0; state.sequence = 0; state.dropNextAppId = false; state.throwNextAppPost = false; state.omitMcpAud = false; }
function success(result, status = 200) { return { status, payload: { success: true, errors: [], messages: [], result } }; }
function failure(status, message) { return { status, payload: { success: false, errors: [{ message }], result: null } }; }
function json(res, value) { const body = JSON.stringify(value.payload); res.writeHead(value.status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }); res.end(body); }
async function bodyJson(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined; }
function nextId(prefix) { state.sequence += 1; return `${prefix}-${state.sequence}`; }

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://mock");
    const method = req.method ?? "GET";
    const body = await bodyJson(req);
    state.requests.push({ method, pathname: url.pathname, body });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) state.mutations.push({ method, pathname: url.pathname, body });
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== "client" || parts[1] !== "v4" || parts[2] !== "accounts" || parts[3] !== account) return json(res, failure(404, "unknown account"));
    const tail = parts.slice(4);
    if (tail[0] === "access" && tail[1] === "organizations" && method === "GET") return json(res, success([{ auth_domain: team.slice("https://".length) }]));
    if (tail[0] === "access" && tail[1] === "service_tokens" && tail.length === 3 && method === "GET") {
      const token = state.serviceTokens.get(tail[2]);
      return json(res, token ? success(structuredClone(token)) : failure(404, "missing service token"));
    }
    if (tail[0] === "access" && tail[1] === "apps") {
      if (tail.length === 2 && method === "GET") return json(res, success([...state.apps.values()].map((item) => structuredClone(item))));
      if (tail.length === 2 && method === "POST") {
        const id = nextId("access-app");
        const { policies = [], ...appBody } = body;
        const isMcp = body.domain === `${hostname}/mcp`;
        const app = { id, ...(isMcp && !state.omitMcpAud ? { aud: "mcp-aud" } : !isMcp ? { aud: "ordinary-aud" } : {}), ...structuredClone(appBody) };
        state.apps.set(id, app);
        state.policies.set(id, policies.map((policy) => ({ id: nextId("access-policy"), ...structuredClone(policy), exclude: [], require: [] })));
        if (state.throwNextAppPost) { state.throwNextAppPost = false; return json(res, failure(502, "simulated lost POST acknowledgement")); }
        if (state.dropNextAppId) { state.dropNextAppId = false; const withoutId = structuredClone(app); delete withoutId.id; return json(res, success(withoutId)); }
        return json(res, success(structuredClone(app)));
      }
      if (tail.length === 4 && tail[3] === "policies" && method === "GET") return json(res, success((state.policies.get(tail[2]) ?? []).map((item) => structuredClone(item))));
      if (tail.length === 4 && tail[3] === "policies" && method === "POST") {
        const policy = { id: nextId("access-policy"), ...structuredClone(body), exclude: [], require: [] };
        const list = state.policies.get(tail[2]) ?? []; list.push(policy); state.policies.set(tail[2], list); return json(res, success(structuredClone(policy)));
      }
    }
    return json(res, failure(404, `${method} ${url.pathname}`));
  } catch (error) { return json(res, failure(500, error instanceof Error ? error.message : String(error))); }
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address(); assert(address && typeof address === "object");
const apiBase = `http://127.0.0.1:${address.port}/client/v4`;
const stateDir = await mkdtemp(join(tmpdir(), "eliotr-mcp-apply-"));
function usageSnapshot() {
  const metrics = { workers_requests: 100, workers_cpu_ms: 100, d1_storage_bytes: 100, d1_rows_read: 100, d1_rows_written: 100, r2_storage_gb_month: 1, r2_class_a_ops: 100, r2_class_b_ops: 100, queue_ops: 100, do_requests: 100, do_gb_seconds: 100, do_sql_reads: 100, do_sql_writes: 100, do_storage_bytes: 100, workers_ai_neurons_per_day: 100, ai_search_instances: 5, ai_search_queries_month: 100, vectorize_queried_dims_month: 100, vectorize_stored_dims_month: 100 };
  return JSON.stringify({ protocol: "eliotr.cloudflare-usage-snapshot.v1", account_id_digest: digestAccountId(account), account_ref: "cloudflare-account:mcp-apply…ount", collected_at: new Date(Date.now() - 60_000).toISOString(), window: { kind: "monthly", start: new Date(Date.now() - 86_400_000).toISOString(), end: new Date(Date.now() + 86_400_000).toISOString() }, daily_window: { kind: "daily", start: new Date(Date.now() - 86_400_000).toISOString(), end: new Date(Date.now() + 86_400_000).toISOString() }, source: "test-fixture", readback: { whoami_verified: true }, metrics });
}
async function run(profile = "service-token", extra = {}) {
  await rm(join(stateDir, "cloudflare-access-receipt.json"), { force: true });
  const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: "mock-token", CLOUDFLARE_API_BASE_URL: apiBase, ELIOTR_ACCESS_HOSTNAME: hostname, ELIOTR_OWNER_EMAILS: owner, ELIOTR_ENVIRONMENT: "staging", ELIOTR_DEPLOYMENT_GENERATION: "mcp-test", ELIOTR_CUSTOM_DOMAIN: "1", ELIOTR_STATE_DIRECTORY: stateDir, ELIOTR_ACCESS_TEAM_DOMAIN: team, ELIOTR_ACCESS_AUDIENCE: "ordinary-aud", ELIOTR_GOOGLE_EXTERNAL_TRANSPORT: "gemini-mcp", ELIOTR_MCP_ACCESS_AUTH_PROFILE: profile, ...(profile === "service-token" ? { ELIOTR_MCP_ACCESS_SERVICE_TOKEN_ID: tokenId, ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: clientId } : {}), ELIOTR_TEST_SPAWN_SNAPSHOT_JSON: usageSnapshot(), NODE_OPTIONS: "" };
  Object.assign(env, extra);
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ["--import", pathToFileURL(resolve(root, "scripts/test-usage-gate-shim.mjs")).href, resolve(root, "scripts/provision-cloudflare-access.mjs")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status, signal) => resolveRun({ status, signal, stdout, stderr }));
  });
}
function pass(result, label) { assert.equal(result.status, 0, `${label}\n${result.stdout}\n${result.stderr}`); }
function fail(result, label) { assert.notEqual(result.status, 0, `${label} unexpectedly passed`); }
function appPosts() { return state.mutations.filter((item) => item.pathname.endsWith("/access/apps")); }

try {
  reset(); state.serviceTokens.set(tokenId, { id: tokenId, client_id: clientId });
  let result = await run(); pass(result, "service-token apply");
  let receipt = JSON.parse(await readFile(join(stateDir, "cloudflare-access-receipt.json"), "utf8"));
  assert.equal(receipt.mcp.policy.decision, "non_identity"); assert.equal(receipt.mcp.aud, "mcp-aud"); assert.equal(appPosts().length, 2);
  const mcpPost = appPosts().find((item) => item.body.domain === `${hostname}/mcp`); assert(mcpPost); assert.equal(mcpPost.body.path_cookie_attribute, true); assert.equal(mcpPost.body.policies[0].decision, "non_identity"); assert.deepEqual(mcpPost.body.policies[0].include, [{ service_token: { token_id: tokenId } }]);

  reset(); result = await run("managed-oauth"); pass(result, "managed-oauth apply"); receipt = JSON.parse(await readFile(join(stateDir, "cloudflare-access-receipt.json"), "utf8"));
  assert.equal(receipt.mcp.auth_profile, "managed-oauth"); assert.equal(receipt.mcp.policy.decision, "allow"); assert.equal(receipt.mcp.oauth_configuration_enabled, true); assert.equal(appPosts().find((item) => item.body.domain === `${hostname}/mcp`).body.oauth_configuration.enabled, true);

  reset(); state.serviceTokens.set(tokenId, { id: tokenId, client_id: clientId }); result = await run("service-token", { ELIOTR_MCP_ACCESS_AUDIENCE: "wrong-aud" }); fail(result, "mismatching MCP AUD"); assert.equal(appPosts().length, 2); assert.match(result.stderr, /created application readback/u);

  reset(); state.serviceTokens.set(tokenId, { id: tokenId, client_id: clientId }); state.omitMcpAud = true; result = await run(); fail(result, "unknown MCP AUD"); assert.match(result.stderr, /dedicated AUD/u);

  reset(); state.apps.set("existing-mcp", { id: "existing-mcp", name: "Eliot Research MCP: research.example.test/mcp", type: "self_hosted", domain: `${hostname}/wrong`, destinations: [{ type: "public", uri: `${hostname}/wrong` }], session_duration: "24h", app_launcher_visible: false, path_cookie_attribute: true }); state.policies.set("existing-mcp", []); state.serviceTokens.set(tokenId, { id: tokenId, client_id: clientId }); result = await run(); fail(result, "MCP contour drift"); assert.equal(appPosts().length, 0); assert.match(result.stderr, /application drift/u);

  reset(); state.serviceTokens.set(tokenId, { id: tokenId, client_id: clientId }); state.throwNextAppPost = true; result = await run(); pass(result, "owner lost-ACK reconciliation"); assert.equal(appPosts().length, 2); assert.equal([...state.apps.values()].filter((app) => app.name === `Eliot Research: ${hostname}`).length, 1);

  reset(); result = await run("managed-oauth", { ELIOTR_MCP_ACCESS_SERVICE_TOKEN_ID: tokenId }); fail(result, "managed token input refusal"); assert.equal(state.mutations.length, 0);
  reset(); result = await run("service-token", { ELIOTR_GOOGLE_EXTERNAL_TRANSPORT: undefined }); fail(result, "implicit owner-only receipt refusal"); assert.equal(state.mutations.length, 0);
  reset(); result = await run("managed-oauth", { ELIOTR_GOOGLE_EXTERNAL_TRANSPORT: "drive-exchange" }); fail(result, "canonical transport mismatch"); assert.equal(state.mutations.length, 0);
  console.log("Cloudflare MCP Access apply fixtures: PASS");
  console.log("- service-token and managed-oauth apply/readback: PASS");
  console.log("- unknown and mismatching AUD: REJECTED after fresh readback");
  console.log("- MCP contour drift and managed token inputs: REJECTED before mutation");
  console.log("- owner lost-ACK: reconciled with one inventory read and no duplicate POST");
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(stateDir, { recursive: true, force: true });
}
