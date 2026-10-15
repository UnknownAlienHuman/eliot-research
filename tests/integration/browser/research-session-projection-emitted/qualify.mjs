import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire, Module } from "node:module";
import { createServer as createTcpServer } from "node:net";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, createServer } from "vite";
import { chromium } from "playwright-core";

const workspaceRoot = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const harnessRoot = path.dirname(fileURLToPath(import.meta.url));
const donorStateRoot = String.raw`C:\Development\Research\eliot-research\.eliotr-state\frontend-service-release-20261011`;
const ownerHandoffPath = path.join(donorStateRoot, "owning-recent-generated-handoff-20261013.json");
const miniflarePackagePath = path.join(workspaceRoot,
  "node_modules/.pnpm/miniflare@5.20260926.1-alpha_@types+node@26.4.0/node_modules/miniflare/package.json");
const sourceFiles = {
  preparedRuntime: path.join(workspaceRoot, "scripts/lib/deployment-owner-web-prepared-core.mjs"),
  browserEntry: path.join(harnessRoot, "browser-entry.ts"),
  browserHtml: path.join(harnessRoot, "browser-entry.html"),
  workerEntry: path.join(harnessRoot, "worker-entry.mjs"),
  testShim: path.join(harnessRoot, "cloudflare-test-shim.mjs"),
  workersShim: path.join(harnessRoot, "cloudflare-workers-shim.mjs"),
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseNativePort(argv) {
  if (argv.length !== 2 || argv[0] !== "--native-port") {
    throw new Error("usage: node qualify.mjs --native-port <root-granted-port>");
  }
  const port = Number(argv[1]);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("native port must be a valid granted TCP port");
  return port;
}

async function assertPortFree(port) {
  const probe = createTcpServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => probe.close((error) => error ? reject(error) : resolve()));
  });
}

async function verifyOwnerPin(root, pin) {
  const filename = path.resolve(root, pin.path);
  assert.equal(await realpath(filename), filename, `pinned path resolved through a link: ${pin.path}`);
  const bytes = await readFile(filename);
  assert.equal(bytes.length, pin.byte_length, `pinned length drifted: ${pin.path}`);
  assert.equal(sha256(bytes), pin.sha256, `pinned hash drifted: ${pin.path}`);
  return bytes;
}

async function buildBrowserEntry() {
  const result = await build({
    configFile: false,
    root: workspaceRoot,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      sourcemap: false,
      lib: { entry: sourceFiles.browserEntry, name: "EliotResearchSessionQualification", formats: ["iife"] },
      rollupOptions: { output: { inlineDynamicImports: true, entryFileNames: "entry.js" } },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) => item.output ?? []);
  const chunks = outputs.filter((output) => output.type === "chunk");
  assert.equal(chunks.length, 1, "qualification entry must be one bundled browser script");
  const code = chunks[0].code;
  assert(code.includes("createResearchSessionProjectionAdapter"), "owner projection adapter is absent from browser bundle");
  assert(code.includes("AgentClient"), "official agents/client implementation is absent from browser bundle");
  return { code, byte_length: Buffer.byteLength(code), sha256: sha256(Buffer.from(code)) };
}

function stable(value) {
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString("base64") };
  if (value instanceof ArrayBuffer) return stable(new Uint8Array(value));
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

async function snapshotD1(database) {
  const tableResult = await database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all();
  assert.equal(tableResult.success, true, "D1 table inventory failed");
  const tables = [];
  for (const { name } of tableResult.results.filter(({ name }) =>
    !name.startsWith("_cf_") && !name.startsWith("_mf_") && !name.startsWith("sqlite_"))) {
    const quoted = `"${String(name).replaceAll('"', '""')}"`;
    const result = await database.prepare(`SELECT * FROM ${quoted}`).all();
    assert.equal(result.success, true, `D1 readback failed for ${name}`);
    const rows = result.results.map(stable).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    tables.push({ name, rows });
  }
  return { tables, sha256: sha256(Buffer.from(JSON.stringify(tables))) };
}

async function snapshotR2(bucket, key) {
  const object = await bucket.get(key);
  assert(object, `fixture R2 object is missing: ${key}`);
  const bytes = Buffer.from(await object.arrayBuffer());
  return { key, byte_length: bytes.length, sha256: sha256(bytes) };
}

function collectIdentity(token) {
  const [encodedHeader, encodedPayload] = token.split(".");
  const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  assert.equal(payload.iss, "https://owner-e2e.cloudflareaccess.com");
  assert.deepEqual(payload.aud, ["owner-e2e-audience"]);
  assert.equal(payload.type, "app");
  assert.equal(typeof payload.sub, "string");
  assert.equal(typeof payload.iat, "number");
  assert.equal(typeof payload.exp, "number");
  return {
    principal_ref: payload.sub,
    credential_generation: `cf-access-jwt:${header.kid}:${payload.iat}`,
    expires_at_ms: payload.exp * 1000,
  };
}

async function waitForSocketEvent(page, count, kind) {
  await page.waitForFunction(({ expected, eventKind }) => {
    const sockets = (window.__ELIOT_PROJECTION_SOCKETS__ ?? []);
    return sockets.reduce((total, socket) => total + socket.events.filter((event) => event.type === eventKind).length, 0) >= expected;
  }, { expected: count, eventKind: kind }, { timeout: 10_000 });
}

const nativePort = parseNativePort(process.argv.slice(2));
const runId = randomUUID();
const outputDirectory = path.join(workspaceRoot, ".eliotr-state", "research-session-projection-emitted-browser");
const outputPath = path.join(outputDirectory, `${runId}.json`);
const report = {
  protocol: "eliotr.research-session-emitted-browser-qualification.v1",
  run_id: runId,
  started_at: new Date().toISOString(),
  state: "RUNNING",
  namespace: `issue-334-${runId}`,
  native_port: nativePort,
  pids: { runner: process.pid, miniflare_host: process.pid },
  node_version: process.version,
  provider_execution: "NOT_RUN",
  external_egress: "DENIED; only ephemeral Access JWKS loopback is allowed",
  cleanup: { browser_closed: false, miniflare_disposed: false, port_released: false },
};

let vite;
let browserServer;
let browser;
let context;
let pageA;
let pageB;
let miniflareInstance;
let runtime;
let d1;
let searchD1;
let workBucket;
let workerOrigin;
let accessToken;
let originalModuleLoad;
let failure;

try {
  await assertPortFree(nativePort);
  const owner = JSON.parse(await readFile(ownerHandoffPath, "utf8"));
  assert.equal(owner.issue, 333, "owning generated handoff issue changed");
  assert.equal(owner.source_head, "d4cdb8bf9adc0915920f898711473dd7e8594a21");
  const donorRoot = path.resolve(owner.root);
  assert.equal(donorRoot, path.join(donorStateRoot, "release-7e4668ad"));
  const workerPin = await verifyOwnerPin(donorRoot, { ...owner.worker, path: path.relative(donorRoot, owner.worker.path).replaceAll("\\", "/") });
  const graphPin = await verifyOwnerPin(donorRoot, { ...owner.observed_graph, path: path.relative(donorRoot, owner.observed_graph.path).replaceAll("\\", "/") });
  const configPin = await verifyOwnerPin(donorRoot, { ...owner.emitted_config, path: path.relative(donorRoot, owner.emitted_config.path).replaceAll("\\", "/") });
  report.source = {
    source_head: owner.source_head,
    worker: { byte_length: workerPin.length, sha256: sha256(workerPin) },
    graph: { byte_length: graphPin.length, sha256: sha256(graphPin) },
    emitted_config: { byte_length: configPin.length, sha256: sha256(configPin) },
    worker_path: owner.worker.path,
  };
  report.stage = "owning-artifact-pins-verified";
  const donorHelperPath = path.join(donorRoot, "scripts/lib/deployment-owner-web-prepared-core.mjs");
  const localHelperPath = sourceFiles.preparedRuntime;
  const donorHelperHash = sha256(await readFile(donorHelperPath));
  const localHelperHash = sha256(await readFile(localHelperPath));
  assert.equal(localHelperHash, donorHelperHash, "prepared runtime helper differs from the retained owning donor");
  report.prepared_runtime_helper_sha256 = localHelperHash;
  const preparedHelperSource = await readFile(localHelperPath, "utf8");
  assert(preparedHelperSource.includes("allow:['127.0.0.1/32']"), "prepared runtime egress allowlist drifted");
  report.egress_allowlist = ["127.0.0.1/32"];

  const browserBundle = await buildBrowserEntry();
  report.browser_bundle = browserBundle;
  const miniflarePackage = await realpath(miniflarePackagePath);
  const miniflareRequire = createRequire(miniflarePackage);
  const miniflareModule = miniflareRequire("miniflare");
  const diagnosticKey = randomUUID();
  const htmlTemplate = await readFile(sourceFiles.browserHtml, "utf8");
  const workerEntryTemplate = await readFile(sourceFiles.workerEntry, "utf8");
  const qualification = {
    diagnostic_key: diagnosticKey,
    html: htmlTemplate,
    browser_bundle: browserBundle.code,
  };
  const workerEntrySource = workerEntryTemplate.replace(
    "__ELIOT_PROJECTION_QUALIFICATION__",
    () => JSON.stringify(qualification).replaceAll("<", "\\u003c"),
  );
  assert.notEqual(workerEntrySource, workerEntryTemplate, "isolated Worker entry template was not instantiated");
  report.isolated_worker_entry_sha256 = sha256(Buffer.from(workerEntrySource));
  report.miniflare_version = miniflareRequire("./package.json").version;
  assert.equal(report.miniflare_version, "5.20260926.1-alpha");

  const miniflareModuleForHelper = Object.create(miniflareModule);
  const NativeMiniflare = miniflareModule.Miniflare;
  const workerDir = path.join(donorRoot, "apps/eliotr-web/dist/eliotr_core");
  const isolatedEntryPath = path.join(workerDir, "__research_session_projection_qualification.mjs");
  const capturedD1 = new Map();
  const capturedR2 = new Map();
  const QualifiedMiniflare = class extends NativeMiniflare {
    constructor(options) {
      const workers = Array.isArray(options.workers) ? options.workers : Object.values(options.workers ?? {});
      const core = workers.find((worker) => {
        const config = worker.config ?? worker;
        const manifest = config.manifest ?? worker.manifest;
        return config.name === "core" || manifest?.mainModule === "index.js" ||
          Object.keys(manifest?.modules ?? {}).some((name) => path.posix.basename(name) === "index.js");
      });
      const coreConfig = core?.config ?? core;
      assert(coreConfig, `prepared Core worker missing; received ${JSON.stringify(workers.map((worker) => ({
        keys: Object.keys(worker), name: worker.name, config_name: worker.config?.name,
        main_module: worker.config?.manifest?.mainModule,
      })))}`);
      const manifest = coreConfig.manifest;
      assert(manifest && manifest.modules, "emitted module manifest is missing");
      const indexModule = Object.keys(manifest.modules).find((name) => path.posix.basename(name) === "index.js");
      assert(indexModule, "emitted index.js absent from Miniflare manifest");
      assert.equal(coreConfig.env?.AI, undefined, "Workers AI binding must stay absent");
      assert.equal(coreConfig.env?.BROWSER, undefined, "Browser binding must stay absent");
      const entryModule = path.relative(manifest.modulesRoot, isolatedEntryPath).split(path.sep).join("/");
      manifest.modules[entryModule] = { type: "esm", contents: workerEntrySource };
      manifest.mainModule = entryModule;
      options.host = "127.0.0.1";
      options.port = nativePort;
      options.inspectorPort = 0;
      super(options);
      miniflareInstance = this;
    }

    async getD1Database(binding, ...args) {
      const database = await super.getD1Database(binding, ...args);
      capturedD1.set(binding, database);
      return database;
    }

    async getR2Bucket(binding, ...args) {
      const bucket = await super.getR2Bucket(binding, ...args);
      capturedR2.set(binding, bucket);
      return bucket;
    }
  };
  Object.defineProperty(miniflareModuleForHelper, "Miniflare", { value: QualifiedMiniflare, enumerable: true });
  originalModuleLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "miniflare") return miniflareModuleForHelper;
    return originalModuleLoad.call(this, request, parent, isMain);
  };

  const testShimPath = sourceFiles.testShim;
  const workersShimPath = sourceFiles.workersShim;
  vite = await createServer({
    configFile: false,
    root: workspaceRoot,
    logLevel: "silent",
    appType: "custom",
    server: { middlewareMode: true, fs: { allow: [workspaceRoot] } },
    resolve: {
      alias: [
        { find: /^cloudflare:test$/, replacement: testShimPath },
        { find: /^cloudflare:workers$/, replacement: workersShimPath },
      ],
    },
  });
  const preparedModule = await vite.ssrLoadModule("/scripts/lib/deployment-owner-web-prepared-core.mjs");
  assert.equal(typeof preparedModule.createPreparedCoreStartupRuntime, "function");
  const originalFetchAtStartup = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "127.0.0.1" && url.port === String(nativePort)) workerOrigin = url.origin;
    return originalFetchAtStartup(input, init);
  };
  try {
    runtime = await preparedModule.createPreparedCoreStartupRuntime({
      root: donorRoot,
      sourceCommit: owner.source_head,
      signal: new AbortController().signal,
      remaining: () => 120_000,
    });
  } finally {
    globalThis.fetch = originalFetchAtStartup;
  }
  assert(miniflareInstance, "Miniflare instance was not captured");
  assert.equal(workerOrigin, `http://127.0.0.1:${nativePort}`);
  d1 = capturedD1.get("CORE_DB");
  searchD1 = capturedD1.get("SEARCH_DB");
  workBucket = capturedR2.get("WORK_BUCKET") ?? await miniflareInstance.getR2Bucket("WORK_BUCKET", "core");
  assert(d1 && searchD1 && workBucket, "prepared D1/R2 handles were not captured");
  report.pids.miniflare_host = process.pid;
  report.native_origin = workerOrigin;
  report.namespace = `issue-334-${runId}`;

  const preparedEvidence = await runtime.evidence();
  assert.equal(preparedEvidence.source_commit, owner.source_head);
  assert.equal(preparedEvidence.scope, "LOCAL_PREPARED_CORE_EMPTY_D1_R2_SIGNED_JWT_ONLY_NOT_LIVE");
  assert.equal(preparedEvidence.run_and_draft_tables_empty, true);
  assert.equal(preparedEvidence.remote_mutations, 0);
  report.prepared_runtime = preparedEvidence;
  report.namespace = preparedEvidence.local_overlay.DEPLOYMENT_GENERATION;
  report.stage = "emitted-runtime-pins-and-migrations-verified";

  let capturedToken;
  const originalFetchForToken = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const token = headers.get("cf-access-jwt-assertion");
    if (token !== null) capturedToken = token;
    return originalFetchForToken(input, init);
  };
  let sessionResponse;
  try {
    sessionResponse = await runtime.get("/api/v1/system/session");
  } finally {
    globalThis.fetch = originalFetchForToken;
  }
  assert.equal(sessionResponse.status, 200, `prepared signed Access identity failed: ${sessionResponse.bytes.toString("utf8").slice(0, 400)}`);
  assert(capturedToken, "valid ephemeral Access token was not observed at the existing HTTP seam");
  accessToken = capturedToken;
  const identity = collectIdentity(accessToken);
  report.access = { principal_ref: identity.principal_ref, credential_generation: identity.credential_generation, expires_at_ms: identity.expires_at_ms };
  report.stage = "ephemeral-access-jwt-verified";

  globalThis.__eliotProjectionNativeEnv = {
    CORE_DB: d1,
    SEARCH_DB: searchD1,
    WORK_BUCKET: workBucket,
    CORE_MIGRATIONS: [],
    SEARCH_MIGRATIONS: [],
    DEPLOYMENT_GENERATION: preparedEvidence.local_overlay.DEPLOYMENT_GENERATION,
  };
  const workflowFixtureModule = await vite.ssrLoadModule("/apps/eliotr-core/test/research-workflow-fixture.ts");
  Object.assign(workflowFixtureModule.principal, {
    principal_ref: identity.principal_ref,
    credential_generation: identity.credential_generation,
    deployment_generation: preparedEvidence.local_overlay.DEPLOYMENT_GENERATION,
  });
  const legacyFixtureModule = await vite.ssrLoadModule("/apps/eliotr-core/test/research-session-legacy-fixture.ts");
  const fixture = await legacyFixtureModule.prepareHistoricalV2Workflow(`emitted-browser-${runId}`, {
    search_database: searchD1,
    search_migrations: [],
    migrations_applied: true,
  });
  const operationId = fixture.request.operation_id;
  assert.equal(fixture.principal.principal_ref, identity.principal_ref);
  assert.equal(fixture.principal.credential_generation, identity.credential_generation);
  report.fixture = {
    operation_id: operationId,
    investigation_ref: fixture.request.investigation_ref,
    scope_snapshot_id: fixture.scope.snapshot_id,
    principal_ref: identity.principal_ref,
    credential_generation: identity.credential_generation,
    r2_object_ref: fixture.request.input_manifest.object_ref,
  };
  report.stage = "historical-v2-scope-grant-run-r2-fixture-prepared";
  const binding = {
    agent: "research-session",
    name: operationId,
    session_id: operationId,
    operation_id: operationId,
    investigation_ref: { ...fixture.request.investigation_ref },
    handler_generation: fixture.request.handler_generation,
    principal_ref: identity.principal_ref,
    credential_generation: identity.credential_generation,
    deployment_generation: preparedEvidence.local_overlay.DEPLOYMENT_GENERATION,
    authority_expires_at: identity.expires_at_ms,
    timeoutMs: 5_000,
  };
  const configResponse = await fetch(`${workerOrigin}/api/__qualification/config`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-qualification-key": diagnosticKey },
    body: JSON.stringify(binding),
  });
  assert.equal(configResponse.status, 204, "isolated browser entry binding was not accepted");
  report.stage = "isolated-browser-entry-bound";

  const routePath = `/agents/research-session/${encodeURIComponent(operationId)}`;
  const routeResponse = await fetch(`${workerOrigin}${routePath}`, {
    headers: { "cf-access-jwt-assertion": accessToken, Accept: "application/json" },
    redirect: "manual",
  });
  const routeBody = await routeResponse.json();
  assert.equal(routeResponse.status, 410, JSON.stringify(routeBody));
  assert.equal(routeBody.code, "SESSION_PROJECTION_PROTOCOL_REQUIRED");
  report.route = { method: "GET", path: routePath, status: routeResponse.status, code: routeBody.code };
  report.stage = "actual-emitted-agents-route-initialized";

  async function readDiagnostic(endpoint) {
    const response = await fetch(`${workerOrigin}${endpoint}`, { headers: { "x-qualification-key": diagnosticKey } });
    assert.equal(response.status, 200, `qualification diagnostic failed for ${endpoint}`);
    return response.json();
  }
  const before = {
    d1: await snapshotD1(d1),
    r2: await snapshotR2(workBucket, fixture.request.input_manifest.object_ref),
    durableObject: await readDiagnostic("/api/__qualification/state"),
    workflow: await readDiagnostic("/api/__qualification/counters"),
  };
  browserServer = await chromium.launchServer({
    channel: "chrome",
    headless: true,
    args: ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run"],
  });
  report.pids.chromium = browserServer.process()?.pid ?? null;
  browser = await chromium.connect(browserServer.wsEndpoint());
  const playwrightPackage = JSON.parse(await readFile(path.join(workspaceRoot, "node_modules/playwright-core/package.json"), "utf8"));
  report.browser = {
    engine: "Google Chrome",
    channel: "chrome",
    version: browser.version(),
    playwright_core_version: playwrightPackage.version,
  };
  report.stage = "branded-chrome-started";
  context = await browser.newContext();
  await context.addCookies([{
    name: "CF_Authorization",
    value: accessToken,
    url: workerOrigin,
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
  }]);
  await context.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const observed = [];
    class ObservedWebSocket extends NativeWebSocket {
      constructor(url, protocols) {
        super(url, protocols);
        const item = { url: String(url), events: [], socket: this };
        observed.push(item);
        this.addEventListener("open", () => item.events.push({ type: "open" }));
        this.addEventListener("message", (event) => item.events.push({
          type: "message",
          data: typeof event.data === "string" ? event.data.slice(0, 1024) : "[binary]",
        }));
        this.addEventListener("close", (event) => item.events.push({
          type: "close", code: event.code, reason: event.reason, was_clean: event.wasClean,
        }));
      }
    }
    Object.defineProperty(window, "WebSocket", { configurable: true, writable: true, value: ObservedWebSocket });
    window.__ELIOT_PROJECTION_SOCKETS__ = observed;
  });
  const externalRequests = [];
  const webSockets = [];
  function observe(page, label) {
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.hostname !== "127.0.0.1") externalRequests.push({ page: label, url: url.origin });
    });
    page.on("websocket", (socket) => {
      const observed = { page: label, url: socket.url(), received: [], sent: [], closed: false };
      socket.on("framereceived", (frame) => observed.received.push(String(frame.payload).slice(0, 1024)));
      socket.on("framesent", (frame) => observed.sent.push(String(frame.payload).slice(0, 1024)));
      socket.on("close", () => { observed.closed = true; });
      webSockets.push(observed);
    });
  }
  pageA = await context.newPage();
  pageB = await context.newPage();
  observe(pageA, "tab-a");
  observe(pageB, "tab-b");
  await Promise.all([
    pageA.goto(`${workerOrigin}/api/__qualification`, { waitUntil: "domcontentloaded" }),
    pageB.goto(`${workerOrigin}/api/__qualification`, { waitUntil: "domcontentloaded" }),
  ]);

  const first = await pageA.evaluate(() => window.__eliotResearchSessionQualification.readProjection());
  assert.equal(first.kind, "PROJECTION", JSON.stringify(first));
  assert.equal(first.value.protocol, "eliotr.research-session-projection.v1");
  assert.equal(first.value.state, "ACTIVE");
  assert.equal(first.value.operation_id, operationId);
  const repeated = await pageA.evaluate(() => window.__eliotResearchSessionQualification.readProjection());
  assert.deepEqual(repeated, first, "repeated same-tab projection changed");
  await waitForSocketEvent(pageA, 1, "open");
  const peerFirst = await pageB.evaluate(() => window.__eliotResearchSessionQualification.readProjection());
  assert.deepEqual(peerFirst, first, "second tab received a different projection");
  await waitForSocketEvent(pageB, 1, "open");

  await pageA.evaluate(() => window.__eliotResearchSessionQualification.dispose());
  await waitForSocketEvent(pageA, 1, "close");
  const reconnect = await pageA.evaluate(() => window.__eliotResearchSessionQualification.readProjection());
  assert.deepEqual(reconnect, first, "projection after disposal/reconnect changed");
  await waitForSocketEvent(pageA, 2, "open");
  const canonical = await pageA.evaluate(() => window.__eliotResearchSessionQualification.readCanonical());
  assert.equal(canonical.status, 200, JSON.stringify(canonical.body));
  const canonicalBody = canonical.body?.data ?? canonical.body;
  const canonicalOperation = canonicalBody.operation_id ?? canonicalBody.workflow_instance_id;
  assert.equal(canonicalOperation, operationId, "canonical HTTP readback belongs to another run");
  report.canonical_http = { status: canonical.status, operation_id: canonicalOperation, body: canonicalBody };

  await pageA.evaluate(() => window.__eliotResearchSessionQualification.dispose());
  await waitForSocketEvent(pageA, 2, "close");
  const peerStateBefore = await pageB.evaluate(() => window.__eliotResearchSessionQualification.socketState());
  assert(peerStateBefore.some((socket) => socket.ready_state === WebSocket.OPEN), "peer socket closed with the other tab");
  const peerAfterClose = await pageB.evaluate(() => window.__eliotResearchSessionQualification.readProjection());
  assert.deepEqual(peerAfterClose, first, "peer did not survive the other tab's disposal");
  const browserSocketStatesA = await pageA.evaluate(() => window.__eliotResearchSessionQualification.socketState());
  await pageA.close();
  await pageB.evaluate(() => window.__eliotResearchSessionQualification.dispose());
  await waitForSocketEvent(pageB, 1, "close");
  const browserSocketStatesB = await pageB.evaluate(() => window.__eliotResearchSessionQualification.socketState());
  await pageB.close();

  const after = {
    d1: await snapshotD1(d1),
    r2: await snapshotR2(workBucket, fixture.request.input_manifest.object_ref),
    durableObject: await readDiagnostic("/api/__qualification/state"),
    workflow: await readDiagnostic("/api/__qualification/counters"),
  };
  const stableDurableObjectBefore = {
    transcript_tables: before.durableObject.transcript_tables,
    transcript_entries: before.durableObject.transcript_entries,
    session_entries: before.durableObject.session_entries,
  };
  const stableDurableObjectAfter = {
    transcript_tables: after.durableObject.transcript_tables,
    transcript_entries: after.durableObject.transcript_entries,
    session_entries: after.durableObject.session_entries,
  };
  report.browser_qualification = {
    repeated_snapshot: "PASS",
    disposal_reconnect: "PASS",
    two_tabs_peer_survives: "PASS",
    canonical_http_reconciliation: "PASS",
    tabs_closed: true,
    socket_frames: webSockets,
    browser_socket_states: [browserSocketStatesA, browserSocketStatesB],
    non_loopback_requests: externalRequests,
  };
  report.invariance = {
    d1_before_sha256: before.d1.sha256,
    d1_after_sha256: after.d1.sha256,
    d1_tables: before.d1.tables.length,
    d1_table_rows: before.d1.tables.reduce((sum, table) => sum + table.rows.length, 0),
    r2_before: before.r2,
    r2_after: after.r2,
    durable_object_stable_before_sha256: sha256(Buffer.from(JSON.stringify(stableDurableObjectBefore))),
    durable_object_stable_after_sha256: sha256(Buffer.from(JSON.stringify(stableDurableObjectAfter))),
    connection_metadata: {
      allowed_key: "research-session-chat-binding:v1",
      before_count: before.durableObject.connection_metadata.length,
      after_count: after.durableObject.connection_metadata.length,
      before_sha256: sha256(Buffer.from(JSON.stringify(before.durableObject.connection_metadata))),
      after_sha256: sha256(Buffer.from(JSON.stringify(after.durableObject.connection_metadata))),
    },
    workflow_before: before.workflow,
    workflow_after: after.workflow,
    provider_execution: "NOT_RUN",
    remote_effects: 0,
  };
  assert.equal(after.d1.sha256, before.d1.sha256, "D1 table/byte snapshot changed during reads");
  assert.deepEqual(after.r2, before.r2, "fixture R2 input changed during reads");
  assert.deepEqual(stableDurableObjectAfter, stableDurableObjectBefore,
    "DO session/transcript bytes changed during reads");
  assert.equal(after.workflow.create, 0, "projection allocated a Workflow instance");
  assert.equal(after.workflow.create, before.workflow.create, "Workflow effect count changed");
  assert.deepEqual(externalRequests, [], "browser requested a non-loopback origin");
  assert(webSockets.length >= 3, "expected two-tab and reconnect WebSocket evidence");
  const expectedPath = routePath;
  assert(webSockets.every((socket) => new URL(socket.url).pathname === expectedPath), "browser socket used an unexpected route");
  report.state = "PASS_LOCAL_EMITTED_WORKER_BRANDED_CHROME_ONLY";
  report.stage = "complete";
  report.finished_at = new Date().toISOString();
} catch (error) {
  failure = error;
  report.state = "FAIL";
  report.failure = error instanceof Error ? (error.stack ?? error.message).slice(0, 5000) : String(error).slice(0, 5000);
  report.finished_at = new Date().toISOString();
} finally {
  try { if (pageA && !pageA.isClosed()) await pageA.close(); } catch { /* Cleanup is best effort; preserve the primary qualification result. */ }
  try { if (pageB && !pageB.isClosed()) await pageB.close(); } catch { /* Cleanup is best effort; preserve the primary qualification result. */ }
  try { if (context) await context.close(); } catch { /* Cleanup is best effort; preserve the primary qualification result. */ }
  try { if (browser) await browser.close(); } catch { /* Cleanup is best effort; preserve the primary qualification result. */ }
  try {
    if (browserServer) await browserServer.close();
    report.cleanup.browser_closed = true;
  } catch { /* Cleanup is best effort; preserve the primary qualification result. */ }
  try {
    if (runtime !== undefined) {
      await runtime.dispose();
      report.cleanup.miniflare_disposed = true;
    } else if (miniflareInstance !== undefined) {
      await miniflareInstance.dispose();
      report.cleanup.miniflare_disposed = true;
    }
  } catch (error) {
    report.cleanup.miniflare_dispose_error = error instanceof Error ? error.message : String(error);
  }
  try { if (vite) await vite.close(); } catch (error) {
    report.cleanup.vite_close_error = error instanceof Error ? error.message : String(error);
  }
  if (originalModuleLoad !== undefined) Module._load = originalModuleLoad;
  try {
    await assertPortFree(nativePort);
    report.cleanup.port_released = true;
  } catch {
    report.cleanup.port_released = false;
  }
  report.finished_at ??= new Date().toISOString();
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  report.result_path = outputPath;
}

process.stdout.write(`${JSON.stringify({ state: report.state, result_path: outputPath, native_port: nativePort, pids: report.pids, cleanup: report.cleanup })}\n`);
if (failure !== undefined) {
  process.stderr.write(`${report.failure}\n`);
  process.exitCode = 1;
}
