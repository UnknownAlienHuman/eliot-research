import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { readConfiguredTransport } from "./check-launch-code.mjs";
import { createCloudflareMcpTransport } from "./lib/cloudflare-mcp-oauth.mjs";
import { readActiveDeploymentIdentity, selectDeploymentGoogleTransport } from "./lib/deployment-maintenance.mjs";

const ACCOUNT_ID = "00000000000000000000000000000000";
const MCP_URL = "https://mcp.cloudflare.com/mcp";

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.calls = [];
    this.killCount = 0;
    this.rpcError = null;
    this.stdin = {
      write: (line) => {
        const message = JSON.parse(line);
        this.calls.push(message);
        if (message.id === undefined) return true;
        if (this.rpcError?.method === message.method) {
          process.nextTick(() => this.stdout.emit("data", `${JSON.stringify({
            jsonrpc: "2.0", id: message.id, error: this.rpcError.error,
          })}\n`));
          return true;
        }
        const result = this.#result(message);
        process.nextTick(() => this.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`));
        return true;
      },
    };
  }

  #result(message) {
    if (message.method === "initialize") return { protocolVersion: "2025-06-18" };
    if (message.method === "thread/start") return { thread: { id: "volatile-thread-test" } };
    if (message.method === "mcpServer/tool/call") {
      const code = message.params?.arguments?.code;
      assert.match(code, /^async \(\) => cloudflare\.request\(/u);
      assert.doesNotMatch(code, /CLOUDFLARE_API_TOKEN|bearer|Authorization/iu);
      const request = JSON.parse(code.slice("async () => cloudflare.request(".length, -1));
      const scripts = `/accounts/${ACCOUNT_ID}/workers/scripts`;
      const versionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const workerResults = {
        [scripts]: [{ id: "eliotr-core", compatibility_date: "2026-08-28", has_assets: true }],
        [`${scripts}/eliotr-core/deployments`]: { deployments: [{
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", created_on: "2026-10-03T12:00:00Z", strategy: "percentage",
          versions: [{ version_id: versionId, percentage: 100 }],
        }] },
        [`${scripts}/eliotr-core/versions/${versionId}`]: { id: versionId, number: 9, resources: {
          script_runtime: { compatibility_date: "2026-08-28" }, bindings: [
            { name: "DEPLOYMENT_GENERATION", type: "plain_text", text: "git-existing" },
            { name: "GOOGLE_EXTERNAL_TRANSPORT", type: "plain_text", text: this.workerGoogleTransport },
          ],
        } },
      };
      if (Object.hasOwn(workerResults, request.path)) {
        return { content: [{ type: "text", text: JSON.stringify({ status: this.workerStatus ?? 200,
          success: true, errors: this.workerErrors ?? [], result: workerResults[request.path] }) }] };
      }
      if (request.path === `/accounts/${ACCOUNT_ID}`) {
        return { content: [{ type: "text", text: JSON.stringify({ status: 200, success: true, result: { id: ACCOUNT_ID } }) }] };
      }
      if (request.path === `/accounts/${ACCOUNT_ID}/access/apps?per_page=100`) {
        return { content: [{ type: "text", text: JSON.stringify({ status: 200, success: true, result: [], result_info: { page: 1, per_page: 100, count: 0, total_count: 0, total_pages: 0 } }) }] };
      }
      if ((request.method === "POST" && request.path === `/accounts/${ACCOUNT_ID}/access/apps/app-test/policies`) ||
          (request.method === "GET" && request.path === `/accounts/${ACCOUNT_ID}/access/apps/app-test/policies?per_page=100`)) {
        if (request.method === "POST") return { content: [{ type: "text", text: JSON.stringify({ status: 200, success: true, result: { id: "policy-test" } }) }] };
        const result = Array.from({ length: 100 }, (_, index) => ({ id: `policy-${index + 1}` }));
        return { content: [{ type: "text", text: JSON.stringify({ status: 200, success: true, result, result_info: { page: 1, per_page: 100, count: 100, total_count: 101, total_pages: 2 } }) }] };
      }
      if (request.path === `/accounts/${ACCOUNT_ID}/access/apps/app-test/policies?page=2&per_page=100`) {
        return { content: [{ type: "text", text: JSON.stringify({ status: 200, success: true, result: [{ id: "policy-101" }], result_info: { page: 2, per_page: 100, count: 1, total_count: 101, total_pages: 2 } }) }] };
      }
      if (request.path === `/accounts/${ACCOUNT_ID}/access/apps/app-error/policies`) {
        return { isError: true, content: [{ type: "text", text: "this must not be parsed" }] };
      }
      if ((request.path === `/accounts/${ACCOUNT_ID}/access/apps/app-bad/policies` || request.path === `/accounts/${ACCOUNT_ID}/access/apps/app-bad/policies?per_page=100`) && request.method === "GET") {
        return { content: [{ type: "text", text: JSON.stringify({ status: 200, success: true, result: [], result_info: { page: 1, per_page: 100, count: 0, total_count: 0, total_pages: 2 } }) }] };
      }
      if (request.path === `/accounts/${ACCOUNT_ID}/access/apps/app-duplicate/policies` || request.path === `/accounts/${ACCOUNT_ID}/access/apps/app-duplicate/policies?per_page=100`) {
        return { content: [{ type: "text", text: JSON.stringify({ status: 200, success: true, result: [{ id: "duplicate" }, { id: "duplicate" }], result_info: { page: 1, per_page: 100, count: 2, total_count: 2, total_pages: 1 } }) }] };
      }
      assert.equal(request.path, `/accounts/${ACCOUNT_ID}/access/organizations`);
      return { content: [{ type: "text", text: JSON.stringify({ status: 200, success: true, result: [{ auth_domain: "test.cloudflareaccess.com" }] }) }] };
    }
    throw new Error(`unexpected method ${message.method}`);
  }

  kill() {
    this.killCount += 1;
    this.emit("close");
  }
}

const fake = new FakeProcess();
const transportOptions = {
  cwd: resolve("."),
  accountId: ACCOUNT_ID,
  runCli: (args, cliOptions) => {
    assert.deepEqual(cliOptions.env.CLOUDFLARE_API_TOKEN, undefined);
    assert.deepEqual(cliOptions.env.CF_API_TOKEN, undefined);
    if (args[1] === "get") {
      return { status: 0, stdout: JSON.stringify({
        name: "cloudflare-api",
        enabled: true,
        transport: {
          type: "streamable_http",
          url: MCP_URL,
          bearer_token_env_var: null,
          http_headers: null,
          env_http_headers: null,
          http_headers_helper: null,
        },
      }) };
    }
    assert.deepEqual(args, ["mcp", "list", "--json"]);
    return { status: 0, stdout: JSON.stringify([{ name: "cloudflare-api", enabled: true, transport: {
      type: "streamable_http",
      url: MCP_URL,
      bearer_token_env_var: null,
      http_headers: null,
      env_http_headers: null,
      http_headers_helper: null,
    }, auth_status: "o_auth" }]) };
  },
  spawnProcess: (command, args, spawnOptions) => {
    assert.equal(command, process.platform === "win32" ? "codex.exe" : "codex");
    assert.deepEqual(args, ["app-server", "--listen", "stdio://"]);
    assert.equal(spawnOptions.env.CLOUDFLARE_API_TOKEN, undefined);
    assert.equal(spawnOptions.windowsHide, true);
    assert.equal(spawnOptions.shell, false);
    return fake;
  },
  env: { PATH: process.env.PATH ?? "" },
};
const transport = createCloudflareMcpTransport(transportOptions);
await transport.verifyAccount();
assert.deepEqual(await transport.request("GET", `/accounts/${ACCOUNT_ID}/access/organizations`), [{ auth_domain: "test.cloudflareaccess.com" }]);
assert.deepEqual(await transport.request("GET", `/accounts/${ACCOUNT_ID}/access/apps?per_page=100`), []);
assert.deepEqual(await transport.request("POST", `/accounts/${ACCOUNT_ID}/access/apps/app-test/policies`, { name: "owner", decision: "allow", include: [] }), { id: "policy-test" });
assert.equal((await transport.request("GET", `/accounts/${ACCOUNT_ID}/access/apps/app-test/policies`)).length, 101);
await assert.rejects(
  () => transport.request("POST", `/accounts/${ACCOUNT_ID}/access/apps/app-error/policies`, { name: "owner", decision: "allow", include: [] }),
  (error) => error?.code === "MCP_PROTOCOL_ERROR",
);
await assert.rejects(
  () => transport.request("GET", `/accounts/${ACCOUNT_ID}/access/apps/app-bad/policies`),
  (error) => error?.code === "MCP_PROTOCOL_INVALID",
);
await assert.rejects(
  () => transport.request("GET", `/accounts/${ACCOUNT_ID}/access/apps/app-duplicate/policies`),
  (error) => error?.code === "MCP_PROTOCOL_INVALID",
);
await assert.rejects(
  () => transport.request("GET", `/accounts/${ACCOUNT_ID}/access/apps?per_page=10`),
  (error) => error?.code === "MCP_REQUEST_INVALID",
);
await assert.rejects(
  () => transport.request("POST", `/accounts/${ACCOUNT_ID}/access/apps`, { arbitrary: true }),
  (error) => error?.code === "MCP_REQUEST_INVALID",
);
transport.close();
assert.equal(fake.killCount, 1, "closing the transport must terminate its app-server child");
assert.deepEqual(fake.calls.map((call) => call.method), [
  "initialize",
  "initialized",
  "thread/start",
  "mcpServer/tool/call",
  "mcpServer/tool/call",
  "mcpServer/tool/call",
  "mcpServer/tool/call",
  "mcpServer/tool/call",
  "mcpServer/tool/call",
  "mcpServer/tool/call",
  "mcpServer/tool/call",
  "mcpServer/tool/call",
]);
assert.equal(fake.calls[11]?.params?.server, "cloudflare-api");
assert.equal(fake.calls[11]?.params?.tool, "execute");
assert.throws(
  () => createCloudflareMcpTransport({ cwd: resolve("."), accountId: ACCOUNT_ID, env: { CLOUDFLARE_API_TOKEN: "redacted" } }),
  (error) => error?.code === "MCP_AUTH_UNAVAILABLE",
);
const rpcFailureFake = new FakeProcess();
rpcFailureFake.rpcError = {
  method: "mcpServer/tool/call",
  error: {
    code: -32042,
    message: "private-native-error-message-must-not-leak",
    data: { bearer: "private-native-error-data-must-not-leak" },
  },
};
const rpcFailureTransport = createCloudflareMcpTransport({
  ...transportOptions,
  spawnProcess: () => rpcFailureFake,
});
let rpcFailure;
try {
  await rpcFailureTransport.verifyAccount();
  assert.fail("JSON-RPC tool-call errors must fail the Access readback");
} catch (error) {
  rpcFailure = error;
} finally {
  rpcFailureTransport.close();
}
assert.equal(rpcFailure?.code, "MCP_PROTOCOL_ERROR");
assert.equal(rpcFailure?.rpcMethod, "mcpServer/tool/call");
assert.equal(rpcFailure?.rpcErrorCode, -32042);
assert.match(rpcFailure?.message ?? "", /MCP tool call \(mcpServer\/tool\/call\).*JSON-RPC code -32042/u);
assert.doesNotMatch(rpcFailure?.message ?? "", /private-native-error-message|private-native-error-data|bearer/iu);
assert.equal(rpcFailureFake.killCount, 1);
const invalidRpcCodeFake = new FakeProcess();
invalidRpcCodeFake.rpcError = {
  method: "thread/start",
  error: { code: "not-numeric", message: "private-invalid-code-message", data: "private-data" },
};
const invalidRpcCodeTransport = createCloudflareMcpTransport({
  ...transportOptions,
  spawnProcess: () => invalidRpcCodeFake,
});
let invalidRpcCodeFailure;
try {
  await invalidRpcCodeTransport.verifyAccount();
  assert.fail("malformed JSON-RPC error codes must fail the Access readback");
} catch (error) {
  invalidRpcCodeFailure = error;
} finally {
  invalidRpcCodeTransport.close();
}
assert.equal(invalidRpcCodeFailure?.code, "MCP_PROTOCOL_ERROR");
assert.equal(invalidRpcCodeFailure?.rpcMethod, "thread/start");
assert.equal(invalidRpcCodeFailure?.rpcErrorCode, null);
assert.match(invalidRpcCodeFailure?.message ?? "", /thread start \(thread\/start\).*non-safe numeric error code/u);
assert.doesNotMatch(invalidRpcCodeFailure?.message ?? "", /private-invalid-code-message|private-data/iu);
assert.equal(invalidRpcCodeFake.killCount, 1);
// Run the actual Access provisioner's preservation/dispatch source with the real
// bounded MCP protocol transport, no token, and a raw-fetch refusal sentinel.
const root = fileURLToPath(new URL("../", import.meta.url));
const source = (await readFile(resolve(root, "scripts/provision-cloudflare-access.mjs"), "utf8")).replace(/\r\n/gu, "\n");
const selectionStart = source.indexOf("const configuredGoogleTransport =");
const selectionEnd = source.indexOf("const mcpEnabled =", selectionStart);
const requestStart = source.indexOf("async function request(");
const requestEnd = source.indexOf("\n}\n", requestStart);
assert.ok(selectionStart >= 0 && selectionEnd > selectionStart && requestStart >= 0 && requestEnd > requestStart);
const maintenanceFake = new FakeProcess();
const maintenanceTransport = createCloudflareMcpTransport({ ...transportOptions, spawnProcess: () => maintenanceFake });
const rawFetch = () => assert.fail("MCP preservation must never use raw fetch");
try {
  for (const verifyExisting of [false, true]) {
    const request = runInNewContext(`(${source.slice(requestStart, requestEnd + 2)})`, {
      verifyExisting, mcpTransport: maintenanceTransport, fetch: rawFetch,
    });
    const selection = runInNewContext(`(async () => { ${source.slice(selectionStart, selectionEnd)}
      return { googleTransport, activeTransport }; })`, {
      process: { env: {} }, token: undefined, accountId: ACCOUNT_ID,
      apiBase: "https://api.cloudflare.com/client/v4", mcpTransport: maintenanceTransport, request,
      repositoryRoot: root, readFile, resolve, readConfiguredTransport, selectDeploymentGoogleTransport,
      preserveGoogleTransport: "disabled",
      readActiveDeploymentIdentity: (options) => readActiveDeploymentIdentity({ ...options, fetchImpl: rawFetch }),
      checkOnly: !verifyExisting, verifyExisting,
    });
    maintenanceFake.workerGoogleTransport = "disabled";
    const preserved = await selection();
    assert.equal(preserved.googleTransport, "disabled");
    assert.equal(preserved.activeTransport.generation, "git-existing");
    for (const observed of [undefined, "unknown", "gemini-mcp"]) {
      maintenanceFake.workerGoogleTransport = observed;
      await assert.rejects(selection(), /freshly verified disabled/u);
    }
    maintenanceFake.workerGoogleTransport = "disabled";
    maintenanceFake.workerStatus = 201;
    await assert.rejects(selection(), (error) => error.code === "MCP_REQUEST_FAILED");
    maintenanceFake.workerStatus = 200;
    maintenanceFake.workerErrors = [{ code: 10000, message: "private-provider-diagnostic" }];
    await assert.rejects(selection(), (error) => error.code === "MCP_REQUEST_FAILED" &&
      !error.message.includes("private-provider-diagnostic"));
    maintenanceFake.workerErrors = [];
  }
  const beforeRefusals = maintenanceFake.calls.length;
  for (const [method, path, body] of [
    ["POST", `/accounts/${ACCOUNT_ID}/workers/scripts`],
    ["GET", `/accounts/${ACCOUNT_ID}/workers/scripts/another-worker/deployments`],
    ["GET", `/accounts/${ACCOUNT_ID}/workers/scripts/eliotr-core/versions/not-a-uuid`],
    ["GET", `/accounts/${ACCOUNT_ID}/workers/scripts?arbitrary=true`],
    ["GET", `/accounts/${"1".repeat(32)}/workers/scripts`],
    ["GET", `/accounts/${ACCOUNT_ID}/workers/scripts`, {}],
  ]) await assert.rejects(maintenanceTransport.request(method, path, body), (error) => error.code === "MCP_REQUEST_INVALID");
  assert.equal(maintenanceFake.calls.length, beforeRefusals, "out-of-scope Worker reads reached MCP");
  const requests = maintenanceFake.calls.filter((call) => call.method === "mcpServer/tool/call")
    .map((call) => JSON.parse(call.params.arguments.code.slice("async () => cloudflare.request(".length, -1)));
  assert.ok(requests.length >= 6);
  assert.ok(requests.every((request) => request.method === "GET" && request.body === undefined &&
    request.path.startsWith(`/accounts/${ACCOUNT_ID}/workers/scripts`)));
  console.log("Cloudflare MCP + preserve disabled: check-only/verify-existing PASS; tokenless GET-only, fail-closed negatives PASS");
} finally {
  maintenanceTransport.close();
}
assert.equal(maintenanceFake.killCount, 1);
console.log("Cloudflare official MCP OAuth protocol fixture: PASS");
