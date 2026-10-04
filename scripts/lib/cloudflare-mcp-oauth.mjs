// Narrow official Cloudflare MCP OAuth transport for Access readbacks.
//
// The MCP connection is managed by Codex. This module never reads, prints,
// exports, or persists an OAuth credential. It starts a volatile app-server
// tool context in an explicitly supplied local project directory and permits
// only the fixed account/Access requests and existing eliotr-core identity reads
// used by the Access provisioner. An explicitly selected AI Gateway readback
// mode is separately restricted to the complete account gateway inventory GET.

import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { scrubTokenEnv } from "./cloudflare-wrangler-oauth.mjs";

export const CLOUDFLARE_MCP_TRANSPORT = "cloudflare-mcp";
const SERVER = "cloudflare-api";
const TOOL = "execute";
const SERVER_URL = "https://mcp.cloudflare.com/mcp";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_LINE_BYTES = 512 * 1024;
const MAX_ACCESS_LIST_PAGES = 100;
const MAX_AI_GATEWAY_LIST_PAGES = 100;
const MAX_DYNAMIC_ROUTE_LIST_PAGES = 100;
const DYNAMIC_ROUTE_GATEWAY_ID = "eliotr-reasoning";
const RPC_PHASES = Object.freeze({
  initialize: "initialization",
  "thread/start": "thread start",
  "mcpServer/tool/call": "MCP tool call",
});

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

function accessListDescriptor(path, accountSegment) {
  const appPath = `/accounts/${accountSegment}/access/apps`;
  if (path === `${appPath}?per_page=100`) return { base: appPath, page: 1 };
  const appPage = path.match(new RegExp(`^${appPath}\\?page=([1-9][0-9]{0,2})&per_page=100$`, "u"));
  if (appPage !== null) return { base: appPath, page: Number(appPage[1]) };
  const policy = path.match(new RegExp(`^${appPath}/([^/]+)/policies(?:\\?per_page=100|\\?page=([1-9][0-9]{0,2})&per_page=100)?$`, "u"));
  if (policy === null || policy[1].length === 0 || policy[1].length > 128) return null;
  const base = `${appPath}/${policy[1]}/policies`;
  if (path === `${base}?per_page=100`) return { base, page: 1 };
  return { base, page: policy[2] === undefined ? 1 : Number(policy[2]) };
}

function aiGatewayListDescriptor(path, accountSegment) {
  const base = `/accounts/${accountSegment}/ai-gateway/gateways`;
  if (path === `${base}?per_page=100`) return { base, page: 1 };
  const page = path.match(new RegExp(`^${base}\\?page=([1-9][0-9]{0,2})&per_page=100$`, "u"));
  if (page === null) return null;
  const number = Number(page[1]);
  return number >= 2 && number <= MAX_AI_GATEWAY_LIST_PAGES ? { base, page: number } : null;
}

function dynamicRouteBase(accountSegment, gatewayId) {
  return `/accounts/${accountSegment}/ai-gateway/gateways/${gatewayId}/routes`;
}

function dynamicRouteListDescriptor(path, accountSegment, gatewayId) {
  const base = dynamicRouteBase(accountSegment, gatewayId);
  const match = path.match(new RegExp(`^${base}\\?page=([1-9][0-9]{0,2})&per_page=100$`, "u"));
  if (match === null) return null;
  const page = Number(match[1]);
  return page <= MAX_DYNAMIC_ROUTE_LIST_PAGES ? { base, page } : null;
}

function dynamicRouteIdFromPath(path, accountSegment, gatewayId) {
  const base = dynamicRouteBase(accountSegment, gatewayId);
  if (!path.startsWith(`${base}/`)) return null;
  const segment = path.slice(base.length + 1);
  if (segment === "" || segment.includes("/") || segment.includes("?")) return null;
  let id;
  try { id = decodeURIComponent(segment); } catch { return null; }
  return id !== "." && id !== ".." && /^[A-Za-z0-9._:@/-]{1,256}$/u.test(id) &&
    encodeURIComponent(id) === segment ? id : null;
}

function validateDynamicRouteWrite(method, path, body, accountSegment, gatewayId, allowRouteWrites) {
  const base = dynamicRouteBase(accountSegment, gatewayId);
  if (method !== "POST" || !allowRouteWrites || body === undefined) return false;
  if (path === base) {
    exactKeys(body, ["name", "elements"], "Dynamic Route create request");
    if (typeof body.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(body.name) ||
        !Array.isArray(body.elements) || body.elements.length === 0 || body.elements.length > 256 ||
        Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_LINE_BYTES) {
      fail("MCP_REQUEST_INVALID", "Dynamic Route create request is outside its bounded shape");
    }
    return true;
  }
  const deployment = path.startsWith(`${base}/`) && path.endsWith("/deployments")
    ? path.slice(base.length + 1, -"/deployments".length) : "";
  const deploymentRouteId = deployment === "" || deployment.includes("/") || deployment.includes("?")
    ? null : (() => { try { return decodeURIComponent(deployment); } catch { return null; } })();
  if (deploymentRouteId !== null && deploymentRouteId !== "." && deploymentRouteId !== ".." &&
      /^[A-Za-z0-9._:@/-]{1,256}$/u.test(deploymentRouteId) &&
      encodeURIComponent(deploymentRouteId) === deployment) {
    exactKeys(body, ["version_id"], "Dynamic Route deployment request");
    if (typeof body.version_id !== "string" || !/^[A-Za-z0-9._:@/-]{1,256}$/u.test(body.version_id)) {
      fail("MCP_REQUEST_INVALID", "Dynamic Route deployment request is malformed");
    }
    return true;
  }
  return false;
}

function validateAiGatewayPage(info, listed, descriptor) {
  const keys = ["page", "per_page", "count", "total_count", "total_pages"];
  if (info === null || typeof info !== "object" || Array.isArray(info) ||
      Object.keys(info).some((key) => !keys.includes(key)) ||
      !Number.isSafeInteger(info.page) || !Number.isSafeInteger(info.per_page) ||
      !Number.isSafeInteger(info.count) || !Number.isSafeInteger(info.total_count) ||
      (Object.hasOwn(info, "total_pages") && !Number.isSafeInteger(info.total_pages)) ||
      !Array.isArray(listed) || info.page !== descriptor.page || info.per_page !== 100 ||
      info.count !== listed.length || info.count < 0 || info.count > info.per_page ||
      info.total_count < info.count || info.total_count < 0) {
    fail("MCP_PROTOCOL_INVALID", "Cloudflare AI Gateway inventory pagination is malformed");
  }
  const totalPages = Math.ceil(info.total_count / info.per_page);
  const hasTotalPages = Object.hasOwn(info, "total_pages");
  if (totalPages > MAX_AI_GATEWAY_LIST_PAGES ||
      (hasTotalPages && (info.total_pages !== totalPages || info.total_pages < 0)) ||
      (totalPages === 0 && (info.page !== 1 || listed.length !== 0)) ||
      (totalPages > 0 && info.page > totalPages) ||
      (totalPages > 0 && info.page < totalPages && info.count !== info.per_page) ||
      (totalPages > 0 && info.page === totalPages && info.count === 0)) {
    fail("MCP_PROTOCOL_INVALID", "Cloudflare AI Gateway inventory pagination is incomplete");
  }
  for (const item of listed) {
    if (item === null || typeof item !== "object" || Array.isArray(item) ||
        typeof item.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(item.id)) {
      fail("MCP_PROTOCOL_INVALID", "Cloudflare AI Gateway inventory contains an invalid gateway identity");
    }
  }
  return { totalPages, hasTotalPages };
}

function isWorkerIdentityPath(path, accountSegment) {
  const scripts = `/accounts/${accountSegment}/workers/scripts`;
  return path === scripts || path === `${scripts}/eliotr-core/deployments` ||
    new RegExp(`^${scripts}/eliotr-core/versions/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`, "u").test(path);
}

function checkKnownRequest(accountId, method, path, body, resourceReadback, allowRouteWrites, gatewayId) {
  if (typeof method !== "string" || (method !== "GET" && method !== "POST") ||
      typeof path !== "string" || path.length > 512 || !path.startsWith("/accounts/")) {
    fail("MCP_REQUEST_INVALID", "Cloudflare MCP request is outside the fixed Access transport");
  }
  const accountSegment = encodeURIComponent(accountId);
  if (resourceReadback === "dynamic-routes") {
    const routeList = dynamicRouteListDescriptor(path, accountSegment, gatewayId);
    if (gatewayId !== DYNAMIC_ROUTE_GATEWAY_ID ||
        (method === "GET" && (body !== undefined ||
          (routeList === null && dynamicRouteIdFromPath(path, accountSegment, gatewayId) === null))) ||
        (method === "POST" && !validateDynamicRouteWrite(method, path, body, accountSegment, gatewayId, allowRouteWrites))) {
      fail("MCP_REQUEST_INVALID", "Cloudflare MCP request is outside the fixed Dynamic Route scope");
    }
    return;
  }
  if (resourceReadback === "ai-gateways") {
    if (method !== "GET" || aiGatewayListDescriptor(path, accountSegment) === null || body !== undefined) {
      fail("MCP_REQUEST_INVALID", "Cloudflare MCP request is outside the fixed AI Gateway readback");
    }
    return;
  }
  const accountPath = `/accounts/${accountSegment}`;
  const appPath = `${accountPath}/access/apps`;
  if (method === "GET" && isWorkerIdentityPath(path, accountSegment)) {
    if (body !== undefined) fail("MCP_REQUEST_INVALID", "Worker identity read cannot carry a body");
    return;
  }
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
  const list = accessListDescriptor(path, accountSegment);
  if (method === "GET" && list !== null) {
    if (body !== undefined) fail("MCP_REQUEST_INVALID", "Access list read cannot carry a body");
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

function jsonRpcError(method, error) {
  const safeMethod = Object.hasOwn(RPC_PHASES, method) ? method : "unknown";
  const phase = RPC_PHASES[safeMethod] ?? "unknown RPC phase";
  const rpcErrorCode = typeof error?.code === "number" && Number.isSafeInteger(error.code)
    ? error.code : null;
  const codeDescription = rpcErrorCode === null ? "non-safe numeric error code" : `JSON-RPC code ${rpcErrorCode}`;
  const failure = new CloudflareMcpOAuthError("MCP_PROTOCOL_ERROR",
    `Cloudflare MCP app-server ${phase} (${safeMethod}) failed: ${codeDescription}`);
  failure.rpcMethod = safeMethod;
  failure.rpcErrorCode = rpcErrorCode;
  return failure;
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
  if (parsed === null || typeof parsed !== "object" || !Number.isSafeInteger(parsed.status) ||
      parsed.status < 100 || parsed.status > 599 ||
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
  const resourceReadback = options.resourceReadback;
  const gatewayId = options.gatewayId;
  const allowRouteWrites = options.allowRouteWrites ?? false;
  if (resourceReadback !== undefined && resourceReadback !== "ai-gateways" && resourceReadback !== "dynamic-routes") {
    fail("MCP_RESOURCE_SCOPE_INVALID", "Cloudflare MCP resource readback scope is unsupported");
  }
  if (typeof allowRouteWrites !== "boolean" || (allowRouteWrites && resourceReadback !== "dynamic-routes")) {
    fail("MCP_RESOURCE_SCOPE_INVALID", "Cloudflare MCP Dynamic Route scope options are invalid");
  }
  if (resourceReadback === "dynamic-routes" && gatewayId !== DYNAMIC_ROUTE_GATEWAY_ID) {
    fail("MCP_RESOURCE_SCOPE_INVALID", "Cloudflare MCP Dynamic Route gateway scope is invalid");
  }
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
      if (message.error !== undefined) item.reject(jsonRpcError(item.method, message.error));
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
      pending.set(id, { resolve, reject, timer, method });
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

  async function requestPage(method, path, body) {
    checkKnownRequest(accountId, method, path, body, resourceReadback, allowRouteWrites, gatewayId);
    const threadId = await ensureReady();
    const result = await rpc("mcpServer/tool/call", {
      threadId,
      server: SERVER,
      tool: TOOL,
      arguments: { code: fixedCode(method, path, body) },
    });
    const envelope = cloudflareEnvelopeFrom(result);
    if (resourceReadback === "dynamic-routes") return envelope;
    const workerIdentityRead = method === "GET" && isWorkerIdentityPath(path, encodeURIComponent(accountId));
    const gatewayList = method === "GET" && resourceReadback === "ai-gateways"
      ? aiGatewayListDescriptor(path, encodeURIComponent(accountId)) : null;
    if (!envelope.success || envelope.status < 200 || envelope.status >= 300 ||
        (workerIdentityRead && (envelope.status !== 200 || (Array.isArray(envelope.errors) && envelope.errors.length > 0))) ||
        (gatewayList !== null && (envelope.status !== 200 ||
          (envelope.errors !== undefined && (!Array.isArray(envelope.errors) || envelope.errors.length > 0))))) {
      throw new CloudflareMcpOAuthError("MCP_REQUEST_FAILED", `${method} ${path} failed (${envelope.status})`);
    }
    const list = method === "GET" && resourceReadback === undefined
      ? accessListDescriptor(path, encodeURIComponent(accountId)) : null;
    if (list !== null) {
      const info = envelope.result_info;
      const listed = envelope.result;
      if (!Array.isArray(listed) || info === null || typeof info !== "object" || Array.isArray(info) ||
          !Number.isSafeInteger(info.page) || !Number.isSafeInteger(info.per_page) ||
          !Number.isSafeInteger(info.count) || !Number.isSafeInteger(info.total_count) ||
          !Number.isSafeInteger(info.total_pages) || info.page !== list.page || info.page < 1 ||
          info.per_page < 1 || info.count < 0 || info.total_count < 0 || info.total_pages < 0 ||
          info.count !== listed.length || info.total_count < info.count ||
          (info.total_pages > 0 && Math.ceil(info.total_count / info.per_page) !== info.total_pages) ||
          (info.total_pages === 0 && (info.page !== 1 || info.count !== 0 || info.total_count !== 0 || listed.length !== 0)) ||
          (info.total_pages > 0 && info.page > info.total_pages) ||
          (info.total_pages > 0 && info.page < info.total_pages && info.count !== info.per_page) ||
          (info.total_pages > 0 && info.page === info.total_pages && info.count > info.per_page) ||
          info.total_pages > MAX_ACCESS_LIST_PAGES ||
          listed.some((item) => item === null || typeof item !== "object" || Array.isArray(item) ||
            typeof item.id !== "string" || item.id.length === 0 || item.id.length > 256)) {
        throw new CloudflareMcpOAuthError("MCP_PROTOCOL_INVALID", "Cloudflare Access list pagination is incomplete");
      }
      return { list, listed, info, totalPages: info.total_pages, hasTotalPages: true };
    }
    if (gatewayList !== null) {
      const info = envelope.result_info;
      const listed = envelope.result;
      const pagination = validateAiGatewayPage(info, listed, gatewayList);
      return { list: gatewayList, listed, info, ...pagination };
    }
    return envelope.result ?? envelope;
  }

  async function request(method, path, body) {
    checkKnownRequest(accountId, method, path, body, resourceReadback, allowRouteWrites, gatewayId);
    if (resourceReadback === "dynamic-routes") return requestPage(method, path, body);
    const list = method === "GET" ? (resourceReadback === "ai-gateways"
      ? aiGatewayListDescriptor(path, encodeURIComponent(accountId))
      : accessListDescriptor(path, encodeURIComponent(accountId))) : null;
    if (list === null) return requestPage(method, path, body);
    const gatewayList = resourceReadback === "ai-gateways";
    if (gatewayList && list.page !== 1) {
      fail("MCP_REQUEST_INVALID", "AI Gateway inventory reads must begin at page one");
    }
    const all = [];
    let firstInfo;
    let firstTotalPages;
    let firstHasTotalPages;
    const ids = new Set();
    // Canonicalize the first policy read to the bounded page size too. A bare
    // policy URL otherwise uses Cloudflare's default page size, while follow-up
    // pages use per_page=100 and can skip entries or fail metadata reconciliation.
    let current = list.page === 1 ? `${list.base}?per_page=100` : path;
    for (let page = 1; page <= MAX_ACCESS_LIST_PAGES; page += 1) {
      const result = await requestPage("GET", current);
      if (firstInfo === undefined) {
        firstInfo = result.info;
        firstTotalPages = result.totalPages;
        firstHasTotalPages = result.hasTotalPages;
      }
      if (result.info.per_page !== firstInfo.per_page || result.info.total_count !== firstInfo.total_count ||
          result.totalPages !== firstTotalPages || result.hasTotalPages !== firstHasTotalPages) {
        throw new CloudflareMcpOAuthError("MCP_PROTOCOL_INVALID", `${gatewayList ? "Cloudflare AI Gateway" : "Cloudflare Access"} list pagination changed during read`);
      }
      for (const item of result.listed) {
        if (ids.has(item.id)) throw new CloudflareMcpOAuthError("MCP_PROTOCOL_INVALID", "Cloudflare Access list repeats an item");
        ids.add(item.id);
      }
      all.push(...result.listed);
      if (result.totalPages === 0 || page === result.totalPages) {
        if (result.info.total_count !== all.length) {
          throw new CloudflareMcpOAuthError("MCP_PROTOCOL_INVALID", `${gatewayList ? "Cloudflare AI Gateway" : "Cloudflare Access"} list pagination is incomplete`);
        }
        return all;
      }
      current = `${list.base}?page=${page + 1}&per_page=100`;
    }
    throw new CloudflareMcpOAuthError("MCP_PROTOCOL_INVALID", "Cloudflare Access list pagination exceeds its bound");
  }

  async function verifyAccount() {
    if (resourceReadback === "ai-gateways" || resourceReadback === "dynamic-routes") {
      fail("MCP_REQUEST_INVALID", "Resource-scoped transport verifies scope through its exact resource path");
    }
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
