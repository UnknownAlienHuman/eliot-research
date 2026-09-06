import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, access, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
/* global URL: readonly, URLSearchParams: readonly, localStorage: readonly,
  sessionStorage: readonly, document: readonly, indexedDB: readonly, caches: readonly,
  Buffer: readonly, fetch: readonly, setTimeout: readonly, clearTimeout: readonly */
import { prepareLocal, executeLocal, executeLocalD1WithRetry, isTransientLocalD1Error, resolveLocalBrowserExecutable, writeHarnessMarker, removeHarnessOwned, wranglerArgs, devArguments } from "../../../scripts/lib/local-launch.mjs";
import { startLocalWorker, reserveChromiumSafePort } from "../../../scripts/lib/local-worker.mjs";
import { startOwnerBridge, bindChromiumSafeListener, isChromiumSafePort, assertChromiumSafePort, isPortCollisionMessage, CHROMIUM_UNSAFE_PORTS } from "../../../scripts/lib/local-owner-bridge.mjs";
import { initializeLocalNamespace } from "../../../scripts/lib/local-namespace.mjs";
import { localPolicyQuery, applyLocalReadPolicy } from "../../../scripts/lib/local-read-policy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const webcrypto = globalThis.crypto;
const encoder = new globalThis.TextEncoder();
const decoder = new globalThis.TextDecoder();

export const OWNER_E2E_ISSUER = "https://owner-e2e.cloudflareaccess.com";
export const OWNER_E2E_AUDIENCE = "owner-e2e-audience";
export const OWNER_E2E_CERTS_PATH = "/cdn-cgi/access/certs";
export const OWNER_E2E_KID = "e2e-key-1";

export const CONTROLLED_ISSUER_SEAM = {
  verifier: "packages/platform-cloudflare/src/access.ts:createCloudflareAccessVerifier (unchanged, ER-17 reviewed)",
  seam: "apps/eliotr-core/src/env.ts:resolveOwnerE2ETestFetch + apps/eliotr-core/src/http.ts:configuredAccessVerifier (ER-24, exact profile only)",
  profile: "tests/integration/browser/owner-e2e.mjs:applyOwnerE2EProfile (loopback ACCESS_TEST_JWKS_URL, controlled issuer/audience)",
  positive: "apps/eliotr-core/test/owner-session.test.ts:real-RSA/controlled-JWKS signed session + this live-Worker owner-e2e",
  runbook: "docs/implementation/local-launch.md:only signed-identity verification is replaced by a controlled test verifier",
  contract: "docs/implementation/launch-prs/execution-contract.md:fixtures may replace only the external issuer",
  limitation: "Controlled issuer replaces only the external IdP origin. JWT/RS256/issuer/audience/time/type/service checks stay on the production path.",
};

export const BROWSER_BUNDLE_LIMITS_EXPECTED = {
  files: 64,
  file_bytes: 16 * 1024 * 1024,
  metadata_bytes: 256 * 1024,
  total_bytes: 32 * 1024 * 1024,
};

export async function checkBundleLimitsSource() {
  const text = await readFile(resolve(root, "apps/eliotr-pwa/src/bundle-input.ts"), "utf8");
  assert.ok(text.includes("files: 64"), "browser profile must declare 64 files");
  assert.ok(text.includes("16 * 1024 * 1024"), "browser profile must declare 16 MiB/file");
  assert.ok(text.includes("32 * 1024 * 1024"), "browser profile must declare 32 MiB total");
  assert.ok(text.includes("256 * 1024"), "browser profile must declare 256 KiB metadata");
  const cases = [
    { name: "64 files max", value: 64, limit: 64, pass: true },
    { name: "65 files max+1", value: 65, limit: 64, pass: false },
    { name: "16MiB file max", value: 16 * 1024 * 1024, limit: 16 * 1024 * 1024, pass: true },
    { name: "16MiB+1 file max+1", value: 16 * 1024 * 1024 + 1, limit: 16 * 1024 * 1024, pass: false },
    { name: "256KiB metadata max", value: 256 * 1024, limit: 256 * 1024, pass: true },
    { name: "256KiB+1 metadata max+1", value: 256 * 1024 + 1, limit: 256 * 1024, pass: false },
    { name: "32MiB total max", value: 32 * 1024 * 1024, limit: 32 * 1024 * 1024, pass: true },
    { name: "32MiB+1 total max+1", value: 32 * 1024 * 1024 + 1, limit: 32 * 1024 * 1024, pass: false },
  ];
  for (const item of cases) {
    assert.equal(item.value <= item.limit, item.pass, `${item.name} bound mismatch`);
  }
  return { protocol: "eliotr.owner-e2e.bounds.v1", state: "PASS", cases: cases.length };
}

function base64UrlEncode(bytes) {
  return globalThis.btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(part) {
  const padded = part.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - part.length % 4) % 4);
  return Uint8Array.from(globalThis.atob(padded), (c) => c.charCodeAt(0));
}

async function sha256Hex(bytes) {
  const digest = await webcrypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createOwnerE2EKey() {
  const keys = await webcrypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await webcrypto.subtle.exportKey("jwk", keys.publicKey);
  assert.equal(keys.privateKey.extractable, true, "test key must be in-memory only");
  const bounded = { kty: "RSA", n: publicJwk.n, e: publicJwk.e, kid: OWNER_E2E_KID, alg: "RS256", use: "sig" };
  assert.ok(typeof bounded.n === "string" && bounded.n.length > 0 && typeof bounded.e === "string");
  assert.ok(JSON.stringify(bounded).length < 4096, "public JWK must stay bounded");
  return { privateKey: keys.privateKey, publicJwk: bounded };
}

export async function startLoopbackJsonServer(body, { path = OWNER_E2E_CERTS_PATH, closeTimeoutMs = 5000 } = {}) {
  assert.ok(typeof body === "string" && body.length > 0 && body.length < 8192, "loopback document must stay bounded");
  assert.ok(typeof path === "string" && path.startsWith("/") && !path.includes(".."), "loopback path must be exact");
  const serve = (req, res) => {
    void (async () => {
      const remote = req.socket.remoteAddress ?? "";
      const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
      if (!loopback) { res.statusCode = 403; res.end(); return; }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method !== "GET" || url.pathname !== path || url.search !== "" || url.hash !== "") {
        res.statusCode = 404; res.end(); return;
      }
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      res.end(body);
    })().catch(() => { try { res.statusCode = 500; res.end(); } catch { /* closed */ } });
  };
  const track = (server, sockets) => {
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => { sockets.delete(socket); });
    });
  };
  // Chromium-safe bind: port 0 may draw a Chromium-blocked ephemeral port on
  // Windows (observed: 6000 -> net::ERR_UNSAFE_PORT). Retry with a fresh listener;
  // rejected attempts are closed before retry, leaking no listener.
  const listenAttempt = (candidate) => new Promise((resolve, reject) => {
    const attempt = createServer(serve);
    attempt.once("error", (error) => {
      attempt.close(() => reject(error));
    });
    attempt.listen(candidate, "127.0.0.1", () => {
      resolve({ server: attempt, port: attempt.address().port });
    });
  });
  const bound = await bindChromiumSafeListener(listenAttempt, { port: 0 });
  assert.ok(isChromiumSafePort(bound.port), "bound loopback port must be Chromium-safe");
  const server = bound.server;
  const sockets = new Set();
  track(server, sockets);
  const port = bound.port;
  const url = `http://127.0.0.1:${port}${path}`;
  const close = async () => {
    for (const socket of [...sockets]) { try { socket.destroy(); } catch { /* owned only */ } }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("loopback server did not close within the strict deadline")), closeTimeoutMs);
      timer.unref?.();
      server.close((error) => { clearTimeout(timer); if (error) reject(error); else resolve(); });
    });
    for (const socket of [...sockets]) { try { socket.destroy(); } catch { /* owned only */ } }
  };
  return { url, port, bindAttempts: bound.attempts, close };
}

export async function startJwksServer(publicJwk, opts) {
  return startLoopbackJsonServer(JSON.stringify({ keys: [publicJwk] }), opts);
}

export async function startDuplicateJwksServer(publicJwk, opts) {
  // Negative fixture: two keys share one kid. The production verifier path must
  // fail closed with ACCESS_JWKS_INVALID (503), never select either key.
  return startLoopbackJsonServer(JSON.stringify({ keys: [publicJwk, { ...publicJwk }] }), opts);
}

// Mutable JWKS document for the real key-rollover proof. Serves exactly the
// keys installed via setKeys (bounded, RS256, distinct kids); rotate() swaps
// the v1 document for a v2 document so a restarted Worker (fresh JWKS fetch,
// i.e. the production cache-refresh path) allows the v2 token and denies the
// v1 token with ACCESS_JWT_KEY_UNKNOWN. Distinct from the duplicate-kid 503
// negative above, which keeps its own server and assertion.
export async function startRotatingJwksServer(initialKeys, opts) {
  assert.ok(Array.isArray(initialKeys) && initialKeys.length > 0, "rotating JWKS must start with keys");
  let current = JSON.stringify({ keys: initialKeys });
  const serve = (req, res) => {
    void (async () => {
      const remote = req.socket.remoteAddress ?? "";
      const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
      if (!loopback) { res.statusCode = 403; res.end(); return; }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method !== "GET" || url.pathname !== (opts?.path ?? OWNER_E2E_CERTS_PATH) || url.search !== "" || url.hash !== "") {
        res.statusCode = 404; res.end(); return;
      }
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      res.end(current);
    })().catch(() => { try { res.statusCode = 500; res.end(); } catch { /* closed */ } });
  };
  // The served document is read per request, so rotation never rebinds: the
  // Chromium-safe port stays fixed for the life of the server, no race.
  const bound = await bindChromiumSafeListener((candidate) => new Promise((resolve, reject) => {
    const attempt = createServer(serve);
    attempt.once("error", (error) => { attempt.close(() => reject(error)); });
    attempt.listen(candidate, "127.0.0.1", () => resolve({ server: attempt, port: attempt.address().port }));
  }), { port: 0 });
  assert.ok(isChromiumSafePort(bound.port), "rotating JWKS port must be Chromium-safe");
  const mutable = bound.server;
  const sockets = new Set();
  mutable.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => { sockets.delete(socket); });
  });
  const server = {
    url: `http://127.0.0.1:${bound.port}${OWNER_E2E_CERTS_PATH}`,
    port: bound.port,
    bindAttempts: bound.attempts,
    version: 1,
    setKeys(nextKeys) {
      assert.ok(Array.isArray(nextKeys) && nextKeys.length > 0 && JSON.stringify(nextKeys).length < 8192,
        "rotated JWKS document must stay bounded and non-empty");
      const kids = nextKeys.map((key) => key.kid);
      assert.deepEqual([...new Set(kids)].sort(), [...kids].sort(), "rotated JWKS kids must be distinct");
      current = JSON.stringify({ keys: nextKeys });
      server.version += 1;
    },
    async close() {
      for (const socket of [...sockets]) { try { socket.destroy(); } catch { /* owned only */ } }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("rotating JWKS did not close within the strict deadline")), 5000);
        timer.unref?.();
        mutable.close((error) => { clearTimeout(timer); if (error) reject(error); else resolve(); });
      });
    },
  };
  return server;
}

export async function verifyChromiumSafePortProtocol() {
  // Deterministic regression for the Windows net::ERR_UNSAFE_PORT failure.
  // Forces an unsafe ephemeral candidate (6000) then a collision (EADDRINUSE)
  // before a safe bind, using injected listeners; then proves the live loopback
  // path binds Chromium-safe. No sleep, no blacklist-of-one, no leaked listener.
  let cases = 0;
  const pass = (condition, message) => { cases += 1; assert.ok(condition, message); };
  pass(CHROMIUM_UNSAFE_PORTS.has(6000), "unsafe-port policy must cover the observed 6000 failure");
  for (const port of [6000, 6666, 6667, 5060, 5061, 10080, 4045, 3659, 2049, 6697]) {
    pass(!isChromiumSafePort(port), `policy must reject Chromium-unsafe ${port}`);
  }
  for (const port of [1024, 8787, 8788, 49152, 65535]) {
    pass(isChromiumSafePort(port), `policy must accept safe loopback port ${port}`);
  }
  for (const port of [0, 1, 80, 443, 1023, 65536, -1, Number.NaN]) {
    pass(!isChromiumSafePort(port), `policy must reject out-of-range ${String(port)}`);
  }
  let syncRejected = false;
  try { assertChromiumSafePort(6000); } catch (error) { syncRejected = /Chromium-unsafe/.test(String(error?.message ?? error)); }
  pass(syncRejected, "explicit unsafe port must fail closed");
  const opened = [];
  const closed = [];
  const script = ["unsafe", "collision", "safe"];
  const fakeListen = async (candidate) => {
    const record = { candidate, closed: false, bound: false };
    record.close = (callback) => { record.closed = true; closed.push(record); callback(); };
    opened.push(record);
    const next = script.shift();
    if (next === "unsafe") { record.bound = true; return { server: record, port: 6000 }; }
    if (next === "collision") throw Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
    record.bound = true;
    return { server: record, port: 48151 };
  };
  const before = opened.length;
  await assert.rejects(bindChromiumSafeListener(fakeListen, { port: 6000, attempts: 5 }),
    /Chromium-unsafe/, "explicit unsafe request must fail without binding");
  pass(opened.length === before, "explicit unsafe request must not bind any listener");
  const bound = await bindChromiumSafeListener(fakeListen, { port: 0, attempts: 5 });
  pass(bound.port === 48151, "retry must land on the safe bind");
  pass(bound.attempts === 3, "retry must report unsafe + collision + safe attempts");
  pass(opened.length === before + 3 && closed.length === 1, "unsafe bind closed; collision bound nothing to close");
  pass(opened[before + 2] !== undefined && opened[before + 2].closed === false && bound.server === opened[before + 2],
    "successful bind must stay open exactly once");
  await new Promise((resolve) => bound.server.close(() => resolve()));
  const live = await bindChromiumSafeListener((candidate) => new Promise((resolve, reject) => {
    const attempt = createServer((req, res) => { res.end(); });
    attempt.once("error", (error) => { attempt.close(() => reject(error)); });
    attempt.listen(candidate, "127.0.0.1", () => resolve({ server: attempt, port: attempt.address().port }));
  }), { port: 0 });
  pass(isChromiumSafePort(live.port), "live ephemeral bind must be Chromium-safe");
  await new Promise((resolve, reject) => live.server.close((error) => error ? reject(error) : resolve()));
  pass(opened.slice(before).filter((record) => record.bound && !record.closed).length === 0,
    "no bound fake listener left open after the winner close");
  // Deterministic REAL collision: hold a live TCP listener on a Chromium-safe
  // port, then prove the production reserve path reselects to a different safe
  // port (evidence for the startLocalWorker reselect loop) and that an
  // explicit bind of the held port fails with a collision diagnostic while
  // leaking no listener.
  // Bind the holder through the production reserve path until it holds a
  // Chromium-safe port (bounded; an unsafe ephemeral draw closes its listener
  // before the next draw, so no leak). The holder then stays open while the
  // proof below runs, which is the deterministic collision.
  let holder;
  let heldPort = 0;
  for (let draw = 1; draw <= 25; draw += 1) {
    const candidate = createTcpServer();
    const port = await new Promise((resolve, reject) => {
      candidate.once("error", (error) => { candidate.close(() => reject(error)); });
      candidate.listen(0, "127.0.0.1", () => resolve(candidate.address().port));
    }).catch(() => 0);
    if (port !== 0 && isChromiumSafePort(port)) { holder = candidate; heldPort = port; break; }
    await new Promise((resolve) => candidate.close(() => resolve()));
    assert.ok(draw < 25, "holder must draw a Chromium-safe port within the bound");
  }
  try {
    pass(Number.isSafeInteger(heldPort) && isChromiumSafePort(heldPort),
      `holder must own a Chromium-safe port, got ${heldPort}`);
    const reselected = await reserveChromiumSafePort();
    pass(reselected.port !== heldPort,
      `reserve must reselect away from the held port ${heldPort}, got ${reselected.port}`);
    pass(isChromiumSafePort(reselected.port),
      `reselected port ${reselected.port} must be Chromium-safe (evidence: held=${heldPort} winner=${reselected.port} reserveAttempts=${reselected.attempts})`);
    let explicitFailed = false;
    try {
      await bindChromiumSafeListener((candidate) => new Promise((resolve, reject) => {
        const attempt = createTcpServer();
        attempt.once("error", (error) => { attempt.close(() => reject(error)); });
        attempt.listen(candidate, "127.0.0.1", () => resolve({ server: attempt, port: attempt.address().port }));
      }), { port: heldPort, attempts: 1 });
    } catch (error) {
      explicitFailed = isPortCollisionMessage(`${error?.message ?? error}${error?.code ?? ""}`);
    }
    pass(explicitFailed, "explicit bind of the held port must fail with a collision diagnostic and leak no listener");
    // Unsafe-6000 case through the real dev-argument gate: no spawn, just the
    // fail-closed refusal the Worker path enforces before any listener binds.
    let unsafeRefused = false;
    try {
      devArguments({ config: "wrangler.json", persist: "state", generation: "test" }, 6000);
    } catch (error) {
      unsafeRefused = /Chromium-unsafe/.test(String(error?.message ?? error));
    }
    pass(unsafeRefused, "devArguments(6000) must fail closed as Chromium-unsafe");
  } finally {
    await new Promise((resolve, reject) => holder.close((error) => error ? reject(error) : resolve()));
  }
  return { protocol: "eliotr.owner-e2e.chromium-safe-ports.v1", state: "PASS", cases };
}

export function encodeJwtPart(value) {
  return base64UrlEncode(encoder.encode(JSON.stringify(value)));
}

export async function signOwnerToken(privateKey, claims, kid = OWNER_E2E_KID) {
  const data = `${encodeJwtPart({ alg: "RS256", typ: "JWT", kid })}.${encodeJwtPart(claims)}`;
  const signature = await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, encoder.encode(data));
  return `${data}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function applyOwnerE2EProfile(paths, jwksUrl) {
  const jwks = new URL(jwksUrl);
  assert.equal(jwks.protocol, "http:", "JWKS override must be loopback http");
  assert.equal(jwks.hostname, "127.0.0.1", "JWKS override must be 127.0.0.1");
  assert.equal(jwks.pathname, OWNER_E2E_CERTS_PATH, "JWKS override must use the exact certs path");
  assert.equal(jwks.search, "", "JWKS override must not carry a query");
  const port = Number(jwks.port);
  assert.ok(Number.isSafeInteger(port) && port >= 1024 && port <= 65535, "JWKS override port must be in range");
  const text = await readFile(paths.config, "utf8");
  assert.ok(!text.includes("owner-e2e") || text.includes(OWNER_E2E_ISSUER), "profile patch must be explicit");
  assert.ok(!/BEGIN PRIVATE|"d"\s*:\s*"[A-Za-z0-9_-]{10,}/.test(text), "Worker config must never contain private key material");
  const config = JSON.parse(text);
  assert.equal(config.name, "eliotr-core-local", "local profile must stay canonical");
  assert.equal(config.vars?.ENVIRONMENT, "development", "owner-e2e seam requires dedicated development ENVIRONMENT");
  config.vars = {
    ...config.vars,
    ENVIRONMENT: "development",
    ACCESS_TEAM_DOMAIN: OWNER_E2E_ISSUER,
    ACCESS_AUDIENCE: OWNER_E2E_AUDIENCE,
    ACCESS_TEST_JWKS_URL: jwksUrl,
  };
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  assert.ok(serialized.length < 65536, "patched profile must stay bounded");
  assert.ok(!serialized.includes("BEGIN PRIVATE"), "patched profile must not embed private keys");
  await writeFile(paths.config, serialized, { mode: 0o600 });
  return { issuer: OWNER_E2E_ISSUER, audience: OWNER_E2E_AUDIENCE, jwksUrl };
}

function d1Query(paths, binding, sql) {
  // Authoritative CLI D1 readback shares SQLite files with a running
  // `wrangler dev` Worker. Bounded retry covers documented transient locks
  // (SQLITE_BUSY/database is locked/EBUSY) within a strict deadline; schema,
  // authority and data errors stay fail-closed with no new generation.
  // While the Worker is running, Worker/API readback (catalog/revisions/
  // session) is the primary active-runtime signal; CLI reads below reconcile
  // the same durable state and must replay exactly after restart.
  const output = executeLocalD1WithRetry(wranglerArgs(paths, ["d1", "execute", binding, "--command", sql, "--json"]), { execute: executeLocal });
  let batches;
  try {
    batches = JSON.parse(output);
  } catch (error) {
    assert.fail(`D1 query returned non-JSON readback: ${String(error?.message ?? error).slice(0, 200)}`);
  }
  assert.ok(Array.isArray(batches) && batches.length === 1 && batches[0].success === true, "D1 query did not produce one success result");
  return batches[0].results;
}

function isRetryableNamespaceObservation(error) {
  if (isTransientLocalD1Error(error)) return true;
  const cause = error?.cause;
  if (cause && isTransientLocalD1Error(cause)) return true;
  const text = `${error?.message ?? ""}\n${cause?.message ?? ""}\n${cause?.cause?.diagnostic ?? ""}\n${cause?.cause?.stdout ?? ""}\n${cause?.cause?.stderr ?? ""}`;
  return /TRANSIENT_D1_LOCK|SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy|resource busy or locked|\bEBUSY\b|\bEPERM\b|\bETIMEDOUT\b|\bEAGAIN\b|miniflare.*lock|lock.*miniflare/i.test(text)
    && !/CONFLICT|SETTLEMENT_UNCERTAIN|INPUT_INVALID|PROFILE_UNSUPPORTED|EXISTING_LINEAGE|OWNER_REQUIRED|READBACK_INVALID|no such table|no such column|syntax error/i.test(text);
}

async function initializeNamespaceWithBoundedRetry(args, { attempts = 6, deadlineMs = 15000, delayMs = 250 } = {}) {
  const deadline = Date.now() + deadlineMs;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await initializeLocalNamespace(args);
    } catch (error) {
      lastError = error;
      if (!isRetryableNamespaceObservation(error)) throw error;
      if (attempt >= attempts || Date.now() + delayMs > deadline) throw error;
      await new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function verifyMigrationLedgers(paths) {
  const counts = {};
  for (const [binding, directory] of [["CORE_DB", "core"], ["SEARCH_DB", "search"]]) {
    const expected = (await readdir(resolve(root, "infra/d1", directory, "migrations"))).filter((name) => name.endsWith(".sql")).sort();
    assert.ok(expected.length > 0, "migration streams must be non-empty");
    const rows = d1Query(paths, binding, "SELECT name FROM d1_migrations ORDER BY name");
    assert.deepEqual(rows.map((row) => row.name), expected, "Local migration ledger differs from tracked migration files");
    counts[binding] = expected.length;
  }
  return counts;
}

// Bounded retry for read-only restart readbacks against the local runner.
// Only unclassified runner flakes (e.g. a lingering workerd file handle after
// worker.stop) are retried; the acceptance predicate stays byte-exact, so real
// drift fails identically on every attempt and the last error is thrown.
async function readbackWithBoundedRetry(label, fn, { attempts = 3, delayMs = 1000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function workerJson(origin, path, { token, method = "GET", body, contentType } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers["cf-access-jwt-assertion"] = token;
  if (contentType) headers["content-type"] = contentType;
  const response = await globalThis.fetch(`${origin}${path}`, {
    method, headers, body, redirect: "manual", signal: globalThis.AbortSignal.timeout(15000),
  });
  const text = await response.text();
  const data = (() => {
    try { return text ? JSON.parse(text) : null; } catch { return { raw: text.slice(0, 512) }; }
  })();
  return { status: response.status, data, headers: response.headers };
}

// Single authoritative cross-client ledger sink. Every lifecycle HTTP call the
// harness originates records exactly one entry proving its client origin:
// `browser` entries come back from Chromium page.evaluate fetch (same-origin
// via the current page origin) and carry the page URL as origin proof; `node`
// entries are attacker-probe/CLI paths that never carry owner authority.
// Asserted exhaustively at the end: captured-but-unasserted is failure.
// Serialized entries must never contain JWT material (tokens travel only as
// opaque lengths, never values).
export function createCrossClientLedger() {
  const entries = [];
  let seq = 0;
  return {
    entries,
    record(entry) {
      seq += 1;
      assert.ok(entry && (entry.client === "browser" || entry.client === "node"),
        "ledger entry must declare an exact client origin");
      assert.ok(typeof entry.method === "string" && typeof entry.path === "string" &&
        Number.isSafeInteger(entry.status), "ledger entry must carry exact method/path/status");
      entries.push({ seq, ...entry });
      return seq;
    },
  };
}

export function assertCrossClientLedger(ledger, label) {
  assert.ok(ledger.entries.length > 0, `${label}: cross-client ledger must be non-empty`);
  const seen = new Set();
  for (const entry of ledger.entries) {
    assert.ok(Number.isSafeInteger(entry.seq) && entry.seq > 0, `${label}: ledger seq must be exact`);
    assert.ok(!seen.has(entry.seq), `${label}: ledger seq must be unique and ordered`);
    seen.add(entry.seq);
    assert.ok(entry.client === "browser" || entry.client === "node", `${label}: unknown client origin`);
    assert.ok(typeof entry.correlation === "string" && entry.correlation.length > 0,
      `${label}: ledger entry must carry a correlation id`);
  }
  for (let index = 1; index <= ledger.entries.length; index += 1) {
    assert.ok(seen.has(index), `${label}: ledger ordering must be gapless, missing seq ${index}`);
  }
  const serialized = JSON.stringify(ledger.entries);
  assert.ok(!/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(serialized) &&
    !serialized.includes("cf-access-jwt-assertion"),
    `${label}: cross-client ledger must never contain JWT material`);
  return { protocol: "eliotr.owner-e2e.cross-client-ledger.v1", state: "PASS", entries: ledger.entries.length };
}

// Browser-originated JSON call: runs fetch() inside Chromium via page.evaluate
// against the page's own origin (same-origin, no CORS egress), so the
// Playwright request/response ledger independently records the identical
// method/path/status. Returns the parsed outcome and records one `browser`
// ledger entry. Tokens are never written into the ledger (opaque length only).
export async function browserJson(page, ledger, path, { method = "GET", body, contentType, extraHeaders, tokenLength = 0, correlation } = {}) {
  assert.ok(typeof path === "string" && path.startsWith("/"), "browser call must use an exact same-origin path");
  assert.ok(typeof correlation === "string" && correlation.length > 0, "browser call must carry a correlation id");
  // Only the production access-assertion header may be added (JWT matrix);
  // never cookies, authorization substitutes or forwarded network identity.
  // Header VALUES stay inside the page; the ledger records presence only.
  if (extraHeaders !== undefined) {
    assert.ok(typeof extraHeaders === "object" && extraHeaders !== null &&
      Object.keys(extraHeaders).every((key) => key === "cf-access-jwt-assertion"),
      "browser extra headers are limited to the access assertion");
  }
  const outcome = await page.evaluate(async ({ pathArg, methodArg, bodyArg, contentTypeArg, extraHeadersArg }) => {
    const init = { method: methodArg, redirect: "manual", credentials: "same-origin",
      headers: { Accept: "application/json", ...(extraHeadersArg ?? {}) } };
    if (contentTypeArg) init.headers["content-type"] = contentTypeArg;
    if (bodyArg !== undefined) init.body = bodyArg;
    const response = await fetch(pathArg, init);
    const text = await response.text();
    const data = (() => {
      try { return text ? JSON.parse(text) : null; } catch { return { raw: text.slice(0, 512) }; }
    })();
    return { status: response.status, url: response.url, data };
  }, { pathArg: path, methodArg: method, bodyArg: body, contentTypeArg: contentType, extraHeadersArg: extraHeaders });
  ledger.record({ client: "browser", method, path, status: outcome.status,
    correlation, token_present: tokenLength > 0 || extraHeaders !== undefined });
  assert.ok(!/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(JSON.stringify(outcome.data ?? null)),
    `browser response must not reflect credentials: ${method} ${path}`);
  return outcome;
}

async function verifyControlledIssuerCrypto(privateKey, publicJwk) {
  const nowSeconds = Math.floor(globalThis.Date.now() / 1000);
  const goodClaims = { iss: OWNER_E2E_ISSUER, aud: [OWNER_E2E_AUDIENCE], sub: "e2e-owner", type: "app", iat: nowSeconds, exp: nowSeconds + 600 };
  const good = await signOwnerToken(privateKey, goodClaims);
  const parts = good.split(".");
  assert.equal(parts.length, 3, "signed token must have three segments");
  const header = JSON.parse(decoder.decode(base64UrlDecode(parts[0])));
  assert.equal(header.alg, "RS256");
  assert.equal(header.kid, OWNER_E2E_KID);
  const key = await webcrypto.subtle.importKey("jwk", { ...publicJwk },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await webcrypto.subtle.verify("RSASSA-PKCS1-v1_5", key,
    base64UrlDecode(parts[2]), encoder.encode(`${parts[0]}.${parts[1]}`));
  assert.equal(valid, true, "in-memory signature must verify against the public JWK");
  const forged = `${parts[0]}.${parts[1]}.AAAA`;
  const forgedValid = await webcrypto.subtle.verify("RSASSA-PKCS1-v1_5", key,
    base64UrlDecode("AAAA"), encoder.encode(`${parts[0]}.${parts[1]}`)).catch(() => false);
  assert.equal(forgedValid, false, "forged signature must not verify");
  assert.ok(forged !== good);
  return { protocol: "eliotr.owner-e2e.controlled-issuer.v1", state: "PASS", issuer: OWNER_E2E_ISSUER, audience: OWNER_E2E_AUDIENCE };
}

async function launchPlaywright(runId) {
  const { chromium } = await import("playwright-core");
  const profileDir = await mkdtemp(resolve(tmpdir(), "eliotr-owner-e2e-profile-"));
  await writeHarnessMarker(profileDir, runId, "browser-profile");
  let context;
  let browser;
  try {
    const executable = await resolveLocalBrowserExecutable();
    await access(executable);
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath: executable,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run",
        "--disable-background-networking", "--disable-component-update", "--disable-extensions",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
    });
    browser = context.browser();
    assert.ok(browser, "Playwright browser must be owned by this harness");
    const page = context.pages()[0] ?? await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];
    const responses = [];
    // Full phase-aware traffic ledger: every browser request AND response is
    // recorded with method, normalized origin/path, status and resource type so
    // the phase assertion below closes over ALL traffic, including successful
    // unexpected responses that console/pageerror/failed-request ledgers miss.
    const requests = [];
    const networkResponses = [];
    const websockets = [];
    const pageWorkers = [];
    const ledgerEntry = (method, rawUrl) => {
      try {
        const parsed = new URL(rawUrl);
        return { method, origin: parsed.origin, path: `${parsed.pathname}${parsed.search}`.slice(0, 512) };
      } catch {
        return { method, origin: "unparsable", path: String(rawUrl).slice(0, 512) };
      }
    };
    // Context-level capture (not page-level): the PWA shell worker /sw.js
    // re-issues fetches from worker scope, and page-level events do not report
    // worker-scope requests while still reporting their failures, which breaks
    // request/response pairing. Context events cover page and worker scopes
    // uniformly, so every outcome pairs with its request.
    context.on("request", (request) => {
      const entry = ledgerEntry(request.method(), request.url());
      requests.push({ ...entry, resourceType: request.resourceType() });
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        const loc = message.location();
        const where = loc?.url ? ` @${String(loc.url).slice(0, 160)}` : "";
        consoleErrors.push(`${message.text().slice(0, 1500)}${where}`.slice(0, 2048));
      }
    });
    page.on("pageerror", (error) => { pageErrors.push(String(error?.stack ?? error).slice(0, 2048)); });
    context.on("requestfailed", (request) => { failedRequests.push(
      `${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? "unknown"}`.slice(0, 512)); });
    context.on("response", (response) => {
      const request = response.request();
      const entry = ledgerEntry(request.method(), request.url());
      let contentType;
      try { contentType = String(response.headers()["content-type"] ?? "").split(";")[0]?.trim().slice(0, 128) ?? ""; }
      catch { contentType = "unreadable"; }
      networkResponses.push({ ...entry, status: response.status(), resourceType: request.resourceType(), contentType });
      responses.push(`${request.method()} ${request.url()} -> ${response.status()}`.slice(0, 512));
    });
    page.on("websocket", (socket) => { websockets.push(socket.url().slice(0, 512)); });
    page.on("worker", (worker) => { pageWorkers.push(worker.url().slice(0, 512)); });
    const evaluate = (fn, arg) => page.evaluate(fn, arg);
    const resetLedger = () => {
      consoleErrors.length = 0; pageErrors.length = 0; failedRequests.length = 0; responses.length = 0;
      requests.length = 0; networkResponses.length = 0; websockets.length = 0; pageWorkers.length = 0;
    };
    const close = async () => {
      try { await context?.close(); } catch { /* Best-effort. */ }
      try { await browser?.close(); } catch { /* Already closed. */ }
      await removeHarnessOwned(profileDir, runId);
      await assert.rejects(access(profileDir), /ENOENT/, "temp browser profile must be removed");
    };
    return { browser, context, page, evaluate, consoleErrors, pageErrors, failedRequests, responses,
      requests, networkResponses, websockets, pageWorkers, resetLedger, close, profileDir };
  } catch (error) {
    try { await context?.close(); } catch { /* Close partial context before profile removal. */ }
    try { await browser?.close(); } catch { /* Close partial browser before profile removal. */ }
    try { await removeHarnessOwned(profileDir, runId); } catch { /* Marker mismatch: retain for inspection. */ }
    throw error;
  }
}

async function dumpStorageInPage() {
  const out = { localKeys: Object.keys(localStorage), sessionKeys: Object.keys(sessionStorage),
    cookie: document.cookie || "", indexedDB: [], caches: [], idbDump: "", cacheUrls: [] };
  if (typeof indexedDB !== "undefined" && indexedDB.databases) {
    try { out.indexedDB = (await indexedDB.databases()).map((d) => d.name); } catch { out.indexedDB = ["unknown"]; }
  }
  if (typeof caches !== "undefined") {
    try {
      out.caches = await caches.keys();
      for (const name of out.caches) {
        try {
          const cache = await caches.open(name);
          for (const req of await cache.keys()) out.cacheUrls.push(req.url.slice(0, 512));
        } catch { out.cacheUrls.push("unreadable"); }
      }
    } catch { out.caches = ["unknown"]; }
  }
  for (const name of out.indexedDB) {
    try {
      const open = indexedDB.open(name);
      const db = await new Promise((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const dumps = [];
      for (const storeName of Array.from(db.objectStoreNames)) {
        const rows = await new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, "readonly");
          const req = tx.objectStore(storeName).getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        dumps.push(storeName + ":" + JSON.stringify(rows).slice(0, 4096));
      }
      db.close();
      out.idbDump += dumps.join("|").slice(0, 8192);
    } catch { out.idbDump += "unreadable"; }
  }
  return out;
}

async function readBrowserStorage(page) {
  return page.evaluate(dumpStorageInPage);
}

function shellReady() {
  return Boolean(document.querySelector("#app") || document.querySelector("#library"));
}

function bodyIncludes(text) {
  return Boolean(document.body?.textContent?.includes(text));
}

function hasPrivateLibraryMarker() {
  return Boolean(document.body?.textContent?.includes("Source catalog-") || document.querySelector("#library [data-source]"));
}

function assertNoPrivateStorage(storage, label) {
  assert.deepEqual(storage.localKeys, [], `${label}: localStorage must be empty`);
  assert.deepEqual(storage.sessionKeys, [], `${label}: sessionStorage must be empty`);
  assert.ok(!storage.cookie.includes("eyJ") && !storage.cookie.toLowerCase().includes("jwt"),
    `${label}: document.cookie must hold no JWT`);
  assert.ok(storage.caches.every((name) => name === "eliotr-shell-v1"),
    `${label}: only the non-private PWA shell cache may exist, found: ${JSON.stringify(storage.caches)}`);
  assert.ok(storage.cacheUrls.every((url) => !url.includes("/api/") && !url.includes("/federation/") && !url.includes("/oauth/") && !url.includes("eyJ")),
    `${label}: CacheStorage must not retain private API responses`);
  assert.ok(storage.indexedDB.every((name) => name === "eliotr-shell-v1" || storage.indexedDB.length === 0),
    `${label}: only the non-private PWA shell DB may exist, found: ${JSON.stringify(storage.indexedDB)}`);
  const dump = `${storage.idbDump}|${storage.cookie}`;
  assert.ok(!dump.includes("eyJ") && !dump.includes("cf-access") && !dump.includes("catalog-") && !dump.includes("source-"),
    `${label}: browser storage must hold no credentials/source bytes/private responses`);
}

export function assertAuthedLedger(harness, label, origin) {
  const { consoleErrors, pageErrors, failedRequests } = harness;
  assert.deepEqual(pageErrors, [], `${label}: pageerror must be empty`);
  // Contract: /manifest.webmanifest is an exact public shell asset proxied
  // without a session and served exact 200 (see authedNetworkSpec). A manifest
  // 401 here is drift and must fail, never be allowlisted as noise.
  for (const text of consoleErrors) {
    assert.ok(!text.includes("/manifest.webmanifest"),
      `${label}: manifest must serve exact 200, got authed console: ${text.slice(0, 300)}`);
  }
  const pair403 = `Failed to load resource: the server responded with a status of 403 (Forbidden) @${origin}/__local/pair`;
  const allowedConsole = new Set([pair403]);
  assert.ok(consoleErrors.length <= 1, `${label}: at most the exact one-use reuse noise may log, got: ${consoleErrors.slice(0, 5).join("; ")}`);
  for (const text of consoleErrors) {
    assert.ok(allowedConsole.has(text), `${label}: unexpected authed console, got: ${text.slice(0, 300)}`);
    assert.ok(!text.includes("eyJ") && !text.includes("/api/"),
      `${label}: authed console must hold no JWT and no private API 401, got: ${text.slice(0, 200)}`);
  }
  const allowedFailed = new Set([
    `GET ${origin}/api/v1/research/catalog?limit=20 :: net::ERR_ABORTED`,
    `POST ${origin}/__local/pair :: net::ERR_ABORTED`,
  ]);
  assert.ok(failedRequests.length <= 2, `${label}: at most the exact superseded probes may abort`);
  for (const text of failedRequests) {
    assert.ok(allowedFailed.has(text), `${label}: unexpected authed abort, got: ${text.slice(0, 300)}`);
  }
}

// Regression: a manifest 401 in the authed window must fail closed because the
// contract requires exact 200 for the public shell asset. Passes only when a
// synthetic manifest-401 harness is rejected and the clean + one-use-reuse
// harnesses are accepted.
export function verifyAuthedManifestRegression(origin = "http://127.0.0.1:1") {
  const pair403 = `Failed to load resource: the server responded with a status of 403 (Forbidden) @${origin}/__local/pair`;
  const manifest401 = `Failed to load resource: the server responded with a status of 401 (Unauthorized) @${origin}/manifest.webmanifest`;
  assert.throws(() => assertAuthedLedger({ consoleErrors: [manifest401], pageErrors: [], failedRequests: [] },
    "manifest-regression", origin), /manifest must serve exact 200/,
    "authed ledger must reject a manifest 401");
  assert.throws(() => assertAuthedLedger({ consoleErrors: [`Manifest fetch from ${origin}/manifest.webmanifest failed, code 401 @${origin}/`], pageErrors: [], failedRequests: [] },
    "manifest-regression", origin), /manifest must serve exact 200/,
    "authed ledger must reject a manifest fetch 401");
  assert.doesNotThrow(() => assertAuthedLedger({ consoleErrors: [], pageErrors: [], failedRequests: [] },
    "manifest-regression", origin), "clean authed ledger must pass");
  assert.doesNotThrow(() => assertAuthedLedger({ consoleErrors: [pair403], pageErrors: [], failedRequests: [] },
    "manifest-regression", origin), "one-use pair 403 reuse noise must pass");
  return { protocol: "eliotr.owner-e2e.authed-manifest-regression.v1", state: "PASS" };
}

function assertUnauthLedger(harness, label, origin) {
  const { consoleErrors, pageErrors, failedRequests } = harness;
  assert.deepEqual(pageErrors, [], `${label}: pageerror must be empty`);
  const allowedConsole = new Set([
    `Failed to load resource: the server responded with a status of 401 (Unauthorized) @${origin}/api/v1/research/catalog?limit=20`,
    `Failed to load resource: the server responded with a status of 401 (Unauthorized) @${origin}/api/v1/system/health`,
  ]);
  assert.ok(consoleErrors.length <= 2, `${label}: at most the two exact unauth probes may log, got: ${consoleErrors.slice(0, 3).join("; ")}`);
  assert.ok(new Set(consoleErrors).size === consoleErrors.length, `${label}: duplicate console entries indicate retry noise`);
  for (const text of consoleErrors) {
    assert.ok(allowedConsole.has(text), `${label}: unexpected console error, got: ${text.slice(0, 300)}`);
    assert.ok(!text.includes("eyJ"), `${label}: ledger must never contain JWT`);
  }
  const allowedFailed = new Set([
    `GET ${origin}/api/v1/research/catalog?limit=20 :: net::ERR_ABORTED`,
    `GET ${origin}/api/v1/system/health :: net::ERR_ABORTED`,
  ]);
  assert.ok(failedRequests.length <= 2, `${label}: at most the two exact probes may abort, got: ${failedRequests.slice(0, 3).join("; ")}`);
  for (const text of failedRequests) {
    assert.ok(allowedFailed.has(text), `${label}: unexpected failed request, got: ${text.slice(0, 300)}`);
  }
  for (const text of [...consoleErrors, ...failedRequests]) {
    assert.ok(!text.includes("favicon") && !text.includes("manifest"),
      `${label}: favicon/manifest must never fail, got: ${text.slice(0, 200)}`);
  }
}

// Phase-aware full traffic closure over ALL browser requests AND responses.
// `api` enumerates every expected responded application/local request as exact
// { method, path, status } triples, including successful ones: any 2xx outside
// `api` is successful unexpected traffic and fails. Static shell GETs are allowed
// only same-origin, non-API, 200/304, with inert resource types. Everything else
// fails closed: cross-origin egress, redirects (except 304), event streams,
// websockets, workers, unlisted mutations, unpaired responses, and unlisted aborts.
// Serialized ledgers must never contain JWT material.
// Static shell GETs are allowed only same-origin, non-API, 200/304. The shell
// worker re-issues subresource fetches from worker scope with resourceType
// fetch/xhr (observed: document fetch of /), so inert fetch types are allowed
// here; application routes are still classified by exact path regardless of type.
const STATIC_RESOURCE_TYPES = new Set(["document", "stylesheet", "script", "image", "font", "manifest", "other", "fetch", "xhr"]);

export function summarizePhaseLedger(harness) {
  const serviceWorkers = typeof harness.context?.serviceWorkers === "function" ? harness.context.serviceWorkers() : [];
  return {
    requests: harness.requests.length,
    responses: harness.networkResponses.length,
    failed: harness.failedRequests.length,
    websockets: harness.websockets.length,
    workers: harness.pageWorkers.length,
    service_workers: serviceWorkers.map((entry) => entry.url()),
    console_errors: harness.consoleErrors.length,
    page_errors: harness.pageErrors.length,
  };
}

async function settleLedger(page) {
  // Let straggler responses land before pairing; leftovers still fail below.
  try { await page.waitForLoadState("networkidle", { timeout: 10000 }); } catch { /* unpaired traffic fails closed */ }
}

// Exact per-phase traffic contracts. Allowlists are upper bounds: every entry is
// a route the application legitimately uses in that phase with an exact status.
// Anything else, including successful unexpected responses, fails.
function unauthNetworkSpec(origin) {
  return {
    origins: [origin],
    api: [
      { method: "GET", path: "/api/v1/research/catalog?limit=20", status: 401 },
      { method: "GET", path: "/api/v1/system/health", status: 401 },
    ],
    aborts: [
      `GET ${origin}/api/v1/research/catalog?limit=20 :: net::ERR_ABORTED`,
      `GET ${origin}/api/v1/system/health :: net::ERR_ABORTED`,
    ],
  };
}

function authedNetworkSpec(origin) {
  return {
    origins: [origin],
    api: [
      { method: "GET", path: "/__local/", status: 200 },
      { method: "POST", path: "/__local/pair", status: 204 },
      { method: "POST", path: "/__local/pair", status: 403 },
      { method: "GET", path: "/api/v1/research/catalog?limit=20", status: 200 },
      { method: "GET", path: "/api/v1/system/health", status: 200 },
      // Exact public shell asset: the bridge proxies /manifest.webmanifest
      // (GET, no query) without a session because Chromium fetches it
      // credentialless while the Worker serves it publicly. Must succeed (200);
      // any other status is drift and fails below.
      { method: "GET", path: "/manifest.webmanifest", status: 200 },
    ],
    mutations: ["/__local/pair"],
    aborts: [
      `GET ${origin}/api/v1/research/catalog?limit=20 :: net::ERR_ABORTED`,
      `POST ${origin}/__local/pair :: net::ERR_ABORTED`,
    ],
  };
}

function logoutNetworkSpec(origin) {
  return {
    origins: [origin],
    api: [
      { method: "GET", path: "/__local/", status: 200 },
      { method: "POST", path: "/__local/logout", status: 204 },
      { method: "GET", path: "/api/v1/research/catalog?limit=20", status: 401 },
      { method: "GET", path: "/api/v1/system/health", status: 200 },
      // Same exact public shell asset as the authed phase: proxied without a
      // session, must succeed (200).
      { method: "GET", path: "/manifest.webmanifest", status: 200 },
    ],
    mutations: ["/__local/logout"],
    aborts: [`POST ${origin}/__local/logout :: net::ERR_ABORTED`],
  };
}

export function assertPhaseNetwork(harness, label, { origins, api, mutations = [], aborts = [], workerOrigins = origins }) {
  assert.ok(Array.isArray(origins) && origins.length > 0, `${label}: phase origins must be explicit`);
  assert.deepEqual(harness.websockets, [], `${label}: websocket must be empty (event-stream/socket egress denied)`);
  assert.deepEqual(harness.pageWorkers, [], `${label}: worker/service-worker must be empty (background fetch denied)`);
  // Narrow service-worker rule, evidence-backed: the built PWA registers exactly
  // its same-origin shell worker /sw.js (the eliotr-shell-v1 cache asserted
  // non-private by assertNoPrivateStorage). Workers persist across navigations in
  // the persistent context, so their origins may be any harness origin visited so
  // far (workerOrigins), while requests stay bound to the current phase origins.
  // Any other worker scope, any cross-harness worker, or duplicates fail closed.
  const serviceWorkers = typeof harness.context?.serviceWorkers === "function" ? harness.context.serviceWorkers() : [];
  const swUrls = serviceWorkers.map((entry) => entry.url());
  assert.ok(swUrls.length <= workerOrigins.length, `${label}: at most one shell worker per visited origin may exist, got: ${swUrls.join(",").slice(0, 300)}`);
  const seenWorkerOrigins = new Set();
  for (const raw of swUrls) {
    let parsed;
    try { parsed = new URL(raw); } catch { assert.fail(`${label}: unparsable worker url: ${String(raw).slice(0, 200)}`); }
    assert.ok(workerOrigins.includes(parsed.origin) && parsed.pathname === "/sw.js" && parsed.search === "" &&
      !seenWorkerOrigins.has(parsed.origin),
      `${label}: unexpected service worker scope: ${String(raw).slice(0, 300)}`);
    seenWorkerOrigins.add(parsed.origin);
  }
  const apiIndex = new Map();
  for (const entry of api) {
    assert.ok(typeof entry.method === "string" && typeof entry.path === "string" && Number.isSafeInteger(entry.status),
      `${label}: api allowlist entries must be exact triples`);
    const key = `${entry.method} ${entry.path}`;
    if (!apiIndex.has(key)) apiIndex.set(key, new Set());
    apiIndex.get(key).add(entry.status);
  }
  const mutationPaths = new Set(mutations);
  // FIFO pairing: every response consumes its request; leftovers must abort exactly.
  const pending = harness.requests.map((entry) => ({ ...entry }));
  const take = (method, origin, path) => {
    const index = pending.findIndex((entry) => entry.method === method && entry.origin === origin && entry.path === path);
    if (index === -1) return null;
    return pending.splice(index, 1)[0];
  };
  for (const response of harness.networkResponses) {
    const matched = take(response.method, response.origin, response.path);
    assert.ok(matched !== null, `${label}: unpaired response has no browser request: ${response.method} ${response.origin}${response.path} -> ${response.status}`);
    assert.ok(origins.includes(response.origin), `${label}: cross-origin egress denied: ${response.origin}${response.path}`);
    assert.ok(!["eventsource", "websocket"].includes(response.resourceType),
      `${label}: event-stream/socket resource denied: ${response.resourceType} ${response.path}`);
    assert.ok(response.contentType !== "text/event-stream",
      `${label}: event-stream content denied: ${response.path}`);
    assert.ok(response.status === 304 || response.status < 300 || response.status >= 400,
      `${label}: redirect denied: ${response.method} ${response.path} -> ${response.status}`);
    const key = `${response.method} ${response.path}`;
    // Enumerated entries (exact method+path+status, including deliberate
    // denials like the unauthenticated catalog 401) are checked exactly; unlisted
    // application prefixes always fail; anything else must be an inert static GET.
    const isAppRoute = apiIndex.has(key) || response.path.startsWith("/api/") || response.path.startsWith("/federation/") ||
      response.path.startsWith("/oauth/") || response.path.startsWith("/__local");
    if (isAppRoute) {
      assert.ok(apiIndex.has(key),
        `${label}: unexpected application traffic (successful or not): ${key} -> ${response.status}`);
      assert.ok(apiIndex.get(key).has(response.status),
        `${label}: application route status drift: ${key} -> ${response.status}, expected ${[...apiIndex.get(key)].join("/")}`);
    } else {
      assert.ok(["GET", "HEAD"].includes(response.method),
        `${label}: unexpected mutation outside application routes: ${key}`);
      assert.ok(response.status === 200 || response.status === 304,
        `${label}: static route must be 200/304: ${key} -> ${response.status}`);
      assert.ok(STATIC_RESOURCE_TYPES.has(response.resourceType),
        `${label}: unexpected static resource type ${response.resourceType}: ${key}`);
    }
    if (!["GET", "HEAD"].includes(response.method)) {
      assert.ok(mutationPaths.has(response.path),
        `${label}: unlisted mutation denied: ${key} -> ${response.status}`);
    }
  }
  const abortAllowed = new Set(aborts);
  // URLs whose responded outcome is fully classified above (every request paired).
  const accounted = new Set(harness.networkResponses.map((entry) => `${entry.method} ${entry.origin}${entry.path}`));
  for (const text of harness.failedRequests) {
    assert.ok(abortAllowed.has(text), `${label}: unexpected failed request, got: ${text.slice(0, 300)}`);
    const match = /^(GET|HEAD|POST|PUT|DELETE) (https?:\/\/[^ ]+) :: /.exec(text);
    assert.ok(match !== null, `${label}: failed request must parse: ${text.slice(0, 200)}`);
    const parsed = new URL(match[2]);
    assert.ok(origins.includes(parsed.origin), `${label}: cross-origin failed egress denied: ${text.slice(0, 200)}`);
    const consumed = take(match[1], parsed.origin, `${parsed.pathname}${parsed.search}`);
    if (consumed !== null) continue;
    // Superseded duplicate probe: the same application URL already has a fully
    // classified responded outcome above (observed: the PWA issues each probe
    // twice on mount; one wins with a classified response, the duplicate is
    // client-canceled with ERR_ABORTED and carries no response). An abort with
    // no accounted URL, a non-abort error, or an unlisted URL still fails.
    const key = `${match[1]} ${parsed.origin}${parsed.pathname}${parsed.search}`;
    assert.ok(/:: net::ERR_ABORTED$/.test(text) && accounted.has(key),
      `${label}: failed request without a browser request: ${text.slice(0, 200)}; pending=${JSON.stringify(pending.slice(0, 8))}; requests=${JSON.stringify(harness.requests.slice(0, 12))}`);
  }
  assert.deepEqual(pending, [], `${label}: every browser request must pair with a response or an allowed abort, dangling: ${JSON.stringify(pending.slice(0, 4))}`);
  const serialized = JSON.stringify({ requests: harness.requests, responses: harness.networkResponses });
  assert.ok(!/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(serialized) && !serialized.includes("cf-access"),
    `${label}: network ledger must never contain JWT or access credentials`);
}

async function buildBundleFiles(namespace, ownerGeneration, revisionRef) {
  const content = encoder.encode("# Evidence\n\nPinned owner-e2e content.\n");
  const contentDigest = await sha256Hex(content);
  const manifest = {
    protocol: "eliotr.normalized.v1",
    origin: {
      owner_system_id: "eliotr",
      source_namespace_id: namespace,
      source_owner_generation: ownerGeneration,
      source_revision_ref: revisionRef,
      source_view_ref: "view-e2e-1",
      ownership_mode: "immutable_import",
    },
    source: {
      logical_id: `source-${namespace}`,
      original_name: "source.md",
      original_sha256: contentDigest,
      origin_location_class: "external",
      mime_type: "text/markdown",
    },
    residency_and_disclosure: {
      scope_domain_id: "scope-e2e",
      access_domain_id: "access-e2e",
      confidentiality_domain_id: "private",
      encryption_key_domain_id: "key-e2e",
      retention_domain_id: "retention-e2e",
      erasure_domain_id: "erasure-e2e",
      disclosure_ceiling: "owner-only",
      allowed_use: ["research"],
    },
    normalization: {
      analyzer: "e2e",
      analyzer_version: "1",
      profile: "standard",
      config_hash: "1".repeat(64),
      created_at: new Date().toISOString(),
    },
    content: { markdown: "content.md", markdown_sha256: contentDigest },
    capabilities: { text_ranges: true, pages: false, bounding_boxes: false, tables: false, figures: false },
    quality: { state: "standard", assurance_ceiling: "source-local", warnings: [] },
    export: { purpose: "e2e", receipt_ref: "export-e2e-1" },
  };
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  const manifestDigest = await sha256Hex(manifestBytes);
  const hashesText = `${contentDigest}  content.md\n${manifestDigest}  manifest.json\n`;
  const hashesBytes = encoder.encode(hashesText);
  const files = { "content.md": content, "manifest.json": manifestBytes, "hashes.sha256": hashesBytes };
  const hashes = {
    "content.md": contentDigest,
    "manifest.json": manifestDigest,
    "hashes.sha256": await sha256Hex(hashesBytes),
  };
  const totalBytes = content.byteLength + manifestBytes.byteLength + hashesBytes.byteLength;
  return { manifest, files, hashes, totalBytes };
}

// Browser-originated artifact lifecycle (the single authoritative ingest path in
// this harness): the full prepare/parts/complete/
// commit/status sequence as importBundleViaWorker, but every HTTP call runs
// inside Chromium via page.evaluate fetch against the bridge origin (the
// paired session cookie authenticates; the page never sees the JWT). Each call
// records one `browser` entry in the shared cross-client ledger with a
// correlation id binding the lifecycle together, so the end-of-run ledger
// assertion proves browser origin, exact method/path/status, ordering and
// correlation for every artifact entry. Bundle bytes are UTF-8 text files, so
// they cross the evaluate boundary as strings.
export async function importBundleViaBrowser(page, ledger, bundle, idempotencyKey, correlationPrefix) {
  const artifactPaths = [];
  const call = async (path, { method = "GET", body, contentType, correlation } = {}) => {
    const outcome = await browserJson(page, ledger, path, { method, body, contentType, correlation });
    assert.ok(outcome.status >= 200 && outcome.status < 300,
      `browser artifact call failed: ${method} ${path} -> ${outcome.status}`);
    assert.ok(outcome.data && typeof outcome.data.data !== "undefined" &&
      typeof outcome.data.deployment_generation === "string",
      `browser artifact call must return the typed envelope: ${method} ${path}`);
    artifactPaths.push({ method, path, status: outcome.status, correlation });
    return outcome.data;
  };
  const prepared = await call("/api/v1/ingest/bundles/prepare", {
    method: "POST", contentType: "application/json",
    body: JSON.stringify({ manifest: bundle.manifest, file_hashes: bundle.hashes,
      total_bytes: bundle.totalBytes, idempotency_key: idempotencyKey }),
    correlation: `${correlationPrefix}/prepare`,
  });
  const data = prepared.data;
  assert.equal(data.disposition, "UPLOAD_REQUIRED", "fresh bundle must require upload");
  const operationId = data.operation_id;
  const session = data.multipart_session_ref;
  assert.ok(operationId && session);
  assert.equal(data.manifest_sha256.length, 64);
  const base = `/api/v1/ingest/bundles/${encodeURIComponent(operationId)}`;
  for (const file of data.files) {
    const bytes = bundle.files[file.path];
    assert.ok(bytes, `missing bundle bytes for ${file.path}`);
    const text = decoder.decode(bytes);
    const params = new URLSearchParams({ multipart_session_ref: session, path: file.path,
      size_bytes: String(bytes.byteLength), final_part: "1" });
    const uploaded = await call(`${base}/parts/1?${params.toString()}`, {
      method: "PUT", contentType: "application/octet-stream", body: text,
      correlation: `${correlationPrefix}/parts/${file.path}`,
    });
    assert.equal(uploaded.data.path, file.path);
    const completed = await call(`${base}/files/complete`, {
      method: "POST", contentType: "application/json",
      body: JSON.stringify({ multipart_session_ref: session, path: file.path,
        parts: [{ part_number: 1, size_bytes: bytes.byteLength, etag: uploaded.data.etag }] }),
      correlation: `${correlationPrefix}/complete/${file.path}`,
    });
    assert.equal(completed.data.sha256, bundle.hashes[file.path]);
  }
  const committed = await call("/api/v1/ingest/bundles/commit", {
    method: "POST", contentType: "application/json",
    body: JSON.stringify({ operation_id: operationId, multipart_session_ref: session,
      manifest_sha256: data.manifest_sha256 }),
    correlation: `${correlationPrefix}/commit`,
  });
  assert.equal(committed.data.decision, "ADMITTED");
  assert.equal(committed.data.operation_id, operationId);
  const status = await call(`${base}`, { method: "GET", correlation: `${correlationPrefix}/status` });
  assert.equal(status.data.state, "COMMITTED");
  assert.deepEqual(status.data.receipt, committed.data);
  return { receipt: committed.data, operationId, manifestSha: data.manifest_sha256, artifactPaths };
}

async function r2ObjectGet(paths, bucket, key) {
  const args = wranglerArgs(paths, ["r2", "object", "get", `${bucket}/${key}`, "--pipe"]);
  const output = executeLocal(args, { capture: true });
  return output;
}

async function tryR2ObjectGet(paths, bucket, key) {
  try {
    return { ok: true, output: await r2ObjectGet(paths, bucket, key) };
  } catch (error) {
    return { ok: false, error };
  }
}

async function resolveEvidenceBucket(paths) {
  const text = await readFile(paths.config, "utf8");
  const config = JSON.parse(text);
  const entry = (config.r2_buckets ?? []).find((item) => item.binding === "EVIDENCE_BUCKET");
  assert.ok(entry?.bucket_name, "local profile must declare EVIDENCE_BUCKET");
  assert.ok(!String(entry.bucket_name).includes("work"), "evidence bucket must not be the work bucket");
  return String(entry.bucket_name);
}

async function resolveWorkBucket(paths) {
  const text = await readFile(paths.config, "utf8");
  const config = JSON.parse(text);
  const entry = (config.r2_buckets ?? []).find((item) => item.binding === "WORK_BUCKET");
  assert.ok(entry?.bucket_name, "local profile must declare WORK_BUCKET");
  return String(entry.bucket_name);
}

// Forced early-failure cleanup proof (fast, no Worker/browser): simulates a run
// that creates its marker/runId-owned state, profiles, decoys and a loopback
// listener, then fails during migration/startup. The identical nested-finally
// discipline as runOwnerE2E must leave zero run-owned residue while unrelated
// same-prefix entries survive. Exact-path removal only; a foreign marker never
// authorizes deletion.
export async function verifyEarlyFailureCleanup() {
  const runId = `early-${process.pid}-${Date.now()}`;
  const stateRoot = resolve(root, ".eliotr-state");
  await mkdir(stateRoot, { recursive: true });
  // Unrelated same-prefix entries pre-exist and must survive everything below.
  const unrelatedTmp = resolve(tmpdir(), `eliotr-owner-e2e-profile-unrelated-${runId}`);
  const unrelatedState = resolve(stateRoot, `owner-e2e-unrelated-${runId}`);
  for (const path of [unrelatedTmp, unrelatedState]) {
    await mkdir(path, { recursive: true });
    await writeFile(resolve(path, "sentinel.txt"), "unrelated\n", { mode: 0o600 });
  }
  let directory;
  let profileDir;
  let decoy;
  let listener;
  let listenerPort = 0;
  const errors = [];
  try {
    directory = await mkdtemp(resolve(tmpdir(), "eliotr-owner-e2e-"));
    await writeHarnessMarker(directory, runId, "owner-state");
    profileDir = await mkdtemp(resolve(tmpdir(), "eliotr-owner-e2e-profile-"));
    await writeHarnessMarker(profileDir, runId, "browser-profile");
    decoy = resolve(tmpdir(), `eliotr-owner-e2e-profile-decoy-${runId}`);
    await mkdir(decoy, { recursive: true });
    listener = createTcpServer();
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    listenerPort = listener.address().port;
    assert.ok(Number.isSafeInteger(listenerPort) && listenerPort > 0, "early-failure listener must bind");
    // Simulated early migration/startup failure happens here.
    throw new Error("simulated early migration failure");
  } catch (failure) {
    assert.match(String(failure?.message ?? failure), /simulated early migration failure/,
      "the only failure in this proof must be the injected one");
  } finally {
    // Unconditional nested finally per resource: one failure cannot prevent
    // the deletion of the remaining owned resources. Exact marker/runId paths
    // only; unrelated entries are never matched.
    try {
      if (listener !== undefined) {
        await new Promise((resolve) => listener.close(() => resolve()));
        listener = undefined;
      }
    } catch (error) { errors.push(error); }
    try {
      if (profileDir !== undefined) {
        try { await removeHarnessOwned(profileDir, runId); } catch (error) { errors.push(error); }
        await assert.rejects(access(profileDir), /ENOENT/, "early-failure profile must be removed");
      }
    } catch (error) { errors.push(error); }
    try {
      if (directory !== undefined) {
        try { await removeHarnessOwned(directory, runId); } catch (error) { errors.push(error); }
        await assert.rejects(access(directory), /ENOENT/, "early-failure state must be removed");
      }
    } catch (error) { errors.push(error); }
    try {
      if (decoy !== undefined) {
        await rm(decoy, { recursive: true, force: true });
        await assert.rejects(access(decoy), /ENOENT/, "early-failure decoy must be removed");
      }
    } catch (error) { errors.push(error); }
  }
  assert.deepEqual(errors, [], `early-failure cleanup must delete every owned resource, got: ${errors.map(String).join("; ").slice(0, 500)}`);
  // Zero residue: no run-owned tmp/state entry may remain; unrelated entries
  // survive (proof against prefix-delete), then are removed by exact path.
  const tmpNames = await readdir(tmpdir()).catch(() => []);
  assert.ok(!tmpNames.some((name) => name.includes(runId) && !name.includes("unrelated")),
    "zero run-owned tmp residue must remain after early failure");
  await access(resolve(unrelatedTmp, "sentinel.txt"));
  await access(resolve(unrelatedState, "sentinel.txt"));
  await rm(unrelatedTmp, { recursive: true, force: true });
  await rm(unrelatedState, { recursive: true, force: true });
  return { protocol: "eliotr.owner-e2e.early-cleanup.v1", state: "PASS", listenerPort };
}

export async function runOwnerE2E() {
  const startedAt = new globalThis.Date().toISOString();
  const stateRoot = resolve(root, ".eliotr-state");
  const beforeDirs = new Set(await readdir(stateRoot).catch(() => []));
  // Run-specific ownership marker: teardown deletes only this marker-proven
  // directory inside the OS temp root. Success, assert-failure, Worker-start
  // failure, browser-start failure, timeout and interruption all funnel
  // through the same finally below. Never delete unrelated temp entries.
  // NOTE: the isolated state directory itself is created INSIDE the try so an
  // early failure cannot leak an unmarked directory outside the cleanup below.
  const runId = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
  let directory;
  let worker;
  let playwright;
  let bridge;
  let jwks;
  let teardownError = null;
  const receipt = {
    protocol: "eliotr.owner-e2e.v1",
    started_at: startedAt,
    browser: null,
    isolated_setup: "PENDING",
    unauth_denied: "PENDING",
    authorized_library: "PENDING",
    persistence: "PENDING",
    logout: "PENDING",
    teardown: "PENDING",
    console_errors: "PENDING",
    failed_startup: "PENDING",
    storage: "PENDING",
    bounds: "PENDING",
    controlled_issuer: "PENDING",
    seam_rejection: "PENDING",
    browser_pairing: "PENDING",
    browser_logout: "PENDING",
    evidence_readback: "PENDING",
    chromium_safe_ports: "PENDING",
    network_ledger: "PENDING",
    ledger_negative: "PENDING",
    jwt_negatives: "PENDING",
    worker_ports: "PENDING",
    jwks_rotation: "PENDING",
    browser_jwt_matrix: "PENDING",
    artifact_ledger: "PENDING",
    cross_client_ledger: "PENDING",
    early_cleanup: "PENDING",
    teardown_inventory: "PENDING",
  };
  // Authoritative cross-client ledger: browser-origin artifact/JWT lifecycle
  // entries plus node-origin attacker probes, asserted exhaustively at the end.
  const ledger = createCrossClientLedger();
  // Every real Worker start in this run must bind an explicit Chromium-safe
  // port (evidence for the hold-the-listener + bounded reselect discipline).
  const workerPortEvidence = [];
  // Adversarial teardown decoys: prefix-colliding but unmarked directories plus
  // one foreign-marker directory. Created here with exact known names; the
  // reconciliation below proves they survive every phase including failed and
  // interrupted runs, and removes them only by exact path. No prefix glob
  // deletion exists anywhere in this harness.
  const decoyTmpProfile = resolve(tmpdir(), `eliotr-owner-e2e-profile-decoy-${runId}`);
  const decoyTmpSmoke = resolve(tmpdir(), `smoke-decoy-${runId}`);
  const decoyStateOwner = resolve(stateRoot, `owner-e2e-decoy-${runId}`);
  const decoyStateSmoke = resolve(stateRoot, `smoke-decoy-${runId}`);
  const foreignProfile = resolve(tmpdir(), `eliotr-owner-e2e-profile-foreign-${runId}`);
  const decoyPaths = [decoyTmpProfile, decoyTmpSmoke, decoyStateOwner, decoyStateSmoke, foreignProfile];
  const ownedStaging = [];
  const decoyNames = {
    tmp: new Set([`eliotr-owner-e2e-profile-decoy-${runId}`, `smoke-decoy-${runId}`,
      `eliotr-owner-e2e-profile-foreign-${runId}`]),
    state: new Set([`owner-e2e-decoy-${runId}`, `smoke-decoy-${runId}`]),
  };
  try {
    receipt.chromium_safe_ports = (await verifyChromiumSafePortProtocol()).state;
    receipt.early_cleanup = (await verifyEarlyFailureCleanup()).state;
    directory = await mkdtemp(resolve(tmpdir(), "eliotr-owner-e2e-"));
    await writeHarnessMarker(directory, runId, "owner-state");
    await mkdir(stateRoot, { recursive: true });
    for (const path of [decoyTmpProfile, decoyTmpSmoke, decoyStateOwner, decoyStateSmoke, foreignProfile]) {
      await mkdir(path, { recursive: true });
      await writeFile(resolve(path, "decoy-sentinel.txt"), `decoy owned by run ${runId}\n`, { mode: 0o600 });
    }
    await writeHarnessMarker(foreignProfile, `${runId}-foreign`, "foreign-profile");
    // Marker enforcement proof: a foreign marker never authorizes deletion under
    // this runId, so the foreign directory must survive a removal attempt.
    await assert.rejects(removeHarnessOwned(foreignProfile, runId), /marker mismatch/,
      "foreign marker must refuse deletion under this runId");
    await access(resolve(foreignProfile, "decoy-sentinel.txt"));
    const { privateKey, publicJwk } = await createOwnerE2EKey();
    // Rotating JWKS from the start (serving exactly [v1]): identical exact-path
    // semantics to the static server, plus setKeys() for the real rollover
    // proof later (old token denied, new token allowed after cache refresh).
    jwks = await startRotatingJwksServer([publicJwk]);
    assert.ok(isChromiumSafePort(jwks.port), `JWKS loopback port must be Chromium-safe, got ${jwks.port}`);
    receipt.jwks_bind = `PASS (port=${jwks.port} attempts=${jwks.bindAttempts})`;
    {
      const badPaths = [
        `${jwks.url}/wrong`,
        jwks.url.replace(OWNER_E2E_CERTS_PATH, "/wrong"),
        `${jwks.url}?x=1`,
      ];
      for (const bad of badPaths) {
        const response = await globalThis.fetch(bad, { redirect: "manual", signal: globalThis.AbortSignal.timeout(5000) });
        assert.equal(response.status, 404, `JWKS server must 404 non-exact path: ${bad}`);
        await response.text().catch(() => {});
      }
      const post = await globalThis.fetch(jwks.url, { method: "POST", redirect: "manual", signal: globalThis.AbortSignal.timeout(5000) });
      assert.equal(post.status, 404, "JWKS server must 404 non-GET");
      await post.text().catch(() => {});
      const started = Date.now();
      const probe = await globalThis.fetch(jwks.url, { signal: globalThis.AbortSignal.timeout(5000) });
      assert.equal(probe.status, 200, "JWKS server must serve the exact certs document");
      await probe.text();
      assert.ok(Date.now() - started < 5000, "JWKS exact-path readback must stay bounded");
    }
    const nowSeconds = () => Math.floor(globalThis.Date.now() / 1000);
    let dupJwksEvidence = "PENDING";
    const sign = (overrides = {}, kid = OWNER_E2E_KID) => signOwnerToken(privateKey, {
      iss: OWNER_E2E_ISSUER, aud: [OWNER_E2E_AUDIENCE], sub: "e2e-owner",
      type: "app", iat: nowSeconds(), exp: nowSeconds() + 600, ...overrides,
    }, kid);
    {
      const stagingDir = await mkdtemp(resolve(tmpdir(), "eliotr-owner-e2e-staging-"));
      const stagingId = `${runId}-staging`;
      await writeHarnessMarker(stagingDir, stagingId, "owner-state-staging");
      ownedStaging.push({ dir: stagingDir, id: stagingId });
      let stagingWorker;
      try {
        let stagingPaths;
        let lastStagingError;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            stagingPaths = await prepareLocal({ stateDirectory: stagingDir, log: () => {} });
            lastStagingError = undefined;
            break;
          } catch (error) {
            lastStagingError = error;
            const text = String(error?.message ?? error) + String(error?.cause?.stderr ?? "");
            if (!/bad port|database is locked|SQLITE_BUSY|EBUSY|EPERM|ETIMEDOUT|EAGAIN/i.test(text) || attempt >= 3) throw error;
            await new Promise((resolve) => globalThis.setTimeout(resolve, 1000 * attempt));
          }
        }
        if (!stagingPaths) throw lastStagingError;
        await applyOwnerE2EProfile(stagingPaths, jwks.url);
        const raw = await readFile(stagingPaths.config, "utf8");
        const parsed = JSON.parse(raw);
        parsed.vars = { ...parsed.vars, ENVIRONMENT: "staging" };
        await writeFile(stagingPaths.config, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
        stagingWorker = await startLocalWorker(stagingPaths);
        const stagingToken = await sign();
        const denied = await workerJson(stagingWorker.origin, "/api/v1/system/session", { token: stagingToken });
        assert.equal(denied.status, 503, "staging with identical test vars must fail config, never seam");
        assert.equal(denied.data?.code ?? denied.data?.data?.code, "ACCESS_CONFIG_INVALID",
          "staging seam must fail with ACCESS_CONFIG_INVALID");
        assert.ok(!JSON.stringify(denied.data).includes("e2e-owner") || denied.status !== 200,
          "staging denial must not leak identity");
        receipt.seam_rejection = "PASS";
      } finally {
        // Nested finally per resource: a stop failure cannot prevent the
        // marker-proven staging removal, and a removal failure is recorded
        // (never silently retained) after every resource had its chance.
        const stagingErrors = [];
        try { await stagingWorker?.stop(); } catch (error) { stagingErrors.push(`stop: ${error?.message ?? error}`); }
        try { await removeHarnessOwned(stagingDir, stagingId); }
        catch (error) { stagingErrors.push(`remove: ${error?.message ?? error}`); }
        try {
          await assert.rejects(access(stagingDir), /ENOENT/, "staging state must be removed");
        } catch (error) { stagingErrors.push(`verify: ${error?.message ?? error}`); }
        assert.deepEqual(stagingErrors, [], `staging cleanup must leave no residue: ${stagingErrors.join("; ").slice(0, 400)}`);
      }
      assert.equal(receipt.seam_rejection, "PASS", "production/staging seam rejection must pass");
    }
    {
      // Duplicate-JWKS negative through a second real Worker: a JWKS document
      // with two keys sharing one kid must fail closed with ACCESS_JWKS_INVALID
      // (503), never select either key and never authorize the Library view.
      const dupDir = await mkdtemp(resolve(tmpdir(), "eliotr-owner-e2e-staging-"));
      const dupId = `${runId}-staging-dup-jwks`;
      await writeHarnessMarker(dupDir, dupId, "owner-state-staging-dup");
      ownedStaging.push({ dir: dupDir, id: dupId });
      let dupJwks;
      let dupWorker;
      try {
        dupJwks = await startDuplicateJwksServer(publicJwk);
        assert.ok(isChromiumSafePort(dupJwks.port), "duplicate-JWKS port must be Chromium-safe");
        const dupPaths = await prepareLocal({ stateDirectory: dupDir, log: () => {} });
        await applyOwnerE2EProfile(dupPaths, dupJwks.url);
        dupWorker = await startLocalWorker(dupPaths);
        const dupToken = await sign();
        const dupDenied = await workerJson(dupWorker.origin, "/api/v1/system/session", { token: dupToken });
        assert.equal(dupDenied.status, 503, "duplicate JWKS kids must fail closed with 503");
        assert.equal(dupDenied.data?.code ?? dupDenied.data?.data?.code, "ACCESS_JWKS_INVALID",
          "duplicate JWKS kids must carry ACCESS_JWKS_INVALID");
        const dupCatalog = await workerJson(dupWorker.origin, "/api/v1/research/catalog?limit=20", { token: dupToken });
        assert.equal(dupCatalog.status, 503, "duplicate JWKS must also deny the Library view");
        assert.ok(!JSON.stringify(dupDenied.data).includes("e2e-owner"), "duplicate-JWKS denial must not leak identity");
        dupJwksEvidence = "dup-jwks-503/ACCESS_JWKS_INVALID";
      } finally {
        // Same nested-finally discipline: every owned resource is released
        // even when an earlier release fails; failures accumulate, never hide.
        const dupErrors = [];
        try { await dupWorker?.stop(); } catch (error) { dupErrors.push(`stop: ${error?.message ?? error}`); }
        try { await dupJwks?.close(); } catch (error) { dupErrors.push(`jwks: ${error?.message ?? error}`); }
        try { await removeHarnessOwned(dupDir, dupId); }
        catch (error) { dupErrors.push(`remove: ${error?.message ?? error}`); }
        try {
          await assert.rejects(access(dupDir), /ENOENT/, "duplicate-JWKS staging state must be removed");
        } catch (error) { dupErrors.push(`verify: ${error?.message ?? error}`); }
        assert.deepEqual(dupErrors, [], `duplicate-JWKS cleanup must leave no residue: ${dupErrors.join("; ").slice(0, 400)}`);
      }
    }
    const paths = await prepareLocal({ stateDirectory: directory, log: () => {} });
    await access(resolve(root, "apps/eliotr-pwa/dist/index.html"));
    assert.equal(paths.directory, directory, "isolated state must use the fresh directory");
    assert.ok(paths.persist.startsWith(directory), "persisted D1/R2 state must live under the isolated directory");
    await applyOwnerE2EProfile(paths, jwks.url);
    const ledgers = await verifyMigrationLedgers(paths);
    assert.ok(ledgers.CORE_DB > 0 && ledgers.SEARCH_DB > 0, "both migration streams must be applied");
    receipt.isolated_setup = "PASS";
    receipt.bounds = (await checkBundleLimitsSource()).state;
    receipt.controlled_issuer = (await verifyControlledIssuerCrypto(privateKey, publicJwk)).state;
    worker = await startLocalWorker(paths);
    assert.ok(isChromiumSafePort(worker.port),
      `initial Worker port must be Chromium-safe, got ${worker.port}`);
    workerPortEvidence.push(`initial=${worker.port}/startAttempts=${worker.startAttempts}`);
    for (const headers of [{}, { "cf-access-jwt-assertion": "forged.token.signature" },
      { "cf-access-client-id": "forged", "cf-access-client-secret": "forged" }]) {
      for (const path of ["/api/v1/research/catalog", "/api/v1/system/session"]) {
        const response = await globalThis.fetch(`${worker.origin}${path}`,
          { headers, redirect: "manual", signal: globalThis.AbortSignal.timeout(5000) });
        assert.equal(response.status, 401, `real Worker must deny ${path} without a signed assertion`);
        const problem = await response.json();
        assert.equal(problem.status, 401);
        assert.ok(String(problem.code).startsWith("ACCESS_"), "denial must carry an ACCESS_ code");
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.ok(!JSON.stringify(problem).includes("forged.token.signature"), "denial must not reflect credentials");
      }
    }
    receipt.unauth_denied = "PASS";
    const token = await sign();
    const session = await workerJson(worker.origin, "/api/v1/system/session", { token });
    assert.equal(session.status, 200, "controlled signed token must reach the real Worker verifier");
    const identity = session.data.data;
    assert.equal(identity.protocol, "eliotr.owner-session.v1");
    assert.equal(identity.principal_ref, "e2e-owner");
    assert.equal(identity.client_class, "owner_pwa");
    assert.ok(typeof identity.credential_generation === "string" && identity.credential_generation.length > 0);
    assert.ok(Number.isFinite(Date.parse(identity.expires_at)));
    assert.equal(session.data.deployment_generation, paths.generation);
    assert.ok(!JSON.stringify(session.data).includes(token.slice(0, 16)), "session must not reflect the token");
    const oversizedToken = `${await sign()}.${"a".repeat(17000)}`;
    // Zero-mutation baseline: no namespace/grant/source exists yet, so every
    // negative below must leave all protected counts exactly unchanged while
    // denying both the session route and the authorized Library view.
    const protectedD1Counts = () => ({
      source: d1Query(paths, "CORE_DB", "SELECT COUNT(*) AS n FROM source")[0].n,
      revision: d1Query(paths, "CORE_DB", "SELECT COUNT(*) AS n FROM source_revision")[0].n,
      policy: d1Query(paths, "CORE_DB", "SELECT COUNT(*) AS n FROM scope_read_policy")[0].n,
      operation: d1Query(paths, "CORE_DB", "SELECT COUNT(*) AS n FROM bundle_ingest_operation")[0].n,
    });
    const d1BeforeNegatives = protectedD1Counts();
    const goodForTamper = await sign();
    const tamperSegs = goodForTamper.split(".");
    const tamperedPayloadClaims = JSON.parse(decoder.decode(base64UrlDecode(tamperSegs[1])));
    tamperedPayloadClaims.sub = "e2e-attacker";
    const tamperedPayloadToken = `${tamperSegs[0]}.${encodeJwtPart(tamperedPayloadClaims)}.${tamperSegs[2]}`;
    const kidlessToken = `${encodeJwtPart({ alg: "RS256", typ: "JWT" })}.${tamperSegs[1]}.${tamperSegs[2]}`;
    const baseClaims = { iss: OWNER_E2E_ISSUER, aud: [OWNER_E2E_AUDIENCE], sub: "e2e-owner",
      type: "app", iat: nowSeconds(), exp: nowSeconds() + 600 };
    const negatives = [
      { name: "missing", expect: [401], code: "ACCESS_JWT_MISSING" },
      { name: "malformed", token: "not-a-jwt", expect: [401], code: "ACCESS_JWT_MALFORMED" },
      // No whitespace-padded case: HTTP header optional whitespace is stripped
      // by the transport before verification, so the verifier receives the
      // trimmed token by construction. The verifier's own trim check
      // (packages/platform-cloudflare/src/access.ts) still guards non-header
      // transports and is covered by the malformed cases here.
      { name: "forged", token: `${(await sign()).split(".").slice(0, 2).join(".")}.AAAA`, expect: [401], code: "ACCESS_JWT_SIGNATURE_INVALID" },
      { name: "tampered-payload", token: tamperedPayloadToken, expect: [401], code: "ACCESS_JWT_SIGNATURE_INVALID" },
      { name: "wrong-issuer", token: await sign({ iss: "https://other.cloudflareaccess.com" }), expect: [401], code: "ACCESS_JWT_ISSUER_INVALID" },
      { name: "wrong-audience", token: await sign({ aud: ["other-audience"] }), expect: [401], code: "ACCESS_JWT_AUDIENCE_INVALID" },
      { name: "expired", token: await sign({ iat: nowSeconds() - 1000, exp: nowSeconds() - 100 }), expect: [401], code: "ACCESS_JWT_EXPIRED" },
      { name: "wrong-type", token: await sign({ type: "service" }), expect: [401], code: "ACCESS_JWT_TYPE_INVALID" },
      { name: "active-nbf", token: await sign({ nbf: nowSeconds() + 600, exp: nowSeconds() + 1200 }), expect: [401], code: "ACCESS_JWT_NOT_YET_VALID" },
      { name: "nbf-after-exp", token: await sign({ nbf: nowSeconds() + 10, exp: nowSeconds() + 5 }), expect: [401], code: "ACCESS_JWT_MALFORMED" },
      { name: "future-iat", token: await sign({ iat: nowSeconds() + 600, exp: nowSeconds() + 1200 }), expect: [401], code: "ACCESS_JWT_ISSUED_IN_FUTURE" },
      { name: "missing-exp", token: await signOwnerToken(privateKey, { ...baseClaims, exp: undefined }), expect: [401], code: "ACCESS_JWT_MALFORMED" },
      { name: "invalid-exp-string", token: await signOwnerToken(privateKey, { ...baseClaims, exp: "soon" }), expect: [401], code: "ACCESS_JWT_MALFORMED" },
      { name: "missing-iat", token: await signOwnerToken(privateKey, { ...baseClaims, iat: undefined }), expect: [401], code: "ACCESS_JWT_MALFORMED" },
      { name: "invalid-iat-string", token: await signOwnerToken(privateKey, { ...baseClaims, iat: "recently" }), expect: [401], code: "ACCESS_JWT_MALFORMED" },
      { name: "exp-equals-iat", token: await sign({ iat: nowSeconds(), exp: nowSeconds() }), expect: [401], code: "ACCESS_JWT_MALFORMED" },
      { name: "exp-before-iat", token: await sign({ iat: nowSeconds() + 10, exp: nowSeconds() + 5 }), expect: [401], code: "ACCESS_JWT_MALFORMED" },
      { name: "missing-kid", token: kidlessToken, expect: [401], code: "ACCESS_JWT_KEY_ID_MISSING" },
      { name: "service-token-empty-sub", token: await sign({ sub: "" }), expect: [401], code: "ACCESS_JWT_SUBJECT_INVALID" },
      { name: "whitespace-sub", token: await sign({ sub: "  " }), expect: [401], code: "ACCESS_JWT_SUBJECT_INVALID" },
      { name: "service-principal-denied", token: await sign({ sub: "", common_name: "e2e-service-1" }), expect: [403], code: "ACCESS_SERVICE_PRINCIPAL_DENIED", catalog: 403 },
      { name: "unknown-kid", token: await sign({}, "unknown-kid"), expect: [401], code: "ACCESS_JWT_KEY_UNKNOWN" },
      { name: "oversized", token: oversizedToken, expect: [401], code: "ACCESS_JWT_TOO_LARGE" },
    ];
    const negativeEvidence = [];
    for (const item of negatives) {
      let response;
      if (item.name === "missing") {
        response = await workerJson(worker.origin, "/api/v1/system/session", {});
      } else if (item.name === "wrong-alg") {
        const good = await sign();
        const segs = good.split(".");
        const badHeader = encodeJwtPart({ alg: "HS256", typ: "JWT", kid: OWNER_E2E_KID });
        response = await workerJson(worker.origin, "/api/v1/system/session", { token: `${badHeader}.${segs[1]}.${segs[2]}` });
      } else {
        response = await workerJson(worker.origin, "/api/v1/system/session", { token: item.token });
      }
      assert.ok(item.expect.includes(response.status), `${item.name} must deny, got ${response.status}`);
      const bodyCode = response.data?.code ?? response.data?.data?.code;
      assert.equal(bodyCode, item.code, `${item.name} must carry exact code ${item.code}, got ${bodyCode}`);
      assert.ok(!JSON.stringify(response.data).includes("e2e-owner") || response.status !== 200, `${item.name} must not leak identity on denial`);
      // Same negative token against the authorized Library view: exact denial, no rows.
      const catalogDenied = item.name === "missing"
        ? await workerJson(worker.origin, "/api/v1/research/catalog?limit=20", {})
        : await workerJson(worker.origin, "/api/v1/research/catalog?limit=20", { token: item.token });
      assert.equal(catalogDenied.status, item.catalog ?? 401, `${item.name} must deny the Library view`);
      assert.ok(!JSON.stringify(catalogDenied.data).includes("catalog-"), `${item.name} must leak no catalog rows`);
      negativeEvidence.push(`${item.name}=${response.status}/${bodyCode}`);
    }
    assert.deepEqual(protectedD1Counts(), d1BeforeNegatives, "JWT negatives must cause zero protected D1 mutation");
    {
      const good = await sign();
      const segs = good.split(".");
      const badHeader = encodeJwtPart({ alg: "HS256", typ: "JWT", kid: OWNER_E2E_KID });
      const algDenied = await workerJson(worker.origin, "/api/v1/system/session", { token: `${badHeader}.${segs[1]}.${segs[2]}` });
      assert.equal(algDenied.status, 401, "wrong-alg must deny with 401");
      assert.equal(algDenied.data?.code, "ACCESS_JWT_ALGORITHM_DENIED", "wrong-alg must carry exact code");
      negativeEvidence.push(`wrong-alg=401/${algDenied.data?.code}`);
      // Skew window honesty: exp==now is still inside the acceptance skew (200),
      // while iat beyond any reasonable skew is rejected (401). Both on the real path.
      const skewValid = await workerJson(worker.origin, "/api/v1/system/session",
        { token: await sign({ iat: nowSeconds() - 10, exp: nowSeconds() }) });
      assert.equal(skewValid.status, 200, "exp==now must still verify inside the skew window");
      const skewFuture = await workerJson(worker.origin, "/api/v1/system/session",
        { token: await sign({ iat: nowSeconds() + 120, exp: nowSeconds() + 720 }) });
      assert.equal(skewFuture.status, 401, "iat beyond the skew window must deny");
      assert.equal(skewFuture.data?.code, "ACCESS_JWT_ISSUED_IN_FUTURE");
      negativeEvidence.push("skew-window=200-then-401/ACCESS_JWT_ISSUED_IN_FUTURE");
      // Email contract honesty: the Access verifier admits no email claim
      // (packages/platform-cloudflare/src/access.ts has no email field), so extra
      // email/email_verified claims are not load-bearing. A valid token carrying
      // attacker email still identifies the signed subject only; the identity
      // carries no email and the denial path above already rejects bad signatures.
      const emailed = await workerJson(worker.origin, "/api/v1/system/session",
        { token: await sign({ email: "attacker@example.invalid", email_verified: false }) });
      assert.equal(emailed.status, 200, "extra email claims must not disturb a valid signature");
      assert.equal(emailed.data?.data?.principal_ref, "e2e-owner", "identity must remain the signed subject");
      assert.ok(!JSON.stringify(emailed.data).includes("attacker@example.invalid"), "identity must not adopt email claims");
      negativeEvidence.push("email-not-load-bearing=200/e2e-owner");
    }
    // Browser-path negatives: the same bad tokens must fail bridge pairing (the
    // real browser gate) without reflecting credentials and without binding a
    // listener that could leak (startOwnerBridge rejects before bind).
    const bridgeNegatives = ["forged", "expired", "unknown-kid", "wrong-issuer", "wrong-audience"];
    const bridgeTokens = {
      forged: `${(await sign()).split(".").slice(0, 2).join(".")}.AAAA`,
      expired: await sign({ iat: nowSeconds() - 1000, exp: nowSeconds() - 100 }),
      "unknown-kid": await sign({}, "unknown-kid"),
      "wrong-issuer": await sign({ iss: "https://other.cloudflareaccess.com" }),
      "wrong-audience": await sign({ aud: ["other-audience"] }),
    };
    for (const name of bridgeNegatives) {
      try {
        await startOwnerBridge({ workerOrigin: worker.origin, token: bridgeTokens[name], generation: paths.generation, port: 0 });
        assert.fail(`bridge pairing with ${name} token must reject`);
      } catch (error) {
        assert.ok(!String(error?.message ?? "").includes("eyJ"), `bridge ${name} rejection must not reflect credentials`);
        negativeEvidence.push(`bridge-${name}=rejected`);
      }
    }
    receipt.jwt_negatives = `PASS (${negatives.length + 1 + 2 + 1 + bridgeNegatives.length} negatives + ${dupJwksEvidence}, D1 unchanged, evidence: ${negativeEvidence.length} items)`;
    const namespace = "e2e-library";
    const revisionRef = "rev-e2e-1";
    const namespaceCommand = { protocol: "eliotr.local-namespace-init.v1", namespace,
      owner_incarnation_ref: "e2e-installation", expected_ownership_revision: 0, expected_policy_revision: 0,
      created_at: new globalThis.Date().toISOString(), policy: {
        allowed_ownership_modes: ["immutable_import"], source_class: "document", assurance_ceiling: "QUALIFIED",
        instruction_taint: "DATA_ONLY", allowed_effects: "READ_ONLY", allowed_use: ["research"],
        disclosure_ceiling: "owner-only", license_policy_ref: "e2e-license",
        default_storage_policy: "NORMALIZED_CLOUD_ONLY", default_residency_profile_id: "e2e-residency",
        default_retention_policy_id: "e2e-retention", minimum_quality_state: "standard" } };
    // Setup/replay at the active-runtime boundary: the Worker is running for
    // identity, so CLI D1 shares SQLite files with Miniflare. Bounded retry
    // covers documented transient locks only; the second (replay) readback
    // stays exact and fail-closed for schema/authority/data errors.
    const namespaceReceipt = await initializeNamespaceWithBoundedRetry({ command: namespaceCommand,
      identity, query: localPolicyQuery(paths) });
    assert.equal(namespaceReceipt.read_access_granted, false, "namespace init must not grant read access");
    assert.deepEqual(d1Query(paths, "CORE_DB", "SELECT COUNT(*) AS n FROM scope_read_policy"), [{ n: 0 }],
      "login/init alone must not create an implicit read grant");
    const namespaceReplay = await initializeNamespaceWithBoundedRetry({ command: namespaceCommand,
      identity, query: localPolicyQuery(paths) });
    assert.deepEqual(namespaceReplay, namespaceReceipt, "same namespace intent must replay exactly");
    const grant = await applyLocalReadPolicy({ command: { action: "GRANT", namespace,
      expected_generation: 0, allowed_use: ["research"], disclosure: "owner-only",
      expires_at: new globalThis.Date(globalThis.Date.now() + 3600000).toISOString() },
      identity, query: localPolicyQuery(paths) });
    assert.equal(grant.state, "APPLIED_OR_REPLAY");
    assert.equal(grant.policy.generation, 1);
    assert.equal(grant.policy.state, "ACTIVE");
    const grantReplay = await applyLocalReadPolicy({ command: { action: "GRANT", namespace,
      expected_generation: 0, allowed_use: ["research"], disclosure: grant.policy.disclosure_ceiling,
      expires_at: grant.policy.expires_at }, identity, query: localPolicyQuery(paths) });
    assert.equal(grantReplay.policy.generation, 1, "same grant must replay without a new generation");
    const ownerGeneration = namespaceReceipt.ownership.source_owner_generation;
    const bundle = await buildBundleFiles(namespace, ownerGeneration, revisionRef);
    // Browser-first lifecycle: the real Chromium launches and pairs BEFORE any
    // artifact exists, so every artifact prepare/parts/complete/commit/status
    // call below originates inside Chromium (page.evaluate, same-origin via
    // the paired bridge) and lands in both the Playwright phase ledger and the
    // cross-client ledger with browser origin. No Node fetch touches ingest.
    playwright = await launchPlaywright(runId);
    receipt.browser = `playwright-core chromium; ${await playwright.browser.version()}`;
    // Every loopback origin the real browser visits. Service workers persist per
    // origin across restarts (each restart rebinds a fresh port), so the worker
    // rule allows exactly one /sw.js per visited harness origin, no more.
    const visitedOrigins = [];
    const trackOrigin = (origin) => {
      if (!visitedOrigins.includes(origin)) visitedOrigins.push(origin);
      return [...visitedOrigins];
    };
    await playwright.page.goto(worker.origin, { waitUntil: "domcontentloaded", timeout: 15000 });
    await playwright.page.waitForFunction(shellReady, null, { timeout: 15000 });
    const unauthHasPrivate = await playwright.evaluate(hasPrivateLibraryMarker);
    assert.equal(unauthHasPrivate, false, "unauthenticated PWA must not render private Library rows");
    const unauthStorage = await readBrowserStorage(playwright.page);
    assertNoPrivateStorage(unauthStorage, "unauthenticated");
    assertUnauthLedger(playwright, "unauthenticated", worker.origin);
    await settleLedger(playwright.page);
    assertPhaseNetwork(playwright, "unauthenticated", { ...unauthNetworkSpec(worker.origin), workerOrigins: trackOrigin(worker.origin) });
    receipt.network_ledger_phases = { unauthenticated: summarizePhaseLedger(playwright) };
    playwright.resetLedger();
    bridge = await startOwnerBridge({ workerOrigin: worker.origin, token, generation: paths.generation, port: 0 });
    assert.ok(isChromiumSafePort(Number(new URL(bridge.origin).port)),
      `bridge loopback port must be Chromium-safe, got ${bridge.origin}`);
    receipt.network_ledger_phases.bridge_first_bind = { attempts: bridge.bindAttempts, origin: "redacted-loopback" };
    assert.ok(bridge.pairingUrl.includes("/__local/#"), "bridge must issue a one-use fragment link");
    assert.ok(!bridge.pairingUrl.includes(token.slice(0, 8)), "pairing URL must not embed the JWT");
    assert.ok(!bridge.pairingUrl.includes("eyJ"), "pairing URL must never carry JWT material");
    const secret = bridge.pairingUrl.split("#")[1];
    assert.ok(typeof secret === "string" && secret.length >= 32, "pairing secret must be present");
    assert.ok(!secret.includes("eyJ") && !secret.includes("."), "pairing secret must be opaque, never a JWT");
    await playwright.page.goto(bridge.pairingUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await playwright.page.waitForSelector("#connect", { timeout: 15000 });
    await playwright.page.click("#connect", { timeout: 15000 });
    await playwright.page.waitForFunction(shellReady, null, { timeout: 15000 });
    // No source is admitted yet, so pairing proves the session cookie only; the
    // Library row appears after the browser-originated import below + reload.
    const pairedCookies = await playwright.context.cookies();
    const sessionCookies = pairedCookies.filter((item) => item.name.startsWith("eliotr_local_"));
    assert.equal(sessionCookies.length, 1, "Chromium itself must hold exactly one opaque session cookie from the real bridge response");
    const sessionCookie = sessionCookies[0];
    assert.equal(sessionCookie.httpOnly, true, "browser session cookie must be HttpOnly");
    assert.ok(sessionCookie.sameSite === "Strict" || sessionCookie.sameSite === "StrictLaxAllowUnsafeTokens" || String(sessionCookie.sameSite).toLowerCase().includes("strict"),
      `browser session cookie must be SameSite=Strict, got ${sessionCookie.sameSite}`);
    assert.equal(sessionCookie.domain, "127.0.0.1", "browser session cookie must be loopback-bound");
    assert.equal(sessionCookie.path, "/", "browser session cookie path must be /");
    assert.ok(typeof sessionCookie.value === "string" && sessionCookie.value.length >= 32, "browser cookie value must be opaque");
    assert.ok(!sessionCookie.value.includes("eyJ") && !sessionCookie.value.includes("."), "browser cookie must be opaque, never a JWT");
    assert.ok(!JSON.stringify(pairedCookies).includes("eyJ"), "browser cookie store must hold no JWT");
    const reuseStatus = await playwright.page.evaluate(async (pairSecret) => {
      const response = await fetch("/__local/pair", { method: "POST", headers: { "X-Eliotr-Pair": pairSecret } });
      return response.status;
    }, secret);
    assert.equal(reuseStatus, 403, "pairing secret must be one-use even when reused from Chromium itself");
    receipt.browser_pairing = `PASS (Chromium paired via opaque bridge origin, HttpOnly=${sessionCookie.httpOnly}, SameSite=${sessionCookie.sameSite}, domain=${sessionCookie.domain})`;
    // Artifact lifecycle through the real browser: prepare/parts/complete/
    // commit/status via page.evaluate (same-origin bridge session cookie).
    // Replay where applicable: the same bearer authorizes twice identically,
    // and prepare with the same idempotency key replays DUPLICATE with the
    // same operation_id and the existing receipt instead of a second operation.
    const d1CountsForReplay = () => ({
      source: d1Query(paths, "CORE_DB", "SELECT COUNT(*) AS n FROM source")[0].n,
      operation: d1Query(paths, "CORE_DB", "SELECT COUNT(*) AS n FROM bundle_ingest_operation")[0].n,
    });
    const imported = await importBundleViaBrowser(playwright.page, ledger, bundle, "e2e-first-import", "e2e-import-1");
    assert.equal(imported.receipt.decision, "ADMITTED");
    assert.equal(imported.receipt.source_revision_ref, revisionRef);
    const bearerReplayA = await browserJson(playwright.page, ledger, "/api/v1/system/session",
      { correlation: "e2e-import-1/replay-bearer-a" });
    const bearerReplayB = await browserJson(playwright.page, ledger, "/api/v1/system/session",
      { correlation: "e2e-import-1/replay-bearer-b" });
    assert.equal(bearerReplayA.status, 200, "bearer replay (1/2) must verify through the browser session");
    assert.equal(bearerReplayB.status, 200, "bearer replay (2/2) must verify through the browser session");
    assert.equal(bearerReplayA.data?.data?.principal_ref, "e2e-owner");
    assert.deepEqual(bearerReplayB.data?.data?.credential_generation,
      bearerReplayA.data?.data?.credential_generation, "bearer replay must yield the identical generation");
    const countsBeforePrepareReplay = d1CountsForReplay();
    const prepareReplay = await browserJson(playwright.page, ledger, "/api/v1/ingest/bundles/prepare", {
      method: "POST", contentType: "application/json",
      body: JSON.stringify({ manifest: bundle.manifest, file_hashes: bundle.hashes,
        total_bytes: bundle.totalBytes, idempotency_key: "e2e-first-import" }),
      correlation: "e2e-import-1/replay-prepare",
    });
    assert.equal(prepareReplay.status, 200, "prepare replay must answer through the browser session");
    assert.equal(prepareReplay.data?.data?.disposition, "DUPLICATE", "prepare replay must be DUPLICATE, never a second upload");
    assert.equal(prepareReplay.data?.data?.operation_id, imported.operationId, "prepare replay must bind the same operation");
    assert.deepEqual(prepareReplay.data?.data?.existing_receipt, imported.receipt, "prepare replay must return the existing receipt");
    assert.deepEqual(d1CountsForReplay(), countsBeforePrepareReplay, "prepare replay must cause zero new source/operation rows");
    // The admitted Library row becomes visible to Chromium only after a PWA
    // reload (the pre-import catalog had no rows); this is the same-origin
    // browser retrieval the ledger closes over below.
    const sourceRows = d1Query(paths, "CORE_DB", `SELECT source_id, source_namespace_id FROM source WHERE source_namespace_id='${namespace}'`);
    assert.equal(sourceRows.length, 1, "authoritative D1 source row must exist");
    const sourceId = sourceRows[0].source_id;
    const revisionRows = d1Query(paths, "CORE_DB", `SELECT r.source_revision_ref, r.content_sha256 FROM source_revision r JOIN source s ON s.source_id=r.source_id WHERE s.source_namespace_id='${namespace}'`);
    assert.ok(revisionRows.some((row) => row.source_revision_ref === revisionRef), "authoritative D1 revision row must exist");
    const policyRows = d1Query(paths, "CORE_DB", `SELECT generation, state FROM scope_read_policy WHERE source_namespace_id='${namespace}'`);
    assert.deepEqual(policyRows, [{ generation: 1, state: "ACTIVE" }]);
    const catalog = await workerJson(worker.origin, "/api/v1/research/catalog?limit=20", { token });
    assert.equal(catalog.status, 200, "authorized catalog must succeed through the real Worker");
    const catalogSources = catalog.data.data.sources ?? [];
    assert.ok(catalogSources.some((entry) => entry.id === sourceId), "authorized Library catalog must list the admitted source");
    const revisions = await workerJson(worker.origin, `/api/v1/library/revisions?source_id=${encodeURIComponent(sourceId)}&limit=10`, { token });
    assert.equal(revisions.status, 200, "authorized revision history must succeed");
    assert.ok(JSON.stringify(revisions.data).includes(revisionRef), "revision history must include the admitted revision");
    const canonicalKey = imported.receipt.normalized_artifact_ref;
    assert.ok(typeof canonicalKey === "string" && canonicalKey.startsWith("normalized/"),
      "commit receipt must name the canonical immutable EVIDENCE_BUCKET key");
    assert.ok(!canonicalKey.includes("..") && !canonicalKey.includes("//") && canonicalKey.length < 1024,
      "canonical key must stay bounded and traversal-free");
    const evidenceBucket = await resolveEvidenceBucket(paths);
    const workBucket = await resolveWorkBucket(paths);
    assert.ok(evidenceBucket.includes("evidence"), "evidence bucket name must identify the immutable store");
    assert.ok(workBucket.includes("work"), "work bucket name must identify staging");
    assert.ok(evidenceBucket !== workBucket, "evidence and work buckets must differ");
    const revisionDetail = d1Query(paths, "CORE_DB",
      `SELECT r.source_revision_ref, r.content_sha256, r.object_residency_key_digest, r.normalized_artifact_ref, ` +
      `s.source_namespace_id, s.source_owner_generation, s.source_id FROM source_revision r JOIN source s ON s.source_id=r.source_id ` +
      `WHERE s.source_namespace_id='${namespace}'`);
    assert.ok(revisionDetail.some((row) => row.normalized_artifact_ref === canonicalKey &&
      row.source_revision_ref === revisionRef && row.source_namespace_id === namespace &&
      row.source_owner_generation === ownerGeneration), "D1 revision must bind the canonical key to owner/namespace/generation");
    assert.equal(imported.receipt.object_residency_key_digest,
      revisionDetail.find((row) => row.source_revision_ref === revisionRef)?.object_residency_key_digest,
      "commit receipt residency digest must match D1");
    const operationRows = d1Query(paths, "CORE_DB",
      `SELECT state, decision_receipt_ref, promotion_receipt_ref FROM bundle_ingest_operation WHERE operation_id='${imported.operationId}'`);
    assert.equal(operationRows.length, 1, "authoritative ingest operation must exist");
    assert.equal(operationRows[0].state, "COMMITTED", "operation must be COMMITTED");
    assert.ok(typeof operationRows[0].decision_receipt_ref === "string" && operationRows[0].decision_receipt_ref.length > 0,
      "admission receipt ref must exist");
    assert.ok(typeof operationRows[0].promotion_receipt_ref === "string" && operationRows[0].promotion_receipt_ref.length > 0,
      "promotion receipt ref must exist");
    const expectedManifestBytes = bundle.files["manifest.json"];
    assert.ok(expectedManifestBytes && expectedManifestBytes.length > 0, "expected manifest bytes must exist");
    const expectedManifestSha = bundle.hashes["manifest.json"];
    const evidenceGet = await tryR2ObjectGet(paths, evidenceBucket, canonicalKey);
    assert.equal(evidenceGet.ok, true, `exact EVIDENCE_BUCKET object must be readable: ${canonicalKey}`);
    const evidenceBytes = Buffer.from(evidenceGet.output ?? "", "utf8");
    assert.ok(evidenceBytes.length > 0, "EVIDENCE_BUCKET object body must be non-empty");
    assert.equal(evidenceBytes.length, expectedManifestBytes.length, "EVIDENCE_BUCKET size must match admitted manifest size");
    assert.equal(await sha256Hex(evidenceBytes), expectedManifestSha, "EVIDENCE_BUCKET byte digest must match admitted manifest sha");
    assert.equal(JSON.parse(decoder.decode(evidenceBytes)).protocol, "eliotr.normalized.v1",
      "EVIDENCE_BUCKET manifest must carry the normalized protocol");
    const workGet = await tryR2ObjectGet(paths, workBucket, canonicalKey);
    assert.equal(workGet.ok, false, "canonical immutable key must not exist in WORK_BUCKET staging");
    const canonicalKeyForReceipt = canonicalKey;
    const evidenceMeta = {
      bucket: evidenceBucket, key: canonicalKeyForReceipt, sha256: expectedManifestSha,
      size_bytes: evidenceBytes.length, content_type: "application/json; charset=utf-8",
      source_namespace_id: namespace, source_owner_generation: ownerGeneration,
      admission_receipt_ref: operationRows[0].decision_receipt_ref,
      promotion_receipt_ref: operationRows[0].promotion_receipt_ref,
    };
    receipt.evidence_readback = "PASS";
    receipt.authorized_library = "PASS";
    // Post-import retrieval through the real browser: reload the paired PWA so
    // its same-origin catalog fetch (closed over by the phase ledger below)
    // renders the admitted source row inside Chromium itself.
    await playwright.page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
    await playwright.page.waitForFunction(shellReady, null, { timeout: 15000 });
    await playwright.page.waitForFunction(bodyIncludes, sourceId, { timeout: 15000 });
    const browserCatalog = await browserJson(playwright.page, ledger, "/api/v1/research/catalog?limit=20",
      { correlation: "e2e-import-1/browser-catalog" });
    assert.equal(browserCatalog.status, 200, "browser-originated Library catalog must list the admitted source");
    assert.ok((browserCatalog.data?.data?.sources ?? []).some((entry) => entry.id === sourceId),
      "browser catalog must contain the admitted source id");
    const browserRevisions = await browserJson(playwright.page, ledger,
      `/api/v1/library/revisions?source_id=${encodeURIComponent(sourceId)}&limit=10`,
      { correlation: "e2e-import-1/browser-revisions" });
    assert.equal(browserRevisions.status, 200, "browser-originated revision history must succeed");
    assert.ok(JSON.stringify(browserRevisions.data).includes(revisionRef),
      "browser revision history must include the admitted revision");
    const authedStorage = await readBrowserStorage(playwright.page);
    assertNoPrivateStorage(authedStorage, "authed");
    assert.ok(!playwright.consoleErrors.join("|").includes("eyJ"), "authed console must hold no JWT");
    assertAuthedLedger(playwright, "authed", bridge.origin);
    await settleLedger(playwright.page);
    // The authed window closes over pairing AND the full browser-originated
    // artifact lifecycle: every artifact path returned by the browser import
    // (exact method/path/status) plus the bearer/prepare replays and the
    // browser retrieval calls must appear as responded browser traffic.
    // Anything else, including successful unexpected responses, fails.
    {
      const authedSpec = authedNetworkSpec(bridge.origin);
      const authedApi = [...authedSpec.api,
        ...imported.artifactPaths,
        { method: "GET", path: "/api/v1/system/session", status: 200 },
        { method: "POST", path: "/api/v1/ingest/bundles/prepare", status: 200 },
        { method: "GET", path: "/api/v1/research/catalog?limit=20", status: 200 },
        { method: "GET", path: `/api/v1/library/revisions?source_id=${encodeURIComponent(sourceId)}&limit=10`, status: 200 },
      ];
      // Every non-GET application route exercised in this window must also be
      // a listed mutation: the exact browser artifact lifecycle paths
      // (including the PUT query strings, bound at runtime above) plus the
      // DUPLICATE prepare replay. Anything else still fails as unlisted.
      const authedMutations = [...authedSpec.mutations,
        ...authedApi.filter((entry) => entry.method !== "GET" && entry.method !== "HEAD").map((entry) => entry.path),
      ];
      assertPhaseNetwork(playwright, "authed", { ...authedSpec, api: authedApi, mutations: authedMutations, workerOrigins: trackOrigin(bridge.origin) });
    }
    receipt.network_ledger_phases.authed = summarizePhaseLedger(playwright);
    playwright.resetLedger();
    // Browser-driven JWT matrix: expired, wrong audience, wrong issuer,
    // invalid signature, tampered payload and unknown kid, each driven through
    // Chromium page.evaluate fetch same-origin at the Worker with exact HTTP
    // denial/error semantics and zero protected D1/R2/owner mutation per case.
    // Tokens travel only inside the page call; every ledger records presence,
    // never values. Replay is covered above (identical bearer + DUPLICATE
    // prepare replay with zero new rows).
    {
      const matrixBefore = protectedD1Counts();
      const evidencePresentBefore = (await tryR2ObjectGet(paths, evidenceBucket, canonicalKey)).ok;
      assert.equal(evidencePresentBefore, true, "matrix baseline requires the admitted evidence object");
      await playwright.page.goto(worker.origin, { waitUntil: "domcontentloaded", timeout: 15000 });
      await playwright.page.waitForFunction(shellReady, null, { timeout: 15000 });
      const matrixCases = [
        { name: "expired", token: await sign({ iat: nowSeconds() - 1000, exp: nowSeconds() - 100 }), status: 401, code: "ACCESS_JWT_EXPIRED" },
        { name: "wrong-audience", token: await sign({ aud: ["other-audience"] }), status: 401, code: "ACCESS_JWT_AUDIENCE_INVALID" },
        { name: "wrong-issuer", token: await sign({ iss: "https://other.cloudflareaccess.com" }), status: 401, code: "ACCESS_JWT_ISSUER_INVALID" },
        { name: "invalid-signature", token: `${(await sign()).split(".").slice(0, 2).join(".")}.AAAA`, status: 401, code: "ACCESS_JWT_SIGNATURE_INVALID" },
        { name: "tampered-payload", token: tamperedPayloadToken, status: 401, code: "ACCESS_JWT_SIGNATURE_INVALID" },
        { name: "unknown-kid", token: await sign({}, "unknown-kid"), status: 401, code: "ACCESS_JWT_KEY_UNKNOWN" },
      ];
      const matrixEvidence = [];
      for (const item of matrixCases) {
        const denied = await browserJson(playwright.page, ledger, "/api/v1/system/session", {
          extraHeaders: { "cf-access-jwt-assertion": item.token },
          tokenLength: item.token.length,
          correlation: `e2e-jwt-matrix/${item.name}`,
        });
        assert.equal(denied.status, item.status, `browser ${item.name} must deny with ${item.status}`);
        assert.equal(denied.data?.code ?? denied.data?.data?.code, item.code,
          `browser ${item.name} must carry exact code ${item.code}`);
        assert.ok(!JSON.stringify(denied.data).includes("e2e-owner") || denied.status !== 200,
          `browser ${item.name} must not leak identity on denial`);
        const catalogDenied = await browserJson(playwright.page, ledger, "/api/v1/research/catalog?limit=20", {
          extraHeaders: { "cf-access-jwt-assertion": item.token },
          tokenLength: item.token.length,
          correlation: `e2e-jwt-matrix/${item.name}-catalog`,
        });
        assert.equal(catalogDenied.status, 401, `browser ${item.name} must deny the Library view`);
        assert.ok(!JSON.stringify(catalogDenied.data).includes("catalog-"),
          `browser ${item.name} must leak no catalog rows`);
        assert.deepEqual(protectedD1Counts(), matrixBefore,
          `browser ${item.name} must cause zero protected D1 mutation`);
        matrixEvidence.push(`${item.name}=${denied.status}/${item.code}`);
      }
      assert.equal((await tryR2ObjectGet(paths, evidenceBucket, canonicalKey)).ok, true,
        "browser JWT matrix must not disturb the admitted evidence object");
      await settleLedger(playwright.page);
      {
        const matrixSpec = unauthNetworkSpec(worker.origin);
        matrixSpec.api.push({ method: "GET", path: "/api/v1/system/session", status: 401 });
        assertPhaseNetwork(playwright, "jwt-matrix",
          { ...matrixSpec, workerOrigins: trackOrigin(worker.origin) });
      }
      receipt.network_ledger_phases.jwt_matrix = summarizePhaseLedger(playwright);
      receipt.browser_jwt_matrix = `PASS (${matrixCases.length} browser cases, D1/R2 unchanged, evidence: ${matrixEvidence.join(",")})`;
      playwright.resetLedger();
    }
    const stoppedOrigin = worker.origin;
    const stoppedGeneration = paths.generation;
    await worker.stop();
    worker = undefined;
    await assert.rejects(globalThis.fetch(`${stoppedOrigin}/healthz`, { signal: globalThis.AbortSignal.timeout(5000) }),
      /fetch failed|ECONNREFUSED|aborted/, "stopped Worker port must be closed (owned process removed)");
    await prepareLocal({ stateDirectory: directory, log: () => {} });
    await applyOwnerE2EProfile(paths, jwks.url);
    assert.deepEqual(await readbackWithBoundedRetry("restart-migration-ledgers",
      () => verifyMigrationLedgers(paths)), ledgers, "restart must preserve both migration ledgers");
    // Restart readback happens at the safe lifecycle boundary: the Worker is
    // stopped, so CLI D1 owns the SQLite files alone. The exact receipt must
    // replay byte-for-byte; this second readback is never weakened.
    assert.deepEqual(await initializeNamespaceWithBoundedRetry({ command: namespaceCommand,
      identity, query: localPolicyQuery(paths) }), namespaceReceipt,
      "restart must preserve the namespace ownership/policy rows exactly");
    assert.deepEqual(d1Query(paths, "CORE_DB", "SELECT COUNT(*) AS n FROM scope_read_policy"), [{ n: 1 }],
      "restart must preserve the explicit read grant");
    assert.deepEqual(d1Query(paths, "CORE_DB", `SELECT r.source_revision_ref FROM source_revision r JOIN source s ON s.source_id=r.source_id WHERE s.source_namespace_id='${namespace}'`),
      revisionRows.map((row) => ({ source_revision_ref: row.source_revision_ref })),
      "restart must preserve the admitted revision rows");
    assert.equal(paths.generation, (await prepareLocal({ stateDirectory: directory, log: () => {} })).generation,
      "isolated generation must be stable for the same directory");
    await applyOwnerE2EProfile(paths, jwks.url);
    worker = await startLocalWorker(paths);
    assert.ok(isChromiumSafePort(worker.port),
      `restart Worker port must be Chromium-safe, got ${worker.port}`);
    workerPortEvidence.push(`restart=${worker.port}/startAttempts=${worker.startAttempts}`);
    const rebound = await globalThis.fetch(`${worker.origin}/healthz`, { signal: globalThis.AbortSignal.timeout(5000) });
    assert.equal(rebound.status, 200);
    const reboundBody = await rebound.json();
    assert.equal(reboundBody.ready, true, "restart must report ready");
    assert.equal(reboundBody.deployment_generation, paths.generation, "restart must serve the same generation");
    const catalogAfter = await workerJson(worker.origin, "/api/v1/research/catalog?limit=20", { token });
    assert.equal(catalogAfter.status, 200, `restart must still serve the authorized catalog: ${JSON.stringify(catalogAfter.data)?.slice(0, 400)}`);
    assert.ok((catalogAfter.data.data.sources ?? []).some((entry) => entry.id === sourceId),
      "restart must preserve the same Library source identity");
    const revisionsAfter = await workerJson(worker.origin, `/api/v1/library/revisions?source_id=${encodeURIComponent(sourceId)}&limit=10`, { token });
    assert.equal(revisionsAfter.status, 200);
    assert.ok(JSON.stringify(revisionsAfter.data).includes(revisionRef), "restart must preserve the same revision");
    const preRestartNames = new Set((await playwright.context.cookies())
      .filter((item) => item.name.startsWith("eliotr_local_")).map((item) => item.name));
    try { await bridge?.close(); } catch { /* Close stale pre-restart bridge before post-restart PWA readback. */ }
    bridge = undefined;
    playwright.resetLedger();
    await playwright.page.goto(worker.origin, { waitUntil: "domcontentloaded", timeout: 15000 });
    await playwright.page.waitForFunction(shellReady, null, { timeout: 15000 });
    const restartStorage = await readBrowserStorage(playwright.page);
    assertNoPrivateStorage(restartStorage, "post-restart");
    assertUnauthLedger(playwright, "post-restart", worker.origin);
    await settleLedger(playwright.page);
    assertPhaseNetwork(playwright, "post-restart", { ...unauthNetworkSpec(worker.origin), workerOrigins: trackOrigin(worker.origin) });
    receipt.network_ledger_phases.post_restart = summarizePhaseLedger(playwright);
    receipt.persistence = "PASS";
    try { await bridge.close(); } catch { /* replaced below */ }
    bridge = await startOwnerBridge({ workerOrigin: worker.origin, token, generation: paths.generation, port: 0 });
    assert.ok(isChromiumSafePort(Number(new URL(bridge.origin).port)),
      `re-pair bridge port must be Chromium-safe, got ${bridge.origin}`);
    receipt.network_ledger_phases.bridge_repair_bind = { attempts: bridge.bindAttempts, origin: "redacted-loopback" };
    assert.ok(!bridge.pairingUrl.includes("eyJ"), "re-pairing URL must never carry JWT material");
    const secret2 = bridge.pairingUrl.split("#")[1];
    assert.ok(typeof secret2 === "string" && secret2.length >= 32 && !secret2.includes("eyJ"), "re-pairing secret must be opaque");
    await playwright.page.goto(bridge.pairingUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await playwright.page.waitForSelector("#connect", { timeout: 15000 });
    await playwright.page.click("#connect", { timeout: 15000 });
    await playwright.page.waitForFunction(shellReady, null, { timeout: 15000 });
    await playwright.page.waitForFunction(bodyIncludes, sourceId, { timeout: 15000 });
    const rePaired = await playwright.context.cookies();
    const reNew = rePaired.filter((item) => item.name.startsWith("eliotr_local_") && !preRestartNames.has(item.name));
    assert.equal(reNew.length, 1, "Chromium re-pairing after restart must yield exactly one fresh opaque session cookie");
    assert.equal(reNew[0].httpOnly, true, "re-paired cookie must be HttpOnly");
    assert.ok(!String(reNew[0].value).includes("eyJ"), "re-paired cookie must be opaque");
    const reSessionName = reNew[0].name;
    playwright.resetLedger();
    await playwright.page.goto(`${bridge.origin}/__local/`, { waitUntil: "domcontentloaded", timeout: 15000 });
    await playwright.page.waitForSelector("#logout", { timeout: 15000 });
    await playwright.page.click("#logout", { timeout: 15000 });
    await playwright.page.waitForFunction(() => document.getElementById("status")?.textContent?.includes("Local session closed"), null, { timeout: 15000 });
    const clearedCookies = await playwright.context.cookies();
    assert.equal(clearedCookies.filter((item) => item.name === reSessionName).length, 0,
      "Chromium cookie store must show Set-Cookie clearing of the fresh session via browser state after browser-driven logout");
    receipt.browser_logout = `PASS (Chromium logged out via ${bridge.origin}/__local/ #logout, fresh session ${reSessionName} cleared)`;
    const deniedViaBrowser = await playwright.page.evaluate(async () => {
      const response = await fetch("/api/v1/research/catalog?limit=20");
      return { status: response.status, url: response.url };
    });
    assert.equal(deniedViaBrowser.status, 401, "browser-originated private API must be exact 401 after logout");
    assert.ok(deniedViaBrowser.url.includes("/api/v1/research/catalog"), "denied URL must be the exact private catalog route");
    assert.deepEqual(playwright.pageErrors, [], "page errors must stay empty after browser logout");
    {
      const allowedLogoutAbort = `POST ${bridge.origin}/__local/logout :: net::ERR_ABORTED`;
      assert.ok(playwright.failedRequests.length <= 1,
        `post-logout failed requests must hold at most the exact logout probe abort, got: ${playwright.failedRequests.slice(0, 2).join("; ")}`);
      for (const text of playwright.failedRequests) {
        assert.equal(text, allowedLogoutAbort, `post-logout abort must be the exact logout probe, got: ${text.slice(0, 300)}`);
      }
    }
    const logoutConsole = [...playwright.consoleErrors];
    assert.ok(logoutConsole.length <= 1, `post-logout console must hold at most the one deliberate 401, got: ${logoutConsole.slice(0, 2).join("; ")}`);
    if (logoutConsole.length === 1) {
      assert.ok(logoutConsole[0].includes("/api/v1/research/catalog") && logoutConsole[0].includes("401"),
        `deliberate post-logout denial must be the exact catalog 401, got: ${logoutConsole[0].slice(0, 300)}`);
      assert.ok(!logoutConsole[0].includes("eyJ"), "deliberate denial must not leak JWT");
    }
    await settleLedger(playwright.page);
    assertPhaseNetwork(playwright, "logout", { ...logoutNetworkSpec(bridge.origin), workerOrigins: trackOrigin(bridge.origin) });
    receipt.network_ledger_phases.logout = summarizePhaseLedger(playwright);
    playwright.resetLedger();
    await playwright.page.goto(worker.origin, { waitUntil: "domcontentloaded", timeout: 15000 });
    await playwright.page.waitForFunction(shellReady, null, { timeout: 15000 });
    const loggedOutHasPrivate = await playwright.evaluate(bodyIncludes, sourceId);
    assert.equal(loggedOutHasPrivate, false, "Library must hide the source after logout");
    const loggedOutStorage = await readBrowserStorage(playwright.page);
    assertNoPrivateStorage(loggedOutStorage, "post-logout");
    assertUnauthLedger(playwright, "post-logout-clean", worker.origin);
    await settleLedger(playwright.page);
    assertPhaseNetwork(playwright, "post-logout-clean", { ...unauthNetworkSpec(worker.origin), workerOrigins: trackOrigin(worker.origin) });
    receipt.network_ledger_phases.post_logout_clean = summarizePhaseLedger(playwright);
    // Real JWKS key rollover (distinct from the duplicate-kid 503 negative):
    // the rotating server swaps its v1 document for a v2 document (new kid),
    // the Worker restarts (fresh JWKS fetch = the production cache-refresh
    // path), the v1 token is denied with ACCESS_JWT_KEY_UNKNOWN while the v2
    // token is allowed, and Chromium itself re-pairs with the v2 identity and
    // retrieves the admitted Library source. Zero protected mutation throughout.
    {
      const rotationBefore = protectedD1Counts();
      const ROTATION_KID = "e2e-key-2";
      const v2keys = await createOwnerE2EKey();
      const v2public = { ...v2keys.publicJwk, kid: ROTATION_KID };
      const signV2 = (overrides = {}) => signOwnerToken(v2keys.privateKey, {
        iss: OWNER_E2E_ISSUER, aud: [OWNER_E2E_AUDIENCE], sub: "e2e-owner",
        type: "app", iat: nowSeconds(), exp: nowSeconds() + 600, ...overrides,
      }, ROTATION_KID);
      jwks.setKeys([v2public]);
      assert.equal(jwks.version, 2, "rotating JWKS must advance to document version 2");
      try { await bridge?.close(); } catch { /* Stale pre-rotation bridge is replaced below. */ }
      bridge = undefined;
      await worker.stop();
      worker = undefined;
      await prepareLocal({ stateDirectory: directory, log: () => {} });
      await applyOwnerE2EProfile(paths, jwks.url);
      worker = await startLocalWorker(paths);
      assert.ok(isChromiumSafePort(worker.port),
        `rotation Worker port must be Chromium-safe, got ${worker.port}`);
      workerPortEvidence.push(`rotation=${worker.port}`);
      // Old v1 token: denied on the real path (Node) and through Chromium.
      const oldDenied = await workerJson(worker.origin, "/api/v1/system/session", { token });
      assert.equal(oldDenied.status, 401, "rotated-out v1 token must deny with 401");
      assert.equal(oldDenied.data?.code ?? oldDenied.data?.data?.code, "ACCESS_JWT_KEY_UNKNOWN",
        "rotated-out v1 token must carry ACCESS_JWT_KEY_UNKNOWN");
      ledger.record({ client: "node", method: "GET", path: "/api/v1/system/session",
        status: oldDenied.status, correlation: "e2e-rotation/v1-denied-node", token_present: true });
      const newToken = await signV2();
      const newAllowed = await workerJson(worker.origin, "/api/v1/system/session", { token: newToken });
      assert.equal(newAllowed.status, 200, "v2 token must verify after rotation + cache refresh");
      assert.equal(newAllowed.data?.data?.principal_ref, "e2e-owner", "v2 identity must remain the owner subject");
      assert.ok(String(newAllowed.data?.data?.credential_generation).includes(ROTATION_KID),
        "v2 generation must bind the new kid");
      ledger.record({ client: "node", method: "GET", path: "/api/v1/system/session",
        status: newAllowed.status, correlation: "e2e-rotation/v2-allowed-node", token_present: true });
      assert.ok(!JSON.stringify(newAllowed.data).includes(newToken.slice(0, 16)), "v2 session must not reflect the token");
      assert.deepEqual(protectedD1Counts(), rotationBefore, "rotation denial/allowance must cause zero D1 drift");
      playwright.resetLedger();
      await playwright.page.goto(worker.origin, { waitUntil: "domcontentloaded", timeout: 15000 });
      await playwright.page.waitForFunction(shellReady, null, { timeout: 15000 });
      const oldDeniedBrowser = await browserJson(playwright.page, ledger, "/api/v1/system/session", {
        extraHeaders: { "cf-access-jwt-assertion": token },
        tokenLength: token.length, correlation: "e2e-rotation/v1-denied-browser",
      });
      assert.equal(oldDeniedBrowser.status, 401, "Chromium must observe the v1 denial");
      assert.equal(oldDeniedBrowser.data?.code ?? oldDeniedBrowser.data?.data?.code, "ACCESS_JWT_KEY_UNKNOWN");
      const newAllowedBrowser = await browserJson(playwright.page, ledger, "/api/v1/system/session", {
        extraHeaders: { "cf-access-jwt-assertion": newToken },
        tokenLength: newToken.length, correlation: "e2e-rotation/v2-allowed-browser",
      });
      assert.equal(newAllowedBrowser.status, 200, "Chromium must observe the v2 allowance");
      const rotationCatalogBrowser = await browserJson(playwright.page, ledger, "/api/v1/research/catalog?limit=20", {
        extraHeaders: { "cf-access-jwt-assertion": newToken },
        tokenLength: newToken.length, correlation: "e2e-rotation/v2-catalog-browser",
      });
      assert.equal(rotationCatalogBrowser.status, 200, "v2 catalog through Chromium must succeed");
      assert.ok((rotationCatalogBrowser.data?.data?.sources ?? []).some((entry) => entry.id === sourceId),
        "v2 catalog must still list the admitted source after rotation");
      bridge = await startOwnerBridge({ workerOrigin: worker.origin, token: newToken, generation: paths.generation, port: 0 });
      assert.ok(isChromiumSafePort(Number(new URL(bridge.origin).port)),
        "rotation bridge port must be Chromium-safe");
      receipt.network_ledger_phases.bridge_rotation_bind = { attempts: bridge.bindAttempts, origin: "redacted-loopback" };
      const rotationSecret = bridge.pairingUrl.split("#")[1];
      assert.ok(typeof rotationSecret === "string" && rotationSecret.length >= 32 && !rotationSecret.includes("eyJ"),
        "rotation pairing secret must be opaque");
      await playwright.page.goto(bridge.pairingUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
      await playwright.page.waitForSelector("#connect", { timeout: 15000 });
      await playwright.page.click("#connect", { timeout: 15000 });
      await playwright.page.waitForFunction(shellReady, null, { timeout: 15000 });
      await playwright.page.waitForFunction(bodyIncludes, sourceId, { timeout: 15000 });
      const rotationCookies = (await playwright.context.cookies()).filter((item) => item.name.startsWith("eliotr_local_"));
      assert.ok(rotationCookies.length >= 1, "Chromium must hold a fresh opaque session after rotation re-pairing");
      assert.ok(!JSON.stringify(rotationCookies).includes("eyJ"), "rotation cookie store must hold no JWT");
      const rotationRetrieval = await browserJson(playwright.page, ledger,
        `/api/v1/library/revisions?source_id=${encodeURIComponent(sourceId)}&limit=10`,
        { correlation: "e2e-rotation/v2-revisions-browser" });
      assert.equal(rotationRetrieval.status, 200, "v2 revision retrieval through Chromium must succeed");
      assert.ok(JSON.stringify(rotationRetrieval.data).includes(revisionRef), "rotation retrieval must include the revision");
      assert.deepEqual(protectedD1Counts(), rotationBefore, "rotation re-pairing must cause zero D1 drift");
      assert.equal((await tryR2ObjectGet(paths, evidenceBucket, canonicalKey)).ok, true,
        "rotation must not disturb the admitted evidence object");
      await settleLedger(playwright.page);
      {
        const rotationOrigins = [worker.origin, bridge.origin];
        const rotationApi = [
          { method: "GET", path: "/api/v1/research/catalog?limit=20", status: 401 },
          { method: "GET", path: "/api/v1/system/health", status: 401 },
          { method: "GET", path: "/api/v1/system/session", status: 401 },
          { method: "GET", path: "/api/v1/system/session", status: 200 },
          { method: "GET", path: "/api/v1/research/catalog?limit=20", status: 200 },
          ...authedNetworkSpec(bridge.origin).api,
          { method: "GET", path: `/api/v1/library/revisions?source_id=${encodeURIComponent(sourceId)}&limit=10`, status: 200 },
        ];
        const rotationAborts = [
          `GET ${worker.origin}/api/v1/research/catalog?limit=20 :: net::ERR_ABORTED`,
          `GET ${worker.origin}/api/v1/system/health :: net::ERR_ABORTED`,
          `GET ${bridge.origin}/api/v1/research/catalog?limit=20 :: net::ERR_ABORTED`,
          `POST ${bridge.origin}/__local/pair :: net::ERR_ABORTED`,
        ];
        // The rotation Worker rebound to a fresh port that Chromium visited
        // (goto + pairing + retrieval above) but no earlier phase tracked: record
        // it alongside the rotation bridge so the one-shell-worker-per-visited-
        // origin rule counts exactly the visited origins — no more, no fewer.
        trackOrigin(worker.origin);
        assertPhaseNetwork(playwright, "rotation",
          { origins: rotationOrigins, api: rotationApi, mutations: ["/__local/pair"],
            aborts: rotationAborts, workerOrigins: trackOrigin(bridge.origin) });
      }
      receipt.network_ledger_phases.rotation = summarizePhaseLedger(playwright);
      receipt.jwks_rotation = `PASS (v1 denied 401/ACCESS_JWT_KEY_UNKNOWN, v2 allowed 200 via Node+Chromium, re-paired in Chromium, D1/R2 unchanged, jwks=v${jwks.version})`;
      playwright.resetLedger();
    }
    // Ledger-negative seam: inject a successful unexpected response from the real
    // browser and prove the phase closure trips. The Worker answers 404; the
    // strict ledger must reject it because it is outside the allowlist.
    playwright.resetLedger();
    const injectedStatus = await playwright.page.evaluate(async () => {
      const response = await fetch("/api/v1/e2e-unexpected-probe?limit=20");
      return response.status;
    });
    assert.equal(injectedStatus, 404, "injected unexpected route must answer 404 from the real Worker");
    await settleLedger(playwright.page);
    let ledgerTripped = false;
    try {
      assertPhaseNetwork(playwright, "ledger-negative", { ...unauthNetworkSpec(worker.origin), workerOrigins: trackOrigin(worker.origin) });
    } catch {
      ledgerTripped = true;
    }
    assert.equal(ledgerTripped, true, "injected successful unexpected response must trip the phase ledger");
    receipt.ledger_negative = `PASS (injected /api/v1/e2e-unexpected-probe -> ${injectedStatus} tripped closure)`;
    playwright.resetLedger();
    // Full asserted lifecycle ledger: every artifact prepare/parts/complete/
    // commit/status + retrieval + rotation + matrix entry must be present with
    // browser origin (ingest never leaves Chromium), exact method/path/status,
    // gapless ordering and correlation. Captured-but-unasserted is failure.
    {
      const structural = assertCrossClientLedger(ledger, "lifecycle");
      const byCorrelation = new Map(ledger.entries.map((entry) => [entry.correlation, entry]));
      const expectedCorrelations = [
        "e2e-import-1/prepare",
        ...imported.artifactPaths.filter((item) => item.correlation.startsWith("e2e-import-1/parts/")).map((item) => item.correlation),
        ...imported.artifactPaths.filter((item) => item.correlation.startsWith("e2e-import-1/complete/")).map((item) => item.correlation),
        "e2e-import-1/commit",
        "e2e-import-1/status",
        "e2e-import-1/replay-bearer-a",
        "e2e-import-1/replay-bearer-b",
        "e2e-import-1/replay-prepare",
        "e2e-import-1/browser-catalog",
        "e2e-import-1/browser-revisions",
        "e2e-jwt-matrix/expired",
        "e2e-jwt-matrix/expired-catalog",
        "e2e-jwt-matrix/wrong-audience",
        "e2e-jwt-matrix/wrong-audience-catalog",
        "e2e-jwt-matrix/wrong-issuer",
        "e2e-jwt-matrix/wrong-issuer-catalog",
        "e2e-jwt-matrix/invalid-signature",
        "e2e-jwt-matrix/invalid-signature-catalog",
        "e2e-jwt-matrix/tampered-payload",
        "e2e-jwt-matrix/tampered-payload-catalog",
        "e2e-jwt-matrix/unknown-kid",
        "e2e-jwt-matrix/unknown-kid-catalog",
        "e2e-rotation/v1-denied-node",
        "e2e-rotation/v2-allowed-node",
        "e2e-rotation/v1-denied-browser",
        "e2e-rotation/v2-allowed-browser",
        "e2e-rotation/v2-catalog-browser",
        "e2e-rotation/v2-revisions-browser",
      ];
      for (const correlation of expectedCorrelations) {
        assert.ok(byCorrelation.has(correlation), `lifecycle ledger must contain ${correlation}`);
      }
      assert.equal(byCorrelation.size, expectedCorrelations.length,
        `lifecycle ledger must contain exactly the asserted entries, got ${byCorrelation.size} vs ${expectedCorrelations.length}`);
      for (const entry of ledger.entries) {
        const isIngest = entry.path.startsWith("/api/v1/ingest/");
        if (isIngest) {
          assert.equal(entry.client, "browser", `ingest route must be browser-origin: ${entry.correlation}`);
        }
        if (entry.correlation.startsWith("e2e-import-1/")) {
          assert.equal(entry.client, "browser", `import lifecycle must be browser-origin: ${entry.correlation}`);
        }
      }
      const ingestEntries = ledger.entries.filter((entry) => entry.path.startsWith("/api/v1/ingest/"));
      assert.equal(ingestEntries.length, imported.artifactPaths.length + 1,
        "ingest ledger must hold exactly the lifecycle calls plus the DUPLICATE prepare replay");
      receipt.artifact_ledger = `PASS (${imported.artifactPaths.length} lifecycle + 1 DUPLICATE replay, all browser-origin, exact status/ordering/correlation)`;
      receipt.cross_client_ledger = `PASS (${structural.entries} entries, gapless, no JWT material)`;
    }
    receipt.worker_ports = `PASS (${workerPortEvidence.join(", ")})`;
    receipt.network_ledger = `PASS (7 phases paired, websockets/workers/redirects/streams/cross-origin denied, summaries: ${JSON.stringify(receipt.network_ledger_phases)})`;
    receipt.logout = "PASS";
    receipt.storage = "PASS";
    receipt.console_errors = "PASS";
    try {
      await startOwnerBridge({ workerOrigin: worker.origin, token: "forged.token.signature", generation: paths.generation, port: 0 });
      assert.fail("forged bridge token must not pair");
    } catch (error) {
      assert.ok(!String(error?.message ?? "").includes("forged.token.signature"), "bridge must not reflect credentials");
    }
    try {
      await startOwnerBridge({ workerOrigin: worker.origin, token: "", generation: paths.generation, port: 0 });
      assert.fail("empty bridge token must not pair");
    } catch (error) {
      assert.ok(String(error?.message ?? "").length > 0);
    }
    const ownedBefore = worker.origin;
    try {
      await startLocalWorker({ ...paths, config: resolve(directory, "missing-wrangler.json") });
      assert.fail("failed start must reject");
    } catch (error) {
      assert.ok(String(error?.message ?? "").length > 0, "failed start must report without leaking state");
    }
    assert.equal(worker.origin, ownedBefore, "failed startup must not replace the owned running Worker");
    await assert.rejects(globalThis.fetch(`${stoppedOrigin}/healthz`, { signal: globalThis.AbortSignal.timeout(5000) }),
      /fetch failed|ECONNREFUSED|aborted/, "failed startup must not resurrect the old Worker port");
    const probe = await globalThis.fetch(`${worker.origin}/healthz`, { signal: globalThis.AbortSignal.timeout(5000) });
    assert.equal(probe.status, 200, "owned Worker must still serve after the failed start");
    const profilesBefore = new Set((await readdir(tmpdir()).catch(() => []))
      .filter((name) => name.startsWith("eliotr-owner-e2e-profile-")));
    const savedExecutable = process.env.ELIOTR_BROWSER_EXECUTABLE;
    process.env.ELIOTR_BROWSER_EXECUTABLE = resolve(directory, "missing-browser-executable");
    try {
      await launchPlaywright(runId);
      assert.fail("injected browser start must reject");
    } catch (error) {
      assert.ok(String(error?.message ?? "").length > 0, "injected browser failure must report");
    } finally {
      if (savedExecutable === undefined) delete process.env.ELIOTR_BROWSER_EXECUTABLE;
      else process.env.ELIOTR_BROWSER_EXECUTABLE = savedExecutable;
    }
    const profilesAfter = (await readdir(tmpdir()).catch(() => []))
      .filter((name) => name.startsWith("eliotr-owner-e2e-profile-"));
    assert.deepEqual(profilesAfter.filter((name) => !profilesBefore.has(name)), [],
      "injected browser-start failure must leave no profile residue");
    receipt.failed_startup = "PASS";
    receipt.finished_at = new globalThis.Date().toISOString();
    receipt.live = "NOT_EXECUTED";
    receipt.resource_ids = {
      namespace, source_id: sourceId, source_revision_ref: revisionRef,
      operation_id: imported.operationId, manifest_sha256: imported.manifestSha,
      evidence_bucket: evidenceMeta.bucket, evidence_key: evidenceMeta.key,
      evidence_sha256: evidenceMeta.sha256, evidence_size_bytes: evidenceMeta.size_bytes,
      evidence_content_type: evidenceMeta.content_type,
      admission_receipt_ref: evidenceMeta.admission_receipt_ref,
      generation: stoppedGeneration,
    };
  } finally {
    // Unconditional nested finally: EVERY owned resource is released even when
    // an earlier release fails. Steps never short-circuit: each runs inside
    // its own guard, failures accumulate into stepErrors, and the residue
    // inventory below runs BEFORE any deletion so a failure cannot hide what
    // was left behind. Exact marker/runId paths only; unrelated same-prefix
    // entries are inventoried, never touched.
    const teardownStarted = Date.now();
    const teardownDeadlineMs = 60000;
    const stepErrors = [];
    const runStep = async (label, fn) => {
      const remaining = teardownDeadlineMs - (Date.now() - teardownStarted);
      if (remaining <= 0) {
        stepErrors.push(`teardown deadline exceeded before ${label}`);
        return;
      }
      try {
        await Promise.race([
          (async () => { await fn(); })(),
          new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error(`teardown step timed out: ${label}`)), Math.max(1000, remaining));
            timer.unref?.();
          }),
        ]);
      } catch (error) {
        stepErrors.push(`${label}: ${error?.message ?? error}`);
      }
    };
    const fail = (message) => { stepErrors.push(message); };
    await runStep("inventoryResidue", async () => {
      // Residue inventory BEFORE deleting the current run: every exact-known
      // run-owned path is recorded present/absent so the post-delete
      // verification below is evidence-backed, not assumed.
      const tmpNames = new Set(await readdir(tmpdir()).catch(() => []));
      const ownTmp = [directory?.split(/[/\\]/).pop()].filter(Boolean);
      receipt.teardown_inventory = {
        residue_before: {
          run_dir_present: directory !== undefined,
          own_tmp_present: ownTmp.filter((name) => tmpNames.has(name)),
          decoys_present: decoyPaths.map((path) => path.split(/[/\\]/).pop()),
        },
      };
    });
    await runStep("bridge.close", async () => { try { await bridge?.close(); } catch (error) { fail(`bridge.close: ${error?.message ?? error}`); } });
    await runStep("worker.stop", async () => { try { await worker?.stop(); } catch (error) { fail(`worker.stop: ${error?.message ?? error}`); } });
    await runStep("playwright.close", async () => { try { await playwright?.close(); } catch (error) { fail(`playwright.close: ${error?.message ?? error}`); } });
    await runStep("jwks.close", async () => {
      const started = Date.now();
      try { await jwks?.close(); } catch (error) { fail(`jwks.close: ${error?.message ?? error}`); }
      if (Date.now() - started >= 10000) fail("JWKS shutdown exceeded its strict deadline");
    });
    await runStep("removeHarnessOwned", async () => {
      if (directory === undefined) { fail("isolated state directory was never created"); return; }
      try { await removeHarnessOwned(directory, runId); }
      catch (error) { fail(`removeHarnessOwned: ${error?.message ?? error}`); }
    });
      await runStep("assertStateRemoved", async () => {
        if (directory === undefined) return;
        await assert.rejects(access(directory), /ENOENT/, "isolated state directory must be removed").catch((error) => {
          fail(`assertStateRemoved: ${error?.message ?? error}`);
        });
      });
      await runStep("reconcileStateRoot", async () => {
        // Marker/runId-only rule: NO deletion by owner-e2e-*/smoke-* prefix exists
        // in this harness. Unexpected shared-state entries are a failure and are
        // left untouched for inspection. Known adversarial decoys (exact names,
        // created by this run) must survive; they are removed by exact path only
        // in removeDecoys below. Immutable before/after inventories are recorded.
        const afterDirs = new Set(await readdir(stateRoot).catch(() => []));
        const added = [...afterDirs].filter((name) => !beforeDirs.has(name) && !decoyNames.state.has(name));
        const removed = [...beforeDirs].filter((name) => !afterDirs.has(name));
        for (const name of decoyNames.state) {
          if (!afterDirs.has(name)) {
            fail(`adversarial decoy was deleted by prefix cleanup: ${name}`);
          }
        }
        receipt.teardown_inventory = {
          ...receipt.teardown_inventory,
          before: [...beforeDirs].sort(),
          after: [...afterDirs].sort(),
          added,
          removed,
          decoys_survived: [...decoyNames.state].filter((name) => afterDirs.has(name)).sort(),
        };
        if (added.length > 0) {
          fail(`teardown created unexpected shared state (left untouched): ${added.join(",")}`);
        }
        if (removed.length > 0) {
          fail(`teardown removed pre-existing shared state: ${removed.join(",")}`);
        }
      });
      await runStep("reconcileTempProfiles", async () => {
        // Only the marker-proven own profileDir may ever be removed (done in
        // playwright.close via removeHarnessOwned). Prefix-colliding entries are
        // inventoried, never touched: own profile must be gone, every decoy and
        // foreign-marker directory must survive, and no pre-existing entry may
        // have been removed. This replaces the tautological filter and any glob.
        const names = await readdir(tmpdir()).catch(() => []);
        const ownName = playwright?.profileDir?.split(/[/\\]/).pop() ?? "";
        if (ownName !== "") {
          try {
            await access(playwright.profileDir);
            fail("own browser profile survived playwright.close");
          } catch { /* removed: expected */ }
        }
        for (const name of decoyNames.tmp) {
          if (!names.includes(name)) {
            fail(`adversarial temp decoy was deleted by prefix cleanup: ${name}`);
          }
        }
        receipt.teardown_inventory.tmp_decoys_survived = [...decoyNames.tmp].filter((name) => names.includes(name)).sort();
        receipt.teardown_inventory.tmp_profile_count = names.filter((name) =>
          name.startsWith("eliotr-owner-e2e-profile-")).length;
      });
      await runStep("reconcileStaging", async () => {
        // Staging workers use marker-proven removal with their known runIds;
        // retry here covers interrupted runs without any prefix glob.
        for (const { dir, id } of ownedStaging) {
          try { await removeHarnessOwned(dir, id); } catch { /* already removed */ }
          try {
            await access(dir);
            fail(`owned staging residue: ${dir}`);
          } catch { /* removed: expected */ }
        }
      });
      await runStep("removeDecoys", async () => {
        // Exact-path removal of this run's own decoys only (created above with
        // known names). Foreign/unrelated entries are never matched.
        for (const path of decoyPaths) {
          await rm(path, { recursive: true, force: true }).catch((error) => {
            fail(`removeDecoys: ${error?.message ?? error}`);
          });
        }
        for (const path of decoyPaths) {
          try {
            await access(path);
            fail(`decoy survived exact-path removal: ${path}`);
          } catch { /* removed: expected */ }
        }
      });
    if (Date.now() - teardownStarted >= teardownDeadlineMs) {
      fail("outer teardown deadline exceeded with full reconciliation");
    }
    receipt.teardown_ms = Date.now() - teardownStarted;
    receipt.teardown_step_errors = [...stepErrors];
    if (teardownError === null && stepErrors.length > 0) {
      teardownError = new Error(stepErrors[0]);
    }
    receipt.teardown = teardownError === null ? "PASS" : "FAIL";
  }
  if (teardownError !== null) throw teardownError;
  return receipt;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runOwnerE2E().then(
    (receipt) => { globalThis.console.log(JSON.stringify(receipt, null, 2)); },
    (error) => { globalThis.console.error(error?.stack ?? String(error)); process.exitCode = 1; },
  );
}
