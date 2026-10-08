import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { createCloudflareMcpTransport } from "./lib/cloudflare-mcp-oauth.mjs";
import { captureMaintenanceAiGateways, requireSameMaintenanceAiGateways } from "./lib/deployment-ai-gateways.mjs";

const ACCOUNT_ID = "00000000000000000000000000000000";
const MCP_URL = "https://mcp.cloudflare.com/mcp";
const cwd = resolve(".");
const env = {
  PATH: process.env.PATH ?? "",
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  ELIOTR_CLOUDFLARE_AUTH_MODE: "wrangler-oauth",
  ELIOTR_CLOUDFLARE_MCP_CWD: cwd,
  CLOUDFLARE_API_TOKEN: "oauth-bearer-is-scrubbed-before-mcp",
};
const input = { apiBase: "https://api.cloudflare.com/client/v4" };
const activeWorkerIdentity = {
  worker_id: "eliotr-core",
  ai_gateway_urls: {
    reasoning: `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/eliotr-reasoning`,
    retrieval: `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/eliotr-retrieval`,
  },
};
const disabled = { disabled_slices: ["RETRIEVAL", "ERASURE"], enabled_slices: [], partial_slices: [] };

function gateway(id, overrides = {}) {
  return {
    id,
    cache_invalidate_on_update: false,
    cache_ttl: 0,
    collect_logs: false,
    rate_limiting_interval: 0,
    rate_limiting_limit: 0,
    authentication: true,
    opaque_metadata: "ignored by the stable settings projection",
    ...overrides,
  };
}

function mcpConfiguration(args, options) {
  assert.equal(options.env.CLOUDFLARE_API_TOKEN, undefined, "OAuth bearer must be scrubbed from MCP children");
  assert.equal(options.env.CF_API_TOKEN, undefined);
  if (args[1] === "get") return { status: 0, stdout: JSON.stringify({
    name: "cloudflare-api", enabled: true, transport: {
      type: "streamable_http", url: MCP_URL, bearer_token_env_var: null,
      http_headers: null, env_http_headers: null, http_headers_helper: null,
    },
  }) };
  assert.deepEqual(args, ["mcp", "list", "--json"]);
  return { status: 0, stdout: JSON.stringify([{ name: "cloudflare-api", enabled: true, auth_status: "o_auth",
    transport: { type: "streamable_http", url: MCP_URL, bearer_token_env_var: null,
      http_headers: null, env_http_headers: null, http_headers_helper: null } }]) };
}

class FakeProcess extends EventEmitter {
  constructor(envelopeForRequest) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.calls = [];
    this.killCount = 0;
    this.stdin = { write: (line) => {
      const message = JSON.parse(line);
      this.calls.push(message);
      if (message.id === undefined) return true;
      let result;
      if (message.method === "initialize") result = { protocolVersion: "2025-06-18" };
      else if (message.method === "thread/start") result = { thread: { id: "gateway-readback-test" } };
      else if (message.method === "mcpServer/tool/call") {
        const code = message.params?.arguments?.code;
        assert.match(code, /^async \(\) => cloudflare\.request\(/u);
        assert.doesNotMatch(code, /CLOUDFLARE_API_TOKEN|bearer|Authorization/iu);
        const request = JSON.parse(code.slice("async () => cloudflare.request(".length, -1));
        result = { content: [{ type: "text", text: JSON.stringify(envelopeForRequest(request)) }] };
      } else throw new Error(`unexpected app-server method ${message.method}`);
      process.nextTick(() => this.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`));
      return true;
    } };
  }

  kill() {
    this.killCount += 1;
    this.emit("close");
  }
}

function createTransport(inventory, options = {}) {
  const fake = new FakeProcess((request) => {
    const pageMatch = request.path.match(/\?page=([0-9]+)&per_page=100$/u);
    const page = pageMatch === null ? 1 : Number(pageMatch[1]);
    const start = (page - 1) * 100;
    const result = inventory.slice(start, start + 100);
    const resultInfo = { page, per_page: 100, count: result.length, total_count: inventory.length };
    if (options.totalPages !== undefined) resultInfo.total_pages = options.totalPages;
    return { status: options.status ?? 200, success: options.success ?? true,
      ...(Object.hasOwn(options, "errors") ? { errors: options.errors } : {}), result, result_info: resultInfo };
  });
  const seen = [];
  const transport = createCloudflareMcpTransport({
    cwd,
    accountId: ACCOUNT_ID,
    resourceReadback: "ai-gateways",
    env: { PATH: env.PATH },
    runCli: mcpConfiguration,
    spawnProcess: (command, args, spawnOptions) => {
      assert.equal(command, process.platform === "win32" ? "codex.exe" : "codex");
      assert.deepEqual(args, ["app-server", "--listen", "stdio://"]);
      assert.equal(spawnOptions.env.CLOUDFLARE_API_TOKEN, undefined);
      assert.equal(spawnOptions.shell, false);
      return fake;
    },
  });
  const observedTransport = {
    request: async (...args) => {
      seen.push(args);
      return transport.request(...args);
    },
    verifyAccount: () => transport.verifyAccount(),
    close: () => transport.close(),
  };
  return { transport: observedTransport, fake, seen };
}

function helperTransport(inventory, options = {}) {
  let closed = 0;
  let received;
  return {
    get closed() { return closed; },
    get received() { return received; },
    createTransport: (settings) => {
      received = settings;
      return {
        request: async (method, path) => {
          assert.equal(method, "GET");
          assert.equal(path, `/accounts/${ACCOUNT_ID}/ai-gateway/gateways?per_page=100`);
          if (options.throwRequest) throw new Error("read denied");
          return typeof inventory === "function" ? inventory() : inventory;
        },
        close: () => { closed += 1; },
      };
    },
  };
}

const baseInventory = [gateway("eliotr-reasoning")];
const mock = helperTransport(baseInventory);
const profile = await captureMaintenanceAiGateways({ env, input, activeWorkerIdentity,
  candidate: disabled, observed: disabled, createTransport: mock.createTransport });
assert.equal(profile.state, "PINNED");
assert.equal(profile.protocol, "eliotr.maintenance-ai-gateway-profile.v1");
assert.equal(profile.account_id, ACCOUNT_ID);
assert.equal(profile.gateways.reasoning.authentication, true);
assert.equal(profile.gateways.retrieval, null);
assert.match(profile.profile_sha256, /^[a-f0-9]{64}$/u);
assert.equal(Object.isFrozen(profile), true);
assert.equal(Object.isFrozen(profile.gateways.reasoning), true);
assert.equal(mock.closed, 1);
assert.equal(mock.received.resourceReadback, "ai-gateways");
assert.equal(mock.received.env.CLOUDFLARE_API_TOKEN, undefined);
assert.equal(mock.received.cwd, cwd);

const same = await requireSameMaintenanceAiGateways({ profile, env, input, activeWorkerIdentity,
  createTransport: helperTransport(baseInventory).createTransport });
assert.deepEqual(same.gateway_presence, { reasoning: "PRESENT", retrieval: "ABSENT" });
assert.equal(same.state, "PASS");

await assert.rejects(() => captureMaintenanceAiGateways({ env, input, activeWorkerIdentity,
  candidate: disabled, observed: disabled, createTransport: helperTransport([]).createTransport }), /reasoning gateway is absent/u);
await assert.rejects(() => captureMaintenanceAiGateways({ env, input, activeWorkerIdentity,
  candidate: disabled, observed: disabled,
  createTransport: helperTransport([gateway("eliotr-reasoning", { authentication: false })]).createTransport }), /unauthenticated/u);
await assert.rejects(() => captureMaintenanceAiGateways({ env, input,
  activeWorkerIdentity: { ...activeWorkerIdentity, ai_gateway_urls: { ...activeWorkerIdentity.ai_gateway_urls,
    retrieval: "https://gateway.ai.cloudflare.com/v1/wrong/eliotr-retrieval" } },
  candidate: disabled, observed: disabled, createTransport: helperTransport(baseInventory).createTransport }), /Worker gateway URLs/u);
await assert.rejects(() => captureMaintenanceAiGateways({ env, input, activeWorkerIdentity,
  candidate: { ...disabled, enabled_slices: ["RETRIEVAL"] }, observed: disabled,
  createTransport: helperTransport(baseInventory).createTransport }), /candidate must keep RETRIEVAL disabled/u);
await assert.rejects(() => captureMaintenanceAiGateways({ env, input, activeWorkerIdentity,
  candidate: disabled, observed: { ...disabled, partial_slices: ["RETRIEVAL"] },
  createTransport: helperTransport(baseInventory).createTransport }), /observed capability profile must keep RETRIEVAL disabled/u);
await assert.rejects(() => captureMaintenanceAiGateways({ env, input, activeWorkerIdentity,
  candidate: disabled, observed: disabled,
  createTransport: helperTransport([gateway("eliotr-reasoning"), gateway("eliotr-reasoning")]).createTransport }), /repeated identity/u);
await assert.rejects(() => captureMaintenanceAiGateways({ env, input, activeWorkerIdentity,
  candidate: disabled, observed: disabled,
  createTransport: helperTransport([gateway("eliotr-reasoning"), gateway("eliotr-unknown")]).createTransport }), /unknown project gateway/u);
await assert.rejects(() => requireSameMaintenanceAiGateways({ profile: { ...profile }, env, input,
  activeWorkerIdentity, createTransport: helperTransport(baseInventory).createTransport }), /not privately branded/u);
await assert.rejects(() => requireSameMaintenanceAiGateways({ profile, env, input, activeWorkerIdentity,
  createTransport: helperTransport([gateway("eliotr-reasoning", { cache_ttl: 1 })]).createTransport }), /settings changed/u);
await assert.rejects(() => requireSameMaintenanceAiGateways({ profile, env, input, activeWorkerIdentity,
  createTransport: helperTransport([gateway("eliotr-reasoning"), gateway("eliotr-retrieval")]).createTransport }), /presence or settings changed/u);

const hundredAndOne = [gateway("eliotr-reasoning"),
  ...Array.from({ length: 99 }, (_, index) => gateway(`other-${String(index + 1).padStart(3, "0")}`)),
  gateway("other-101")];
const paginated = createTransport(hundredAndOne);
assert.equal((await paginated.transport.request("GET",
  `/accounts/${ACCOUNT_ID}/ai-gateway/gateways?per_page=100`)).length, 101,
"gateway inventory must derive complete pagination when total_pages is omitted");
const paginatedPaths = paginated.fake.calls.filter((call) => call.method === "mcpServer/tool/call").map((call) => {
  const code = call.params.arguments.code;
  return JSON.parse(code.slice("async () => cloudflare.request(".length, -1)).path;
});
assert.deepEqual(paginatedPaths, [
  `/accounts/${ACCOUNT_ID}/ai-gateway/gateways?per_page=100`,
  `/accounts/${ACCOUNT_ID}/ai-gateway/gateways?page=2&per_page=100`,
]);
paginated.transport.close();
assert.equal(paginated.fake.killCount, 1);

const forbidden = createTransport(baseInventory);
await assert.rejects(() => forbidden.transport.request("GET", `/accounts/${ACCOUNT_ID}/ai-gateway/gateways?page=2&per_page=100`), /AI Gateway inventory reads must begin at page one/u);
await assert.rejects(() => forbidden.transport.request("GET", `/accounts/${ACCOUNT_ID}/access/apps?per_page=100`), /fixed AI Gateway readback/u);
await assert.rejects(() => forbidden.transport.request("GET", `/accounts/${"1".repeat(32)}/ai-gateway/gateways?per_page=100`), /fixed AI Gateway readback/u);
await assert.rejects(() => forbidden.transport.request("POST", `/accounts/${ACCOUNT_ID}/ai-gateway/gateways?per_page=100`), /fixed AI Gateway readback/u);
await assert.rejects(() => forbidden.transport.request("GET", `/accounts/${ACCOUNT_ID}/ai-gateway/gateways?per_page=100`, {}), /fixed AI Gateway readback/u);
await assert.rejects(() => forbidden.transport.verifyAccount(), /verifies scope through its exact account list path/u);
forbidden.transport.close();

for (const options of [{ status: 201 }, { errors: ["denied"] }, { errors: null }]) {
  const badResponse = createTransport(baseInventory, options);
  await assert.rejects(() => badResponse.transport.request("GET",
    `/accounts/${ACCOUNT_ID}/ai-gateway/gateways?per_page=100`), /failed \(\d+\)/u);
  badResponse.transport.close();
}

const badTotalPages = createTransport(baseInventory, { totalPages: 2 });
await assert.rejects(() => badTotalPages.transport.request("GET",
  `/accounts/${ACCOUNT_ID}/ai-gateway/gateways?per_page=100`), /pagination is incomplete/u);
badTotalPages.transport.close();

console.log("Maintenance AI Gateway preservation fixtures: PASS");
