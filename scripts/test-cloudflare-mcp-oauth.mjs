import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { createCloudflareMcpTransport } from "./lib/cloudflare-mcp-oauth.mjs";

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.calls = [];
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
    if (message.method === "mcpServerStatus/list") return { servers: [{ name: "cloudflare-api", authStatus: "oAuth" }] };
    if (message.method === "thread/start") return { thread: { id: "volatile-thread-test" } };
    if (message.method === "mcpServer/tool/call") {
      const code = message.params?.arguments?.code;
      assert.match(code, /^async \(\) => cloudflare\.request\(/u);
      assert.doesNotMatch(code, /CLOUDFLARE_API_TOKEN|bearer|Authorization/iu);
      const request = JSON.parse(code.slice("async () => cloudflare.request(".length, -1));
      if (request.path === "/accounts/account-test") {
        return { content: [{ type: "text", text: JSON.stringify({ status: 200, success: true, result: { id: "account-test" } }) }] };
      }
      assert.equal(request.path, "/accounts/account-test/access/organizations");
      return { content: [{ type: "text", text: JSON.stringify({ status: 200, success: true, result: [{ auth_domain: "test.cloudflareaccess.com" }], result_info: { page: 1, total_pages: 1 } }) }] };
    }
    throw new Error(`unexpected method ${message.method}`);
  }

  kill() {
    this.emit("close");
  }
}

const fake = new FakeProcess();
const transport = createCloudflareMcpTransport({
  cwd: resolve("."),
  accountId: "account-test",
  spawnProcess: (command, args, spawnOptions) => {
    assert.equal(command, "codex");
    assert.deepEqual(args, ["app-server", "--listen", "stdio://"]);
    assert.equal(spawnOptions.env.CLOUDFLARE_API_TOKEN, undefined);
    assert.equal(spawnOptions.windowsHide, true);
    return fake;
  },
  env: { PATH: process.env.PATH ?? "" },
});
await transport.verifyAccount();
assert.deepEqual(await transport.request("GET", "/accounts/account-test/access/organizations"), [{ auth_domain: "test.cloudflareaccess.com" }]);
await assert.rejects(
  () => transport.request("GET", "/accounts/account-test/access/apps?per_page=10"),
  (error) => error?.code === "MCP_REQUEST_INVALID",
);
await assert.rejects(
  () => transport.request("POST", "/accounts/account-test/access/apps", { arbitrary: true }),
  (error) => error?.code === "MCP_REQUEST_INVALID",
);
transport.close();
assert.deepEqual(fake.calls.map((call) => call.method), [
  "initialize",
  "initialized",
  "mcpServerStatus/list",
  "thread/start",
  "mcpServer/tool/call",
  "mcpServer/tool/call",
]);
assert.equal(fake.calls[5]?.params?.server, "cloudflare-api");
assert.equal(fake.calls[5]?.params?.tool, "execute");
console.log("Cloudflare official MCP OAuth protocol fixture: PASS");
