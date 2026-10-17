import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { admitStartupObservation } from "./emitted-route-membership.mjs";
import { scrubTokenEnv } from "./cloudflare-wrangler-oauth.mjs";
import { createPreparedCoreStartupRuntime, readPreparedCoreRuntimeProof } from "./deployment-owner-web-prepared-core.mjs";
import { ownerWebStartupReadOnlyPaths } from "./deployment-owner-web-startup-routes.mjs";

const PROFILE = "LOCAL_PREPARED_CLIENT_CURRENT_LIVE_BACKEND_READONLY";
const SCOPE = "Prepared client bytes with the current live backend, read-only; does not qualify prepared Core, deployment or live cutover";
const LOCAL_PROFILE = "LOCAL_PREPARED_CLIENT_CORE_SIGNED_JWT_EMPTY_D1_READONLY";
const LOCAL_SCOPE = "Prepared client and Core with empty migrated local D1/R2 and signed JWT; does not qualify production, providers or live cutover";
const CLIENT = "apps/eliotr-web/dist/client";
const MAX_BODY = 16 * 1024 * 1024;
const MAX_REQUESTS = 512;
const CLEANUP_MS = 5_000;
const ROUTES = [
  { route: "/", htmlPath: "index.html", boundary: "SETTLED_ROOT_RESEARCH_NO_ACTIONS" },
  { route: "/agent-inbox/", htmlPath: "agent-inbox/index.html", boundary: "SETTLED_IDLE_INBOX_NO_ACTIONS" },
];
// Initial queries have no selected project. Project readiness begins only after
// an explicit current project selection; no unscoped readiness request is sent.
const STARTUP_GETS = new Set([
  "/api/v1/system/health", "/api/v1/system/session", "/api/v1/research/projects",
  "/api/v1/research/runs",
]);
const ALLOWED_STARTUP_GETS = new Set(ownerWebStartupReadOnlyPaths);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = message => { throw new Error("Owner-web startup: " + message); };
const relativePath = value => typeof value === "string" && value.length > 0 &&
  !path.isAbsolute(value) && !value.includes("\\") && !value.includes(":") &&
  !value.split("/").some(part => !part || part === "." || part === "..");
const hidden = value => value.split("/").some(part => part.startsWith("."));

async function cleanupWithin(action, label) {
  let timer;
  try {
    await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Owner-web startup: ${label} cleanup exceeded bounds`)), CLEANUP_MS);
    })]);
  } finally { clearTimeout(timer); }
}

export function ownerWebStartupBindings({ sourceCommit, inputManifestSha256, generatedConfigSha256, outputs }) {
  const artifacts = outputs.filter(item => item.path.startsWith(CLIENT + "/"))
    .map(item => ({ path: item.path.slice(CLIENT.length + 1), rawBytes: item.byte_length, sha256: item.sha256 }))
    .filter(item => !hidden(item.path));
  return { sourceCommit, artifacts,
    buildSha256: hash(Buffer.from(JSON.stringify({ sourceCommit, inputManifestSha256, generatedConfigSha256, outputs }))),
    artifactReadbackSha256: hash(Buffer.from(JSON.stringify(artifacts))) };
}

function bindings({ sourceCommit, buildSha256, artifactReadbackSha256, artifacts }) {
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit) ||
      ![buildSha256, artifactReadbackSha256].every(value => /^[a-f0-9]{64}$/u.test(value ?? "")) ||
      !Array.isArray(artifacts) || !artifacts.length || artifacts.length > 4096) fail("invalid bindings");
  const seen = new Set();
  for (const item of artifacts) {
    if (!relativePath(item.path) || hidden(item.path) || seen.has(item.path) ||
        !/^[a-f0-9]{64}$/u.test(item.sha256 ?? "") || !Number.isSafeInteger(item.rawBytes) ||
        item.rawBytes < 0 || item.rawBytes > MAX_BODY ||
        Object.keys(item).sort().join(",") !== "path,rawBytes,sha256") fail("invalid client artifact");
    seen.add(item.path);
  }
  if (hash(Buffer.from(JSON.stringify(artifacts))) !== artifactReadbackSha256 ||
      !["_headers", ...ROUTES.map(entry => entry.htmlPath)].every(name => seen.has(name))) {
    fail("client manifest digest or required entries differ");
  }
}

async function snapshot(root, artifacts) {
  const directory = path.resolve(root, CLIENT), files = new Map();
  if (await realpath(directory) !== directory) fail("client directory is redirected");
  let total = 0;
  async function walk(folder, prefix = "") {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = prefix + entry.name, filename = path.join(folder, entry.name);
      if (!relativePath(name) || entry.isSymbolicLink()) fail("unsafe client inventory");
      if (entry.isDirectory()) await walk(filename, name + "/");
      else if (entry.isFile()) {
        const info = await lstat(filename);
        if (info.size > MAX_BODY || files.size >= 4096 || (total += info.size) > 128 * 1024 * 1024) {
          fail("client inventory exceeds observation bounds");
        }
        if (await realpath(filename) !== filename) fail("client file is redirected");
        const bytes = await readFile(filename);
        files.set(name, bytes);
      } else fail("unsupported client inventory entry");
    }
  }
  await walk(directory);
  const visible = [...files.keys()].filter(name => !hidden(name));
  if (visible.length !== artifacts.length || artifacts.some(item => {
    const bytes = files.get(item.path);
    return !bytes || bytes.length !== item.rawBytes || hash(bytes) !== item.sha256;
  })) fail("manifest is not the exact inspector-visible client inventory");
  return files; // Includes hidden metadata for custody, but never serves it.
}

function parseHeaders(bytes) {
  const blocks = []; let block;
  for (const line of bytes.toString("utf8").split(/\r?\n/u)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/u.test(line)) {
      if (!line.startsWith("/") || /[\s?#]/u.test(line)) fail("unsupported _headers rule");
      const escaped = line.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*");
      block = { pattern: new RegExp("^" + escaped + "$", "u"), rules: [] }; blocks.push(block);
    } else {
      const match = /^\s+(!\s+)?([A-Za-z0-9-]+)(?::\s*(.*))?$/u.exec(line);
      if (!block || !match || (!match[1] && match[3] === undefined)) fail("invalid _headers directive");
      const key = match[2].toLowerCase();
      if (["set-cookie", "content-length", "content-encoding", "connection", "transfer-encoding"].includes(key)) {
        fail("unsupported transport or credential header");
      }
      block.rules.push({ key, value: match[3] ?? "", remove: Boolean(match[1]) });
    }
  }
  return pathname => {
    const result = Object.create(null);
    for (const item of blocks) if (item.pattern.test(pathname)) for (const rule of item.rules) {
      if (rule.remove) delete result[rule.key];
      else result[rule.key] = result[rule.key] === undefined ? rule.value : result[rule.key] + ", " + rule.value;
    }
    return result;
  };
}

function protectedOrigin(environment) {
  const hostname = environment.ELIOTR_ACCESS_HOSTNAME;
  if (typeof hostname !== "string" || hostname.length > 253 || !hostname.includes(".") ||
      !hostname.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) ||
      environment.ELIOTR_OWNER_HTTP_TRANSPORT !== "cloudflared") fail("invalid protected origin or transport");
  const origin = "https://" + hostname;
  if (![origin, origin + "/"].includes(environment.ELIOTR_SMOKE_BASE_URL)) fail("smoke origin differs");
  return origin;
}

// Separate diagnostic transport. The existing capabilities-only wrapper stays unchanged.
function diagnosticGet({ origin, environment, signal, remaining, children }) {
  const env = scrubTokenEnv(environment);
  for (const key of ["ELIOTR_ACCESS_SMOKE_COOKIE", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET",
    "CLOUDFLARE_ACCESS_CLIENT_ID", "CLOUDFLARE_ACCESS_CLIENT_SECRET"]) delete env[key];
  return pathname => {
    if (!ALLOWED_STARTUP_GETS.has(pathname) || signal.aborted) fail("diagnostic GET outside allowlist or deadline");
    // An observed current-backend GET exceeded 15 seconds. Keep the transport
    // window within the observer's existing total deadline and cleanup bounds.
    const timeout = Math.min(45_000, remaining()), trailer = "\nELIOTR_OWNER_HTTP:";
    const args = ["access", "curl", origin + pathname, "--silent", "--show-error", "--no-location", "--compressed",
      "--max-time", String(Math.max(1, Math.ceil(timeout / 1000))), "--connect-timeout", "10",
      "--max-filesize", String(MAX_BODY), "--request", "GET", "--output", "-", "--header", "Accept: application/json",
      "--write-out", trailer + "%{http_code}:%{content_type}\n"];
    return new Promise((resolve, reject) => {
      const child = execFile(environment.ELIOTR_CLOUDFLARED_BINARY || "cloudflared", args,
        { env, shell: false, windowsHide: true, encoding: "buffer", timeout, maxBuffer: MAX_BODY + 1024, signal },
        (error, stdout) => {
          children.delete(child);
          if (error || !Buffer.isBuffer(stdout) || stdout.length > MAX_BODY + 1024) {
            reject(new Error("Owner-web startup: diagnostic GET failed or exceeded bounds")); return;
          }
          const split = stdout.lastIndexOf(trailer);
          const match = split < 0 ? null : /^\nELIOTR_OWNER_HTTP:([2-5][0-9]{2}):([^\r\n]{0,256})\n$/u
            .exec(stdout.subarray(split).toString("utf8"));
          if (!match || split > MAX_BODY) { reject(new Error("Owner-web startup: invalid HTTP trailer")); return; }
          resolve({ status: Number(match[1]), contentType: match[2], bytes: stdout.subarray(0, split) });
        });
      children.add(child);
    });
  };
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff",
  ".json": "application/json", ".webmanifest": "application/manifest+json" };

function resource(url, origin, entry, files) {
  if (url.origin !== origin || url.username || url.password || url.search || url.hash ||
      url.pathname.includes("%") || url.pathname.includes("\\")) return undefined;
  if (url.pathname.startsWith("/api/")) {
    return entry.route === "/" && ALLOWED_STARTUP_GETS.has(url.pathname) ? { api: url.pathname } : undefined;
  }
  const artifact = url.pathname === entry.route ? entry.htmlPath : url.pathname.slice(1);
  if (!relativePath(artifact) || hidden(artifact) || ["_headers", "_redirects"].includes(artifact) ||
      (!files.has(artifact)) || (/\.html$/u.test(artifact) && url.pathname !== entry.route)) return undefined;
  return { artifact };
}

function browserEnvironment(environment) {
  // Native browser discovery only; no service credentials are inherited by Chrome.
  const allowed = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
    "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "PROGRAMFILES",
    "PROGRAMFILES(X86)", "PROGRAMW6432", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"]);
  return Object.fromEntries(Object.entries(environment).filter(([key]) => allowed.has(key.toUpperCase())));
}

async function observeEntry({ browser, entry, origin, files, sourceCommit, buildSha256,
  artifactReadbackSha256, signal, remaining, bounded, errors, profile, scope }) {
  const context = await bounded(browser.newContext({ serviceWorkers: "block", acceptDownloads: false }));
  const rows = new Map(), pending = new Set(), api = new Map();
  let sequence = 0, lastActivity = Date.now(), collecting = true, pageErrors = 0, consoleErrors = 0;
  const start = Date.now();
  context.on("serviceworker", () => errors.push("SERVICE_WORKER_OBSERVED"));
  context.on("request", request => {
    if (!collecting) return;
    const url = new URL(request.url());
    const row = { id: ++sequence, origin: url.origin, pathname: url.pathname, method: request.method(),
      resource_type: request.resourceType(), started_epoch_ms: Date.now(), state: "PENDING",
      query_bytes: Buffer.byteLength(url.search), query_sha256: hash(Buffer.from(url.search)),
      request_body_sha256: hash(request.postDataBuffer() ?? Buffer.alloc(0)),
      request_body_bytes: request.postDataBuffer()?.length ?? 0, service_worker_request: request.serviceWorker() !== null };
    rows.set(request, row); pending.add(request); lastActivity = Date.now();
    if (rows.size > MAX_REQUESTS) errors.push("REQUEST_INVENTORY_LIMIT");
  });
  context.on("requestfailed", request => {
    if (!collecting) return;
    const row = rows.get(request); if (row) row.state = "FAILED";
    pending.delete(request); errors.push("REQUEST_FAILED"); lastActivity = Date.now();
  });
  context.on("requestfinished", request => {
    if (!collecting) return;
    void (async () => {
      const row = rows.get(request), response = await request.response();
      if (!row || !response) fail("response inventory missing");
      const bytes = await response.body(), url = new URL(request.url()), selected = resource(url, origin, entry, files);
      if (!selected || bytes.length > MAX_BODY) fail("response outside pinned inventory");
      Object.assign(row, { body_sha256: hash(bytes), decoded_body_bytes: bytes.length, status: response.status(),
        from_service_worker: response.fromServiceWorker(), finished_epoch_ms: Date.now(), state: "FINISHED" });
      if (selected.artifact) {
        const pinned = files.get(selected.artifact);
        Object.assign(row, { artifact: selected.artifact, response_role: "PINNED_STATIC_ASSET",
          artifact_matches: bytes.equals(pinned) });
        if (!row.artifact_matches || row.status !== 200) fail("static response bytes differ");
      } else {
        row.response_role = profile === LOCAL_PROFILE ? "LOCAL_PREPARED_CORE_READONLY_PROXY" : "CURRENT_LIVE_BACKEND_READONLY_PROXY";
        if (row.status !== 200 || !/^application\/json(?:;|$)/iu.test(response.headers()["content-type"] ?? "")) {
          fail("startup API did not return actual JSON 200");
        }
        const envelope = JSON.parse(bytes.toString("utf8"));
        if (typeof envelope.deployment_generation !== "string" || !envelope.deployment_generation) fail("API generation absent");
        const proof = { generation: envelope.deployment_generation };
        if (selected.api === "/api/v1/system/health" && envelope.data?.deployment_generation !== proof.generation) {
          fail("health generation differs");
        }
        if (selected.api === "/api/v1/system/session") {
          if (envelope.data?.client_class !== "owner_pwa") fail("live session is not owner_pwa");
          proof.expiresAt = Date.parse(envelope.data.expires_at);
        }
        const previous = api.get(selected.api);
        if (previous && previous.generation !== proof.generation) fail("generation changed during startup");
        api.set(selected.api, proof); // Only generation/expiry in memory; never persist API data.
      }
    })().catch(() => errors.push("RESPONSE_OBSERVATION_FAILED"))
      .finally(() => { pending.delete(request); lastActivity = Date.now(); });
  });
  try {
    // Routed sockets have no upstream connection unless connectToServer is called.
    // Record and close every attempt before any page or navigation can start.
    await bounded(context.routeWebSocket(/.*/u, async websocket => {
      errors.push("WEBSOCKET_OUTSIDE_SCOPE");
      await websocket.close({ code: 1008, reason: "Read-only startup observer" });
    }));
    await bounded(context.route("**/*", async route => {
      const request = route.request(), selected = resource(new URL(request.url()), origin, entry, files);
      if (signal.aborted || errors.length || !selected || request.method() !== "GET" ||
          request.postDataBuffer() !== null || request.serviceWorker() !== null ||
          Object.keys(request.headers()).some(key => ["authorization", "cookie", "cf-access-jwt-assertion",
            "cf-access-client-id", "cf-access-client-secret"].includes(key.toLowerCase()))) {
        const url = new URL(request.url());
        errors.push("REQUEST_OUTSIDE_READONLY_SCOPE:" + JSON.stringify({ pathname: url.pathname,
          selected: Boolean(selected), same_origin: url.origin === origin, query_keys: [...url.searchParams.keys()],
          method: request.method(), body_bytes: request.postDataBuffer()?.length ?? 0,
          service_worker: request.serviceWorker() !== null, prior_errors: errors.length,
          credential_headers: Object.keys(request.headers()).filter(key => ["authorization", "cookie", "cf-access-jwt-assertion",
            "cf-access-client-id", "cf-access-client-secret"].includes(key.toLowerCase())),
        })); await route.abort("blockedbyclient");
      } else await route.continue(); // Real loopback HTTP, no fulfill/mock or credential injection.
    }));
    const page = await bounded(context.newPage());
    page.on("pageerror", () => { pageErrors++; });
    page.on("console", event => { if (event.type() === "error") consoleErrors++; });
    page.on("websocket", () => errors.push("WEBSOCKET_OUTSIDE_SCOPE"));
    await bounded(page.goto(origin + entry.route, { waitUntil: "load", timeout: Math.min(30_000, remaining()) }));
    let pageState;
    for (;;) {
      if (errors.length || pageErrors || consoleErrors) fail("unclean actual startup observation " + JSON.stringify({
        route: entry.route, errors, pageErrors, consoleErrors,
        requests: [...rows.values()].map(row => ({ pathname: row.pathname, state: row.state, status: row.status })),
      }));
      pageState = await bounded(page.evaluate(route => {
        const { navigator, document, location } = globalThis;
        const controller = "serviceWorker" in navigator ? navigator.serviceWorker.controller : null;
        if (route === "/") {
          const root = document.getElementById("root"), guard = document.getElementById("privacy-guard");
          const history = document.querySelector(".er-live-history"), refresh = history?.querySelector("button");
          return { ready: Boolean(root && !root.hidden && !root.inert && root.getAttribute("aria-hidden") !== "true" &&
            guard?.hidden && document.querySelector('.er-shell[data-destination="research"]') &&
            document.querySelector(".er-live-workspace") && document.querySelector("#workspace-heading")?.textContent === "Research" &&
            history && refresh && !refresh.disabled && location.pathname === "/research"),
            service_worker_controller: controller === null ? null : "PRESENT" };
        }
        const fields = ["access-client-id", "access-client-secret", "client-grant-id",
          "qualification-challenge-id", "qualification-challenge-token"];
        return { ready: Boolean(document.documentElement.dataset.eliotrWorkerRetired === "true" &&
          document.querySelector("h1")?.textContent?.trim() && fields.every(id => document.getElementById(id)?.value === "") &&
          document.getElementById("status-line")?.textContent === "Credentials are kept only in this page's memory." &&
          document.getElementById("task-output")?.textContent === "No task loaded." &&
          document.getElementById("dispatch-output")?.textContent === "No dispatch loaded."),
          service_worker_controller: controller === null ? null : "PRESENT" };
      }, entry.route));
      const required = entry.route === "/" ? [...STARTUP_GETS].every(name => api.has(name)) : api.size === 0;
      if (pageState.ready && required && !pending.size && Date.now() - lastActivity >= 600) break;
      await delay(50, undefined, { signal });
    }
    const boundary = Date.now(), generations = new Set([...api.values()].map(value => value.generation));
    if (pageState.service_worker_controller !== null || context.serviceWorkers().length || (await bounded(context.cookies())).length ||
        (entry.route === "/" && (generations.size !== 1 || !(api.get("/api/v1/system/session").expiresAt > boundary)))) {
      fail("session generation, credentials or service-worker boundary failed");
    }
    if (pending.size || errors.length || pageErrors || consoleErrors) fail("boundary did not settle");
    const records = [...rows.values()].map(row => ({ ...row, completed_by_boundary: row.state === "FINISHED" && row.finished_epoch_ms <= boundary }));
    if (records.some(row => !row.completed_by_boundary) || (entry.route !== "/" && records.some(row => row.pathname.startsWith("/api/")))) {
      fail("incomplete boundary or non-idle inbox");
    }
    collecting = false;
    return { protocol: "eliotr.actual-owner-startup-observation.v1", status: "BOUNDED_ACTUAL_RESEARCH_STARTUP_OBSERVED",
      source_commit: sourceCommit, build_sha256: buildSha256, artifact_readback_sha256: artifactReadbackSha256,
      route: entry.route, profile, boundary: entry.boundary, scope, origin,
      started_at: new Date(start).toISOString(), finished_at: new Date().toISOString(), boundary_epoch_ms: boundary,
      requests_at_boundary: records, requests: records.map(row => ({ ...row })), observer_errors: [],
      browser_errors: { page_error_count: pageErrors, console_error_count: consoleErrors },
      context: { fresh: true, storage_state_loaded: false, http_cache: "DISABLED_BY_ROUTE_INTERCEPTION",
        service_workers: "BLOCKED_BY_CONTEXT" },
      page_state: { service_worker_controller: null }, service_workers_at_boundary: [] };
  } finally { collecting = false; await cleanupWithin(() => context.close(), "browser context"); }
}

/** Re-read exact persisted bytes; JSON descriptors alone cannot recreate an admitted token. */
export async function readOwnerWebStartup({ root, sourceCommit, buildSha256, artifactReadbackSha256, artifacts, evidence }) {
  root = path.resolve(root); bindings({ sourceCommit, buildSha256, artifactReadbackSha256, artifacts });
  await snapshot(root, artifacts);
  if (!Array.isArray(evidence) || evidence.length !== ROUTES.length) fail("both entry observations are required");
  const result = new Map();
  const profile = evidence[0]?.profile;
  if (![PROFILE, LOCAL_PROFILE].includes(profile) || evidence.some(record => record.profile !== profile)) fail("unknown or mixed startup profile");
  const scope = profile === LOCAL_PROFILE ? LOCAL_SCOPE : SCOPE;
  if (profile === LOCAL_PROFILE) {
    const a = evidence[0].native_runtime, b = evidence[1].native_runtime;
    if (!a || !b || ["path", "byte_length", "sha256"].some(key => a[key] !== b[key])) {
      fail("entry observations must share the same native Core proof");
    }
  }
  for (const record of evidence) {
    const entry = ROUTES.find(item => item.route === record.route && item.htmlPath === record.htmlPath);
    if (!entry || record.boundary !== entry.boundary || result.has(entry.htmlPath) ||
        !relativePath(record.path) || !/^\.eliotr-state\/owner-web-startup-[a-f0-9-]{36}\/(?:root|agent-inbox)\.json$/u.test(record.path) ||
        !Number.isSafeInteger(record.byte_length) || record.byte_length < 1 || record.byte_length > 4 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/u.test(record.sha256 ?? "")) fail("invalid pinned observation descriptor");
    const filename = path.resolve(root, record.path);
    if (await realpath(filename) !== filename || (await lstat(filename)).size !== record.byte_length) fail("observation path or length differs");
    const bytes = await readFile(filename);
    if (bytes.length !== record.byte_length || hash(bytes) !== record.sha256 || JSON.parse(bytes.toString("utf8")).scope !== scope) {
      fail("observation bytes or scope differ");
    }
    if (profile === LOCAL_PROFILE) {
      if (record.native_runtime?.path !== record.path.slice(0, record.path.lastIndexOf("/")) + "/native-core.json") {
        fail("native Core proof must belong to the observation directory");
      }
      await readPreparedCoreRuntimeProof(root, record.native_runtime, sourceCommit);
    }
    else if (record.native_runtime !== undefined) fail("live proxy may not claim native Core evidence");
    result.set(entry.htmlPath, admitStartupObservation(bytes, { sourceCommit, buildSha256, artifactReadbackSha256,
      observationSha256: record.sha256, route: entry.route, htmlPath: entry.htmlPath, profile, boundary: entry.boundary, artifacts }));
  }
  return result;
}

/** Root invokes once after the combined build; this function performs no build or Git operation. */
export async function observeOwnerWebStartup({ root, environment, sourceCommit, buildSha256, artifacts, artifactReadbackSha256 }) {
  root = path.resolve(root); bindings({ sourceCommit, buildSha256, artifactReadbackSha256, artifacts });
  const selected = environment.ELIOTR_OWNER_WEB_STARTUP_PROFILE ?? "current-live-readonly";
  if (!["current-live-readonly", "prepared-core-local"].includes(selected)) fail("unknown startup profile selection");
  const local = selected === "prepared-core-local", profile = local ? LOCAL_PROFILE : PROFILE, scope = local ? LOCAL_SCOPE : SCOPE;
  const upstream = local ? undefined : protectedOrigin(environment), deadline = Date.now() + 60_000;
  const abort = new globalThis.AbortController(), children = new Set(); let browser, active, origin, server, nativeStartup;
  const remaining = () => { const left = deadline - Date.now(); if (left <= 0 || abort.signal.aborted) fail("60 second deadline exceeded"); return left; };
  const timer = setTimeout(() => abort.abort(), 60_000);
  const bounded = promise => new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("Owner-web startup: 60 second deadline exceeded"));
    abort.signal.addEventListener("abort", onAbort, { once: true });
    if (abort.signal.aborted) onAbort();
    Promise.resolve(promise).then(resolve, reject).finally(() => abort.signal.removeEventListener("abort", onAbort));
  });
  try {
    const files = await bounded(snapshot(root, artifacts)), headers = parseHeaders(files.get("_headers"));
    if (ROUTES.some(entry => !headers(entry.route)["content-security-policy"])) fail("prepared CSP is missing");
    if (local) {
      const launch = createPreparedCoreStartupRuntime({ root, sourceCommit, signal: abort.signal, remaining }).then(async value => {
        nativeStartup = value;
        if (abort.signal.aborted) { await cleanupWithin(() => value.dispose(), "late prepared Core"); fail("prepared Core startup exceeded deadline"); }
        return value;
      });
      await bounded(launch);
    }
    const get = local ? nativeStartup.get : diagnosticGet({ origin: upstream, environment, signal: abort.signal, remaining, children });
    server = createServer((request, response) => {
      void (async () => {
        const current = active;
        if (!current || abort.signal.aborted || current.errors.length || ++current.requestCount > MAX_REQUESTS ||
            request.method !== "GET" || !request.url?.startsWith("/") || request.url.startsWith("//") ||
            request.headers.host !== new URL(origin).host ||
            (request.headers.origin !== undefined && request.headers.origin !== origin) ||
            request.headers["sec-fetch-site"] === "cross-site" || request.headers["transfer-encoding"] !== undefined ||
            (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0") ||
            ["authorization", "cookie", "cf-access-jwt-assertion", "cf-access-client-id", "cf-access-client-secret"]
              .some(key => request.headers[key] !== undefined)) fail("server request outside scope");
        const url = new URL(request.url, origin), selected = resource(url, origin, current.entry, files);
        if (!selected || request.url !== url.pathname) fail("unknown path, query or noncanonical URL");
        const outgoing = headers(url.pathname);
        if (selected.api) {
          const actual = await get(selected.api);
          response.writeHead(actual.status, { ...outgoing, "content-type": actual.contentType || "application/octet-stream" });
          response.end(actual.bytes);
        } else {
          response.writeHead(200, { "content-type": MIME[path.extname(selected.artifact)] ?? "application/octet-stream", ...outgoing });
          response.end(files.get(selected.artifact));
        }
      })().catch(() => { active?.errors.push("LOOPBACK_REQUEST_FAILED"); response.destroy(); });
    });
    server.on("upgrade", (_request, socket) => { active?.errors.push("WEBSOCKET_OUTSIDE_SCOPE"); socket.destroy(); });
    server.on("listening", () => {
      if (abort.signal.aborted) { server.closeAllConnections(); server.close(); }
    });
    const observations = [];
    await bounded(new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }));
    origin = "http://127.0.0.1:" + server.address().port;
    const launch = chromium.launch({ channel: "chrome", headless: true, timeout: Math.min(15_000, remaining()),
      env: browserEnvironment(environment) }).then(async value => {
        browser = value;
        if (abort.signal.aborted) { await cleanupWithin(() => value.close(), "late browser"); fail("browser launch exceeded deadline"); }
        return value;
      });
    await bounded(launch);
    for (const entry of ROUTES) {
      active = { entry, errors: [], requestCount: 0 };
      observations.push(await bounded(observeEntry({ browser, entry, origin, files, sourceCommit, buildSha256,
        artifactReadbackSha256, signal: abort.signal, remaining, bounded, errors: active.errors, profile, scope })));
      active = undefined;
    }
    const reread = await bounded(snapshot(root, artifacts));
    if (reread.size !== files.size || [...files].some(([name, bytes]) => !reread.get(name)?.equals(bytes))) fail("static inventory changed during observation");
    const folder = ".eliotr-state/owner-web-startup-" + randomUUID(), evidence = [];
    await bounded(mkdir(path.resolve(root, folder), { recursive: false }));
    let nativeEvidence;
    if (local) {
      const nativeProof = await bounded(nativeStartup.evidence()), filename = folder + "/native-core.json";
      const bytes = Buffer.from(JSON.stringify(nativeProof, null, 2) + "\n");
      await bounded(writeFile(path.resolve(root, filename), bytes, { flag: "wx" }));
      nativeEvidence = { path: filename, byte_length: bytes.length, sha256: hash(bytes) };
    }
    for (const observation of observations) {
      const entry = ROUTES.find(item => item.route === observation.route);
      const filename = folder + "/" + (entry.route === "/" ? "root" : "agent-inbox") + ".json";
      const bytes = Buffer.from(JSON.stringify(observation, null, 2) + "\n");
      await bounded(writeFile(path.resolve(root, filename), bytes, { flag: "wx" }));
      evidence.push({ path: filename, byte_length: bytes.length, sha256: hash(bytes), route: entry.route,
        htmlPath: entry.htmlPath, profile, boundary: entry.boundary,
        ...(nativeEvidence ? { native_runtime: nativeEvidence } : {}) });
    }
    const startupObservations = await bounded(readOwnerWebStartup({ root, sourceCommit, buildSha256, artifacts, artifactReadbackSha256, evidence }));
    return { startupObservations, evidence, scope };
  } finally {
    const pendingChildren = [...children];
    clearTimeout(timer); abort.abort(); active = undefined;
    // Stop the live proxy independently of browser/context close success.
    const cleanup = [];
    if (nativeStartup) cleanup.push(cleanupWithin(() => nativeStartup.dispose(), "prepared Core"));
    if (server) {
      server.closeAllConnections();
      cleanup.push(cleanupWithin(() => new Promise((resolve, reject) => server.close(error => {
        if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(new Error("Owner-web startup: loopback close failed"));
        else resolve();
      })), "loopback server"));
    }
    for (const child of pendingChildren) {
      cleanup.push(cleanupWithin(() => new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        child.once("close", resolve); child.kill("SIGKILL");
      }), "diagnostic child"));
    }
    if (browser) cleanup.push(cleanupWithin(() => browser.close(), "browser"));
    const results = await Promise.allSettled(cleanup);
    if (results.some(result => result.status === "rejected")) fail("startup resource cleanup failed or exceeded bounds");
  }
}
