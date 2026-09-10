import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { createCloudflareMcpTransport } from "./lib/cloudflare-mcp-oauth.mjs";

const ACCOUNT_ID = "00000000000000000000000000000000";
const MCP_URL = "https://mcp.cloudflare.com/mcp";

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.calls = [];
    this.killCount = 0;
    this.stdin = {
      write: (line) => {
        const message = JSON.parse(line);
        this.calls.push(message);
        if (message.id === undefined) return true;
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
const transport = createCloudflareMcpTransport({
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
});
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
console.log("Cloudflare official MCP OAuth protocol fixture: PASS");
