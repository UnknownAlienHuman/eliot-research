import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { assertEvalOrigin, fetchEval } from "./origin.mjs";

const BASELINE_PROJECT_ID = "a3661347-12c8-459f-bc1c-98f325f69952";
const BASELINE_PROJECT_TITLE = "K3 Dots arxiv-10 2026-10-27";
const BASELINE_SOURCE_COUNT = 10;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_RE = new RegExp("^" + UUID + "$", "iu");
const MAX_OUTPUT_BYTES = 12_000;
const TOOL_NAMES = [
  "list_projects", "list_sources", "get_guide", "outline", "read", "find_claims", "search", "get_page", "propose_page",
  "refresh_models", "request_understanding",
];
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const outDir = fileURLToPath(new URL("../../eval/out/k4/", import.meta.url));
const now = new Date();
const runId = now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
const localMiniflareMode = process.argv.includes("--signed-agent-miniflare");
const serveSignedAgentMode = process.argv.includes("--serve-signed-agent");

type LocalMcpRuntime = {
  mcpOrigin: string;
  uiOrigin: string;
  agentHeaders: Record<string, string>;
  ownerHeaders: Record<string, string>;
  expiresAt: string;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  dispose: () => Promise<void>;
};

async function startLocalMcpRuntime(): Promise<LocalMcpRuntime> {
  const mcpOrigin = serveSignedAgentMode ? envValue("ELIOT_MCP_ORIGIN") : "http://127.0.0.1";
  const uiOrigin = serveSignedAgentMode ? envValue("ELIOT_ORIGIN") : "http://localhost";
  assert(mcpOrigin && uiOrigin, "Serve mode requires explicit ELIOT_MCP_ORIGIN and ELIOT_ORIGIN.");
  if (serveSignedAgentMode) {
    const mcp = new URL(assertEvalOrigin(mcpOrigin, mcpOrigin)), ui = new URL(assertEvalOrigin(uiOrigin, uiOrigin));
    assert(mcp.protocol === "http:" && ui.protocol === "http:" && mcp.hostname === "127.0.0.1" && ui.hostname === "localhost"
      && mcpOrigin === mcp.origin && uiOrigin === ui.origin && Number(mcp.port) > 0 && mcp.port === ui.port,
    "Serve origins must be http://127.0.0.1:<positive-port> and http://localhost:<same-port> without a path, query or fragment.");
  }
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const workerDir = path.join(root, "dist", "eliot_research");
  const config = JSON.parse(await readFile(path.join(workerDir, "wrangler.json"), "utf8"));
  assert.equal(config.name, "eliot-research"); assert.equal(config.main, "index.js");
  const migrationConfig = config.d1_databases?.find((entry: any) => entry.binding === "DB");
  assert(migrationConfig && typeof migrationConfig.migrations_dir === "string");
  const migrationsDir = path.resolve(workerDir, migrationConfig.migrations_dir);
  const migrationFiles = (await readdir(migrationsDir)).filter((name) => /^\d+_.+\.sql$/u.test(name)).sort();
  assert(migrationFiles.includes("0009_agents.sql"), "The built Worker migration pattern must include K4 migration 0009.");
  assert(!migrationFiles.includes("0004_agents.sql"), "K4 must use the current 0009 migration, not the excluded old 0004 file.");

  const wranglerRequire = createRequire(import.meta.resolve("wrangler"));
  const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
  const { unstable_splitSqlQuery } = wranglerRequire("wrangler") as { unstable_splitSqlQuery: (sql: string) => string[] };
  assert.equal(typeof unstable_splitSqlQuery, "function", "Installed Wrangler must provide its D1 migration SQL splitter.");
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const kid = "k4-" + randomUUID();
  const jwk = { ...await exportJWK(publicKey), kid, alg: "RS256", use: "sig", key_ops: ["verify"] };
  const team = "k4-" + randomUUID().replaceAll("-", "").slice(0, 20) + ".cloudflareaccess.com";
  const issuer = "https://" + team, audience = "k4-test-" + randomUUID(), ownerEmail = "k4-owner@example.test";
  const expiresAt = Math.floor(Date.now() / 1000) + (serveSignedAgentMode ? 1800 : 300);
  const sign = (claims: Record<string, unknown>) => new SignJWT({ type: "app", ...claims })
    .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" }).setIssuer(issuer).setAudience(audience)
    .setIssuedAt().setExpirationTime(serveSignedAgentMode ? expiresAt : "5m").sign(privateKey);
  const [agentJwt, ownerJwt] = await Promise.all([
    sign({ sub: "", common_name: "k4-test-agent" }), sign({ sub: "k4-test-owner", email: ownerEmail }),
  ]);
  const jwksUrl = issuer + "/cdn-cgi/access/certs", jwksBody = JSON.stringify({ keys: [jwk] });
  const egressScript = `const expected=${JSON.stringify(jwksUrl)},body=${JSON.stringify(jwksBody)};` +
    `export default{async fetch(request){const url=new URL(request.url);` +
    `if(request.method==="GET"&&url.href===expected)return new Response(body,{headers:{"content-type":"application/json","cache-control":"public,max-age=300"}});` +
    `throw new Error("K4 test egress blocked: "+url.origin+url.pathname);}};`;
  const modules: Array<{ type: "ESModule"; path: string; contents: string }> = [];
  async function collectModules(dir: string): Promise<void> {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      assert(!entry.isSymbolicLink(), "Built Worker modules must not traverse symlinks.");
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await collectModules(file);
      else if (/\.m?js$/u.test(entry.name)) modules.push({ type: "ESModule", path: file, contents: await readFile(file, "utf8") });
    }
  }
  await collectModules(workerDir);
  const entryPath = path.join(workerDir, config.main), entryIndex = modules.findIndex((module) => module.path === entryPath);
  assert(entryIndex >= 0 && modules.length <= 512, "Built Worker entry and bounded module graph are required.");
  const [entry] = modules.splice(entryIndex, 1); assert(entry); modules.unshift(entry);
  const tag = "k4-" + randomUUID();
  const workflows = Object.fromEntries(config.workflows.map((workflow: any) => [workflow.binding,
    { name: tag + "-" + workflow.binding.toLowerCase(), className: workflow.class_name }]));
  const options = convertV4MiniflareOptions({
    workers: [
      {
        name: "eliot-k4-test", rootPath: workerDir, modulesRoot: workerDir, modules,
        compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
        outboundService: { name: "k4-test-jwks-egress" },
        d1Databases: { DB: tag + "-db" }, r2Buckets: { BUCKET: tag + "-r2" },
        durableObjects: { CHAT: { className: "ChatAgent", useSQLite: true } }, workflows,
        assets: { directory: path.resolve(workerDir, config.assets.directory), binding: "ASSETS",
          routerConfig: { has_user_worker: true }, assetConfig: { not_found_handling: config.assets.not_found_handling } },
        bindings: { ...config.vars, ELIOT_LOCAL_DEV: "0", ELIOT_ACCESS_TEAM_DOMAIN: team,
          ELIOT_ACCESS_AUD: audience, ELIOT_OWNER_EMAIL: ownerEmail, ELIOT_OWNER_SERVICE_TOKEN: "",
          ELIOT_ORIGIN: uiOrigin, ELIOT_MCP_ORIGIN: mcpOrigin, ELIOT_CF_ACCOUNT_ID: "" },
      },
      { name: "k4-test-jwks-egress", modules: true, script: egressScript },
    ],
    host: "127.0.0.1", port: serveSignedAgentMode ? Number(new URL(mcpOrigin).port) : 0, inspectorPort: 0,
  });
  const mf = new Miniflare(options);
  try {
    await mf.ready;
    const db = await mf.getD1Database("DB", "eliot-k4-test");
    for (const file of migrationFiles) {
      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      try { await db.batch(unstable_splitSqlQuery(sql).map((statement) => db.prepare(statement))); }
      catch (error) { throw new Error("Miniflare D1 migration " + file + " failed: " + (error instanceof Error ? error.message : String(error)), { cause: error }); }
    }
    return {
      mcpOrigin, uiOrigin, expiresAt: new Date(expiresAt * 1000).toISOString(),
      agentHeaders: { "cf-access-jwt-assertion": agentJwt },
      ownerHeaders: { "cf-access-jwt-assertion": ownerJwt },
      fetch: (input, init) => mf.dispatchFetch(input, init),
      dispose: () => mf.dispose(),
    };
  } catch (error) { await mf.dispose(); throw error; }
}

if (serveSignedAgentMode) {
  const runtime = await startLocalMcpRuntime();
  const sessionPath = path.join(outDir, "session.json");
  try {
    await mkdir(outDir, { recursive: true, mode: 0o700 });
    await writeFile(sessionPath, "", { mode: 0o600, flag: "wx" });
    try {
      if (process.platform === "win32") {
        const identity = execFileSync("whoami.exe", [], { encoding: "utf8" }).trim();
        execFileSync("icacls.exe", [sessionPath, "/inheritance:r", "/grant:r", identity + ":F"], { stdio: "pipe" });
      }
      await writeFile(sessionPath, JSON.stringify({ mcpOrigin: runtime.mcpOrigin, uiOrigin: runtime.uiOrigin,
        agentHeaders: runtime.agentHeaders, ownerHeaders: runtime.ownerHeaders, expiresAt: runtime.expiresAt }) + "\n");
      console.log("READY " + runtime.mcpOrigin + "/mcp");
      await new Promise<void>((resolve) => {
        const stop = () => { clearTimeout(timer); process.off("SIGINT", stop); process.off("SIGTERM", stop); resolve(); };
        const timer = setTimeout(stop, Math.max(0, Date.parse(runtime.expiresAt) - Date.now()));
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
    } finally { await unlink(sessionPath); }
  } finally { await runtime.dispose(); }
  process.exit(0);
}

const localRuntime = localMiniflareMode ? await startLocalMcpRuntime() : null;

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function resolveMcpUrl(signedAgent = false, explicitOrigin?: string): URL {
  if (signedAgent) {
    const configured = explicitOrigin ?? envValue("ELIOT_MCP_ORIGIN");
    assert(configured, "Signed-agent mode requires explicit ELIOT_MCP_ORIGIN.");
    const url = new URL(envValue("ELIOT_MCP_URL") ?? new URL("/mcp", configured).href);
    assert.equal(url.pathname, "/mcp", "ELIOT_MCP_URL must point to the MCP /mcp route.");
    assert.equal(url.search, "", "ELIOT_MCP_URL must not contain a query string.");
    assert.equal(url.hash, "", "ELIOT_MCP_URL must not contain a fragment.");
    assert.equal(url.username + url.password, "", "Credentials must not be embedded in ELIOT_MCP_URL.");
    assert.equal(assertEvalOrigin(url.href, configured), new URL(configured).origin);
    return url;
  }
  const direct = envValue("ELIOT_MCP_URL");
  const configured = envValue("ELIOT_MCP_ORIGIN") ?? envValue("ELIOT_ORIGIN");
  if (direct) {
    const url = new URL(direct);
    assert.equal(url.pathname, "/mcp", "ELIOT_MCP_URL must point to the MCP /mcp route.");
    assert.equal(url.search, "", "ELIOT_MCP_URL must not contain a query string.");
    assert.equal(url.hash, "", "ELIOT_MCP_URL must not contain a fragment.");
    assert.equal(url.username + url.password, "", "Credentials must not be embedded in ELIOT_MCP_URL.");
    assert(["http:", "https:"].includes(url.protocol), "ELIOT_MCP_URL must use HTTP or HTTPS.");
    assertEvalOrigin(url.href, configured);
    return url;
  }
  const root = envValue("ELIOT_URL");
  if (root) {
    const url = new URL(root);
    assert.equal(url.search, "", "ELIOT_URL must not contain a query string.");
    assert.equal(url.hash, "", "ELIOT_URL must not contain a fragment.");
    assert.equal(url.username + url.password, "", "Credentials must not be embedded in ELIOT_URL.");
    assert(["http:", "https:"].includes(url.protocol), "ELIOT_URL must use HTTP or HTTPS.");
    url.pathname = url.pathname.replace(/\/+$/u, "") + "/mcp";
    assertEvalOrigin(url.href, configured);
    return url;
  }
  return new URL("http://127.0.0.1:5173/mcp");
}

type AgentCredential =
  | { ready: true; source: "ELIOT_AGENT_JWT" | "agent-service-headers"; headers: Record<string, string>; reason: null }
  | { ready: false; source: "none"; headers: Record<string, string>; reason: string };

function resolveAgentCredential(): AgentCredential {
  const jwt = envValue("ELIOT_AGENT_JWT");
  const id = envValue("ELIOT_AGENT_ACCESS_CLIENT_ID");
  const secret = envValue("ELIOT_AGENT_ACCESS_CLIENT_SECRET");
  if (jwt && (id || secret)) return { ready: false, source: "none", headers: {}, reason: "Configure either ELIOT_AGENT_JWT or an agent service-header pair, not both." };
  if (jwt) return { ready: true, source: "ELIOT_AGENT_JWT", headers: { "Cf-Access-Jwt-Assertion": jwt }, reason: null };
  if (id && secret) return { ready: true, source: "agent-service-headers",
    headers: { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret }, reason: null };
  return { ready: false, source: "none", headers: {}, reason: "No ELIOT_AGENT_JWT or complete ELIOT_AGENT_ACCESS_CLIENT_ID/SECRET pair is available." };
}

function accessHeaders(): Record<string, string> {
  const id = envValue("CF_ACCESS_CLIENT_ID");
  const secret = envValue("CF_ACCESS_CLIENT_SECRET");
  assert.equal(Boolean(id), Boolean(secret), "Set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, or neither.");
  return id && secret ? { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret } : {};
}

function textOf(result: { content?: unknown[] }): string {
  const blocks = Array.isArray(result.content) ? result.content : [];
  return blocks.filter((item): item is { type: "text"; text: string } =>
    typeof item === "object" && item !== null && "type" in item && item.type === "text" && "text" in item && typeof item.text === "string",
  ).map((item) => item.text).join("\n");
}

function continuation(text: string): string | null {
  return new RegExp("Continue with cursor (" + UUID + ")\\.", "iu").exec(text)?.[1] ?? null;
}

function parseSearchCursor(text: string): string | null {
  return new RegExp("Continue with cursor ((?:guide|claim):" + UUID + ")\\.", "iu").exec(text)?.[1] ?? null;
}

function verifyCursorParsing(): void {
  const id = "00000000-0000-4000-8000-000000000001";
  assert.equal(parseSearchCursor(`Continue with cursor guide:${id}.`), `guide:${id}`);
  assert.equal(parseSearchCursor(`Continue with cursor claim:${id}.`), `claim:${id}`);
  assert.equal(continuation(`Continue with cursor ${id}.`), id);
  assert.equal(continuation(`Continue with cursor guide:${id}.`), null);
  report.cursorParsing = { guidePrefixAccepted: true, claimPrefixAccepted: true, otherUuidCursorUnchanged: true };
}

function parseProjects(text: string): Array<{ id: string; title: string }> {
  const rows: Array<{ id: string; title: string }> = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = new RegExp("^- (.+) \\[(" + UUID + ")\\](?: —.*)?$", "u").exec(line);
    if (match?.[1] && match[2]) rows.push({ title: match[1], id: match[2] });
  }
  return rows;
}

type SourceRow = {
  id: string;
  title: string;
  kind: string;
  readableState: string;
  enabled: boolean;
  currentRevisionId: string | null;
  revisionId: string;
};

function parseSources(text: string): SourceRow[] {
  const rows: SourceRow[] = [];
  const lines = text.split(/\r?\n/u);
  const header = new RegExp("^- (.*) \\[(" + UUID + ")\\] \\(([^,\\r\\n]+), ([^,\\r\\n]+), (enabled|disabled)\\)$", "u");
  const revision = new RegExp("^  Current revision: (none|" + UUID + "); latest revision: (" + UUID + ")$", "u");
  for (let i = 0; i < lines.length; i++) {
    const row = header.exec(lines[i] ?? "");
    if (!row?.[1] || !row[2] || !row[3] || !row[4] || !row[5]) continue;
    const refs = revision.exec(lines[i + 1] ?? "");
    if (!refs?.[1] || !refs[2]) continue;
    rows.push({
      title: row[1], id: row[2], kind: row[3], readableState: row[4], enabled: row[5] === "enabled",
      currentRevisionId: refs[1] === "none" ? null : refs[1], revisionId: refs[2],
    });
  }
  return rows;
}

function parseOutline(text: string): Array<{ revisionId: string; block: number; start: number; end: number; label: string }> {
  const rows: Array<{ revisionId: string; block: number; start: number; end: number; label: string }> = [];
  const re = new RegExp("^- \\[R(" + UUID + "):(\\d+)\\] bytes \\[(\\d+),(\\d+)\\)", "gmu");
  for (const match of text.matchAll(re)) {
    if (!match[1] || !match[2] || !match[3] || !match[4]) continue;
    rows.push({ revisionId: match[1], block: Number(match[2]), start: Number(match[3]), end: Number(match[4]), label: `[R${match[1]}:${match[2]}]` });
  }
  return rows;
}

function revisionRefs(text: string): string[] {
  return [...text.matchAll(new RegExp("\\[R(" + UUID + ")(?:#?:\\d+)?\\]", "gu"))]
    .map((match) => match[1]).filter((value): value is string => Boolean(value));
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableHash(value: unknown): string {
  return sha256(JSON.stringify(value));
}

const signedAgentMode = process.argv.includes("--signed-agent") || process.argv.includes("--agent") || localMiniflareMode;
// LOCAL_FUNCTIONAL native fixture contract (fresh integration namespace, no distillation):
// Root prepares a fresh project (ELIOT_EVAL_PROJECT=<title|id>) with 1+ native UTF-8 text
// sources via POST /api/projects/:id/sources/text (no conversion, no model calls),
// autoDistill 0, at least one 100-2000 byte prose block (40+ letters). This mode proves
// MCP protocol/scope/citation/proposal plumbing only; it is NOT ten-paper O2/O5 quality
// or live Access acceptance. Full K4 still requires the original arxiv-10 corpus and
// owner semantic review; no gold/corpus changes.
const functionalFixtureMode = localMiniflareMode || process.argv.includes('--functional') || envValue('ELIOT_EVAL_FUNCTIONAL') === '1';
const seedNativeMode = process.argv.includes('--seed-native');
if (seedNativeMode && !functionalFixtureMode) throw new Error('--seed-native requires --functional.');
if (seedNativeMode && signedAgentMode) throw new Error('--seed-native is owner-simulation only; omit --signed-agent.');
const agentCredential: AgentCredential = localRuntime
  ? { ready: true, source: "ELIOT_AGENT_JWT", headers: localRuntime.agentHeaders, reason: null }
  : signedAgentMode ? resolveAgentCredential()
  : { ready: false, source: "none", headers: {}, reason: "Signed-agent mode was not requested." };
const configuredMcpOrigin = localRuntime?.mcpOrigin ?? envValue("ELIOT_MCP_ORIGIN");
const configuredUiOrigin = localRuntime?.uiOrigin ?? envValue("ELIOT_ORIGIN");
let agentNotRunReason = signedAgentMode && !agentCredential.ready ? agentCredential.reason
  : signedAgentMode && (!configuredMcpOrigin || !configuredUiOrigin) ? "Signed-agent mode requires explicit ELIOT_MCP_ORIGIN and ELIOT_ORIGIN." : null;
let mcpUrl: URL;
if (agentNotRunReason) {
  mcpUrl = new URL("http://127.0.0.1:5173/mcp");
} else {
  try { mcpUrl = resolveMcpUrl(signedAgentMode, localRuntime?.mcpOrigin); }
  catch {
    if (!signedAgentMode) throw new Error("The MCP eval origin is invalid or not explicitly allowed.");
    agentNotRunReason = "Signed-agent mode requires a valid explicit MCP origin and /mcp URL.";
    mcpUrl = new URL("http://127.0.0.1:5173/mcp");
  }
}
const origin = mcpUrl.origin;
const apiOrigin = signedAgentMode ? configuredUiOrigin ?? "" : configuredUiOrigin ?? origin;
const apiConfiguredOrigin = configuredUiOrigin ?? (!signedAgentMode ? configuredMcpOrigin : undefined);
const mcpAllowedOrigin = configuredMcpOrigin ?? (!signedAgentMode ? configuredUiOrigin : undefined);
const access = signedAgentMode ? agentCredential.headers : accessHeaders();
const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]).has(mcpUrl.hostname);
const client = new Client({ name: "eliot-k4-eval", version: "0.1.0" });
const mcpHttpStatuses: number[] = [];
const transport = new StreamableHTTPClientTransport(mcpUrl, {
  requestInit: { headers: { Origin: origin, ...access }, redirect: "error" },
  redirectPolicy: "same-origin",
  fetch: async (input, init) => {
    const requestUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    const response = localRuntime
      ? await localRuntime.fetch(input, init ?? {})
      : await fetchEval(input, init ?? {}, origin, mcpAllowedOrigin);
    if (new URL(requestUrl).pathname === "/mcp") mcpHttpStatuses.push(response.status);
    return response;
  },
});
const report: Record<string, any> = {
  schemaVersion: 1,
  runId,
  mode: signedAgentMode ? "signed-agent" : "owner-simulation",
  endpoint: { origin: agentNotRunReason ? "NOT_CONFIGURED" : origin, path: "/mcp", localLoopback: agentNotRunReason ? null : loopback,
    accessHeadersConfigured: Boolean(access["CF-Access-Client-Id"]), signedJwtConfigured: signedAgentMode && agentCredential.source === "ELIOT_AGENT_JWT" },
  client: { package: "@modelcontextprotocol/client", version: "2.3.1", transport: "StreamableHTTPClientTransport", protocolNegotiation: "SDK defaults" },
  scope: { LOCAL_REAL_MCP_PROTOCOL: "NOT_RUN", LIVE_ACCESS_NOT_RUN: true, FULL_K4_ACCEPTANCE: "NOT_CLAIMED", O2_O5_BYO_AGENT_QUALITY: localRuntime ? "NOT_RUN_NO_REAL_ARXIV10_AGENT_RUN" : "NOT_RUN", FIXTURE: localRuntime ? "LOCAL_SIGNED_MCP_TRANSPORT" : functionalFixtureMode ? "LOCAL_FUNCTIONAL" : "FULL_BASELINE_CORPUS_REQUIRED" },
  fixture: localRuntime ? "LOCAL_SIGNED_MCP_TRANSPORT" : functionalFixtureMode ? "LOCAL_FUNCTIONAL" : "FULL_BASELINE_CORPUS_REQUIRED",
  signedAgent: { status: "NOT_RUN", reason: signedAgentMode ? agentNotRunReason : "Use --signed-agent to run the signed agent boundary checks." },
  ownerSimulation: { status: "NOT_RUN" },
  baseline: { projectId: BASELINE_PROJECT_ID, projectTitle: BASELINE_PROJECT_TITLE, expectedSources: BASELINE_SOURCE_COUNT, observedVerifiedClaimFtsRows: "NOT_OBSERVED" },
  toolCalls: [],
  modelCallsIssuedByEval: 0,
  aiSearchCallsIssuedByEval: 0,
  runtimeBoundary: { remoteBindings: localRuntime ? "AI binding omitted; only test JWKS egress permitted" : "NOT_PROVEN_OFFLINE; no AI binding called", crons: "NOT_OBSERVED_BY_MCP", liveAccess: localRuntime ? "NOT_RUN_TEST_JWKS_FIXTURE" : "NOT_RUN" },
  status: "RUNNING",
};

async function callTool(name: string, args: Record<string, unknown> = {}, expectError = false): Promise<{ text: string; isError: boolean; bytes: number; httpStatus: number | null }> {
  const statusStart = mcpHttpStatuses.length;
  const result = await client.callTool({ name, arguments: args });
  const text = textOf(result);
  const bytes = encoder.encode(text).byteLength;
  const isError = result.isError === true;
  const httpStatuses = mcpHttpStatuses.slice(statusStart);
  const httpStatus = httpStatuses.at(-1) ?? null;
  report.toolCalls.push({ name, isError, utf8Bytes: bytes, httpStatus });
  assert(bytes <= MAX_OUTPUT_BYTES, `${name} output exceeded ${MAX_OUTPUT_BYTES} UTF-8 bytes (${bytes}).`);
  assert.equal(isError, expectError, `${name} error state did not match expectation.`);
  return { text, isError, bytes, httpStatus };
}

async function apiJson(path: string, method = "GET", body?: unknown, authHeaders: Record<string, string> = access): Promise<any> {
  const url = new URL(path, apiOrigin), init = {
    method,
    headers: { Origin: apiOrigin, ...authHeaders, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  } satisfies RequestInit;
  const response = localRuntime ? await localRuntime.fetch(url, init) : await fetchEval(url, init, apiOrigin, apiConfiguredOrigin);
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(`${method} ${path} returned HTTP ${response.status}.`);
  }
  const raw = await response.text();
  try { return JSON.parse(raw); }
  catch { throw new Error(`${method} ${path} did not return JSON.`); }
}

async function apiStatus(path: string, method = "GET", body?: unknown, authHeaders: Record<string, string> = access): Promise<number> {
  const url = new URL(path, apiOrigin), init = {
    method,
    headers: { Origin: apiOrigin, ...authHeaders, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  } satisfies RequestInit;
  const response = localRuntime ? await localRuntime.fetch(url, init) : await fetchEval(url, init, apiOrigin, apiConfiguredOrigin);
  const status = response.status;
  await response.body?.cancel().catch(() => undefined);
  return status;
}
async function apiBytes(path: string, authHeaders: Record<string, string> = access): Promise<Uint8Array> {
  const url = new URL(path, apiOrigin), init = { method: "GET", headers: { Origin: apiOrigin, ...authHeaders }, redirect: "error", signal: AbortSignal.timeout(30_000) } satisfies RequestInit;
  const response = localRuntime ? await localRuntime.fetch(url, init) : await fetchEval(url, init, apiOrigin, apiConfiguredOrigin);
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error("GET " + path + " returned HTTP " + response.status + "."); }
  return new Uint8Array(await response.arrayBuffer());
}
const MCP_REQUEST_BODY_LIMIT = 65_536;
function buildSeedText(runId: string): string {
  return (
    "# K4 native seed\n\n" +
    "Local MCP protocol seed paragraph one states project scope without model work. " +
    "It carries Cyrillic \u0442\u043e\u0447\u043d\u043e\u0441\u0442\u044c and emoji \uD83C\uDF0D for UTF-8 coverage. Seed " + runId + ".\n\n" +
    "Second seed paragraph holds citable prose for outline, read and get_page checks. " +
    "It mentions list_projects, outline and read as read-only steps before any owner decision.\n\n" +
    "Closing seed paragraph keeps byte ranges stable for the pending proposal flow and preserves labels through accept and reject.\n"
  );
}
async function seedLocalSignedProject(): Promise<{ projectId: string; projectTitle: string; sourceId: string; revisionId: string; seedBytes: number }> {
  assert(localRuntime, "The signed Miniflare fixture is not active.");
  const me = await apiJson("/api/me", "GET", undefined, localRuntime.ownerHeaders);
  assert.equal(me.actor?.type, "owner"); assert.equal(me.actor?.authentication, "access");
  const projectTitle = "K4 signed MCP transport " + runId;
  const created = await apiJson("/api/projects", "POST", { title: projectTitle, description: "Ephemeral local signed-MCP transport fixture." }, localRuntime.ownerHeaders);
  const projectId = created.project?.id;
  assert(UUID_RE.test(projectId), "Local owner JWT did not create the transport project.");
  const seedText = buildSeedText(runId), seedBytes = encoder.encode(seedText).byteLength;
  const added = await apiJson("/api/projects/" + projectId + "/sources/text", "POST", { title: "K4 authored transport source " + runId, text: seedText }, localRuntime.ownerHeaders);
  const sourceId = added.sourceId, revisionId = added.revisionId;
  assert(UUID_RE.test(sourceId) && UUID_RE.test(revisionId), "Local owner JWT did not create the native text source.");
  let current: any = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    current = await apiJson("/api/sources/" + sourceId, "GET", undefined, localRuntime.ownerHeaders);
    if (["readable", "readable_with_warnings"].includes(current.source?.readableState)) break;
    assert(!["failed", "needs_conversion"].includes(current.source?.readableState), "Native transport text must not enter conversion or failure.");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert(["readable", "readable_with_warnings"].includes(current?.source?.readableState), "Native transport text did not become readable.");
  assert.equal(current.source.conversionCalls, 0, "Native text fixture must not call a converter.");
  const understanding = await apiJson("/api/sources/" + sourceId + "/understanding?revisionId=" + encodeURIComponent(revisionId), "GET", undefined, localRuntime.ownerHeaders);
  assert.equal(understanding.state, "none", "Transport fixture must not start source understanding.");
  assert.equal(understanding.progress.attempts, 0, "Transport fixture must not make an understanding attempt.");
  return { projectId, projectTitle, sourceId, revisionId, seedBytes };
}
async function localSideEffectSnapshot(seed: { sourceId: string; revisionId: string }): Promise<unknown> {
  assert(localRuntime, "The signed Miniflare fixture is not active.");
  const headers = localRuntime.ownerHeaders;
  const [settings, providers, catalog, understanding] = await Promise.all([
    apiJson("/api/settings", "GET", undefined, headers),
    apiJson("/api/models/providers", "GET", undefined, headers),
    apiJson("/api/models", "GET", undefined, headers),
    apiJson("/api/sources/" + seed.sourceId + "/understanding?revisionId=" + encodeURIComponent(seed.revisionId), "GET", undefined, headers),
  ]);
  return { settings: settings.settings, providers: providers.providers,
    catalog: { snapshot: catalog.snapshot, models: catalog.models, warnings: catalog.warnings },
    understanding: { state: understanding.state, progress: understanding.progress, report: understanding.report } };
}
async function verifyRequestSizeGate(): Promise<{ smallStatus: number; smallBytes: number; oversizedStatus: number; oversizedBytes: number; smallAfterStatus: number }> {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Origin: origin, ...access };
  const smallBody = JSON.stringify({ jsonrpc: "2.0", id: "k4-size-small", method: "tools/list", params: {} });
  const smallRes = await fetchEval(mcpUrl, { method: "POST", headers, body: smallBody, redirect: "error", signal: AbortSignal.timeout(30_000) }, origin, mcpAllowedOrigin);
  const smallBuf = new Uint8Array(await smallRes.arrayBuffer());
  assert.equal(smallRes.status, 200, "Small MCP tools/list must stay 200.");
  assert(smallBuf.byteLength > 0 && smallBuf.byteLength < 30_000, "Small MCP tools/list must stay bounded.");
  const pad = "x".repeat(70_000);
  const largeBody = JSON.stringify({ jsonrpc: "2.0", id: "k4-size-probe", method: "tools/list", params: { _pad: pad } });
  assert(encoder.encode(largeBody).byteLength > MCP_REQUEST_BODY_LIMIT, "Oversized probe must exceed 65,536 UTF-8 bytes.");
  const largeRes = await fetchEval(mcpUrl, { method: "POST", headers, body: largeBody, redirect: "error", signal: AbortSignal.timeout(30_000) }, origin, mcpAllowedOrigin);
  const largeBuf = new Uint8Array(await largeRes.arrayBuffer());
  const largeText = new TextDecoder().decode(largeBuf);
  assert.equal(largeRes.status, 413, "Oversized MCP body must return 413.");
  assert(largeText.includes("MCP request body exceeds 64 KiB"), "Oversized 413 must carry the documented ApiError.");
  assert(!largeText.includes(pad.slice(0, 64)), "Oversized 413 must not echo the request body.");
  assert(largeBuf.byteLength < 1_000, "Oversized 413 must stay small and bounded.");
  const smallAgainRes = await fetchEval(mcpUrl, { method: "POST", headers, body: smallBody, redirect: "error", signal: AbortSignal.timeout(30_000) }, origin, mcpAllowedOrigin);
  await smallAgainRes.arrayBuffer().catch(() => undefined);
  assert.equal(smallAgainRes.status, 200, "Small MCP tools/list after the oversized probe must stay 200.");
  report.requestSize = { sdkTransport: "StreamableHTTPClientTransport", smallStatus: smallRes.status, smallBytes: smallBuf.byteLength, oversizedBytesSent: encoder.encode(largeBody).byteLength, oversizedStatus: largeRes.status, oversizedBytes: largeBuf.byteLength, smallAfterStatus: smallAgainRes.status, limitBytes: MCP_REQUEST_BODY_LIMIT, modelCalls: 0 };
  return { smallStatus: smallRes.status, smallBytes: smallBuf.byteLength, oversizedStatus: largeRes.status, oversizedBytes: largeBuf.byteLength, smallAfterStatus: smallAgainRes.status };
}
async function ensureSeedNativeProject(): Promise<{ projectId: string; projectTitle: string; sourceId: string; revisionId: string; seedBytes: number; projectsBefore: number; projectsAfter: number }> {
  assert(loopback, "--seed-native is local-only; MCP origin must be loopback.");
  assert(!access["CF-Access-Client-Id"] && !access["CF-Access-Client-Secret"], "--seed-native must run without deployed Access credentials.");
  const me = await apiJson("/api/me");
  assert(me.actor?.type === "owner" && me.actor?.authentication === "local", "--seed-native requires local owner authentication (/api/me).");
  const settings = await apiJson("/api/settings");
  assert(Number(settings.settings?.autoDistill) === 0, "--seed-native requires autoDistill 0 before writes; settings were not changed.");
  const projectsBeforeList = await collectProjects();
  const projectsBefore = projectsBeforeList.length;
  const projectTitle = `K4 native seed ${runId}`;
  const created = await apiJson("/api/projects", "POST", { title: projectTitle, description: "Local functional fixture; not ten-paper or signed-agent acceptance. --seed-native single project." });
  const projectId = created.project?.id as string;
  assert(UUID_RE.test(projectId), "--seed-native project creation did not return a UUID.");
  const seedText = buildSeedText(runId);
  const seedBytes = encoder.encode(seedText).byteLength;
  assert(seedBytes >= 100 && seedBytes <= 2000, `--seed-native text must be 100-2000 UTF-8 bytes, got ${seedBytes}.`);
  const sourceTitle = `K4 seed source ${runId}`;
  const added = await apiJson(`/api/projects/${projectId}/sources/text`, "POST", { title: sourceTitle, text: seedText });
  const sourceId = added.sourceId as string;
  assert(UUID_RE.test(sourceId), "--seed-native source creation did not return a UUID.");
  let settled: any = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    const current = await apiJson(`/api/sources/${sourceId}`);
    const state = current.source?.readableState;
    if (state === "readable" || state === "readable_with_warnings") { settled = current.source; break; }
    assert(state !== "failed" && state !== "needs_conversion", `--seed-native text must stay native readable, got ${state}.`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  assert(settled && (settled.readableState === "readable" || settled.readableState === "readable_with_warnings"), "--seed-native text never settled readable.");
  assert.equal(settled.conversionCalls, 0, `--seed-native must cost 0 conversions, got ${settled.conversionCalls}.`);
  const revisionId = settled.currentRevisionId as string;
  assert(UUID_RE.test(revisionId), "--seed-native readable revision is not a UUID.");
  const projectsAfterList = await collectProjects();
  const projectsAfter = projectsAfterList.length;
  assert.equal(projectsAfter, projectsBefore + 1, "--seed-native must create exactly one fresh project.");
  const seededSources = await collectSources(projectId);
  assert.equal(seededSources.rows.length, 1, "--seed-native must create exactly one source in the fresh project.");
  report.seed = { projectId, projectTitle, sourceId, revisionId, seedBytes, sourceTitle, projectsBefore, projectsAfter, autoDistill: 0, conversionCalls: 0 };
  return { projectId, projectTitle, sourceId, revisionId, seedBytes, projectsBefore, projectsAfter };
}

async function collectProjects(): Promise<Array<{ id: string; title: string }>> {
  const projects: Array<{ id: string; title: string }> = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const result = await callTool("list_projects", { maxTokens: 4000, ...(cursor ? { cursor } : {}) });
    projects.push(...parseProjects(result.text));
    const next = continuation(result.text);
    if (!next) return projects;
    assert(!cursors.has(next), "list_projects repeated a pagination cursor.");
    cursors.add(next);
    cursor = next;
  }
  throw new Error("list_projects exceeded the 20-page bound.");
}

async function collectSources(projectId: string): Promise<{ rows: SourceRow[]; pages: number }> {
  const rows: SourceRow[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 30; page++) {
    const result = await callTool("list_sources", { projectId, maxTokens: 220, ...(cursor ? { cursor } : {}) });
    const pageRows = parseSources(result.text);
    assert(pageRows.length > 0 || rows.length > 0, "list_sources returned no parseable source rows.");
    for (const row of pageRows) {
      assert(UUID_RE.test(row.id) && UUID_RE.test(row.revisionId), "list_sources must return full source and revision UUIDs.");
      if (row.currentRevisionId !== null) assert(UUID_RE.test(row.currentRevisionId), "Current revision reference must be a full UUID.");
      assert(!ids.has(row.id), `list_sources repeated source ${row.id} across pages.`);
      ids.add(row.id);
      rows.push(row);
    }
    const next = continuation(result.text);
    if (!next) return { rows, pages: page + 1 };
    assert(!cursors.has(next), "list_sources repeated a pagination cursor.");
    cursors.add(next);
    cursor = next;
  }
  throw new Error("list_sources exceeded the 30-page bound.");
}

async function localSnapshot(projectId: string): Promise<any> {
  const [settingsData, projectData] = await Promise.all([
    apiJson("/api/settings"), apiJson(`/api/projects/${projectId}`),
  ]);
  const settings = settingsData.settings;
  assert(settings && projectData.project, "Owner snapshot omitted settings or project.");
  return {
    settingsHash: stableHash(settings),
    projectHash: stableHash(projectData.project),
    autoDistill: settings.autoDistill,
    monthlyUsedMicrousd: settingsData.monthlyUsedMicrousd,
    monthlyBudgetMicrousd: settingsData.monthlyBudgetMicrousd,
    monthStart: settingsData.monthStart,
  };
}

function onlyCurrentRefs(name: string, text: string, currentRevisions: Set<string>): { references: string[] } {
  const references = revisionRefs(text);
  const foreign = references.filter((id) => !currentRevisions.has(id));
  assert.equal(foreign.length, 0, `${name} returned non-current revision references: ${foreign.join(", ")}`);
  return { references };
}

type McpClaimEvidence = { revisionId: string; block: number; start: number; end: number; statement: string; quote: string };

function parseClaimEvidence(text: string): McpClaimEvidence[] {
  const rows: McpClaimEvidence[] = [];
  const header = new RegExp("^- .+ \\[R(" + UUID + "):(\\d+)\\] bytes \\[(\\d+),(\\d+)\\)$", "u");
  const statement = /^  Derived claim statement \(not primary evidence\): (.*)$/u;
  const quote = /^  Exact stored source quote: (.*)$/u;
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index++) {
    const row = header.exec(lines[index] ?? "");
    if (!row?.[1] || !row[2] || !row[3] || !row[4]) continue;
    const statementLine = statement.exec(lines[index + 1] ?? "");
    const quoteLine = quote.exec(lines[index + 2] ?? "");
    assert(statementLine?.[1] !== undefined && quoteLine?.[1] !== undefined, "MCP claim row omitted its JSON-quoted statement or source quote.");
    const parsedStatement: unknown = JSON.parse(statementLine[1]);
    const parsedQuote: unknown = JSON.parse(quoteLine[1]);
    assert.equal(typeof parsedStatement, "string", "MCP claim statement is not a JSON string.");
    assert.equal(typeof parsedQuote, "string", "MCP claim quote is not a JSON string.");
    rows.push({ revisionId: row[1], block: Number(row[2]), start: Number(row[3]), end: Number(row[4]), statement: parsedStatement, quote: parsedQuote });
  }
  return rows;
}

async function verifyCurrentPrefixClaims(entries: McpClaimEvidence[], sources: SourceRow[]): Promise<{ verifiedClaims: number; revisionIds: string[] }> {
  const sourceByRevision = new Map(sources.filter((source) => source.currentRevisionId).map((source) => [source.currentRevisionId!, source]));
  const understandingByRevision = new Map<string, Set<string>>();
  for (const entry of entries) {
    const source = sourceByRevision.get(entry.revisionId);
    assert(source, `Claim revision ${entry.revisionId} is not a listed current readable source.`);
    let verifiedTuples = understandingByRevision.get(entry.revisionId);
    if (!verifiedTuples) {
      const data = await apiJson(`/api/sources/${source.id}/understanding?revisionId=${entry.revisionId}`);
      assert.equal(data.sourceId, source.id, "Understanding response changed source identity.");
      assert.equal(data.revisionId, entry.revisionId, "Understanding response changed revision identity.");
      assert(Array.isArray(data.claims), "Understanding response omitted the current claims prefix.");
      verifiedTuples = new Set<string>();
      for (const claim of data.claims) {
        if (claim.ambiguous !== false || typeof claim.statement !== "string" || typeof claim.quote !== "string" ||
          !Number.isSafeInteger(claim.block) || !Number.isSafeInteger(claim.start) || !Number.isSafeInteger(claim.end)) continue;
        verifiedTuples.add(JSON.stringify([claim.statement, claim.quote, claim.block, claim.start, claim.end]));
      }
      understandingByRevision.set(entry.revisionId, verifiedTuples);
    }
    const tuple = JSON.stringify([entry.statement, entry.quote, entry.block, entry.start, entry.end]);
    assert(verifiedTuples.has(tuple), `MCP claim tuple was absent or ambiguous in current understanding prefix for ${entry.revisionId}:${entry.block}.`);
  }
  return { verifiedClaims: entries.length, revisionIds: [...understandingByRevision.keys()] };
}

function citationIdentity(citations: any[]): unknown[] {
  return citations.map((citation) => ({
    sourceId: citation.sourceId, revisionId: citation.revisionId, block: citation.block,
    start: citation.start, end: citation.end, label: citation.label,
  }));
}

function utf8End(bytes: Uint8Array, start: number, wantedEnd: number): number {
  let end = Math.min(bytes.length, wantedEnd);
  while (end > start && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return end;
}

function isUtf8Boundary(bytes: Uint8Array, offset: number): boolean {
  return offset === 0 || offset === bytes.length || (((bytes[offset] ?? 0) & 0xc0) !== 0x80);
}

function parsePageChunk(text: string): { start: number; end: number; total: number; body: string; next: number | null; headRevisionId: string } {
  const range = /Body UTF-8 bytes \[(\d+),(\d+)\) of (\d+) \(consumed through byte \d+\)\./u.exec(text);
  assert(range?.[1] && range[2] && range[3], `get_page omitted its UTF-8 byte range header: ${text.slice(0, 240)}`);
  const head = new RegExp("immutable head revision (" + UUID + ")\\.", "u").exec(text);
  assert(head?.[1], "get_page omitted the immutable head revision.");
  const bodyStart = range.index + range[0].length;
  assert.equal(text.slice(bodyStart, bodyStart + 2), "\n\n", "get_page body header separator changed.");
  const contentStart = bodyStart + 2;
  const tail = new RegExp("\\n\\n(?:Next cursor: (\\d+); continue with headRevisionId (" + UUID + ")\\.|Continue with cursor (\\d+) and headRevisionId (" + UUID + ")\\.|No next cursor\\.)$", "u").exec(text);
  assert(tail?.index !== undefined, "get_page omitted its continuation footer.");
  const nextValue = tail[1] ?? tail[3];
  const nextHead = tail[2] ?? tail[4];
  if (nextHead) assert.equal(nextHead, head[1], "get_page continuation changed the immutable head revision.");
  return {
    start: Number(range[1]), end: Number(range[2]), total: Number(range[3]),
    body: text.slice(contentStart, tail.index), next: nextValue === undefined ? null : Number(nextValue), headRevisionId: head[1],
  };
}

function parseMinimumMaxTokens(text: string): number | null {
  const match = /Minimum maxTokens:\s*(\d+)\s*to fit/u.exec(text);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

const GET_PAGE_HARD_CAP_TOKENS = 4000;
const GET_PAGE_ESCALATION_ROUNDS = 8;

function splitPageFooter(text: string): { core: string; rest: string } | null {
  const tail = new RegExp("\\n\\n(?:Next cursor: (\\d+); continue with headRevisionId (" + UUID + ")\\.|Continue with cursor (\\d+) and headRevisionId (" + UUID + ")\\.|No next cursor\\.)", "u").exec(text);
  if (tail?.index === undefined) return null;
  const coreEnd = tail.index + tail[0].length;
  return { core: text.slice(0, coreEnd), rest: text.slice(coreEnd) };
}

async function verifyLocalRangeAndProposal(projectId: string, sources: SourceRow[], initialOutlineText: string, localBefore: any): Promise<any> {
  const readableSources = sources.filter((row) => row.enabled && row.currentRevisionId && ["readable", "readable_with_warnings"].includes(row.readableState));
  assert(readableSources.length > 0, "No enabled current readable source is available for the protocol fixture.");
  let readable: SourceRow | undefined;
  let revisionId = "";
  let whole = new Uint8Array();
  let blocks: Array<{ id: number; start: number; end: number; type?: string; heading?: string | null }> = [];
  let candidate: { revisionId: string; block: number; start: number; end: number; label: string; canonical: typeof blocks[number] } | undefined;
  let outlineText = "";

  for (const source of readableSources) {
    const sourceRevisionId = source.currentRevisionId!;
    const fullResponse = await fetchEval(new URL(`/api/revisions/${sourceRevisionId}/text`, apiOrigin), {
      headers: { Origin: apiOrigin, ...access }, redirect: "error", signal: AbortSignal.timeout(30_000),
    }, apiOrigin, apiConfiguredOrigin);
    assert(fullResponse.ok, `GET whole source text returned HTTP ${fullResponse.status}.`);
    const sourceWhole = new Uint8Array(await fullResponse.arrayBuffer());
    const outlineData = await apiJson(`/api/revisions/${sourceRevisionId}/outline`);
    const sourceBlocks = outlineData.blocks as typeof blocks;
    assert(Array.isArray(sourceBlocks) && sourceBlocks.length > 0, `REST outline returned no canonical blocks for ${sourceRevisionId}.`);
    const sourceOutline = source.id === readableSources[0]!.id
      ? initialOutlineText
      : (await callTool("outline", { projectId, sourceId: source.id, revisionId: sourceRevisionId, maxTokens: 4000 })).text;
    const listedBlocks = parseOutline(sourceOutline).filter((row) => row.revisionId === sourceRevisionId);
    const byId = new Map(sourceBlocks.map((block) => [block.id, block]));
    const eligible = listedBlocks.map((row) => ({ ...row, canonical: byId.get(row.block) }))
      .filter((row): row is typeof row & { canonical: typeof sourceBlocks[number] } => {
        const block = row.canonical;
        if (!block || block.start !== row.start || block.end !== row.end) return false;
        const bytes = block.end - block.start;
        if (bytes < 100 || bytes > 2000 || /heading|title/iu.test(block.type ?? "")) return false;
        if (block.start < 0 || block.end <= block.start || block.end > sourceWhole.byteLength) return false;
        const text = decoder.decode(sourceWhole.slice(block.start, block.end));
        return (text.match(/\p{L}/gu)?.length ?? 0) >= 40 && (text.match(/\p{L}{3,}/gu)?.length ?? 0) >= 5;
      })
      .sort((left, right) => (right.end - right.start) - (left.end - left.start));
    if (eligible[0]) {
      readable = source;
      revisionId = sourceRevisionId;
      whole = sourceWhole;
      blocks = sourceBlocks;
      candidate = eligible[0];
      outlineText = sourceOutline;
      break;
    }
  }
  assert(readable && candidate && revisionId, "No substantive non-heading canonical block of 100–2,000 UTF-8 bytes was found in the enabled current sources.");
  const chosen = candidate.canonical;
  assert(chosen.start === candidate.start && chosen.end === candidate.end, "MCP/REST outline byte ranges differ.");
  assert(chosen.end - chosen.start >= 100 && chosen.end - chosen.start <= 2000, "Fixture source block must be 100–2,000 UTF-8 bytes.");

  const sampleIndexes = [...new Set([0, Math.floor((blocks.length - 1) / 2), blocks.length - 1])];
  const rangeChecks: Array<{ start: number; end: number; bytes: number; equal: boolean }> = [];
  for (const index of sampleIndexes) {
    const block = blocks[index];
    assert(block, "REST outline block disappeared.");
    const start = block.start;
    const end = utf8End(whole, start, Math.min(block.end, start + 2048));
    assert(end > start, "REST outline did not provide a nonempty UTF-8 range.");
    const rangeResponse = await fetchEval(new URL(`/api/revisions/${revisionId}/range?start=${start}&end=${end}`, apiOrigin), {
      headers: { Origin: apiOrigin, ...access }, redirect: "error", signal: AbortSignal.timeout(30_000),
    }, apiOrigin, apiConfiguredOrigin);
    assert(rangeResponse.ok, `GET /range returned HTTP ${rangeResponse.status}.`);
    const rangeBytes = new Uint8Array(await rangeResponse.arrayBuffer());
    const expected = whole.slice(start, end);
    assert.deepEqual(rangeBytes, expected, `REST /range [${start},${end}) differed from whole canonical text.`);
    decoder.decode(rangeBytes);
    rangeChecks.push({ start, end, bytes: rangeBytes.byteLength, equal: true });
  }

  const quoteStart = chosen.start;
  const quoteEnd = chosen.end;
  assert(quoteEnd > quoteStart, "The selected canonical block has no complete UTF-8 quote bytes.");
  const quoteBytes = whole.slice(quoteStart, quoteEnd);
  const quote = decoder.decode(quoteBytes);
  assert(quote.trim().length > 0 && quoteBytes.byteLength >= 100 && quoteBytes.byteLength <= 2000, "The selected canonical quote is not substantive or falls outside 100–2,000 bytes.");
  const quoteRange = await fetchEval(new URL(`/api/revisions/${revisionId}/range?start=${quoteStart}&end=${quoteEnd}`, apiOrigin), {
    headers: { Origin: apiOrigin, ...access }, redirect: "error", signal: AbortSignal.timeout(30_000),
  }, apiOrigin, apiConfiguredOrigin);
  assert(quoteRange.ok, `GET quote /range returned HTTP ${quoteRange.status}.`);
  assert.deepEqual(new Uint8Array(await quoteRange.arrayBuffer()), quoteBytes, "Proposal quote bytes differ from REST /range.");

  const citationLabel = `[R${revisionId}:${candidate.block}]`;
  assert(outlineText.includes(citationLabel), "MCP outline did not supply the selected persistent R label.");
  const read = await callTool("read", { projectId, revisionId, start: quoteStart, end: quoteEnd, maxTokens: 4000 });
  assert(read.text.includes(citationLabel), "MCP read omitted the persistent citation label.");
  assert(read.text.includes(quote), "MCP read did not return the exact canonical quote bytes as text.");

  const unicodePrefix = "Проверка UTF-8 🌍.\n\n";
  const proposalBody = `${unicodePrefix}${citationLabel}\n\n${quote}`;
  assert(encoder.encode(proposalBody).byteLength <= MAX_OUTPUT_BYTES, "Fixture proposal body exceeds 12,000 UTF-8 bytes.");
  const proposalTitle = `K4 MCP protocol fixture ${runId}`;
  const firstProposal = await callTool("propose_page", {
    projectId, kind: "note", title: proposalTitle, body: proposalBody,
    revisionIds: [revisionId], mutationId: randomUUID(),
  });
  const ids = new RegExp("Proposed page: (" + UUID + ")\\s+Proposal revision: (" + UUID + ")\\s+Status: (\\w+)", "u").exec(firstProposal.text);
  assert(ids?.[1] && ids[2] && ids[3], `propose_page returned no fixture identities: ${firstProposal.text}`);
  assert.equal(ids[3], "proposed", "First proposal must await owner review.");
  const pageId = ids[1], proposedRevisionId = ids[2];

  const pendingResponse = await apiJson(`/api/projects/${projectId}/proposals/${proposedRevisionId}`);
  const pending = pendingResponse.proposal;
  assert.equal(pending.status, "proposed");
  assert.equal(pending.pageId, pageId);
  assert.equal(pending.body, proposalBody, "Owner proposal body differs from MCP fixture bytes.");
  assert.deepEqual(pending.revisionIds, [revisionId]);
  assert.equal(pending.citations.length, 1, "Fixture must resolve exactly one persistent citation.");
  const proposedCitationIdentity = citationIdentity(pending.citations);
  assert.equal(pending.citations[0].revisionId, revisionId);
  assert.equal(pending.citations[0].label, citationLabel);
  assert.equal(pending.citations[0].block, candidate.block);

  const acceptedResponse = await apiJson(`/api/projects/${projectId}/proposals/${proposedRevisionId}/decision`, "POST", {
    decision: "accept", expectedHeadRevisionId: pending.headRevisionId ?? null,
  });
  assert.equal(acceptedResponse.proposal.status, "accepted");
  assert.equal(acceptedResponse.proposal.revisionId, proposedRevisionId);
  const acceptedData = await apiJson(`/api/projects/${projectId}/pages/${pageId}`);
  const accepted = acceptedData.page;
  assert.equal(accepted.headRevisionId, proposedRevisionId);
  assert.equal(accepted.body, proposalBody);
  assert.deepEqual(citationIdentity(accepted.citations), proposedCitationIdentity, "Accepted page changed citation identity.");

  const acceptedBytes = encoder.encode(accepted.body);
  const labelCharOffset = accepted.body.indexOf(citationLabel);
  assert(labelCharOffset >= 0 && accepted.body.slice(0, labelCharOffset) === unicodePrefix, "Unicode prefix did not immediately precede the persistent label.");
  const labelStart = encoder.encode(accepted.body.slice(0, labelCharOffset)).byteLength;
  const labelEnd = labelStart + encoder.encode(citationLabel).byteLength;

  let cursor = 0;
  let assembled = "";
  let pageCount = 0;
  const pageChunks: Array<{ start: number; end: number; bytes: number }> = [];
  let minimumFollowups = 0;
  while (pageCount < 100) {
    let requestedCap = 128;
    let result = await callTool("get_page", { projectId, pageId, maxTokens: requestedCap, ...(cursor > 0 ? { cursor, headRevisionId: proposedRevisionId } : {}) });
    assert(result.bytes <= requestedCap * 3, "get_page output exceeded its 128-token UTF-8 byte cap.");
    for (let round = 0; round < GET_PAGE_ESCALATION_ROUNDS; round++) {
      const advised = parseMinimumMaxTokens(result.text);
      const split = splitPageFooter(result.text);
      const hiddenNote = split !== null && /^\n\n\d+ stored source citations hidden because maxTokens was reached; increase maxTokens to include them\.$/u.test(split.rest);
      const completeCitations = split !== null && (split.rest === "" || split.rest.startsWith("\n\n### Stored source citations\n"));
      if (advised === null && completeCitations) break;
      if (split === null && advised === null) break;
      const nextCap = Math.min(GET_PAGE_HARD_CAP_TOKENS, Math.max(requestedCap + 1, advised ?? 0, requestedCap * 2));
      assert(nextCap > requestedCap, "get_page still needs a larger cap after reaching the 4000-token storage bound.");
      requestedCap = nextCap;
      minimumFollowups += 1;
      result = await callTool("get_page", { projectId, pageId, maxTokens: requestedCap, ...(cursor > 0 ? { cursor, headRevisionId: proposedRevisionId } : {}) });
      assert(result.bytes <= requestedCap * 3, "get_page follow-up output exceeded its requested UTF-8 byte cap.");
    }
    const split = splitPageFooter(result.text);
    assert(parseMinimumMaxTokens(result.text) === null, "get_page still returns Minimum maxTokens advice after bounded storage-only follow-up.");
    assert(split !== null, "get_page omitted its continuation footer.");
    assert(split.rest === "" || split.rest.startsWith("\n\n### Stored source citations\n"), "get_page returned incomplete citation metadata after bounded follow-up.");
    const chunk = parsePageChunk(split.core);
    assert.equal(chunk.start, cursor, "get_page returned a noncontiguous page-body cursor.");
    assert.equal(chunk.headRevisionId, proposedRevisionId);
    assert.equal(chunk.total, encoder.encode(accepted.body).byteLength);
    assert(isUtf8Boundary(acceptedBytes, chunk.start) && isUtf8Boundary(acceptedBytes, chunk.end), "get_page chunk boundary split a UTF-8 character.");
    assert(!(chunk.start > labelStart && chunk.start < labelEnd) && !(chunk.end > labelStart && chunk.end < labelEnd), "get_page chunk boundary split a persistent R token.");
    assert.equal(encoder.encode(chunk.body).byteLength, chunk.end - chunk.start, "get_page chunk text did not match its UTF-8 byte range.");
    assembled += chunk.body;
    pageChunks.push({ start: chunk.start, end: chunk.end, bytes: encoder.encode(chunk.body).byteLength });
    pageCount++;
    if (chunk.next === null) break;
    assert(chunk.next > cursor && chunk.next === chunk.end, "get_page did not advance its UTF-8 byte cursor.");
    cursor = chunk.next;
  }
  assert(pageCount < 100, "get_page exceeded the 100-page protocol bound.");
  assert.equal(assembled, accepted.body, "Paginated get_page body differs byte-for-byte from the accepted page.");
  assert(pageCount > 1, "get_page pagination was not exercised by the protocol fixture.");
  const firstPageEnd = pageChunks[0]?.end;
  assert(firstPageEnd === labelStart || firstPageEnd === labelEnd, "Unicode prefix did not move the persistent R token onto the first byte-cap split boundary.");

  const secondProposal = await callTool("propose_page", {
    projectId, pageId, kind: "note", title: proposalTitle, body: proposalBody,
    revisionIds: [revisionId], mutationId: randomUUID(),
  });
  const secondIds = new RegExp("Proposed page: (" + UUID + ")\\s+Proposal revision: (" + UUID + ")\\s+Status: (\\w+)", "u").exec(secondProposal.text);
  assert(secondIds?.[2] && secondIds[3], "Second proposal did not return its revision identity.");
  assert.equal(secondIds[3], "proposed");
  const secondRevisionId = secondIds[2];
  const secondPending = (await apiJson(`/api/projects/${projectId}/proposals/${secondRevisionId}`)).proposal;
  assert.equal(secondPending.baseRevisionId, proposedRevisionId, "Second proposal was not based on the accepted head.");
  assert.equal(secondPending.headRevisionId, proposedRevisionId);
  const rejectedResponse = await apiJson(`/api/projects/${projectId}/proposals/${secondRevisionId}/decision`, "POST", {
    decision: "reject", expectedHeadRevisionId: proposedRevisionId,
  });
  assert.equal(rejectedResponse.proposal.status, "rejected");
  const afterReject = (await apiJson(`/api/projects/${projectId}/pages/${pageId}`)).page;
  assert.equal(afterReject.headRevisionId, proposedRevisionId, "Rejecting the second proposal lost the accepted head.");
  assert.equal(afterReject.body, proposalBody);
  assert.deepEqual(citationIdentity(afterReject.citations), proposedCitationIdentity, "Rejecting the second proposal changed citation identity.");
  const afterRejectTool = await callTool("get_page", { projectId, pageId, maxTokens: 200 });
  assert(afterRejectTool.text.includes(`immutable head revision ${proposedRevisionId}`), "MCP get_page did not retain the accepted head after rejection.");

  return {
    source: { sourceId: readable.id, revisionId, title: readable.title, sha256: sha256(whole), bytes: whole.byteLength },
    restRanges: rangeChecks,
    proposal: {
      pageId, acceptedRevisionId: proposedRevisionId, rejectedRevisionId: secondRevisionId,
      bodyUtf8Bytes: encoder.encode(proposalBody).byteLength, citationIdentity: proposedCitationIdentity,
      getPagePaginationPages: pageCount, getPageChunks: pageChunks, getPageMinimumFollowups: minimumFollowups,
      getPageBoundaryProof: { capTokens: 128, capBytes: 384, labelStart, labelEnd, firstPageEnd, labelEdgeAtFirstCap: true, noUtf8OrLabelBoundarySplits: true, minimumFollowups },
      acceptedHeadPreservedAfterReject: true,
    },
  };
}

async function runOwnerSimulation(): Promise<void> {
  report.ownerSimulation = { status: "RUNNING" };
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [...TOOL_NAMES].sort(), "The MCP server must expose exactly the eleven K4 tools.");
  assert(!names.some((name) => /accept|approve|decision|owner|publish/iu.test(name)), "An owner-only mutator is exposed as an agent tool.");
  report.server = { toolNames: names, toolCount: names.length, noOwnerDecisionTools: true, ownerOnlySideEffectsDenied: "NOT_RUN_OWNER_SIMULATION" };
  report.scope.LOCAL_REAL_MCP_PROTOCOL = loopback ? "PASS_PENDING_ASSERTIONS" : "NOT_LOCAL";
  report.scope.LIVE_ACCESS_NOT_RUN = loopback;
  report.runtimeBoundary.liveAccess = loopback ? "NOT_RUN" : "READ_ONLY_MCP_REQUESTS_USED_NONLOCAL_URL";
  await verifyRequestSizeGate();

  let projects = await collectProjects();
  // seed-native: projects may gain one fresh fixture project below; keep mutable for reselection.
  const requestedProject = envValue("ELIOT_EVAL_PROJECT");
  let project;
  if (seedNativeMode) {
    assert(!requestedProject, "--seed-native creates its own fresh project; omit ELIOT_EVAL_PROJECT.");
    const seeded = await ensureSeedNativeProject();
    projects = await collectProjects();
    const found = projects.find((item) => item.id === seeded.projectId);
    assert(found, "--seed-native project was not returned by list_projects.");
    project = found;
  } else {
    if (functionalFixtureMode && !requestedProject) throw new Error('Functional fixture mode requires explicit ELIOT_EVAL_PROJECT for a fresh native integration namespace.');
    const selected = requestedProject
    ? projects.find((item) => item.title === requestedProject || item.id === requestedProject)
    : projects.find((item) => item.id === BASELINE_PROJECT_ID);
    assert(selected, requestedProject ? `ELIOT_EVAL_PROJECT did not match a listed project: ${requestedProject}` : "Baseline project was not returned by list_projects.");
    if (!requestedProject) assert.equal(selected.title, BASELINE_PROJECT_TITLE, "Baseline project title changed.");
    project = selected;
  }
  report.project = project;
  const isFunctionalFixture = functionalFixtureMode || (requestedProject ? project.id !== BASELINE_PROJECT_ID : false);
  report.fixture = isFunctionalFixture ? "LOCAL_FUNCTIONAL" : "FULL_BASELINE_CORPUS";
  report.scope.FIXTURE = report.fixture;
  if (isFunctionalFixture) {
    report.scope.FULL_K4_ACCEPTANCE = "NOT_CLAIMED_FUNCTIONAL_FIXTURE";
    report.scope.O2_O5_BYO_AGENT_QUALITY = "NOT_RUN_FUNCTIONAL_FIXTURE";
    report.baseline.fixtureNote = "LOCAL_FUNCTIONAL native fixture: fresh project with 1+ native UTF-8 text sources, autoDistill 0, no distillation, no model calls; not ten-paper O2/O5 quality or live Access.";
  }
  const sourceSnapshotBefore = await collectSources(project.id);
  const sources = sourceSnapshotBefore.rows;
  report.baseline.observedSources = sources.length;
  report.baseline.sourcePaginationPages = sourceSnapshotBefore.pages;
  if (project.id === BASELINE_PROJECT_ID) assert.equal(sources.length, BASELINE_SOURCE_COUNT, "Baseline project source count changed.");
  const readable = sources.filter((row) => row.enabled && row.currentRevisionId && ["readable", "readable_with_warnings"].includes(row.readableState));
  assert(readable.length > 0, "No enabled current readable source is available.");
  const currentRevisions = new Set(readable.map((row) => row.currentRevisionId as string));
  report.sourceInventory = { total: sources.length, enabledCurrentReadable: readable.length, fullSourceAndRevisionIds: true };

  const emptySources = await callTool("list_sources", { projectId: project.id, sourceIds: [], maxTokens: 4000 });
  assert(emptySources.text.includes("No sources explicitly selected."), "Explicit empty selection was not kept empty.");
  const emptyClaims = await callTool("find_claims", { projectId: project.id, sourceIds: [], query: "the", maxTokens: 4000 });
  assert(emptyClaims.text.includes("No verified claims matched."), "find_claims widened explicit empty scope.");
  const emptySearch = await callTool("search", { projectId: project.id, sourceIds: [], query: "и", maxTokens: 4000 });
  assert(emptySearch.text.includes("No readable selected revisions"), "search widened explicit empty scope.");
  report.checks = { explicitEmptyScope: true, outputLimitUtf8Bytes: MAX_OUTPUT_BYTES };

  const otherProject = projects.find((item) => item.id !== project.id);
  let foreignSource: SourceRow | undefined;
  if (otherProject) {
    const foreignList = await callTool("list_sources", { projectId: otherProject.id, maxTokens: 4000 });
    foreignSource = parseSources(foreignList.text).find((row) => row.currentRevisionId && ["readable", "readable_with_warnings"].includes(row.readableState));
  }
  const wrongProjectId = otherProject?.id ?? randomUUID();
  const wrongScope = await callTool("list_sources", { projectId: wrongProjectId, sourceIds: [sources[0]!.id], maxTokens: 4000 }, true);
  report.checks.wrongProjectRejected = { rejected: true, basis: otherProject ? "existing-other-project" : "unknown-project-UUID" };
  const foreignRevisionId = foreignSource?.currentRevisionId ?? randomUUID();
  const foreignRead = await callTool("read", { projectId: project.id, revisionId: foreignRevisionId, start: 0, end: 1, maxTokens: 4000 }, true);
  report.checks.foreignRevisionRejected = { rejected: true, basis: foreignSource ? "revision-from-other-project" : "unknown-revision-UUID" };

  const sample = readable[0]!;
  const guide = await callTool("get_guide", { projectId: project.id, sourceId: sample.id, revisionId: sample.currentRevisionId!, maxTokens: 4000 });
  assert(guide.text.includes("Derived orientation only; it is not primary source evidence."), "get_guide did not label its content as derived.");
  const outline = await callTool("outline", { projectId: project.id, sourceId: sample.id, revisionId: sample.currentRevisionId!, maxTokens: 4000 });
  const outlineRows = parseOutline(outline.text);
  assert(outlineRows.length > 0 && outlineRows.every((row) => currentRevisions.has(row.revisionId)), "outline omitted full current revision labels.");
  const currentSourceIds = readable.map((row) => row.id);
  const searchScope = currentSourceIds.length <= 50 ? currentSourceIds : currentSourceIds.slice(0, 50);
  const enFind = await callTool("find_claims", { projectId: project.id, sourceIds: searchScope, query: "the", maxTokens: 4000 });
  const ruFind = await callTool("find_claims", { projectId: project.id, sourceIds: searchScope, query: "и", maxTokens: 4000 });
  const enSearch = await callTool("search", { projectId: project.id, sourceIds: searchScope, query: "the", maxTokens: 4000 });
  const ruSearch = await callTool("search", { projectId: project.id, sourceIds: searchScope, query: "и", maxTokens: 4000 });
  const enSearchCursor = parseSearchCursor(enSearch.text);
  const ruSearchCursor = parseSearchCursor(ruSearch.text);
  const searchCursorCheck = async (cursor: string | null, query: string): Promise<string> => {
    if (cursor === null) return "NO_NEXT_CURSOR";
    const page = await callTool("search", { projectId: project.id, sourceIds: searchScope, query, cursor, maxTokens: 4000 });
    assert(!page.isError, "search rejected its explicit guide:/claim: continuation cursor.");
    return cursor.startsWith("guide:") ? "GUIDE_CURSOR_ACCEPTED" : "CLAIM_CURSOR_ACCEPTED";
  };
  const enSearchCursorCheck = await searchCursorCheck(enSearchCursor, "the");
  const ruSearchCursorCheck = await searchCursorCheck(ruSearchCursor, "и");
  assert(enFind.text.includes("Only the current readable revisions"), "English find_claims omitted its current-readable scope declaration.");
  assert(ruFind.text.includes("Only the current readable revisions"), "Russian find_claims omitted its current-readable scope declaration.");
  assert(enSearch.text.includes("current readable selected revisions"), "English search omitted its current-readable scope declaration.");
  assert(ruSearch.text.includes("current readable selected revisions"), "Russian search omitted its current-readable scope declaration.");
  const enRefs = onlyCurrentRefs("find_claims EN", enFind.text, currentRevisions);
  const ruRefs = onlyCurrentRefs("find_claims RU", ruFind.text, currentRevisions);
  const enSearchRefs = onlyCurrentRefs("search EN", enSearch.text, currentRevisions);
  const ruSearchRefs = onlyCurrentRefs("search RU", ruSearch.text, currentRevisions);
  const enClaimEvidence = [...parseClaimEvidence(enFind.text), ...parseClaimEvidence(enSearch.text)];
  const ruClaimEvidence = [...parseClaimEvidence(ruFind.text), ...parseClaimEvidence(ruSearch.text)];
  report.literalSearch = {
    EN: {
      terms: "the", findClaimReferences: enRefs.references.length, searchReferences: enSearchRefs.references.length,
      claimRows: enClaimEvidence.length, currentRevisionMembership: "PASS",
      currentVerifiedPrefix: enClaimEvidence.length === 0 ? "NO_POSITIVE_EN" : "PREFIX_NOT_RUN",
      continuationCursor: enSearchCursorCheck,
    },
    RU: {
      terms: "и", findClaimReferences: ruRefs.references.length, searchReferences: ruSearchRefs.references.length,
      claimRows: ruClaimEvidence.length, currentRevisionMembership: "PASS",
      currentVerifiedPrefix: ruClaimEvidence.length === 0 ? "NO_POSITIVE_RU" : "PREFIX_NOT_RUN",
      continuationCursor: ruSearchCursorCheck,
    },
  };

  let localBefore: any = null;
  let localOwner = false;
  if (loopback) {
    const me = await apiJson("/api/me");
    localOwner = me.actor?.type === "owner" && me.actor?.authentication === "local";
    report.localActor = { type: me.actor?.type ?? null, authentication: me.actor?.authentication ?? null, simulatedOwner: localOwner };
    report.ownerSimulation = { status: localOwner ? "RUNNING" : "NOT_RUN", authentication: me.actor?.authentication ?? null };
    localBefore = await localSnapshot(project.id);
    report.usageBefore = localBefore;
    if (project.id === BASELINE_PROJECT_ID) {
      assert(Number(localBefore.autoDistill) === 0, "Baseline autoDistill is no longer off; skipping K4 owner simulation.");
    }
  }

  if (localOwner) {
    for (const [language, evidence] of [["EN", enClaimEvidence], ["RU", ruClaimEvidence]] as const) {
      const outcome = report.literalSearch[language];
      if (evidence.length === 0) {
        outcome.currentVerifiedPrefix = language === "RU" ? "NO_POSITIVE_RU" : "NO_POSITIVE_EN";
        continue;
      }
      const prefix = await verifyCurrentPrefixClaims(evidence, sources);
      outcome.currentVerifiedPrefix = "PASS";
      outcome.prefixClaimsVerified = prefix.verifiedClaims;
      outcome.prefixRevisionIds = prefix.revisionIds;
    }
  } else {
    for (const language of ["EN", "RU"] as const) {
      const outcome = report.literalSearch[language];
      if (outcome.claimRows > 0) outcome.currentVerifiedPrefix = "PREFIX_NOT_RUN";
    }
  }

  if (loopback && localOwner && localBefore && Number(localBefore.autoDistill) === 0) {
    report.proposalFlow = await verifyLocalRangeAndProposal(project.id, sources, outline.text, localBefore);
    report.scope.LOCAL_REAL_MCP_PROTOCOL = "PASS_WITH_LOCAL_OWNER_SIMULATION";
    report.ownerSimulation = { status: "PASS", authentication: "local" };
  } else {
    report.proposalFlow = "NOT_RUN: local owner simulation was not available; no proposal write was sent.";
    report.scope.LOCAL_REAL_MCP_PROTOCOL = loopback ? "READ_ONLY_MCP_ONLY" : "NOT_LOCAL";
    report.ownerSimulation = { status: "NOT_RUN", authentication: localBefore ? "non-local" : "not-observed" };
  }

  const sourceSnapshotAfter = await collectSources(project.id);
  assert.deepEqual(sourceSnapshotAfter.rows, sourceSnapshotBefore.rows, "Source memberships or current revisions changed during the eval.");
  report.checks.sourceInventoryUnchanged = true;
  report.sourceInventory.paginationPagesAfter = sourceSnapshotAfter.pages;
  if (localBefore) {
    const localAfter = await localSnapshot(project.id);
    report.usageAfter = localAfter;
    assert.deepEqual(localAfter, localBefore, "Monthly usage or settings changed during the storage-only eval.");
    assert.equal(localAfter.monthlyUsedMicrousd - localBefore.monthlyUsedMicrousd, 0, "Eval changed monthly model usage.");
    report.checks.monthlyUsageAndSettingsUnchanged = true;
    report.checks.modelCallUsageDeltaMicrousd = 0;
  } else {
    report.checks.monthlyUsageAndSettingsUnchanged = "NOT_OBSERVED_WITHOUT_LOCAL_OWNER";
  }
  report.checks.modelCallsIssued = 0;
  report.checks.aiSearchCallsIssued = 0;
  report.checks.verifiedClaimFtsRows = "NOT_OBSERVED: no MCP tool exposes the total";
  report.runtimeBoundary.remoteBindings = "NOT_PROVEN_OFFLINE; no AI binding called (Vite may warn about configured remote bindings)";
  report.status = "LOCAL_PROTOCOL_EVAL_COMPLETE_WITH_EXPLICIT_LIMITS";
}

async function runSignedAgent(): Promise<void> {
  if (!agentCredential.ready || agentNotRunReason) {
    report.signedAgent = { status: "NOT_RUN", reason: agentNotRunReason ?? agentCredential.reason };
    report.ownerSimulation = { status: "NOT_RUN", reason: "Run the owner simulation separately without --signed-agent." };
    report.status = "SIGNED_AGENT_NOT_RUN";
    return;
  }
  const localUi = new Set(["localhost", "127.0.0.1", "[::1]"]).has(new URL(apiOrigin).hostname);
  if (!loopback || !localUi || agentCredential.source !== "ELIOT_AGENT_JWT") {
    report.signedAgent = { status: "NOT_RUN", reason: "Signed-agent acceptance requires local MCP/API origins and a valid ELIOT_AGENT_JWT; service headers or remote origins are not local JWT proof." };
    report.ownerSimulation = { status: "NOT_RUN", reason: "Run the owner simulation separately without --signed-agent." };
    report.status = "SIGNED_AGENT_NOT_RUN";
    return;
  }
  verifyCursorParsing();
  report.signedAgent = { status: "RUNNING", credentialSource: agentCredential.source };
  report.ownerSimulation = { status: "NOT_RUN", reason: "Run the owner simulation separately without --signed-agent." };
  report.endpoint = { origin, path: mcpUrl.pathname, localLoopback: loopback,
    accessHeadersConfigured: agentCredential.source === "agent-service-headers", signedJwtConfigured: agentCredential.source === "ELIOT_AGENT_JWT" };

  const localSeed = localRuntime ? await seedLocalSignedProject() : null;
  const localStateBefore = localSeed ? await localSideEffectSnapshot(localSeed) : null;
  let outlineMinimumRetry: { advertisedTokens: number; firstBlockId: number; nextCursor: number } | null = null;
  let multiBlockRead: { sourceBytes: number; segments: number; labeledSegments: number } | null = null;
  if (localRuntime) {
    const forgedOrigin = await localRuntime.fetch(new URL("/mcp", localRuntime.uiOrigin), {
      method: "POST",
      headers: {
        ...agentCredential.headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        origin: localRuntime.mcpOrigin,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "k4-origin-probe", version: "0.1.0" },
      } }),
      redirect: "error",
    });
    const forgedOriginBody = await forgedOrigin.text();
    report.originProbe = { requestOrigin: localRuntime.uiOrigin, forgedOrigin: localRuntime.mcpOrigin,
      status: forgedOrigin.status, rejectedBeforeMcpHandler: forgedOrigin.status === 403 && forgedOriginBody.includes("Agent access is not available on this origin.") };
    assert.equal(forgedOrigin.status, 403, "Signed agent POST on the UI host with forged MCP Origin must be rejected with HTTP 403.");
    assert(forgedOriginBody.includes("Agent access is not available on this origin."), "Origin gate must reject the cross-host MCP request before protocol handling.");
  }
  const authProjectId = localSeed?.projectId ?? BASELINE_PROJECT_ID;
  const apiPath = `/api/projects/${authProjectId}/proposals`;
  const apiDeniedStatus = await apiStatus(apiPath);
  assert.equal(apiDeniedStatus, 403, "Signed agent must be denied owner proposal APIs with HTTP 403.");
  const decisionStatus = await apiStatus(`/api/projects/${authProjectId}/proposals/${randomUUID()}/decision`, "POST", {
    decision: "reject", expectedHeadRevisionId: null,
  });
  assert.equal(decisionStatus, 403, "Signed agent must be denied proposal decisions with HTTP 403.");

  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [...TOOL_NAMES].sort(), "The MCP server must expose exactly the eleven K4 tools.");
  assert(!names.some((name) => /accept|approve|decision|owner|publish/iu.test(name)), "An owner-only mutator is exposed as an agent tool.");
  if (localSeed) {
    assert(localRuntime);
    const canonical = await apiJson(`/api/revisions/${localSeed.revisionId}/outline`, "GET", undefined, localRuntime.ownerHeaders);
    assert(Array.isArray(canonical.blocks) && canonical.blocks.length > 1, "Outline minimum-budget regression needs the native fixture's multiple blocks.");
    const tooSmall = await callTool("outline", {
      projectId: localSeed.projectId, sourceId: localSeed.sourceId, revisionId: localSeed.revisionId, maxTokens: 1,
    });
    const minimum = /^Minimum maxTokens: (\d+) to fit one complete result\.$/u.exec(tooSmall.text)?.[1];
    assert(minimum, "One-token outline must advertise the minimum complete first result.");
    const advertisedTokens = Number(minimum);
    const retried = await callTool("outline", {
      projectId: localSeed.projectId, sourceId: localSeed.sourceId, revisionId: localSeed.revisionId, maxTokens: advertisedTokens,
    });
    const first = canonical.blocks[0], next = canonical.blocks[1];
    assert(first && next, "The native outline fixture must include a first block and continuation block.");
    assert(!retried.text.startsWith("Minimum maxTokens:"), "Retrying the advertised outline minimum must return the first complete block.");
    const rows = retried.text.split(/\r?\n/u).filter((line: string) => line.startsWith("- "));
    assert.equal(rows.length, 1, "The minimum outline retry must return exactly the first complete block row.");
    assert(rows[0]?.includes(`bytes [${first.start},${first.end})`), "The minimum outline retry omitted the first block's full byte range.");
    assert(retried.text.includes(`Continue at block ${next.id} with integer cursor ${next.id}.`), "The minimum outline retry omitted its continuation cursor.");
    outlineMinimumRetry = { advertisedTokens, firstBlockId: first.id, nextCursor: next.id };
  }
  const refreshDenied = await callTool("refresh_models", {}, true);
  const understandingDenied = await callTool("request_understanding", {
    sourceId: localSeed?.sourceId ?? randomUUID(), ...(localSeed ? { revisionId: localSeed.revisionId } : {}),
  }, true);
  assert(/only the owner/i.test(refreshDenied.text), "Agent must be denied catalogue refresh before provider access.");
  assert(/only the owner/i.test(understandingDenied.text), "Agent must be denied understanding before any paid dispatch.");

  const projects = await collectProjects();
  const requestedProject = localSeed?.projectId ?? envValue("ELIOT_EVAL_PROJECT");
  if (functionalFixtureMode && !requestedProject) throw new Error('Functional fixture mode requires explicit ELIOT_EVAL_PROJECT for a fresh native integration namespace.');
  const project = requestedProject
    ? projects.find((item) => item.title === requestedProject || item.id === requestedProject)
    : projects.find((item) => item.id === BASELINE_PROJECT_ID);
  assert(project, requestedProject ? "ELIOT_EVAL_PROJECT did not match a listed project." : "Baseline project was not returned by list_projects.");
  const sourcePage = await collectSources(project.id);
  const source = sourcePage.rows.find((row) => row.enabled && row.currentRevisionId && ["readable", "readable_with_warnings"].includes(row.readableState));
  assert(source?.currentRevisionId, "No enabled current readable source is available for the signed-agent proposal.");
  const revisionId = source.currentRevisionId;
  const outline = await callTool("outline", { projectId: project.id, sourceId: source.id, revisionId, maxTokens: 4000 });
  const candidate = parseOutline(outline.text).find((row) => row.revisionId === revisionId);
  assert(candidate && candidate.end > candidate.start, "MCP outline did not return a current source range for the proposal.");
  const read = await callTool("read", { projectId: project.id, revisionId, start: candidate.start, end: candidate.end, maxTokens: 4000 });
  assert(read.text.includes(candidate.label), "MCP read did not preserve the source citation label.");
  if (localSeed) {
    assert(localRuntime);
    const canonicalBytes = await apiBytes(`/api/revisions/${localSeed.revisionId}/text`, localRuntime.ownerHeaders);
    const canonicalOutline = await apiJson(`/api/revisions/${localSeed.revisionId}/outline`, "GET", undefined, localRuntime.ownerHeaders);
    const sourceText = decoder.decode(canonicalBytes);
    assert(sourceText.includes("точность") && sourceText.includes("🌍"), "Multi-block read fixture lost its Cyrillic or emoji text.");
    const blocks = parseOutline(outline.text).filter((row) => row.revisionId === localSeed.revisionId);
    assert(blocks.length > 1 && canonicalOutline.blocks.length > 1, "Multi-block read fixture needs multiple citable and canonical blocks.");
    const multi = await callTool("read", { projectId: localSeed.projectId, revisionId: localSeed.revisionId,
      start: 0, end: canonicalBytes.byteLength, maxTokens: 4000 });
    const segments = [...multi.text.matchAll(/^Source segment (.+?) — source bytes \[(\d+),(\d+)\)$/gmu)];
    let sourceOffset = 0, labeledSegments = 0;
    for (const match of segments) {
      const label = match[1], start = Number(match[2]), end = Number(match[3]);
      assert(label !== undefined && end > start && start === sourceOffset, "Read segments must preserve the complete source byte order.");
      const exact = decoder.decode(canonicalBytes.subarray(start, end));
      const contentStart = (match.index ?? -1) + match[0].length + 1;
      assert.equal(multi.text.slice(contentStart, contentStart + exact.length), exact, "Read segment text differs from its canonical source bytes.");
      if (label !== "unlabelled") {
        const block = blocks.find((row) => row.label === label);
        assert(block, "Read segment label must be an exact citable outline label.");
        const canonicalBlock = canonicalOutline.blocks.find((row: any) => row.id === block.block);
        assert(canonicalBlock && start === canonicalBlock.start && end === canonicalBlock.end,
          "Read segment label does not map to its exact canonical block range.");
        labeledSegments++;
      }
      sourceOffset = end;
    }
    assert.equal(sourceOffset, canonicalBytes.byteLength, "Read output must preserve trailing partial bytes and wrappers.");
    assert(labeledSegments > 1, "Multi-block read must label each complete citable source segment.");
    multiBlockRead = { sourceBytes: sourceOffset, segments: segments.length, labeledSegments };
  }

  const proposalBody = `${candidate.label}\n\nSigned-agent K4 boundary check ${runId}.`;
  const proposalTitle = `K4 signed-agent eval ${runId}`;
  const proposal = await callTool("propose_page", {
    projectId: project.id, kind: "note", title: proposalTitle, body: proposalBody,
    revisionIds: [revisionId], mutationId: randomUUID(),
  });
  assert.equal(proposal.httpStatus, 200, "MCP propose_page must return HTTP 200.");
  const ids = new RegExp("Proposed page: (" + UUID + ")\\s+Proposal revision: (" + UUID + ")\\s+Status: (\\w+)", "u").exec(proposal.text);
  assert(ids?.[1] && ids[2] && ids[3] === "proposed", "MCP propose_page did not return a pending proposal.");

  let localOwnerAcceptance: Record<string, unknown> | null = null;
  if (localRuntime) {
    assert(localSeed);
    const pageId = ids[1], proposalRevisionId = ids[2], ownerHeaders = localRuntime.ownerHeaders;
    const viewed = (await apiJson(`/api/projects/${project.id}/proposals/${proposalRevisionId}`, "GET", undefined, ownerHeaders)).proposal;
    assert.equal(viewed.status, "proposed"); assert.equal(viewed.headRevisionId, null);
    assert.equal(viewed.baseRevisionId, null); assert.equal(viewed.citations.length, 1);
    assert.equal(viewed.citations[0].revisionId, revisionId); assert.equal(viewed.citations[0].block, candidate.block);
    assert.equal(viewed.citations[0].start, candidate.start); assert.equal(viewed.citations[0].end, candidate.end);
    const accepted = (await apiJson(`/api/projects/${project.id}/proposals/${proposalRevisionId}/decision`, "POST",
      { decision: "accept", expectedHeadRevisionId: viewed.headRevisionId }, ownerHeaders)).proposal;
    assert.equal(accepted.status, "accepted"); assert.equal(accepted.headRevisionId, proposalRevisionId);
    const savedPage = (await apiJson(`/api/projects/${project.id}/pages/${pageId}`, "GET", undefined, ownerHeaders)).page;
    assert.equal(savedPage.headRevisionId, proposalRevisionId); assert.equal(savedPage.body, proposalBody);
    assert.deepEqual(citationIdentity(savedPage.citations), citationIdentity(viewed.citations), "Owner acceptance changed citation identity.");
    const citation = savedPage.citations[0];
    const canonical = await apiBytes(`/api/revisions/${citation.revisionId}/text`, ownerHeaders);
    const range = await apiBytes(`/api/revisions/${citation.revisionId}/range?start=${citation.start}&end=${citation.end}`, ownerHeaders);
    assert.deepEqual(range, canonical.subarray(citation.start, citation.end), "Accepted citation range differs from canonical UTF-8 bytes.");
    const acceptedByAgent = await callTool("get_page", { projectId: project.id, pageId, maxTokens: 4000 });
    assert(acceptedByAgent.text.includes("immutable head revision " + proposalRevisionId));
    assert(acceptedByAgent.text.includes(candidate.label));
    const after = await localSideEffectSnapshot(localSeed);
    assert.deepEqual(after, localStateBefore, "Agent owner-only tools changed model/catalogue or understanding state.");
    localOwnerAcceptance = { proposalViewed: viewed.status, decision: accepted.status, acceptedHead: savedPage.headRevisionId,
      citationRangeBytes: range.byteLength, exactRangeMatches: true, acceptedPageReadableByAgent: true,
      settingsCatalogAndUnderstandingUnchanged: true };
  }

  report.project = project;
  const isFunctionalFixture = functionalFixtureMode || (requestedProject ? project.id !== BASELINE_PROJECT_ID : false);
  report.fixture = isFunctionalFixture ? "LOCAL_FUNCTIONAL" : "FULL_BASELINE_CORPUS";
  report.scope.FIXTURE = report.fixture;
  if (isFunctionalFixture) {
    report.scope.FULL_K4_ACCEPTANCE = "NOT_CLAIMED_FUNCTIONAL_FIXTURE";
    report.scope.O2_O5_BYO_AGENT_QUALITY = "NOT_RUN_FUNCTIONAL_FIXTURE";
    report.baseline.fixtureNote = "LOCAL_FUNCTIONAL native fixture: fresh project with 1+ native UTF-8 text sources, autoDistill 0, no distillation, no model calls; not ten-paper O2/O5 quality or live Access.";
  }
  report.server = { toolNames: names, toolCount: names.length, noOwnerDecisionTools: true, ownerOnlySideEffectsDenied: true };
  report.checks = { ownerApiDeniedStatus: apiDeniedStatus, proposalDecisionDeniedStatus: decisionStatus,
    mcpProposePageHttpStatus: proposal.httpStatus, refreshModelsDenied: true, requestUnderstandingDenied: true,
    outlineMinimumRetry: outlineMinimumRetry ?? "NOT_RUN",
    multiBlockRead: multiBlockRead ?? "NOT_RUN",
    modelCallsIssued: 0, aiSearchCallsIssued: 0 };
  report.signedAgent = {
    status: localRuntime ? "PASS_TEST_JWKS_LOCAL_MCP" : "PASS",
    credentialSource: agentCredential.source,
    apiDeniedStatus: apiDeniedStatus,
    proposalDecisionDeniedStatus: decisionStatus,
    proposePageHttpStatus: proposal.httpStatus,
    ownerOnlySideEffectsDenied: true,
    ...(localOwnerAcceptance === null ? {} : { ownerAcceptance: localOwnerAcceptance }),
    proposalStatus: "proposed",
    pageId: ids[1],
    revisionId: ids[2],
    authenticationPath: "signed request handled by Worker authenticate; eval did not decode or assign actor role",
  };
  report.scope.LOCAL_REAL_MCP_PROTOCOL = localRuntime ? "SIGNED_AGENT_MCP_PROTOCOL_PASS_TEST_JWKS" : loopback ? "SIGNED_AGENT_MCP_PROTOCOL_PASS" : "NOT_LOCAL";
  report.scope.LIVE_ACCESS_NOT_RUN = loopback;
  report.runtimeBoundary.liveAccess = localRuntime ? "NOT_RUN_TEST_JWKS_FIXTURE" : loopback ? "NOT_RUN_LOOPBACK_SIGNED_PATH" : "SIGNED_ACCESS_REQUESTS_COMPLETED";
  report.status = localRuntime ? "LOCAL_SIGNED_MCP_TRANSPORT_PASS" : "SIGNED_AGENT_BOUNDARY_PASS";
}

async function main(): Promise<void> {
  verifyCursorParsing();
  if (signedAgentMode) return runSignedAgent();
  return runOwnerSimulation();
}

function markdown(): string {
  const checks = report.checks ?? {};
  const outlineRetry = checks.outlineMinimumRetry && typeof checks.outlineMinimumRetry === "object" ? checks.outlineMinimumRetry : null;
  const readSegments = checks.multiBlockRead && typeof checks.multiBlockRead === "object" ? checks.multiBlockRead : null;
  const literal = report.literalSearch ?? {};
  const proposal = typeof report.proposalFlow === "object" ? report.proposalFlow : null;
  const lines = [
    "# K4 real MCP protocol evaluation",
    "",
    `- Run: ${runId}`,
    `- MCP origin: ${report.endpoint.origin}`,
    `- Mode: ${report.mode}; signed-agent=${report.signedAgent.status}; owner-simulation=${report.ownerSimulation.status}`,
    `- Signed-agent boundary: API=${report.signedAgent.apiDeniedStatus ?? "NOT_RUN"}; decision=${report.signedAgent.proposalDecisionDeniedStatus ?? "NOT_RUN"}; propose_page HTTP=${report.signedAgent.proposePageHttpStatus ?? "NOT_RUN"}; reason=${report.signedAgent.reason ?? "none"}`,
    `- Search cursor parse: guide=${report.cursorParsing?.guidePrefixAccepted ?? false}; claim=${report.cursorParsing?.claimPrefixAccepted ?? false}; UUID entity cursors unchanged=${report.cursorParsing?.otherUuidCursorUnchanged ?? false}`,
    `- Client: ${report.client.package} ${report.client.version} with ${report.client.transport}; SDK protocol defaults` ,
    `- Scope: LOCAL_REAL_MCP_PROTOCOL=${report.scope.LOCAL_REAL_MCP_PROTOCOL}; LIVE_ACCESS_NOT_RUN=${report.scope.LIVE_ACCESS_NOT_RUN}`,
    `- Signed MCP forged-Origin probe: ${report.originProbe?.status ?? "NOT_RUN"}; rejected before protocol handler=${report.originProbe?.rejectedBeforeMcpHandler ?? "NOT_RUN"}`,
    `- Outline minimum-budget retry: ${outlineRetry ? `PASS at ${outlineRetry.advertisedTokens} tokens; first block ${outlineRetry.firstBlockId}; next cursor ${outlineRetry.nextCursor}` : "NOT_RUN"}`,
    `- Multi-block read mapping: ${readSegments ? `PASS; ${readSegments.labeledSegments} labeled segments across ${readSegments.segments} source segments / ${readSegments.sourceBytes} bytes` : "NOT_RUN"}`,
    `- Full K4 acceptance: ${report.scope.FULL_K4_ACCEPTANCE}; actual BYO-agent O2/O5 quality: ${report.scope.O2_O5_BYO_AGENT_QUALITY}`,
    "- Fixture: " + (report.fixture ?? report.scope.FIXTURE ?? "NOT_SELECTED") + " (LOCAL_FUNCTIONAL=fresh native namespace without distillation; FULL_BASELINE_CORPUS=original ten-paper material)",
    `- Project: ${report.project?.title ?? "NOT_SELECTED"} (${report.project?.id ?? "NOT_SELECTED"})`,
    `- Sources: ${report.sourceInventory?.total ?? "NOT_OBSERVED"}; pagination pages ${report.baseline?.sourcePaginationPages ?? "NOT_OBSERVED"}; expected baseline ${BASELINE_SOURCE_COUNT}`,
    `- Verified-claim FTS row total: ${report.checks?.verifiedClaimFtsRows ?? "NOT_OBSERVED"}`,
    `- Tools: ${report.server?.toolCount ?? 0}/11; owner decision tools exposed: ${report.server?.noOwnerDecisionTools === true ? "NO" : "NOT_RUN"}; owner-only side effects denied to agent: ${report.server?.ownerOnlySideEffectsDenied ?? "NOT_RUN"}`,
    `- Max observed MCP output: ${Math.max(0, ...(report.toolCalls ?? []).map((call: any) => call.utf8Bytes))} / ${MAX_OUTPUT_BYTES} UTF-8 bytes`,
    `- Literal EN search refs: ${literal.EN?.findClaimReferences ?? 0} find_claims, ${literal.EN?.searchReferences ?? 0} search; revision membership=${literal.EN?.currentRevisionMembership ?? "NOT_RUN"}; current-prefix=${literal.EN?.currentVerifiedPrefix ?? "NOT_RUN"}`,
    `- Literal RU search refs: ${literal.RU?.findClaimReferences ?? 0} find_claims, ${literal.RU?.searchReferences ?? 0} search; revision membership=${literal.RU?.currentRevisionMembership ?? "NOT_RUN"}; current-prefix=${literal.RU?.currentVerifiedPrefix ?? "NOT_RUN"}`,
    `- Empty scope, wrong project, foreign revision rejected: ${checks.explicitEmptyScope ?? false} / ${checks.wrongProjectRejected?.rejected ?? false} / ${checks.foreignRevisionRejected?.rejected ?? false}`,
    `- Source inventory unchanged: ${checks.sourceInventoryUnchanged ?? false}; monthly usage/settings unchanged: ${checks.monthlyUsageAndSettingsUnchanged ?? "NOT_RUN"}`,
    `- Model calls / AI Search calls issued: ${checks.modelCallsIssued ?? 0} / ${checks.aiSearchCallsIssued ?? 0}; monthly model usage delta: ${checks.modelCallUsageDeltaMicrousd ?? "NOT_OBSERVED"} micro-USD`,
    `- Remote bindings offline: NOT_CLAIMED; cron state: ${report.runtimeBoundary.crons}; live Access: ${report.runtimeBoundary.liveAccess}`,
    `- Request-size gate: SDK init valid; small tools/list ${report.requestSize?.smallStatus ?? "NOT_RUN"} ${report.requestSize?.smallBytes ?? "NOT_OBSERVED"} bytes; oversized ${report.requestSize?.oversizedBytesSent ?? "NOT_OBSERVED"} bytes returns ${report.requestSize?.oversizedStatus ?? "NOT_RUN"} ${report.requestSize?.oversizedBytes ?? "NOT_OBSERVED"} bytes; small-after ${report.requestSize?.smallAfterStatus ?? "NOT_RUN"}; limit ${MCP_REQUEST_BODY_LIMIT} bytes; model calls 0`,
    `- Seed-native: ${report.seed ? `project ${report.seed.projectId} source ${report.seed.sourceId} revision ${report.seed.revisionId} ${report.seed.seedBytes} bytes; projects ${report.seed.projectsBefore}->${report.seed.projectsAfter}` : "NOT_USED"}; explicit local-only owner API; no existing changes/deletes/settings/AI/Understand`,
  ];
  if (proposal) {
    lines.push(`- Local proposal fixture: page ${proposal.proposal.pageId}, accepted revision ${proposal.proposal.acceptedRevisionId}, rejected revision ${proposal.proposal.rejectedRevisionId}`);
    lines.push(`- Exact canonical citation identity survived accept and reject: ${proposal.proposal.acceptedHeadPreservedAfterReject}; get_page pages ${proposal.proposal.getPagePaginationPages}`);
    lines.push(`- get_page boundary case: ${proposal.proposal.getPageBoundaryProof?.capBytes ?? "NOT_RUN"} UTF-8 bytes/page; shifted R label met the first cap at a token edge; no UTF-8 or label split`);
    lines.push(`- REST /range exact byte comparisons: ${proposal.restRanges.length}; canonical source SHA-256 ${proposal.source.sha256}`);
  } else {
    lines.push(`- Proposal/range flow: ${typeof report.proposalFlow === "string" ? report.proposalFlow : "NOT_RUN"}`);
  }
  lines.push("", "This is local real-MCP protocol evidence only. It does not qualify live Access or full K4 answer quality.", "");
  return lines.join("\n");
}

try {
  await main();
} catch (error) {
  report.status = "FAIL";
  report.failure = error instanceof Error ? error.name : "UnknownError";
  let detail = error instanceof Error ? error.message : "Unknown error.";
  for (const token of [localRuntime?.agentHeaders["cf-access-jwt-assertion"], localRuntime?.ownerHeaders["cf-access-jwt-assertion"]])
    if (token) detail = detail.replaceAll(token, "[redacted test JWT]");
  report.failureMessage = detail.slice(0, 1200);
  process.exitCode = 1;
} finally {
  try { await client.close(); } catch { /* keep the original eval result */ }
  try { await localRuntime?.dispose(); } catch { /* preserve the eval result */ }
  await mkdir(outDir, { recursive: true });
  await writeFile(`${outDir}/k4-${runId}.json`, JSON.stringify(report, null, 2) + "\n", "utf8");
  const md = markdown();
  await writeFile(`${outDir}/k4-${runId}.md`, md, "utf8");
  console.log(md);
  if (report.failure) console.error(`K4 eval failed (${report.failure}): ${report.failureMessage ?? "No error detail."}`);
}
