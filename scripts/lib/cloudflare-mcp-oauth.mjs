// Narrow official Cloudflare MCP OAuth transport for Access readbacks.
//
// The MCP connection is managed by Codex. This module never reads, prints,
// exports, or persists an OAuth credential. It starts a volatile app-server
// tool context in an explicitly supplied local project directory and permits
// only the fixed account/Access requests used by the Access provisioner.

import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { scrubTokenEnv } from "./cloudflare-wrangler-oauth.mjs";

export const CLOUDFLARE_MCP_TRANSPORT = "cloudflare-mcp";
const SERVER = "cloudflare-api";
const TOOL = "execute";
const SERVER_URL = "https://mcp.cloudflare.com/mcp";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_LINE_BYTES = 512 * 1024;

export class CloudflareMcpOAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CloudflareMcpOAuthError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new CloudflareMcpOAuthError(code, message);
}

function checkCwd(value) {
  if (typeof value !== "string" || value.trim() === "" || !isAbsolute(value)) {
    fail("MCP_CWD_INVALID", "ELIOTR_CLOUDFLARE_MCP_CWD must be an absolute local project directory");
  }
  return value.trim();
}

function checkAccountId(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/u.test(value)) {
    fail("MCP_ACCOUNT_INVALID", "CLOUDFLARE_ACCOUNT_ID is invalid");
  }
  return value;
}

function checkTimeout(value) {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 120_000) {
    fail("MCP_TIMEOUT_INVALID", "Cloudflare MCP timeout is outside its bounded range");
  }
  return timeout;
}

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key))) {
    fail("MCP_REQUEST_INVALID", `${label} has an unsupported shape`);
  }
}

function appIdFromPath(path, accountSegment) {
  const match = path.match(new RegExp(`^/accounts/${accountSegment}/access/apps/([^/]+)/policies$`, "u"));
  if (match === null || match[1] === undefined || match[1].length === 0 || match[1].length > 128) {
    return null;
  }
  return match[1];
}

function checkKnownRequest(accountId, method, path, body) {
  if (typeof method !== "string" || (method !== "GET" && method !== "POST") ||
      typeof path !== "string" || path.length > 512 || !path.startsWith("/accounts/")) {
    fail("MCP_REQUEST_INVALID", "Cloudflare MCP request is outside the fixed Access transport");
  }
  const accountSegment = encodeURIComponent(accountId);
  const accountPath = `/accounts/${accountSegment}`;
  const appPath = `${accountPath}/access/apps`;
  if (method === "GET" && path === accountPath) {
    if (body !== undefined) fail("MCP_REQUEST_INVALID", "account read cannot carry a body");
    return;
  }
  if (method === "GET" && path === `${accountPath}/access/organizations`) {
    if (body !== undefined) fail("MCP_REQUEST_INVALID", "organization read cannot carry a body");
    return;
  }
  if (method === "GET" && path === `${appPath}?per_page=100`) {
    if (body !== undefined) fail("MCP_REQUEST_INVALID", "application list cannot carry a body");
    return;
  }
  const appId = appIdFromPath(path, accountSegment);
  if (method === "GET" && appId !== null) {
    if (body !== undefined) fail("MCP_REQUEST_INVALID", "policy read cannot carry a body");
    return;
  }
  if (method === "POST" && path === appPath) {
    exactKeys(body, ["type", "name", "domain", "destinations", "session_duration", "app_launcher_visible", "policies"], "Access application request");
    return;
  }
  if (method === "POST" && appId !== null) {
    exactKeys(body, ["name", "decision", "include"], "Access policy request");
    return;
  }
  fail("MCP_REQUEST_INVALID", "Cloudflare MCP request is outside the fixed Access transport");
}

function jsonRpcError(error) {
  const message = error?.message;
  return message === undefined ? "Cloudflare MCP protocol error" : "Cloudflare MCP protocol request failed";
}

function configuredTransportIsSafe(transport) {
  return transport !== null && typeof transport === "object" && !Array.isArray(transport) &&
    transport.type === "streamable_http" && transport.url === SERVER_URL &&
    transport.bearer_token_env_var == null && transport.http_headers == null &&
    transport.env_http_headers == null && transport.http_headers_helper == null &&
    transport.env_vars == null;
}

function requireConfiguredOAuth(getValue, listValue) {
  if (getValue === null || typeof getValue !== "object" || Array.isArray(getValue) ||
      getValue.name !== SERVER || getValue.enabled !== true || !configuredTransportIsSafe(getValue.transport)) {
    fail("MCP_AUTH_UNAVAILABLE", "Cloudflare MCP OAuth server configuration is unavailable");
  }
  if (!Array.isArray(listValue) || listValue.length > 100) {
    fail("MCP_PROTOCOL_INVALID", "Cloudflare MCP server list is malformed");
  }
  const server = listValue.find((item) => item !== null && typeof item === "object" &&
    !Array.isArray(item) && item.name === SERVER);
  if (server === undefined || server.enabled !== true || !configuredTransportIsSafe(server.transport) ||
      server.auth_status !== "o_auth") {
    fail("MCP_AUTH_UNAVAILABLE", "Cloudflare MCP OAuth connection is unavailable");
  }
}

function threadIdFrom(value) {
  const candidates = [value?.thread?.id, value?.id, value?.threadId];
  const id = candidates.find((candidate) => typeof candidate === "string" && candidate.length > 0 && candidate.length <= 256);
  if (id === undefined) fail("MCP_PROTOCOL_INVALID", "Cloudflare MCP did not return a volatile thread id");
  return id;
}

function cloudflareEnvelopeFrom(value) {
  if (value?.isError === true) fail("MCP_PROTOCOL_ERROR", "Cloudflare MCP execute returned an error");
  const blocks = value?.content;
  if (!Array.isArray(blocks)) fail("MCP_PROTOCOL_INVALID", "Cloudflare MCP execute returned no content");
  const text = blocks.find((block) => block?.type === "text" && typeof block.text === "string")?.text;
  if (typeof text !== "string" || text.trim() === "" || Buffer.byteLength(text, "utf8") > MAX_LINE_BYTES) {
    fail("MCP_PROTOCOL_INVALID", "Cloudflare MCP execute returned an unreadable response");
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { fail("MCP_PROTOCOL_INVALID", "Cloudflare MCP execute returned non-JSON response"); }
  if (parsed === null || typeof parsed !== "object" || typeof parsed.status !== "number" ||
      typeof parsed.success !== "boolean") {
    fail("MCP_PROTOCOL_INVALID", "Cloudflare MCP response envelope is malformed");
  }
  return parsed;
}

function fixedCode(method, path, body) {
  const request = { method, path, ...(body === undefined ? {} : { body }) };
  // The code is generated only from the validated fixed request object. The
  // caller cannot provide executable MCP code or a different server/tool.
  return `async () => cloudflare.request(${JSON.stringify(request)})`;
}

function defaultSpawn(command, args, options) {
  return nodeSpawn(command, args, options);
}

function defaultRunCli(args, options) {
  return spawnSync(options.command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: MAX_LINE_BYTES,
    timeout: options.timeoutMs,
    windowsHide: true,
    shell: false,
  });
}

function readCliJson(runCli, args, options) {
  let result;
  try { result = runCli(args, options); } catch { fail("MCP_UNAVAILABLE", "Cloudflare MCP CLI metadata could not be read"); }
  if (result === null || typeof result !== "object" || result.status !== 0 ||
      typeof result.stdout !== "string" || result.stdout.length === 0) {
    fail("MCP_AUTH_UNAVAILABLE", "Cloudflare MCP CLI metadata is unavailable");
  }
  try { return JSON.parse(result.stdout); }
  catch { fail("MCP_PROTOCOL_INVALID", "Cloudflare MCP CLI metadata is not valid JSON"); }
}

export function createCloudflareMcpTransport(options = {}) {
  const cwd = checkCwd(options.cwd);
  const accountId = checkAccountId(options.accountId);
  const timeoutMs = checkTimeout(options.timeoutMs);
  const spawnProcess = options.spawnProcess ?? defaultSpawn;
  const runCli = options.runCli ?? defaultRunCli;
  const sourceEnv = options.env ?? process.env;
  const staticAuthKeys = ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL", "CLOUDFLARE_TOKEN"];
  if (staticAuthKeys.some((key) => typeof sourceEnv[key] === "string" && sourceEnv[key].trim() !== "")) {
    fail("MCP_AUTH_UNAVAILABLE", "Cloudflare MCP transport cannot use a static token");
  }
  const childEnv = scrubTokenEnv(sourceEnv);
  const command = process.platform === "win32" ? "codex.exe" : "codex";
  const cliOptions = { command, cwd, env: childEnv, timeoutMs };
  requireConfiguredOAuth(
    readCliJson(runCli, ["mcp", "get", SERVER, "--json"], cliOptions),
    readCliJson(runCli, ["mcp", "list", "--json"], cliOptions),
  );
  const child = spawnProcess(command, ["app-server", "--listen", "stdio://"], {
    cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  let closed = false;
  const failAll = (error) => {
    if (closed) return;
    closed = true;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  };
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) {
      failAll(new CloudflareMcpOAuthError("MCP_PROTOCOL_INVALID", "Cloudflare MCP response exceeded its bound"));
      return;
    }
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === "") continue;
      let message;
      try { message = JSON.parse(line); } catch {
        failAll(new CloudflareMcpOAuthError("MCP_PROTOCOL_INVALID", "Cloudflare MCP emitted malformed JSON-RPC"));
        return;
      }
      const item = pending.get(message?.id);
      if (item === undefined) continue;
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error !== undefined) item.reject(new CloudflareMcpOAuthError("MCP_PROTOCOL_ERROR", jsonRpcError(message.error)));
      else item.resolve(message.result);
    }
  });
  child.stderr.on("data", () => {});
  child.on("error", () => failAll(new CloudflareMcpOAuthError("MCP_UNAVAILABLE", "Cloudflare MCP app-server could not be started")));
  child.on("close", () => failAll(new CloudflareMcpOAuthError("MCP_UNAVAILABLE", "Cloudflare MCP app-server closed unexpectedly")));

  function write(message) {
    if (closed) fail("MCP_UNAVAILABLE", "Cloudflare MCP app-server is unavailable");
    try { child.stdin.write(`${JSON.stringify(message)}\n`); }
    catch { fail("MCP_UNAVAILABLE", "Cloudflare MCP app-server is unavailable"); }
  }

  function rpc(method, params) {
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new CloudflareMcpOAuthError("MCP_TIMEOUT", `Cloudflare MCP ${method} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      write({ jsonrpc: "2.0", id, method, params });
    });
  }

  let ready;
  async function ensureReady() {
    if (ready !== undefined) return ready;
    ready = (async () => {
      await rpc("initialize", { clientInfo: { name: "eliot-research-access", version: "1.0.0" }, capabilities: { experimentalApi: true } });
      write({ jsonrpc: "2.0", method: "initialized", params: {} });
      const thread = await rpc("thread/start", { cwd, ephemeral: true });
      return threadIdFrom(thread);
    })().catch((error) => {
      ready = undefined;
      throw error instanceof CloudflareMcpOAuthError ? error : new CloudflareMcpOAuthError("MCP_PROTOCOL_ERROR", "Cloudflare MCP initialization failed");
    });
    return ready;
  }

  async function request(method, path, body) {
    checkKnownRequest(accountId, method, path, body);
    const threadId = await ensureReady();
    const result = await rpc("mcpServer/tool/call", {
      threadId,
      server: SERVER,
      tool: TOOL,
      arguments: { code: fixedCode(method, path, body) },
    });
    const envelope = cloudflareEnvelopeFrom(result);
    if (!envelope.success || envelope.status < 200 || envelope.status >= 300) {
      throw new CloudflareMcpOAuthError("MCP_REQUEST_FAILED", `${method} ${path} failed (${envelope.status})`);
    }
    const listPath = path === `/accounts/${encodeURIComponent(accountId)}/access/apps?per_page=100` ||
      appIdFromPath(path, encodeURIComponent(accountId)) !== null;
    if (listPath) {
      const info = envelope.result_info;
      const listed = envelope.result;
      if (!Array.isArray(listed) || info === null || typeof info !== "object" || Array.isArray(info) ||
          !Number.isSafeInteger(info.page) || !Number.isSafeInteger(info.per_page) ||
          !Number.isSafeInteger(info.count) || !Number.isSafeInteger(info.total_count) ||
          !Number.isSafeInteger(info.total_pages) || info.page !== 1 || info.total_pages !== 1 ||
          info.count !== info.total_count || info.count !== listed.length || info.count < 0 || info.per_page < 1) {
        throw new CloudflareMcpOAuthError("MCP_PROTOCOL_INVALID", "Cloudflare Access list pagination is incomplete");
      }
    }
    return envelope.result ?? envelope;
  }

  async function verifyAccount() {
    const value = await request("GET", `/accounts/${encodeURIComponent(accountId)}`);
    const returned = value?.id ?? value?.account?.id;
    if (returned !== accountId) fail("MCP_ACCOUNT_MISMATCH", "Cloudflare MCP account readback does not match the requested account");
    return { accountId };
  }

  function close() {
    if (!closed) failAll(new CloudflareMcpOAuthError("MCP_CLOSED", "Cloudflare MCP transport closed"));
    try { child.kill(); } catch { /* best effort during process teardown */ }
    process.removeListener("exit", close);
  }

  process.once("exit", close);
  return Object.freeze({ request, verifyAccount, close });
}
