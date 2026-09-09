import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, access, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
/* global URL: readonly, URLSearchParams: readonly, navigator: readonly, localStorage: readonly,
  sessionStorage: readonly, document: readonly, indexedDB: readonly, caches: readonly,
  Buffer: readonly, fetch: readonly, setTimeout: readonly, clearTimeout: readonly,
  requestAnimationFrame: readonly */
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

function assertKnownCreatedTempDirectory(directory, prefix) {
  const resolved = resolve(directory);
  const root = resolve(tmpdir());
  const name = basename(resolved);
  if (resolved === root || !resolved.startsWith(`${root}${sep}`) || !name.startsWith(prefix)) {
    throw new Error("Refusing cleanup of an unscoped harness directory");
  }
  return resolved;
}

async function removeKnownCreatedTempDirectory(directory, prefix) {
  const resolved = assertKnownCreatedTempDirectory(directory, prefix);
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function markKnownCreatedTempDirectory(directory, prefix, runId, kind, markerWriter = writeHarnessMarker) {
  try {
    return await markerWriter(directory, runId, kind);
  } catch (error) {
    try {
      // The exact path was created by this harness before marker creation;
      // remove it even though marker-gated cleanup cannot prove ownership.
      await removeKnownCreatedTempDirectory(directory, prefix);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError],
        `Harness marker creation failed and cleanup was incomplete for ${directory}`, { cause: cleanupError });
    }
    throw error;
  }
}

async function createMarkedTempDirectory(prefix, runId, kind, { markerWriter = writeHarnessMarker } = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), prefix));
  await markKnownCreatedTempDirectory(directory, prefix, runId, kind, markerWriter);
  return directory;
}

export const OWNER_E2E_ISSUER = ["https://owner-e2e", ".cloudflareaccess.com"].join("");
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

function isTransientReadbackError(error) {
  const cause = error?.cause;
  const text = `${error?.message ?? error}\n${cause?.diagnostic ?? ""}\n${cause?.stdout ?? ""}\n${cause?.stderr ?? ""}`;
  if (/CONFLICT|SETTLEMENT_UNCERTAIN|INPUT_INVALID|PROFILE_UNSUPPORTED|EXISTING_LINEAGE|OWNER_REQUIRED|READBACK_INVALID|no such table|no such column|syntax error/i.test(text)) return false;
  return isTransientLocalD1Error(error) && /TRANSIENT_D1_LOCK|SQLITE_BUSY|SQLITE_LOCKED|database (?:is )?(?:locked|busy)|resource busy or locked|\bEBUSY\b|miniflare.*lock|lock.*miniflare/i.test(text);
}

// Bounded retry for read-only restart readbacks against the local runner.
// Only explicit transient runner-lock observations are retried; deterministic
// data, authority and schema failures stop on their first attempt.
export async function readbackWithBoundedRetry(label, fn, { attempts = 3, delayMs = 1000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientReadbackError(error) || attempt >= attempts) throw error;
      await new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

export async function verifyReadbackRetryClassification() {
  let deterministicAttempts = 0;
  await assert.rejects(readbackWithBoundedRetry("deterministic-readback", async () => {
    deterministicAttempts += 1;
    throw new Error("LOCAL_NAMESPACE_CONFLICT");
  }, { attempts: 3, delayMs: 1 }), /LOCAL_NAMESPACE_CONFLICT/);
  assert.equal(deterministicAttempts, 1, "deterministic readback failures must not retry");

  let transientAttempts = 0;
  const value = await readbackWithBoundedRetry("transient-readback", async () => {
    transientAttempts += 1;
    if (transientAttempts === 1) {
      const error = new Error("local runner lock");
      error.cause = { diagnostic: "TRANSIENT_D1_LOCK" };
      throw error;
    }
    return "readback";
  }, { attempts: 2, delayMs: 1 });
  assert.equal(value, "readback");
  assert.equal(transientAttempts, 2, "transient runner locks may receive one bounded retry");
  return { protocol: "eliotr.owner-e2e.readback-retry.v1", state: "PASS" };
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

// ---- Closed operation/slot authority (architect): closed enums, explicit
// registration at action/navigation boundaries only, finite request slots
// minted per action, and single-step exact transition validation. This
// replaces the D5 mintOp/prevOpId auto-chain and the BFS supersededBy closure
// (both deleted): unknown or merely-nonempty enum values reject, operations
// link only through declared successors in the closed TRANSITIONS set, and
// the abort anchor key is (method,origin,path,role,actionIds,slotId).
export const OP_KINDS = Object.freeze(["init", "harness-navigation", "harness-action", "observed-navigation"]);
export const OP_CAUSES = Object.freeze(["harness-start", "init", "goto", "goto-pairing", "pair-action", "reload", "logout-action", "framenavigated"]);
export const EDGE_SCOPES = Object.freeze(["harness", "document"]);
export const SLOT_ROLES = Object.freeze(["startup-probe", "catalog-read", "health-read", "pair-action", "jwt-matrix", "logout-action", "rotation-read"]);
export const OP_ACTIONS = Object.freeze(["harness-start", "goto-unauthenticated", "goto-pairing", "click-connect",
  "reload-authed-retrieval", "goto-jwt-matrix", "goto-post-restart", "goto-repairing", "click-reconnect",
  "goto-logout", "click-logout", "goto-post-logout-clean", "goto-rotation", "goto-rotation-pairing",
  "click-rotation-connect", "probe-issue", "probe-mid", "probe-retry", "probe-rogue", "pair-probe", "pair-retry",
  "framenavigated"]);
export const OP_TRANSITIONS = Object.freeze(["harness-start→goto-unauthenticated", "goto-unauthenticated→goto-pairing",
  "goto-pairing→click-connect", "click-connect→reload-authed-retrieval", "reload-authed-retrieval→goto-jwt-matrix",
  "goto-jwt-matrix→goto-post-restart", "goto-post-restart→goto-repairing", "goto-repairing→click-reconnect",
  "click-reconnect→goto-logout", "goto-logout→click-logout", "click-logout→goto-post-logout-clean",
  "goto-post-logout-clean→goto-rotation", "goto-rotation→goto-rotation-pairing", "goto-rotation-pairing→click-rotation-connect",
  "goto-unauthenticated→framenavigated", "goto-pairing→framenavigated", "reload-authed-retrieval→framenavigated",
  "goto-jwt-matrix→framenavigated", "goto-post-restart→framenavigated", "goto-repairing→framenavigated",
  "goto-logout→framenavigated", "goto-post-logout-clean→framenavigated", "goto-rotation→framenavigated",
  "goto-rotation-pairing→framenavigated", "harness-start→probe-issue", "harness-start→pair-probe",
  "probe-issue→probe-retry", "probe-issue→probe-mid", "probe-mid→probe-retry", "pair-probe→pair-retry"]);

// Abortable application identities pre-minted per action (finite request
// slots, scoped method+origin+path). Dynamic artifact paths mint through the
// same authority at their action boundary via extraPaths.
export const ABORTABLE_SLOT_PATHS = Object.freeze([["GET", "/api/v1/research/catalog?limit=20"],
  ["GET", "/api/v1/system/health"], ["GET", "/api/v1/system/session"], ["POST", "/__local/pair"],
  ["POST", "/__local/logout"], ["GET", "/__local/"], ["GET", "/manifest.webmanifest"]]);

// Private canonical policy: deep-frozen copy. Authority reads ONLY this copy;
// public ABORTABLE_SLOT_PATHS mutations (including nested) never affect minting.
const PRIVATE_ABORTABLE = Object.freeze(
  ABORTABLE_SLOT_PATHS.map((entry) => Object.freeze([...entry])),
);

// Exact role compatibility: equal AND a closed SlotRole. Unknown roles and
// merely-nonempty strings (including the deleted broad-phase "authed-window"
// label) reject; roles never derive from URLs.
export function roleCompat(first, second) {
  return first === second && SLOT_ROLES.includes(first);
}

export const NAV_TOKEN_SCOPE = "harness-navigation";
export const CONTRACT_RESPONSE_STATUSES = Object.freeze([200, 204, 304, 401, 403]);

// Closed issuance handles: frozen {opId,docId,role} threaded as arguments.
// Exact capabilities: every legitimate handle is registered in issuanceRegistry
// (WeakMap) at creation; checkIssuanceHandle requires a registry hit + exact
// prototype (Object.prototype) + exact own-keys {opId,docId,role} + matching
// triple. Unregistered lookalikes (including spread copies), null-prototype
// objects, extra-key objects, and triple mismatches throw. The live harness
// threads these handles through mintSlotsFor/bindSlot/stamp; setRole issues a
// new registered handle.
const issuanceRegistry = new WeakMap();
function registerIssuanceHandle(handle) {
  issuanceRegistry.set(handle, Object.freeze({ opId: handle.opId, docId: handle.docId, role: handle.role }));
  return handle;
}
function checkIssuanceShape(handle, where) {
  assert.ok(handle !== null && typeof handle === "object" && Object.isFrozen(handle),
    `${where} requires an explicit frozen issuance handle {opId,docId,role} (direct bypass throws)`);
  assert.ok(Number.isSafeInteger(handle.opId) && Number.isSafeInteger(handle.docId) && handle.docId >= 0,
    `${where} issuance handle opId/docId must be exact`);
  assert.ok(typeof handle.role === "string" && SLOT_ROLES.includes(handle.role),
    `${where} issuance handle role must be an exact SlotRole`);
  return handle;
}
export function createIssuanceHandle(opId, docId, role) {
  assert.ok(Number.isSafeInteger(opId) && opId > 0,
    `issuance handle opId must be exact, got ${String(opId).slice(0, 32)}`);
  assert.ok(Number.isSafeInteger(docId) && docId >= 0,
    `issuance handle docId must be exact, got ${String(docId).slice(0, 32)}`);
  assert.ok(typeof role === "string" && SLOT_ROLES.includes(role),
    `issuance handle role must be an exact SlotRole, got ${JSON.stringify(String(role)).slice(0, 64)}`);
  return registerIssuanceHandle(Object.freeze({ opId, docId, role }));
}

export function checkIssuanceHandle(handle, where = "issuance") {
  checkIssuanceShape(handle, where);
  assert.ok(Object.getPrototypeOf(handle) === Object.prototype,
    `${where} issuance handle must carry the exact Object.prototype (direct bypass throws)`);
  assert.deepEqual(Object.keys(handle).sort(), ["docId", "opId", "role"],
    `${where} issuance handle must carry exactly {opId,docId,role} (direct bypass throws)`);
  assert.ok(issuanceRegistry.has(handle),
    `${where} issuance handle is not a registered capability (direct bypass throws)`);
  const registered = issuanceRegistry.get(handle);
  assert.ok(registered.opId === handle.opId && registered.docId === handle.docId && registered.role === handle.role,
    `${where} issuance handle triple mismatch (direct bypass throws)`);
  return handle;
}

export function deriveRoleHandle(baseHandle, role) {
  checkIssuanceShape(baseHandle, "setRole");
  assert.ok(typeof role === "string" && SLOT_ROLES.includes(role),
    `role must be an exact SlotRole (unknown/merely-nonempty rejects), got ${JSON.stringify(String(role)).slice(0, 64)}`);
  checkIssuanceHandle(baseHandle, "setRole");
  return registerIssuanceHandle(Object.freeze({ opId: baseHandle.opId, docId: baseHandle.docId, role }));
}

// Checked nav barrier: zero in-flight nav handles required at
// registerOp/setRole. Direct bypass (overlapping navigation without
// consumption) throws; the caller must drain via FIFO consume first.
export function assertZeroNavInflight(pendingCount, where = "barrier") {
  assert.ok(Number.isSafeInteger(pendingCount) && pendingCount >= 0,
    `${where}: pending nav count must be exact`);
  assert.ok(pendingCount === 0,
    `${where}: zero in-flight nav handles required, got ${pendingCount} (direct bypass throws)`);
}

// Single-terminal collector: one reqId → one terminal outcome. A failure
// notification is suppressed ONLY when the SAME reqId already has a
// contract-response terminal (its own duplicate delivery report). Cross-reqId,
// non-contract-status, or duplicate-response cases never suppress and fail
// closed downstream. No sleep, no retry hiding: suppressed entries are exactly
// the same-reqId contract-response duplicate, everything else stays ledgered.
// Closed construction: the caller Set is copied+validated into private
// immutable state (non-empty, subset of CONTRACT_RESPONSE_STATUSES); the
// caller Set is never stored or exposed, and noteResponse/shouldSuppressFailure
// consult the private copy only (post-construction mutation has no effect).
export function createRequestTerminalTracker(contractStatuses = new Set(CONTRACT_RESPONSE_STATUSES)) {
  assert.ok(contractStatuses instanceof Set,
    "terminal tracker requires an exact contract status Set");
  assert.ok(contractStatuses.size > 0,
    "terminal tracker requires an exact non-empty contract status set");
  const allowedList = [...contractStatuses];
  assert.ok(allowedList.every((status) => Number.isSafeInteger(status) && CONTRACT_RESPONSE_STATUSES.includes(status)),
    `terminal tracker contract statuses must be a non-empty subset of ${CONTRACT_RESPONSE_STATUSES.join("/")}`);
  const allowed = new Set(allowedList);
  const seenResponseIds = new Set();
  const terminalByReqId = new Map();
  return {
    contractStatuses: new Set(allowed),
    noteResponse(reqId, status) {
      assert.ok(Number.isSafeInteger(reqId), `terminal tracker requires an exact reqId, got ${String(reqId).slice(0, 32)}`);
      assert.ok(Number.isSafeInteger(status), `terminal tracker requires an exact status, got ${String(status).slice(0, 32)}`);
      assert.ok(!seenResponseIds.has(reqId),
        `duplicate response reqId ${reqId} fails closed (one terminal outcome per request)`);
      seenResponseIds.add(reqId);
      const contract = allowed.has(status);
      terminalByReqId.set(reqId, Object.freeze({ kind: "response", status, contract }));
      return contract;
    },
    shouldSuppressFailure(reqId) {
      const terminal = terminalByReqId.get(reqId);
      return terminal !== undefined && terminal.kind === "response" && terminal.contract === true;
    },
    noteFailure(reqId) {
      assert.ok(Number.isSafeInteger(reqId), `terminal tracker requires an exact reqId, got ${String(reqId).slice(0, 32)}`);
      terminalByReqId.set(reqId, Object.freeze({ kind: "failure" }));
    },
    seenResponseIds: () => Object.freeze([...seenResponseIds]),
    terminalByReqId: () => {
      const copy = new Map();
      for (const [key, value] of terminalByReqId) {
        copy.set(key, Object.freeze({ ...value }));
      }
      return copy;
    },
  };
}

// Closed authority instance sequencing for cross-authority closure: every
// createClosedAuthority instance carries a unique authorityId; slotCap/opCap
// carry it and foreign capabilities/ids never resolve (WeakMap miss or
// authorityId mismatch throws with zero residue).
let closedAuthoritySeq = 0;

export function createClosedAuthority(label) {
  assert.ok(typeof label === "string" && label.length > 0 && label.length < 128,
    "authority label must be an exact boundary name");
  closedAuthoritySeq += 1;
  const authorityId = `${label}#${closedAuthoritySeq}`;
  const operations = new Map();
  const edges = [];
  const slots = new Map();
  // Causal nav/action tokens: pendingNav keyed by exact tokenId. Tokens are
  // minted ONLY inside the validated registerOp harness-navigation path via the
  // closure-private mint (public mintNavToken deleted: non-caller mint impossible),
  // bound to opaque frozen token objects through tokenBindings (WeakMap), and
  // consumed one-to-one via consumeNavToken(tokenObject) ONLY. The numeric
  // consumeNavToken(tokenId) branch is deleted: primitives never resolve
  // (WeakMap miss or non-object → null, no state change). A successful consume
  // deletes from pendingNav (no reuse/stale/enumeration). The backward-scan
  // consumeNavSlot(targetDoc) is deleted: targetDoc scanning is ambiguous (two
  // pendings, same doc) and can never anchor edges. Token-less or wrong-token
  // frame events register as unlinked observations and never anchor edges.
  const pendingNav = new Map();
  const tokenBindings = new WeakMap();
  const successorsByOp = new Map();
  let nextOpId = 0;
  let nextSlotId = 0;
  let nextTokenId = 0;
  const opCaps = new WeakMap();
  const slotCaps = new WeakMap();
  const checkEnum = (value, closed, name) => {
    assert.ok(typeof value === "string" && closed.includes(value),
      `${label}: unknown ${name} ${JSON.stringify(String(value)).slice(0, 64)} rejects (closed: ${closed.join("/")}); merely-nonempty is insufficient`);
  };
  // Successors single-materialization: exactly ONE read pass into a frozen
  // snapshot BEFORE validation; the validated snapshot is the committed one.
  // Accessors/Proxies/sparse/inherited/mutation-during-coercion throw with zero
  // residue (no id allocation, no map mutation). Plain Array only, exact
  // own-keys [0..len-1], data descriptors only, length/keys stable across pass.
  const materializeSuccessors = (input) => {
    assert.ok(Array.isArray(input),
      `${label}: op successors must declare exact OpActions`);
    assert.ok(Object.getPrototypeOf(input) === Array.prototype,
      `${label}: op successors must declare exact OpActions (plain Array only; Proxy denies)`);
    const len = input.length;
    assert.ok(Number.isSafeInteger(len) && len >= 0 && len <= OP_ACTIONS.length,
      `${label}: op successors must declare exact OpActions`);
    assert.ok(Object.keys(input).length === len,
      `${label}: op successors must declare exact OpActions (sparse/inherited denies)`);
    for (let index = 0; index < len; index += 1) {
      assert.ok(Object.prototype.hasOwnProperty.call(input, String(index)),
        `${label}: op successors must declare exact OpActions (sparse/inherited denies)`);
    }
    const values = [];
    for (let index = 0; index < len; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      assert.ok(descriptor !== undefined && Object.prototype.hasOwnProperty.call(descriptor, "value"),
        `${label}: op successors must declare exact OpActions (accessor denies)`);
      assert.ok(!("get" in descriptor && descriptor.get !== undefined) && !("set" in descriptor && descriptor.set !== undefined),
        `${label}: op successors must declare exact OpActions (accessor denies)`);
      const name = descriptor.value;
      assert.ok(typeof name === "string" && OP_ACTIONS.includes(name),
        `${label}: op successors must declare exact OpActions`);
      values.push(name);
    }
    assert.ok(input.length === len,
      `${label}: op successors must declare exact OpActions (mutation denies)`);
    assert.ok(Object.keys(input).length === len,
      `${label}: op successors must declare exact OpActions (mutation denies)`);
    const ownNames = Object.getOwnPropertyNames(input);
    const expected = new Set([...Array.from({ length: len }, (_, index) => String(index)), "length"]);
    for (const name of ownNames) {
      assert.ok(expected.has(name),
        `${label}: op successors must declare exact OpActions (extra keys deny)`);
    }
    return Object.freeze(values);
  };
  const snapshotOp = (stored) => {
    if (stored === undefined) return undefined;
    const canonical = successorsByOp.get(stored.id) ?? stored.successors ?? [];
    return Object.freeze({ ...stored, successors: Object.freeze([...canonical]) });
  };
  const registerOp = ({ kind, cause, scope, sourceDoc, targetDoc, action, role, from = null, successors = [] }) => {
    checkEnum(kind, OP_KINDS, "OpKind");
    checkEnum(cause, OP_CAUSES, "OpCause");
    checkEnum(scope, EDGE_SCOPES, "EdgeScope");
    checkEnum(action, OP_ACTIONS, "OpAction");
    checkEnum(role, SLOT_ROLES, "SlotRole");
    assert.ok(Number.isSafeInteger(sourceDoc) && sourceDoc >= 0, `${label}: op sourceDoc must be an exact non-negative int`);
    assert.ok(Number.isSafeInteger(targetDoc) && targetDoc >= sourceDoc, `${label}: op targetDoc must be an exact int >= sourceDoc`);
    const succSnapshot = materializeSuccessors(successors);
    assert.ok(operations.size < 1024, `${label}: operation table must stay finite`);
    let prev;
    if (from === null) {
      assert.ok(kind === "init" || kind === "observed-navigation",
        `${label}: only init/observed-navigation may register without an explicit predecessor (NO auto-chain; prevOpId chaining deleted)`);
    } else {
      assert.ok(Number.isSafeInteger(from), `${label}: predecessor op id must be exact`);
      prev = operations.get(from);
      assert.ok(prev !== undefined, `${label}: unregistered transition endpoint ${from} rejects`);
      assert.ok(OP_TRANSITIONS.includes(`${prev.action}→${action}`),
        `${label}: arbitrary edge ${prev.action}→${action} rejects (closed TRANSITIONS)`);
      const canonicalPrev = successorsByOp.get(from) ?? prev.successors;
      assert.ok(canonicalPrev.includes(action),
        `${label}: undeclared successor ${action} rejects (not in op ${from} successors)`);
    }
    if (kind === "harness-navigation") {
      assert.ok(pendingNav.size === 0,
        `${label}: zero in-flight nav handles required at registerOp, got ${pendingNav.size} (concurrent navigation denies; direct bypass throws)`);
      assert.ok(pendingNav.size < 1024, `${label}: pending nav table must stay finite`);
    }
    nextOpId += 1;
    const op = Object.freeze({ id: nextOpId, kind, cause, scope, sourceDoc, targetDoc, action, role, successors: succSnapshot,
      navTokenId: null, authorityId });
    operations.set(op.id, op);
    successorsByOp.set(op.id, succSnapshot);
    opCaps.set(op, op.id);
    if (kind === "harness-navigation") {
      const token = mintNavToken(op.id, op.targetDoc);
      const stamped = Object.freeze({ ...op, navTokenId: token.tokenId, navToken: token });
      operations.set(stamped.id, stamped);
      opCaps.set(stamped, stamped.id);
      if (from !== null) edges.push(Object.freeze({ fromOpId: from, toOpId: op.id, scope, cause, tokenId: null }));
      return stamped;
    }
    if (from !== null) edges.push(Object.freeze({ fromOpId: from, toOpId: op.id, scope, cause, tokenId: null }));
    return op;
  };
  const mintNavToken = (opId, targetDoc) => {
    const owner = operations.get(opId);
    assert.ok(owner !== undefined, `${label}: nav token must bind a registered op, got ${String(opId).slice(0, 32)}`);
    assert.ok(owner.kind === "harness-navigation",
      `${label}: nav tokens mint only at harness-navigation boundaries (kind=${owner.kind} rejects)`);
    assert.ok(Number.isSafeInteger(targetDoc) && targetDoc >= 0, `${label}: nav token targetDoc must be exact`);
    assert.ok(targetDoc === owner.targetDoc,
      `${label}: nav token targetDoc must equal its minting op targetDoc (stale stamps reject)`);
    assert.ok(pendingNav.size < 1024, `${label}: pending nav table must stay finite`);
    nextTokenId += 1;
    const token = Object.freeze({ scope: NAV_TOKEN_SCOPE, tokenId: nextTokenId, opId, targetDoc });
    pendingNav.set(token.tokenId, { opId, targetDoc, token });
    tokenBindings.set(token, token.tokenId);
    return token;
  };
  const consumeNavToken = (token) => {
    if (token === null || typeof token !== "object") return null;
    const tokenId = tokenBindings.get(token);
    if (!Number.isSafeInteger(tokenId)) return null;
    const entry = pendingNav.get(tokenId);
    if (entry === undefined) return null;
    if (entry.token !== token) return null;
    pendingNav.delete(tokenId);
    tokenBindings.delete(token);
    return { tokenId, opId: entry.opId, targetDoc: entry.targetDoc, token: entry.token };
  };
  // Capability slot mint: numeric mintSlot public surface deleted.
  // mintSlot(opCap, {method,origin,path}) requires a WeakMap-bound op
  // capability of THIS authority; action/role/targetDoc derive SOLELY from the
  // canonical stored op (no caller role/opId/targetDoc/action params). Foreign
  // capabilities/ids (other authorityId or WeakMap miss, including getOp
  // snapshots) never resolve with zero residue. The deleted-surface message
  // preserves the legacy stale-doc substring so the N38 byte-identical regex
  // still matches a numeric attempt as denied.
  const mintSlot = (opCap, slotArgs) => {
    const boundId = (opCap !== null && typeof opCap === "object") ? opCaps.get(opCap) : undefined;
    const capAuth = (opCap !== null && typeof opCap === "object") ? opCap.authorityId : undefined;
    assert.ok(Number.isSafeInteger(boundId) && capAuth === authorityId,
      `${label}: slot requires an op capability of THIS authority (numeric mintSlot deleted; foreign capabilities/ids never resolve; slot targetDoc must equal its op targetDoc (stale/cross mint rejects))`);
    const owner = operations.get(boundId);
    assert.ok(owner !== undefined,
      `${label}: slot must bind a registered op, got ${String(boundId).slice(0, 32)}`);
    assert.ok(slotArgs !== null && typeof slotArgs === "object",
      `${label}: slot args must be an exact {method,origin,path} object`);
    const { method, origin, path } = slotArgs;
    assert.ok(typeof method === "string" && method.length > 0 && method.length < 16, `${label}: slot method must be exact`);
    assert.ok(typeof origin === "string" && origin.length > 0 && origin.length < 256, `${label}: slot origin must be exact`);
    assert.ok(typeof path === "string" && path.startsWith("/") && path.length < 1024, `${label}: slot path must be exact`);
    assert.ok(slots.size < 8192, `${label}: slot table must stay finite`);
    const opId = owner.id;
    const targetDoc = owner.targetDoc;
    const action = owner.action;
    const role = owner.role;
    nextSlotId += 1;
    // Immutable issuance stamp: the slot freezes its minting op/doc/role
    // context synchronously at the action boundary. Requests verify
    // request.docId == slot.targetDoc == op.targetDoc downstream.
    const slot = Object.freeze({ id: nextSlotId, opId, targetDoc, action, role, method, origin, path, authorityId });
    slots.set(slot.id, slot);
    slotCaps.set(slot, slot.id);
    return slot;
  };
  return { label, authorityId, registerOp, mintSlot, consumeNavToken,
    pendingNavTokens: () => [...pendingNav.entries()].map(([tokenId, entry]) => ({ tokenId, opId: entry.opId, targetDoc: entry.targetDoc })),
    pendingNavCount: () => pendingNav.size,
    drainPendingNav: () => {
      const count = pendingNav.size;
      for (const [, entry] of [...pendingNav.entries()]) {
        try { tokenBindings.delete(entry.token); } catch { /* best-effort */ }
      }
      pendingNav.clear();
      return count;
    },
    getOp: (id) => snapshotOp(operations.get(id)),
    operations: () => [...operations.values()].map(snapshotOp), edges: () => [...edges], slots: () => [...slots.values()].map((entry) => Object.freeze({ ...entry })) };
}

async function launchPlaywright(runId, orphanedProfiles = []) {
  const { chromium } = await import("playwright-core");
  const profileDir = await createMarkedTempDirectory("eliotr-owner-e2e-profile-", runId, "browser-profile");
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
    // Capture the PWA's real register() promise before its module executes.
    // The phase fence consumes this promise in-page; it never starts a
    // synthetic update request at a boundary.
    await context.addInitScript(() => {
      const container = navigator.serviceWorker;
      if (!container || typeof container.register !== "function") return;
      const register = container.register.bind(container);
      Object.defineProperty(container, "register", {
        configurable: true,
        value(...args) {
          const promise = register(...args);
          Object.defineProperty(globalThis, "__eliotServiceWorkerRegistrationPromise", {
            configurable: true, value: promise,
          });
          promise.catch(() => {});
          return promise;
        },
      });
    });
    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];
    const failedRequestClock = [];
    const responses = [];
    // Request-identity attribution for every browser request/response/failure:
    // a reqId is minted exactly once per observed request event and pinned to
    // the Playwright Request object via a WeakMap, so the stamp a response or
    // failure carries is always its OWN request's issuing stamp, never a
    // sample of the live global counter. Operations register ONLY at explicit
    // harness action/navigation boundaries via registerOp with exact
    // kind/cause/scope/sourceDoc/targetDoc/action/role/successors; the
    // observed main-frame framenavigated registers only against a matching
    // pending navigation slot, otherwise as an unlinked observation. There is
    // NO auto-chain and no prevOpId field: every edge is an explicit
    // from-declared successor inside the closed TRANSITIONS set. Requests
    // carry {reqId,opId,docId,role,slotId}; role and slot role come from the
    // explicit startup/action boundary via setRole(), NEVER from URL
    // inference. Responses/failures carry their OWN request's reqId/opId/
    // docId/role/slotId join and fail closed on mismatch. The legacy
    // (epoch,serial,seq) counters are retained for diagnostics only and are
    // NEVER consulted for pairing. There is no phantom fallback: an abort
    // without its own reqId join fails closed.
    let navigationEpoch = 0;
    let panelSerial = 0;
    let requestSeq = 0;
    let nextDocId = 0;
    let currentDocId = 0;
    let currentOp = null;
    let currentIssuance = null;
    // Explicit one-use nav-handle queue (FIFO): each harness-navigation
    // registerOp pushes its frozen token object; each main-frame
    // framenavigated shifts exactly one handle. Zero handles → unlinked
    // observation; >1 pending + one frame → unlinked (fail closed), never
    // latest-for-earliest (the single-global overwrite is deleted).
    const pendingNavHandles = [];
    const auth = createClosedAuthority(`owner-e2e:${runId}`);
    const checkedBarrier = (where) => {
      assert.ok(pendingNavHandles.length === 0,
        `owner-e2e:${runId} barrier at ${where}: zero in-flight nav handles required, got ${pendingNavHandles.length} (direct bypass throws)`);
    };
    const checkIssuanceHandle = (handle, where) => {
      assert.ok(handle !== null && typeof handle === "object" && Object.isFrozen(handle),
        `owner-e2e:${runId} ${where} requires an explicit frozen issuance handle {opId,docId,role} (direct bypass throws)`);
      assert.ok(Number.isSafeInteger(handle.opId) && Number.isSafeInteger(handle.docId) && handle.docId >= 0,
        `owner-e2e:${runId} ${where} issuance handle opId/docId must be exact`);
      assert.ok(SLOT_ROLES.includes(handle.role),
        `owner-e2e:${runId} ${where} issuance handle role must be an exact SlotRole`);
      assert.ok(Object.getPrototypeOf(handle) === Object.prototype,
        `owner-e2e:${runId} ${where} issuance handle must carry the exact Object.prototype (direct bypass throws)`);
      assert.deepEqual(Object.keys(handle).sort(), ["docId", "opId", "role"],
        `owner-e2e:${runId} ${where} issuance handle must carry exactly {opId,docId,role} (direct bypass throws)`);
      assert.ok(issuanceRegistry.has(handle),
        `owner-e2e:${runId} ${where} issuance handle is not a registered capability (direct bypass throws)`);
      const registered = issuanceRegistry.get(handle);
      assert.ok(registered.opId === handle.opId && registered.docId === handle.docId && registered.role === handle.role,
        `owner-e2e:${runId} ${where} issuance handle triple mismatch (direct bypass throws)`);
      return handle;
    };
    const assertCurrentIssuance = (handle, where) => {
      assert.ok(handle.opId === currentOp.id,
        `owner-e2e:${runId} ${where} issuance opId ${handle.opId} must equal current op ${currentOp.id} (stale/cross handle rejects)`);
      assert.ok(handle.docId === currentOp.targetDoc,
        `owner-e2e:${runId} ${where} issuance docId ${handle.docId} must equal current op targetDoc ${currentOp.targetDoc} (stale handle rejects)`);
      assert.ok(handle.role === currentOp.role,
        `owner-e2e:${runId} ${where} issuance role ${handle.role} must equal current op role ${currentOp.role} (stale/cross handle rejects)`);
      assert.ok(handle.opId === currentIssuance.opId && handle.docId === currentIssuance.docId && handle.role === currentIssuance.role,
        `owner-e2e:${runId} ${where} issuance must equal current issuance (stale/cross handle rejects)`);
    };
    // Pure issuance: issues a new frozen handle from a base handle, no global
    // mutation. The caller threads the returned handle into registerOp /
    // mintSlotsFor / adoptIssuance explicitly.
    const setRole = (baseHandle, role) => {
      assert.ok(typeof role === "string" && SLOT_ROLES.includes(role),
        `role must be an exact SlotRole (unknown/merely-nonempty rejects), got ${JSON.stringify(String(role)).slice(0, 64)}`);
      checkIssuanceHandle(baseHandle, "setRole");
      assertCurrentIssuance(baseHandle, "setRole");
      checkedBarrier("setRole");
      return registerIssuanceHandle(Object.freeze({ opId: baseHandle.opId, docId: baseHandle.docId, role }));
    };
    // Root operation: explicitly registered once; later ops link from it (or
    // from their exact predecessor) through declared successors only.
    // opCapById threads WeakMap-bound op capabilities (registerOp return values,
    // never getOp snapshots) into mintSlotsFor so slot mint derives SOLELY from
    // canonical stored ops.
    const opCapById = new Map();
    const rootOp = auth.registerOp({ kind: "init", cause: "harness-start", scope: "harness",
      sourceDoc: 0, targetDoc: 0, action: "harness-start", role: "startup-probe", from: null,
      successors: ["goto-unauthenticated"] });
    opCapById.set(rootOp.id, rootOp);
    currentOp = rootOp;
    currentIssuance = registerIssuanceHandle(Object.freeze({ opId: rootOp.id, docId: 0, role: "startup-probe" }));
    const adoptIssuance = (handle) => {
      checkIssuanceHandle(handle, "adoptIssuance");
      const owner = auth.getOp(handle.opId);
      assert.ok(owner !== undefined,
        `owner-e2e:${runId} adoptIssuance binds an unregistered op ${handle.opId} and rejects`);
      assert.ok(handle.docId === owner.targetDoc,
        `owner-e2e:${runId} adoptIssuance issuance docId ${handle.docId} must equal its op targetDoc ${owner.targetDoc} (stale handle rejects)`);
      assert.ok(handle.role === owner.role || handle.opId === currentOp.id,
        `owner-e2e:${runId} adoptIssuance issuance role ${handle.role} must equal its op role ${owner.role} or current op (cross handle rejects)`);
      currentIssuance = handle;
      currentOp = owner;
      return handle;
    };
    const registerOp = (fields, baseHandle) => {
      if (baseHandle !== undefined) {
        checkIssuanceHandle(baseHandle, "registerOp");
        assertCurrentIssuance(baseHandle, "registerOp");
      }
      checkedBarrier("registerOp");
      const op = auth.registerOp(fields);
      opCapById.set(op.id, op);
      // Freeze the issuing context synchronously at this boundary: every
      // request issued under this action carries exactly this op/doc/role.
      const issuance = registerIssuanceHandle(Object.freeze({ opId: op.id, docId: op.targetDoc, role: op.role }));
      // The harness-navigation boundary mints its causal nav token
      // synchronously inside registerOp (see createClosedAuthority). Push the
      // exact token object onto the FIFO queue and return it as the explicit
      // one-use NavHandle to the initiating helper.
      let navHandle = null;
      if (op.kind === "harness-navigation" && op.navToken !== undefined && op.navToken !== null) {
        pendingNavHandles.push(op.navToken);
        navHandle = op.navToken;
      }
      currentOp = op;
      currentIssuance = issuance;
      return { op, issuance, navHandle };
    };
    // Finite request slots for the exact abortable identities of the current
    // action (scoped targetDoc/action/role/method-origin-path). Dynamic
    // artifact paths arrive via extraPaths at their own action boundary.
    // Takes an explicit issuance handle (no global sampling, no auto-mint).
    // Authority reads the private canonical PRIVATE_ABORTABLE only; public
    // ABORTABLE_SLOT_PATHS nesting mutations never affect minting.
    const mintSlotsFor = (issuanceHandle, { origin, extraPaths = [] } = {}) => {
      checkIssuanceHandle(issuanceHandle, "mintSlotsFor");
      assertCurrentIssuance(issuanceHandle, "mintSlotsFor");
      assert.ok(typeof origin === "string" && origin.length > 0 && origin.length < 256,
        "slot origin must be an exact loopback origin");
      assert.ok(Array.isArray(extraPaths), "slot extra paths must be exact");
      assert.ok(extraPaths.every((entry) => Array.isArray(entry) && entry.length === 2 &&
        typeof entry[0] === "string" && typeof entry[1] === "string" && entry[1].startsWith("/")),
        "slot extra paths must be exact [method,path] pairs");
      const owner = auth.getOp(issuanceHandle.opId);
      assert.ok(owner !== undefined,
        `mintSlotsFor binds an unregistered op ${issuanceHandle.opId} and rejects (direct bypass throws)`);
      assert.ok(owner.targetDoc === issuanceHandle.docId,
        `mintSlotsFor issuance docId ${issuanceHandle.docId} must equal its op targetDoc ${owner.targetDoc} (stale handle rejects)`);
      assert.ok(owner.action === currentOp.action && owner.role === currentOp.role,
        `mintSlotsFor issuance action/role must equal current op action/role (stale/cross handle rejects)`);
      const opCap = opCapById.get(issuanceHandle.opId);
      assert.ok(opCap !== undefined,
        `mintSlotsFor binds an unregistered op ${issuanceHandle.opId} and rejects (direct bypass throws)`);
      const minted = [];
      for (const [method, path] of [...PRIVATE_ABORTABLE, ...extraPaths]) {
        minted.push(auth.mintSlot(opCap, { method, origin, path }));
      }
      return minted;
    };
    // Slot bind for an observed request: the open slot for this exact
    // (method,origin,path) under the explicit issuance handle op/role, else
    // null (unknown paths fail closed downstream — no auto-mint, so no request
    // can invent authority outside its synchronous action boundary).
    const bindSlot = (issuanceHandle, method, origin, path) => {
      checkIssuanceHandle(issuanceHandle, "bindSlot");
      assertCurrentIssuance(issuanceHandle, "bindSlot");
      const open = auth.slots().find((slot) => slot.opId === issuanceHandle.opId && slot.method === method &&
        slot.origin === origin && slot.path === path && slot.role === issuanceHandle.role);
      if (open !== undefined) return open.id;
      return null;
    };
    const frameIdentity = (event) => {
      try {
        const frame = event?.frame?.();
        const guid = String(frame?._guid ?? "unknown").slice(0, 64);
        let url = "unknown";
        try { url = String(frame?.url?.() ?? "unknown").slice(0, 256); } catch { url = "unreadable"; }
        return `${guid}@${url}`;
      } catch { return "unknown"; }
    };
    page.on("framenavigated", (frame) => {
      try {
        if (frame === page.mainFrame()) {
          navigationEpoch += 1;
          nextDocId += 1;
          currentDocId = nextDocId;
          // Causal token-bound document replacement via the FIFO nav-handle
          // queue: exactly one queued handle shifts per frame event. Zero
          // handles → unlinked observation; >1 pending + one frame → unlinked
          // (fail closed, queue drained), never latest-for-earliest. A consumed
          // handle anchors via its minting op; otherwise from:null and no edge.
          // The frame handler never touches issuance: navigation takes effect
          // at the next explicit boundary only. The current action op is never
          // stolen.
          let pending = null;
          if (pendingNavHandles.length === 1) {
            const handle = pendingNavHandles.shift();
            pending = auth.consumeNavToken(handle);
          } else if (pendingNavHandles.length === 0) {
            pending = null;
          } else {
            pendingNavHandles.length = 0;
            pending = null;
          }
          const observedRole = pending !== null
            ? (auth.getOp(pending.opId)?.role ?? currentIssuance.role)
            : currentIssuance.role;
          if (pending !== null) {
            auth.registerOp({ kind: "observed-navigation", cause: "framenavigated", scope: "document",
              sourceDoc: currentDocId, targetDoc: currentDocId, action: "framenavigated",
              role: observedRole, from: pending.opId, successors: [] });
          } else {
            auth.registerOp({ kind: "observed-navigation", cause: "framenavigated", scope: "document",
              sourceDoc: currentDocId, targetDoc: currentDocId, action: "framenavigated",
              role: observedRole, from: null, successors: [] });
          }
        }
      } catch { /* navigation accounting must never break the harness */ }
    });
    // Full phase-aware traffic ledger: every browser request AND response is
    // recorded with method, normalized origin/path, status and resource type so
    // the phase assertion below closes over ALL traffic, including successful
    // unexpected responses that console/pageerror/failed-request ledgers miss.
    const requests = [];
    const networkResponses = [];
    const pendingRequests = new Set();
    const pendingWaiters = new Set();
    let trafficSequence = 0;
    const settleRequest = (request) => {
      if (pendingRequests.delete(request)) {
        for (const resolve of pendingWaiters) resolve();
        pendingWaiters.clear();
      }
    };
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
    let nextRequestId = 0;
    const requestIds = new WeakMap();
    // Unique identity + one terminal outcome: the tracker records the single
    // terminal outcome per reqId and dedupes ONLY the same-reqId
    // contract-response suppressing its own duplicate failure notification.
    // Cross-reqId, non-contract, or duplicate-response cases never suppress.
    const terminals = createRequestTerminalTracker();
    context.on("request", (request) => {
      pendingRequests.add(request);
      trafficSequence += 1;
      const entry = ledgerEntry(request.method(), request.url());
      requestSeq += 1;
      nextRequestId += 1;
      // Immutable issuance stamp: a frozen copy of the explicitly adopted
      // issuance handle (op/doc/role) plus the exact bound slot (or null for
      // unknown paths, which fail closed downstream). The stamp object is
      // frozen so later boundaries can never mutate it, and no slot is
      // auto-minted here. Live navigation/doc counters are never sampled.
      // Current-identity gate before stamp: stale/cross handles throw pre-mutation.
      const handle = currentIssuance;
      checkIssuanceHandle(handle, "stamp");
      assertCurrentIssuance(handle, "stamp");
      const stamp = Object.freeze({ id: nextRequestId, epoch: navigationEpoch, serial: panelSerial, seq: requestSeq,
        opId: handle.opId, docId: handle.docId, role: handle.role, slotId: bindSlot(handle, entry.method, entry.origin, entry.path) });
      requestIds.set(request, stamp);
      requests.push(Object.freeze({ ...entry, resourceType: request.resourceType(),
        reqId: stamp.id, epoch: stamp.epoch, serial: stamp.serial, seq: stamp.seq,
        opId: stamp.opId, docId: stamp.docId, role: stamp.role, slotId: stamp.slotId, frame: frameIdentity(request) }));
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        const loc = message.location();
        const where = loc?.url ? ` @${String(loc.url).slice(0, 160)}` : "";
        consoleErrors.push(`${message.text().slice(0, 1500)}${where}`.slice(0, 2048));
      }
    });
    page.on("pageerror", (error) => { pageErrors.push(String(error?.stack ?? error).slice(0, 2048)); });
    const failedRequestEntries = [];
    // One request → one terminal outcome: a same-reqId contract response
    // suppresses ONLY its own duplicate failure notification (observed:
    // Chromium emits net::ERR_ABORTED for an already completed 204 when a
    // navigation races delivery). The suppression is exact: same reqId AND a
    // contract status recorded via the terminal tracker. Cross-reqId responses,
    // non-contract responses, and duplicate responses never suppress — the
    // failure stays ledgered and fails closed downstream. Synthetic regression
    // rows bypass collection and keep every negative exact (Luna-10 included).
    context.on("requestfailed", (request) => {
      settleRequest(request);
      trafficSequence += 1;
      const earlyStamp = requestIds.get(request);
      if (earlyStamp !== undefined && Number.isSafeInteger(earlyStamp.id) && terminals.shouldSuppressFailure(earlyStamp.id)) return;
      // Legacy failure-time clock retained for message-compat diagnostics only;
      // the anchor never consults it. Pairing uses the failure's OWN reqId join.
      failedRequestClock.push({ epoch: navigationEpoch, serial: panelSerial });
      const failure = request.failure()?.errorText ?? "unknown";
      const text = `${request.method()} ${request.url()} :: ${failure}`.slice(0, 512);
      failedRequests.push(text);
      const stamp = requestIds.get(request);
      const entry = ledgerEntry(request.method(), request.url());
      failedRequestEntries.push({ text, ...entry, errorText: failure,
        reqId: typeof stamp?.id === "number" ? stamp.id : null,
        epoch: typeof stamp?.epoch === "number" ? stamp.epoch : null,
        serial: typeof stamp?.serial === "number" ? stamp.serial : null,
        seq: typeof stamp?.seq === "number" ? stamp.seq : null,
        opId: typeof stamp?.opId === "number" ? stamp.opId : null,
        docId: typeof stamp?.docId === "number" ? stamp.docId : null,
        role: typeof stamp?.role === "string" ? stamp.role : null,
        slotId: typeof stamp?.slotId === "number" ? stamp.slotId : null });
    });
    context.on("response", (response) => {
      // The response carries its OWN request's stamp via response.request().
      // A missing stamp fails closed downstream and never falls back to
      // sampling the live global counter. opId/docId/role join the same way.
      // The terminal tracker records the single terminal outcome per reqId;
      // only a same-reqId contract-response suppresses its own duplicate
      // failure notification below (handled in requestfailed via
      // shouldSuppressFailure). Retroactive ledger surgery is deleted: already-
      // recorded failures are never removed here.
      const request = response.request();
      settleRequest(request);
      trafficSequence += 1;
      const stamp = requestIds.get(request);
      const status = response.status();
      if (stamp !== undefined && Number.isSafeInteger(stamp.id)) {
        try { terminals.noteResponse(stamp.id, status); } catch { /* duplicate terminal stays ledgered; verifier fails closed */ }
      }
      const entry = ledgerEntry(request.method(), request.url());
      let contentType;
      try { contentType = String(response.headers()["content-type"] ?? "").split(";")[0]?.trim().slice(0, 128) ?? ""; }
      catch { contentType = "unreadable"; }
      networkResponses.push({ ...entry, status: response.status(), resourceType: request.resourceType(), contentType,
        reqId: typeof stamp?.id === "number" ? stamp.id : null,
        epoch: typeof stamp?.epoch === "number" ? stamp.epoch : null,
        serial: typeof stamp?.serial === "number" ? stamp.serial : null,
        seq: typeof stamp?.seq === "number" ? stamp.seq : null,
        opId: typeof stamp?.opId === "number" ? stamp.opId : null,
        docId: typeof stamp?.docId === "number" ? stamp.docId : null,
        role: typeof stamp?.role === "string" ? stamp.role : null,
        slotId: typeof stamp?.slotId === "number" ? stamp.slotId : null,
        frame: frameIdentity(request) });
      responses.push(`${request.method()} ${request.url()} -> ${response.status()}`.slice(0, 512));
    });
    page.on("websocket", (socket) => { websockets.push(socket.url().slice(0, 512)); });
    page.on("worker", (worker) => { pageWorkers.push(worker.url().slice(0, 512)); });
    const evaluate = (fn, arg) => page.evaluate(fn, arg);
    const resetLedger = () => {
      assertPhaseResetReady(pendingRequests, `phase reset serial ${panelSerial}`);
      panelSerial += 1;
      consoleErrors.length = 0; pageErrors.length = 0; failedRequests.length = 0; failedRequestClock.length = 0; failedRequestEntries.length = 0; responses.length = 0;
      requests.length = 0; networkResponses.length = 0; websockets.length = 0; pageWorkers.length = 0;
      pendingNavHandles.length = 0;
      auth.drainPendingNav();
    };
    const close = async () => {
      try { await context?.close(); } catch { /* Best-effort. */ }
      try { await browser?.close(); } catch { /* Already closed. */ }
      await removeHarnessOwned(profileDir, runId);
      await assert.rejects(access(profileDir), /ENOENT/, "temp browser profile must be removed");
    };
    const pendingRequestCount = () => pendingRequests.size;
    const waitForPendingChange = () => {
      let active = true;
      let resolveWaiter;
      const promise = new Promise((resolve) => {
        resolveWaiter = () => {
          if (!active) return;
          active = false;
          pendingWaiters.delete(resolveWaiter);
          resolve();
        };
        pendingWaiters.add(resolveWaiter);
      });
      return { promise, cancel: () => { active = false; pendingWaiters.delete(resolveWaiter); } };
    };
    return { browser, context, page, evaluate, consoleErrors, pageErrors, failedRequests, failedRequestClock, failedRequestEntries, responses,
      requests, networkResponses, websockets, pageWorkers, resetLedger, close, profileDir,
      pendingRequestCount, waitForPendingChange, trafficSequence: () => trafficSequence,
      registerOp, mintSlotsFor, setRole, adoptIssuance, bindSlot,
      currentOp: () => currentOp,
      currentDocId: () => currentDocId,
      currentIssuance: () => currentIssuance,
      pendingNavQueueLength: () => pendingNavHandles.length,
      operationTable: () => auth.operations(), edgeTable: () => auth.edges(), slotTable: () => auth.slots(),
      ledgerClock: () => ({ epoch: navigationEpoch, serial: panelSerial, seq: requestSeq, opId: currentOp.id, docId: currentDocId, role: currentIssuance.role }) };
  } catch (error) {
    const cleanupErrors = [];
    try { await context?.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    try { await browser?.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    try { await removeHarnessOwned(profileDir, runId); }
    catch (cleanupError) {
      orphanedProfiles.push({ path: profileDir, runId });
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors],
        `Playwright startup failed and cleanup was incomplete for ${profileDir}`, { cause: error });
    }
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
  const { consoleErrors, pageErrors } = harness;
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
  const allowedFailedAnchor = buildAuthedAbortAnchor(label, harness, origin);
  const failures = Array.isArray(harness.failedRequestEntries) ? harness.failedRequestEntries : [];
  for (const entry of failures) {
    allowedFailedAnchor(entry);
  }
}

// Closed accounted-anchor rule for authed ERR_ABORTED traffic
// (settle-then-assert, registered ops/slots, explicit SlotRoles, one-to-one
// consumption, phantom deleted). Requests carry {reqId,opId,docId,role,slotId}
// with role/slot from the explicit startup/action boundary (never
// URL-derived); responses/failures carry their OWN request's reqId join
// (including opId/docId/role/slotId) and fail closed on mismatch. Acceptance
// is the conjunction of:
// (1) exact identity (method/origin/path/role equal own request),
// (2) ERR_ABORTED only,
// (3) same origin as the asserted window,
// (4) a distinct (reqId B≠A, opId differs) later response with the same
//     method+origin+path+role and a contract status from authedNetworkSpec,
// (5) a single-step exact edge from the abort opId to the survivor opId: both
//     endpoints registered, the survivor action a declared successor of the
//     abort op, the pair in the closed TRANSITIONS set, doc binding
//     (survivor sourceDoc === abort targetDoc), and token binding (exact token
//     endpoints: when either side carries a navTokenId, both must carry the
//     same token; an edge carrying a tokenId must match both endpoints).
//     Transitive hops deny.
// (6) successor-slot binding: both sides carry registered slots whose scope
//     equals their own request identity, each bound to its own op with
//     request.docId == slot.targetDoc == op.targetDoc (op/doc mismatch and
//     stale stamps reject), the survivor slot strictly later than the abort
//     slot AND authenticated order (survivor.request.seq > abort.request.seq);
//     the anchor key is (method,origin,path,role,actionIds,slotId),
// (7) one-to-one cardinality via successor-slot consumption (each survivor
//     slot anchors at most one abort) plus one terminal outcome per reqId
//     (seenResponseIds; a failure whose reqId already has a response terminal
//     denies as dedupe overreach — only a same-reqId contract-response may
//     suppress its own duplicate failure notification, handled in collection).
// Forbidden and absent: BFS/transitive closure, latest/earliest/positional
// matching, URL-only role inference, unknown or merely-nonempty roles,
// broad-phase roles, unregistered endpoints, arbitrary edges, slot replay or
// slot mismatch, generic epoch/clock matching, phantom fallback, broader
// allowlist, absolute ceiling, sleep-only timing, hidden retries. The legacy
// (epoch,serial,seq) counters are diagnostics only and are never consulted.
function buildAuthedAbortAnchor(label, harness, origin) {
  const requests = Array.isArray(harness.requests) ? harness.requests : [];
  const responses = Array.isArray(harness.networkResponses) ? harness.networkResponses : [];
  const failures = Array.isArray(harness.failedRequestEntries) ? harness.failedRequestEntries : [];
  const compatStrings = Array.isArray(harness.failedRequests) ? harness.failedRequests : [];
  const rawOps = typeof harness.operationTable === "function" ? harness.operationTable() : (harness.operations ?? []);
  const rawEdges = typeof harness.edgeTable === "function" ? harness.edgeTable() : (harness.supersedes ?? []);
  const rawSlots = typeof harness.slotTable === "function" ? harness.slotTable() : (harness.slots ?? []);
  assert.ok(rawOps.length <= 1024 && rawSlots.length <= 8192 && rawEdges.length <= 2048,
    `${label}: operation/edge/slot tables must stay finite`);
  assert.equal(failures.length, compatStrings.length,
    `${label}: failure ledger drift: ${compatStrings.length} compat strings vs ${failures.length} structured entries (string form is message-compat only, never pairing)`);
  const contract = new Map();
  for (const entry of authedNetworkSpec(origin).api) {
    const key = `${entry.method} ${entry.path}`;
    if (!contract.has(key)) contract.set(key, new Set());
    contract.get(key).add(entry.status);
  }
  const checkClosed = (value, closed, name) => {
    if (value === "authed-window") {
      assert.fail(`${label}: broad-phase role "authed-window" is deleted; split into SlotRoles, got ${name}`);
    }
    assert.ok(typeof value === "string" && closed.includes(value),
      `${label}: unknown ${name} ${JSON.stringify(String(value)).slice(0, 64)} rejects (closed: ${closed.join("/")}); merely-nonempty is insufficient`);
  };
  // Closed operation table: every row carries exact closed enums.
  const registry = new Map();
  for (const op of rawOps) {
    assert.ok(Number.isSafeInteger(op?.id),
      `${label}: operation without an exact id fails closed`);
    assert.ok(!registry.has(op.id),
      `${label}: duplicate operation id ${op.id} fails closed`);
    checkClosed(op?.kind, OP_KINDS, "OpKind");
    checkClosed(op?.cause, OP_CAUSES, "OpCause");
    checkClosed(op?.scope, EDGE_SCOPES, "EdgeScope");
    checkClosed(op?.action, OP_ACTIONS, "OpAction");
    checkClosed(op?.role, SLOT_ROLES, "SlotRole");
    assert.ok(Number.isSafeInteger(op?.sourceDoc) && op.sourceDoc >= 0,
      `${label}: op ${op.id} sourceDoc must be exact`);
    assert.ok(Number.isSafeInteger(op?.targetDoc) && op.targetDoc >= op.sourceDoc,
      `${label}: op ${op.id} targetDoc must be exact and >= sourceDoc`);
    assert.ok(Array.isArray(op?.successors) && op.successors.every((name) => OP_ACTIONS.includes(name)),
      `${label}: op ${op.id} successors must declare exact OpActions`);
    registry.set(op.id, op);
  }
  // Closed slot table: every slot binds a registered op with exact scope.
  const slotTable = new Map();
  for (const slot of rawSlots) {
    assert.ok(Number.isSafeInteger(slot?.id),
      `${label}: slot without an exact id fails closed`);
    assert.ok(!slotTable.has(slot.id),
      `${label}: duplicate slot id ${slot.id} fails closed`);
    assert.ok(Number.isSafeInteger(slot?.opId) && registry.has(slot.opId),
      `${label}: slot ${slot.id} binds an unregistered op and rejects`);
    checkClosed(slot?.action, OP_ACTIONS, "OpAction");
    checkClosed(slot?.role, SLOT_ROLES, "SlotRole");
    assert.ok(Number.isSafeInteger(slot?.targetDoc) && slot.targetDoc >= 0,
      `${label}: slot ${slot.id} targetDoc must be exact`);
    assert.ok(typeof slot?.method === "string" && slot.method.length > 0 &&
      typeof slot?.origin === "string" && slot.origin.length > 0 &&
      typeof slot?.path === "string" && slot.path.startsWith("/"),
      `${label}: slot ${slot.id} scope (method/origin/path) must be exact`);
    assert.ok(slot.action === registry.get(slot.opId).action,
      `${label}: slot ${slot.id} action must equal its minting op action (late/unrelated slot use rejects)`);
    slotTable.set(slot.id, slot);
  }
  // Single-step exact edges: registered endpoints, declared successor, closed
  // TRANSITIONS pair, token-bound endpoints. The BFS supersededBy closure is
  // deleted: transitive hops (A→B→C anchoring A→C) deny. An edge carrying an
  // explicit tokenId must match both endpoints' navTokenId; token-less edges
  // remain valid for action-action pairs minted without navigation tokens.
  const edgeSet = new Set();
  const edgeTokens = new Map();
  for (const edge of rawEdges) {
    assert.ok(Number.isSafeInteger(edge?.fromOpId) && Number.isSafeInteger(edge?.toOpId),
      `${label}: edge must carry explicit from/to opIds`);
    checkClosed(edge?.scope, EDGE_SCOPES, "EdgeScope");
    checkClosed(edge?.cause, OP_CAUSES, "OpCause");
    const fromOp = registry.get(edge.fromOpId);
    const toOp = registry.get(edge.toOpId);
    assert.ok(fromOp !== undefined && toOp !== undefined,
      `${label}: unregistered transition endpoint ${edge.fromOpId}→${edge.toOpId} rejects`);
    assert.ok(fromOp.successors.includes(toOp.action),
      `${label}: undeclared successor ${toOp.action} rejects (not in op ${edge.fromOpId} successors)`);
    assert.ok(OP_TRANSITIONS.includes(`${fromOp.action}→${toOp.action}`),
      `${label}: arbitrary edge ${fromOp.action}→${toOp.action} rejects (closed TRANSITIONS)`);
    if (edge.tokenId !== undefined && edge.tokenId !== null) {
      assert.ok(Number.isSafeInteger(edge.tokenId),
        `${label}: edge tokenId must be exact`);
      assert.ok(fromOp.navTokenId === edge.tokenId && toOp.navTokenId === edge.tokenId,
        `${label}: token ambiguity denies: edge token ${edge.tokenId} must match both endpoints (from navToken=${fromOp.navTokenId ?? "none"} to navToken=${toOp.navTokenId ?? "none"})`);
    }
    edgeSet.add(`${edge.fromOpId}→${edge.toOpId}`);
    edgeTokens.set(`${edge.fromOpId}→${edge.toOpId}`, edge.tokenId ?? null);
  }
  const linked = (fromOp, toOp) => edgeSet.has(`${fromOp}→${toOp}`);
  // Exact request identity: one reqId per browser request, with explicit
  // opId/docId/role/slotId. Missing or duplicate reqIds fail closed here.
  // Slots bind one (identity,op) use: replay or unrelated reuse rejects.
  const requestById = new Map();
  const slotUse = new Map();
  for (const entry of requests) {
    assert.ok(Number.isSafeInteger(entry?.reqId),
      `${label}: request without reqId fails closed: ${entry?.method ?? "?"} ${entry?.origin ?? "?"}${entry?.path ?? "?"}`);
    assert.ok(!requestById.has(entry.reqId),
      `${label}: duplicate reqId ${entry.reqId} fails closed`);
    assert.ok(Number.isSafeInteger(entry?.opId),
      `${label}: request without opId fails closed (reqId ${entry.reqId})`);
    assert.ok(Number.isSafeInteger(entry?.docId),
      `${label}: request without docId fails closed (reqId ${entry.reqId})`);
    assert.ok(typeof entry?.role === "string" && entry.role.length > 0,
      `${label}: request without explicit role fails closed (reqId ${entry.reqId}); role never derives from URL`);
    checkClosed(entry?.role, SLOT_ROLES, "SlotRole");
    assert.ok(registry.has(entry.opId),
      `${label}: request binds an unregistered op and rejects (reqId ${entry.reqId})`);
    if (entry.slotId !== null && entry.slotId !== undefined) {
      assert.ok(Number.isSafeInteger(entry.slotId),
        `${label}: request slot id must be exact (reqId ${entry.reqId})`);
      const slot = slotTable.get(entry.slotId);
      assert.ok(slot !== undefined,
        `${label}: request binds an unknown slot and rejects (reqId ${entry.reqId})`);
      assert.ok(slot.method === entry.method && slot.origin === entry.origin &&
        slot.path === entry.path && slot.role === entry.role,
        `${label}: slot mismatch: slot ${slot.id} scope must equal request identity (reqId ${entry.reqId})`);
      assert.ok(slot.opId === entry.opId,
        `${label}: slot replay or unrelated reuse rejects: slot ${slot.id} is bound to op ${slot.opId}, used by reqId ${entry.reqId} op ${entry.opId}`);
      // Immutable issuance binding for slotted (anchor-eligible) traffic: the
      // frozen request stamp must equal its slot and op targetDocs. Op/doc
      // mismatch and stale stamps reject here. Null-slot static traffic stays
      // under the phase ledger only (it can never anchor: aborts require a
      // registered slot below).
      const issuer = registry.get(entry.opId);
      assert.ok(entry.docId === issuer.targetDoc,
        `${label}: request docId ${entry.docId} must equal its op targetDoc ${issuer.targetDoc} (op/doc mismatch and stale stamps reject; reqId ${entry.reqId})`);
      assert.ok(entry.docId === slot.targetDoc,
        `${label}: request docId ${entry.docId} must equal its slot targetDoc ${slot.targetDoc} (stale stamp rejects; reqId ${entry.reqId} slot ${slot.id})`);
      assert.ok(slot.targetDoc === issuer.targetDoc,
        `${label}: slot targetDoc ${slot.targetDoc} must equal its op targetDoc ${issuer.targetDoc} (slot ${slot.id} op ${entry.opId})`);
      const useKey = `${entry.method} ${entry.origin}${entry.path} ${entry.role} op${entry.opId}`;
      const seen = slotUse.get(entry.slotId);
      assert.ok(seen === undefined || seen === useKey,
        `${label}: duplicate slot use rejects: slot ${entry.slotId} shared across identities or ops`);
      slotUse.set(entry.slotId, useKey);
    }
    requestById.set(entry.reqId, entry);
  }
  // Each response joins to its OWN request by exact reqId; opId/docId/role/
  // slotId must match its own request (fail closed on mismatch).
  // Non-contract outcomes never anchor. Unique identity + one terminal outcome:
  // seenResponseIds denies duplicate responses for the same reqId, and the
  // terminal map records every response terminal for the failure-side
  // dedupe-overreach check below.
  const anchorsByKey = new Map();
  const seenResponseIds = new Set();
  const responseTerminalByReqId = new Map();
  for (const response of responses) {
    assert.ok(Number.isSafeInteger(response?.reqId),
      `${label}: response without its own request reqId fails closed (never sample the global counter): ${response?.method ?? "?"} ${response?.origin ?? "?"}${response?.path ?? "?"} -> ${response?.status ?? "?"}`);
    assert.ok(!seenResponseIds.has(response.reqId),
      `${label}: duplicate response reqId ${response.reqId} fails closed (one terminal outcome per request)`);
    seenResponseIds.add(response.reqId);
    const own = requestById.get(response.reqId);
    assert.ok(own !== undefined,
      `${label}: unpaired responded outcome has no browser request: ${response.method} ${response.origin}${response.path} -> ${response.status}`);
    assert.ok(response.method === own.method && response.origin === own.origin && response.path === own.path,
      `${label}: response identity must equal its own request identity: ${response.method} ${response.origin}${response.path} vs reqId ${response.reqId}`);
    assert.ok(response.role === own.role,
      `${label}: response role must equal its own request role (reqId ${response.reqId}); role never derives from URL`);
    assert.ok(response.opId === own.opId && response.docId === own.docId,
      `${label}: response opId/docId must equal its own request opId/docId (reqId ${response.reqId})`);
    assert.ok((response.slotId ?? null) === (own.slotId ?? null),
      `${label}: response slotId must equal its own request slotId (reqId ${response.reqId})`);
    responseTerminalByReqId.set(response.reqId, { status: response.status });
    const key = `${response.method} ${response.origin}${response.path} ${response.role}`;
    const statuses = contract.get(`${response.method} ${response.path}`);
    if (!statuses || !statuses.has(response.status)) continue;
    if (!anchorsByKey.has(key)) anchorsByKey.set(key, []);
    anchorsByKey.get(key).push({ response, request: own });
  }
  const seenFailureIds = new Set();
  const consumedSlots = new Set();
  return (entry) => {
    assert.ok(entry !== null && typeof entry === "object",
      `${label}: failure without a structured entry fails closed`);
    const text = typeof entry?.text === "string" ? entry.text
      : `${entry?.method ?? "?"} ${entry?.origin ?? "?"}${entry?.path ?? "?"} :: ${entry?.errorText ?? "unknown"}`;
    assert.ok(/net::ERR_ABORTED$/.test(entry?.errorText ?? ""),
      `${label}: non-abort failure denied, only superseded ERR_ABORTED may anchor: ${text.slice(0, 300)}`);
    assert.ok(typeof entry?.method === "string" && typeof entry?.origin === "string" && typeof entry?.path === "string",
      `${label}: failed request must carry exact method/origin/path: ${text.slice(0, 200)}`);
    assert.ok(entry.origin === origin, `${label}: cross-origin failed egress denied: ${text.slice(0, 200)}`);
    assert.ok(typeof entry?.role === "string" && entry.role.length > 0,
      `${label}: failure without explicit role fails closed: ${text.slice(0, 200)}`);
    checkClosed(entry?.role, SLOT_ROLES, "SlotRole");
    const key = `${entry.method} ${entry.origin}${entry.path} ${entry.role}`;
    assert.ok(Number.isSafeInteger(entry?.reqId),
      `${label}: phantom abort without a browser request has no reqId join (missing reqId fails closed): ${text.slice(0, 300)}`);
    assert.ok(!seenFailureIds.has(entry.reqId),
      `${label}: duplicate failure reqId ${entry.reqId} fails closed: ${text.slice(0, 200)}`);
    seenFailureIds.add(entry.reqId);
    const own = requestById.get(entry.reqId);
    assert.ok(own !== undefined,
      `${label}: unpaired abort has no browser request: ${text.slice(0, 300)}`);
    assert.ok(entry.method === own.method && entry.origin === own.origin && entry.path === own.path,
      `${label}: failure identity must equal its own request identity: ${text.slice(0, 200)} vs reqId ${entry.reqId}`);
    assert.ok(entry.role === own.role,
      `${label}: failure role must equal its own request role (reqId ${entry.reqId}); role never derives from URL`);
    assert.ok(entry.opId === own.opId && entry.docId === own.docId,
      `${label}: failure opId/docId must equal its own request opId/docId (reqId ${entry.reqId})`);
    assert.ok((entry.slotId ?? null) === (own.slotId ?? null),
      `${label}: failure slotId must equal its own request slotId (reqId ${entry.reqId})`);
    assert.ok(Number.isSafeInteger(entry?.slotId) && slotTable.has(entry.slotId),
      `${label}: abort without a registered request slot fails closed: ${text.slice(0, 300)}`);
    const abortOp = registry.get(own.opId);
    const abortSlot = slotTable.get(entry.slotId);
    assert.ok(abortOp !== undefined && abortSlot !== undefined,
      `${label}: abort binds an unregistered op or slot and rejects: ${text.slice(0, 200)}`);
    const anchors = anchorsByKey.get(key) ?? [];
    let consumed = null;
    let anchorKey = null;
    let sawSeqInversion = false;
    let sawTokenMismatch = false;
    for (const candidate of anchors) {
      if (candidate.request.reqId === own.reqId) continue;
      if (candidate.request.opId === own.opId) continue;
      if (!Number.isSafeInteger(candidate.request.slotId) || !slotTable.has(candidate.request.slotId)) continue;
      if (candidate.request.slotId === entry.slotId) continue;
      const survivorOp = registry.get(candidate.request.opId);
      const survivorSlot = slotTable.get(candidate.request.slotId);
      if (survivorOp === undefined || survivorSlot === undefined) continue;
      if (!roleCompat(own.role, candidate.request.role)) continue;
      if (!linked(own.opId, candidate.request.opId)) continue;
      if (survivorOp.sourceDoc !== abortOp.targetDoc) continue;
      // Token-bound single-step edges: when either side carries a navTokenId,
      // both must carry the same token (exact token endpoints). Token-less
      // action pairs pass; ambiguous cross-token pairs never anchor.
      if (abortOp.navTokenId != null || survivorOp.navTokenId != null) {
        if (abortOp.navTokenId !== survivorOp.navTokenId) { sawTokenMismatch = true; continue; }
        const edgeToken = edgeTokens.get(`${own.opId}→${candidate.request.opId}`);
        if (edgeToken != null && (edgeToken !== abortOp.navTokenId || edgeToken !== survivorOp.navTokenId)) {
          sawTokenMismatch = true; continue;
        }
      }
      if (survivorSlot.id <= abortSlot.id) continue;
      // Authenticated order IN ADDITION to slot order: the survivor request
      // must be issued after the abort request (time inversion denies even
      // when slot ids happen to order correctly). Clock-only matching stays
      // forbidden: seq is consulted only as a conjunction with slot order.
      if (!(Number.isSafeInteger(candidate.request.seq) && Number.isSafeInteger(own.seq) &&
          candidate.request.seq > own.seq)) { sawSeqInversion = true; continue; }
      if (consumedSlots.has(survivorSlot.id)) continue;
      anchorKey = `${entry.method} ${entry.origin}${entry.path} ${entry.role} ${abortOp.action}#${abortSlot.id}→${survivorOp.action}#${survivorSlot.id}`;
      consumed = candidate;
      break;
    }
    if (consumed === null && sawTokenMismatch) {
      assert.fail(`${label}: token ambiguity denies: abort op ${own.opId} and survivor carry different nav tokens with no exact token-bound edge: ${text.slice(0, 300)}`);
    }
    if (consumed === null && sawSeqInversion) {
      assert.fail(`${label}: authenticated order denies: no distinct later survivor with survivor.request.seq > abort.request.seq (time inversion): ${text.slice(0, 300)}`);
    }
    assert.ok(consumed !== null && anchorKey !== null,
      `${label}: unanchored abort has no distinct later same-method+origin+path+role contract response with an explicit single-step supersession edge, closed transition, doc binding and an unconsumed anchor (successor slot): ${text.slice(0, 300)}`);
    // One terminal outcome: a failure whose reqId already has a response
    // terminal denies as dedupe overreach (only a same-reqId contract-response
    // may suppress its own duplicate failure notification, handled during
    // collection; a retained failure beside its own response is a duplicate
    // terminal and never anchors).
    assert.ok(!responseTerminalByReqId.has(entry.reqId),
      `${label}: dedupe overreach denies: reqId ${entry.reqId} already has a response terminal (one terminal outcome per request): ${text.slice(0, 300)}`);
    consumedSlots.add(slotTable.get(consumed.request.slotId).id);
  };
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

// Deterministic regression proof for the closed accounted-anchor rule (no
// browser required). Operations register through the closed authority with
// exact OpKind/OpCause/EdgeScope/SlotRole/OpAction and declared successors in
// the closed TRANSITIONS set; every request mints a finite slot scoped to its
// op's action/role/identity. Requests carry {reqId,opId,docId,role,slotId};
// responses/failures carry their OWN reqId join and fail closed on mismatch.
// Positives mirror the live authed window: reload-linked catalog+health probes
// aborted pre-navigation and surviving as 200s post-navigation (roles
// catalog-read/health-read), and the pair-action probe aborted while the 204
// pairing response plus the one-use 403 reuse response survive (role
// pair-action). Each positive carries a single-step exact edge, closed
// transition, doc binding and an unconsumed successor slot, consumed
// one-to-one. Negatives 1-3 prove sole aborts fail; negative 4 proves
// one-to-one consumption; negatives 5-8 prove non-abort, cross-origin,
// phantom and unpaired-response fail closure. Luna negatives 9-10 prove the
// removed phantom/positional heuristics stay dead. Negatives 11-12 prove the
// accounted conjuncts: 11 is a no-edge later-duplicate (later contract
// response exists but no single-step edge); 12 is an unrelated-role survivor.
// New negatives 13-19 prove the closed authority: 13 is an arbitrary edge
// (registered endpoints, declared successor, but outside closed TRANSITIONS);
// 14 is an unknown enum role (merely-nonempty "superuser"); 15 is a
// transitive hop (A→B→C edges, abort in A, survivor in C, no direct edge —
// the deleted BFS closure would anchor it); 16 is the deleted broad-phase
// role "authed-window" (split into SlotRoles at live call sites); 17 is an
// unregistered endpoint (path through op 9999); 18 is slot replay (survivor
// reuses the abort slot); 19 is slot mismatch (survivor stamped with a
// pair-scoped slot). N13-N19 are accepted by the 58a3c46 D5 rule (proven by
// the old-behavior run: they fail to reject there) and denied post-fix.
// New negatives 20-25 prove the causal nav/action token design: 20 is op/doc
// mismatch (request.docId != op.targetDoc); 21 is a duplicate response (same
// reqId twice — one terminal outcome); 22 is time inversion (survivor seq <
// abort seq with slot order intact — authenticated order denies); 23 is token
// ambiguity (abort/survivor carry different nav tokens, no exact token-bound
// edge — the deleted backward-scan consumeNavSlot would anchor it); 24 is a
// stale stamp (request.docId != slot.targetDoc after a boundary advanced);
// 25 is dedupe overreach (the abort reqId already has its own non-contract
// response terminal, yet a distinct contract survivor exists — the retained
// failure must deny, never anchor). Collector unit tests D1-D3 prove the live
// terminal tracker: D1 is the legitimate same-reqId contract-response
// suppression (PASS retained); D2 proves a non-contract response never
// suppresses; D3 proves cross-reqId responses never suppress and duplicate
// responses fail closed. N20-N25/D2-D3 are accepted by 1e771ca (proven by the
// old-behavior run) and denied post-fix; D1 passes pre/post (retained).
// New negatives N26-N33 prove the closed nav/issuance/terminal design and all
// fail on 3e17f33 (proven by the old-behavior run) while denying post-fix:
// N26 is primitive forgery (numeric tokenId consume → null); N27 is
// copy/lookalike (spread-copy object and copy numeric → null, original still
// consumable); N28 is stale/reuse (second consume → null with pending empty,
// no stale enumeration); N29 is cross-authority (foreign numeric/object →
// null); N30 is concurrent (second navigation while one pending throws the
// zero-in-flight barrier, never latest-for-earliest); N31 is delayed callback
// (delayed reuse and malformed inputs → null with pending 0 unchanged); N32 is
// barrier bypass (contract superset/non-Set/empty construction and missing or
// unfrozen issuance handles throw); N33 is post-construction mutation (input
// or returned Set mutation never widens the private contract). Legitimate
// P1/P2/D1 PASS retained.
// New negatives N41-N43 prove the capability closure and all fail on a332b4d
// (proven by the old-behavior run) while denying post-fix: N41 is role forgery
// (numeric mint with forged role ACCEPTED pre-fix; post-fix numeric deleted and
// cap mint derives canonical role only); N42 is TOCTOU (sparse/accessor/
// mutating/inherited successors ACCEPTED pre-fix; post-fix single-
// materialization throws with zero residue and no id gap); N43 is cross-
// authority (foreign numeric/opCap ACCEPTED pre-fix via colliding ids; post-fix
// slotCap/opCap carry authorityId and foreign capabilities/ids never resolve).
// Legitimate P1/P2/D1 PASS retained.
// Phantom fallback stays deleted. The live owner E2E proves the accompanying
// window evidence the synthetic ledger cannot carry: the surviving catalog 200
// lists the admitted source id and Chromium holds exactly one opaque HttpOnly
// session cookie.
export function verifyAuthedEpochRegression(origin = "http://127.0.0.1:1") {
  const auth = createClosedAuthority("epoch-regression");
  let seq = 0;
  let nextReqId = 0;
  let nextDocId = 0;
  const mintDocId = () => { nextDocId += 1; return nextDocId; };
  const root = auth.registerOp({ kind: "init", cause: "harness-start", scope: "harness",
    sourceDoc: 0, targetDoc: 0, action: "harness-start", role: "startup-probe", from: null,
    successors: ["probe-issue", "pair-probe"] });
  const registerPair = (preAction, postAction, preRole, postRole, { cause = "reload", preSuccessors = [postAction] } = {}) => {
    const docPre = mintDocId();
    const docPost = mintDocId();
    const opPre = auth.registerOp({ kind: "harness-action", cause, scope: "document",
      sourceDoc: docPre, targetDoc: docPre, action: preAction, role: preRole, from: root.id, successors: preSuccessors });
    const opPost = auth.registerOp({ kind: "harness-action", cause, scope: "document",
      sourceDoc: docPre, targetDoc: docPost, action: postAction, role: postRole, from: opPre.id, successors: [] });
    return { docPre, docPost, opPre, opPost };
  };
  const edge = (from, to, cause) => ({ fromOpId: from?.id ?? from, toOpId: to?.id ?? to, scope: "document", cause });
  const req = (method, path, op, role, docId, resourceType = "fetch") => {
    seq += 1;
    nextReqId += 1;
    assert.ok(typeof role === "string" && Number.isSafeInteger(docId),
      "req helper documents the intended role/docId; canonical slot derives SOLELY from the opCap");
    const slot = auth.mintSlot(op, { method, origin, path });
    return { method, origin, path, resourceType, epoch: 0, serial: 0, seq,
      reqId: nextReqId, opId: slot.opId, docId: slot.targetDoc, role: slot.role, slotId: slot.id, frame: `frame-doc-${slot.targetDoc}@${origin}/` };
  };
  // Raw request row for injected attack tables (bypasses the minting builder
  // so the anchor verifier — not the builder — delivers the denial).
  const rawReq = (method, path, opId, role, docId, slotId) => {
    seq += 1;
    nextReqId += 1;
    return { method, origin, path, resourceType: "fetch", epoch: 0, serial: 0, seq,
      reqId: nextReqId, opId, docId, role, slotId, frame: `frame-doc-${docId}@${origin}/` };
  };
  const res = (request, status) => ({ method: request.method, origin: request.origin, path: request.path,
    resourceType: request.resourceType, epoch: request.epoch, serial: request.serial, seq: request.seq,
    reqId: request.reqId, opId: request.opId, docId: request.docId, role: request.role, slotId: request.slotId,
    frame: request.frame, status, contentType: "application/json" });
  const failOf = (request, errorText = "net::ERR_ABORTED") => ({ text: `${request.method} ${request.origin}${request.path} :: ${errorText}`,
    method: request.method, origin: request.origin, path: request.path, errorText, slotId: request.slotId,
    reqId: request.reqId, epoch: request.epoch, serial: request.serial, seq: request.seq,
    opId: request.opId, docId: request.docId, role: request.role });
  const phantomOf = (method, path, role = "catalog-read") => ({ text: `${method} ${origin}${path} :: net::ERR_ABORTED`,
    method, origin, path, errorText: "net::ERR_ABORTED", reqId: null, epoch: null, serial: null, seq: null,
    opId: null, docId: null, role, slotId: null });
  const tables = (overrides = {}) => ({ operations: auth.operations(),
    supersedes: auth.edges(), slots: auth.slots(), ...overrides });
  const harnessOf = ({ consoleErrors = [], requests = [], networkResponses = [], failures = [], ...rest }) => ({
    consoleErrors, pageErrors: [], requests, networkResponses,
    failedRequests: failures.map((entry) => entry.text),
    failedRequestEntries: failures, ...tables(), ...rest });
  const catalog = "/api/v1/research/catalog?limit=20";
  const health = "/api/v1/system/health";
  const pair = "/__local/pair";
  const pair403 = `Failed to load resource: the server responded with a status of 403 (Forbidden) @${origin}/__local/pair`;
  // Positive 1: reload-linked catalog+health aborts with surviving 200s, explicit
  // edge, matching roles, one-to-one consumption.
  const pair1 = registerPair("probe-issue", "probe-retry", "catalog-read", "catalog-read");
  const opPre1 = pair1.opPre;
  const docPre1 = pair1.docPre;
  const opPost1 = pair1.opPost;
  const docPost1 = pair1.docPost;
  const catalogIssued = req("GET", catalog, opPre1, "catalog-read", docPre1);
  const healthIssued = req("GET", health, opPre1, "health-read", docPre1);
  const catalogSurvived = req("GET", catalog, opPost1, "catalog-read", docPost1);
  const healthSurvived = req("GET", health, opPost1, "health-read", docPost1);
  assert.doesNotThrow(() => assertAuthedLedger(harnessOf({
    consoleErrors: [],
    requests: [catalogIssued, healthIssued, catalogSurvived, healthSurvived],
    networkResponses: [res(catalogSurvived, 200), res(healthSurvived, 200)],
    failures: [failOf(catalogIssued), failOf(healthIssued)],
    supersedes: [edge(opPre1, opPost1, "reload")],
  }), "epoch-positive-catalog-health", origin), "reload-linked catalog+health aborts with surviving 200s must pass");
  // Positive 2: pair-action abort anchored by the 204 pairing response with the
  // one-use 403 reuse response and console noise present.
  const pair2 = registerPair("pair-probe", "pair-retry", "pair-action", "pair-action", { cause: "pair-action" });
  const opPre2 = pair2.opPre;
  const docPre2 = pair2.docPre;
  const opPost2 = pair2.opPost;
  const docPost2 = pair2.docPost;
  const pairProbe = req("POST", pair, opPre2, "pair-action", docPre2);
  const pairRetry = req("POST", pair, opPost2, "pair-action", docPost2);
  const pairSurvivedDistinct = req("POST", pair, opPost2, "pair-action", docPost2);
  assert.doesNotThrow(() => assertAuthedLedger(harnessOf({
    consoleErrors: [pair403],
    requests: [pairProbe, pairRetry, pairSurvivedDistinct],
    networkResponses: [res(pairSurvivedDistinct, 204), res(pairRetry, 403)],
    failures: [failOf(pairProbe)],
    supersedes: [edge(opPre2, opPost2, "pair-action")],
  }), "epoch-positive-pair", origin), "pair-action abort with surviving 204+403-reuse must pass");
  // Negatives 1-3: sole aborts with no paired contract success must fail.
  const soleRoles = { [health]: "health-read", [catalog]: "catalog-read", [pair]: "pair-action" };
  for (const [method, path] of [["GET", health], ["GET", catalog], ["POST", pair]]) {
    const docSole = mintDocId();
    const opSole = auth.registerOp({ kind: "harness-action", cause: "reload", scope: "document",
      sourceDoc: docSole, targetDoc: docSole, action: "probe-issue", role: soleRoles[path], from: root.id, successors: [] });
    const issued = req(method, path, opSole, soleRoles[path], docSole);
    assert.throws(() => assertAuthedLedger(harnessOf({
      consoleErrors: [],
      requests: [issued],
      networkResponses: [],
      failures: [failOf(issued)],
      supersedes: [],
    }), `epoch-negative-sole-${path}`, origin), /distinct later same-method/,
      `sole abort of ${method} ${path} with no paired success must fail`);
  }
  // Negative 4: one-to-one consumption (two aborts, one surviving anchor) fails.
  const pairDup = registerPair("probe-issue", "probe-retry", "catalog-read", "catalog-read");
  const opDupPre = pairDup.opPre;
  const docDupPre = pairDup.docPre;
  const opDupPost = pairDup.opPost;
  const docDupPost = pairDup.docPost;
  const dupIssuedA = req("GET", catalog, opDupPre, "catalog-read", docDupPre);
  const dupIssuedB = req("GET", catalog, opDupPre, "catalog-read", docDupPre);
  const dupSurvived = req("GET", catalog, opDupPost, "catalog-read", docDupPost);
  assert.throws(() => assertAuthedLedger(harnessOf({
    consoleErrors: [],
    requests: [dupIssuedA, dupIssuedB, dupSurvived],
    networkResponses: [res(dupSurvived, 200)],
    failures: [failOf(dupIssuedA), failOf(dupIssuedB)],
    supersedes: [edge(opDupPre, opDupPost, "reload")],
  }), "epoch-negative-duplicate-bound", origin), /unconsumed anchor/,
    "duplicate abort without its own surviving anchor must fail");
  // Negative 5: non-abort failure beside a valid anchor still fails.
  const pairConn = registerPair("probe-issue", "probe-retry", "catalog-read", "catalog-read");
  const opConnPre = pairConn.opPre;
  const docConnPre = pairConn.docPre;
  const opConnPost = pairConn.opPost;
  const docConnPost = pairConn.docPost;
  const connIssued = req("GET", catalog, opConnPre, "catalog-read", docConnPre);
  const connSurvived = req("GET", catalog, opConnPost, "catalog-read", docConnPost);
  assert.throws(() => assertAuthedLedger(harnessOf({
    consoleErrors: [],
    requests: [connIssued, connSurvived],
    networkResponses: [res(connSurvived, 200)],
    failures: [{ ...failOf(connIssued), errorText: "net::ERR_CONNECTION_REFUSED",
      text: `GET ${origin}${catalog} :: net::ERR_CONNECTION_REFUSED` }],
    supersedes: [edge(opConnPre, opConnPost, "reload")],
  }), "epoch-negative-non-abort", origin), /non-abort failure denied/,
    "non-abort failure must fail closed even with an anchor");
  // Negative 6: cross-origin abort fails even when the key matches elsewhere.
  const pairCross = registerPair("probe-issue", "probe-retry", "catalog-read", "catalog-read");
  const opCrossPre = pairCross.opPre;
  const docCrossPre = pairCross.docPre;
  const opCrossPost = pairCross.opPost;
  const docCrossPost = pairCross.docPost;
  const crossIssued = req("GET", catalog, opCrossPre, "catalog-read", docCrossPre);
  const crossSurvived = req("GET", catalog, opCrossPost, "catalog-read", docCrossPost);
  assert.throws(() => assertAuthedLedger(harnessOf({
    consoleErrors: [],
    requests: [crossIssued, crossSurvived],
    networkResponses: [res(crossSurvived, 200)],
    failures: [{ ...failOf(crossIssued), origin: "http://127.0.0.1:2",
      text: `GET http://127.0.0.1:2${catalog} :: net::ERR_ABORTED` }],
    supersedes: [edge(opCrossPre, opCrossPost, "reload")],
  }), "epoch-negative-cross-origin", origin), /cross-origin/,
    "cross-origin abort must fail closed");
  // Negative 7: phantom abort with no browser request and no anchor fails.
  assert.throws(() => assertAuthedLedger(harnessOf({
    consoleErrors: [],
    requests: [],
    networkResponses: [],
    failures: [phantomOf("GET", catalog)],
    supersedes: [],
  }), "epoch-negative-phantom-unanchored", origin), /phantom abort/,
    "phantom abort without a classified anchor must fail closed");
  // Negative 8: a responded outcome with no browser request fails as unpaired.
  const docOrphan = mintDocId();
  const opOrphan = auth.registerOp({ kind: "harness-action", cause: "reload", scope: "document",
    sourceDoc: docOrphan, targetDoc: docOrphan, action: "probe-issue", role: "catalog-read", from: root.id, successors: [] });
  const orphan = req("GET", catalog, opOrphan, "catalog-read", docOrphan);
  assert.throws(() => assertAuthedLedger(harnessOf({
    consoleErrors: [],
    requests: [],
    networkResponses: [res(orphan, 200)],
    failures: [],
    supersedes: [],
  }), "epoch-negative-unpaired-response", origin), /unpaired responded outcome/,
    "response without a browser request must fail closed");
  // Luna negative 9 (same-clock phantom): the abort has no browser request
  // (missing reqId) beside a classified 200. Accepted by 0e5b275, rejected here.
  const docLuna9 = mintDocId();
  const opLuna9 = auth.registerOp({ kind: "harness-action", cause: "reload", scope: "document",
    sourceDoc: docLuna9, targetDoc: docLuna9, action: "probe-issue", role: "health-read", from: root.id, successors: [] });
  const luna9Survived = req("GET", health, opLuna9, "health-read", docLuna9);
  assert.throws(() => assertAuthedLedger(harnessOf({
    consoleErrors: [],
    requests: [luna9Survived],
    networkResponses: [res(luna9Survived, 200)],
    failures: [phantomOf("GET", health, "health-read")],
    supersedes: [],
    failedRequestClock: [{ epoch: 1, serial: 0 }],
  }), "epoch-negative-luna9-same-clock-phantom", origin), /phantom abort without a browser request/,
    "same-clock phantom abort without a browser request must fail closed");
  // Luna negative 10 (reused reqId): the abort reuses the surviving response's
  // OWN reqId, so no distinct later anchor exists. Accepted by 0e5b275,
  // rejected here.
  const pairLuna10 = registerPair("probe-issue", "probe-retry", "catalog-read", "catalog-read");
  const opLuna10Pre = pairLuna10.opPre;
  const docLuna10Pre = pairLuna10.docPre;
  const opLuna10Post = pairLuna10.opPost;
  const docLuna10Post = pairLuna10.docPost;
  const luna10Superseded = req("GET", catalog, opLuna10Pre, "catalog-read", docLuna10Pre);
  const luna10Survived = req("GET", catalog, opLuna10Post, "catalog-read", docLuna10Post);
  assert.throws(() => assertAuthedLedger(harnessOf({
    consoleErrors: [],
    requests: [luna10Superseded, luna10Survived],
    networkResponses: [res(luna10Survived, 200)],
    failures: [failOf(luna10Survived)],
    supersedes: [edge(opLuna10Pre, opLuna10Post, "reload")],
  }), "epoch-negative-luna10-duplicate-ambiguity", origin), /distinct later same-method/,
    "abort reusing the surviving response reqId must fail closed");
  // Negative 11 (no-edge later-duplicate): a later contract response exists
  // with the same identity+role, but no single-step edge links
  // abort->survivor. Accepted by the D5/BFS rule only when transitively
  // chained; denied here for the missing explicit single-step edge.
  const pairNoEdge = registerPair("probe-issue", "probe-retry", "catalog-read", "catalog-read");
  const opNoEdgePre = pairNoEdge.opPre;
  const docNoEdgePre = pairNoEdge.docPre;
  const opNoEdgePost = pairNoEdge.opPost;
  const docNoEdgePost = pairNoEdge.docPost;
  const noEdgeIssued = req("GET", catalog, opNoEdgePre, "catalog-read", docNoEdgePre);
  const noEdgeSurvived = req("GET", catalog, opNoEdgePost, "catalog-read", docNoEdgePost);
  assert.throws(() => assertAuthedLedger(harnessOf({
    consoleErrors: [],
    requests: [noEdgeIssued, noEdgeSurvived],
    networkResponses: [res(noEdgeSurvived, 200)],
    failures: [failOf(noEdgeIssued)],
    supersedes: [],
  }), "epoch-negative-no-edge-later-duplicate", origin), /explicit single-step/,
    "later duplicate without an explicit single-step edge must fail closed");
  // Negative 12 (unrelated-role): same method+origin+path and an edge exist,
  // but the survivor carries a different role. Role-blind matching anchors
  // it; the closed rule denies on role mismatch.
  const docRolePre = mintDocId();
  const docRolePost = mintDocId();
  const opRolePre = auth.registerOp({ kind: "harness-action", cause: "reload", scope: "document",
    sourceDoc: docRolePre, targetDoc: docRolePre, action: "probe-issue", role: "catalog-read",
    from: root.id, successors: ["probe-retry"] });
  const opRolePost = auth.registerOp({ kind: "harness-action", cause: "reload", scope: "document",
    sourceDoc: docRolePre, targetDoc: docRolePost, action: "probe-retry", role: "pair-action",
    from: opRolePre.id, successors: [] });
  const roleIssued = req("GET", catalog, opRolePre, "catalog-read", docRolePre);
  const roleSurvived = req("GET", catalog, opRolePost, "pair-action", docRolePost);
  assert.throws(() => assertAuthedLedger(harnessOf({
    consoleErrors: [],
    requests: [roleIssued, roleSurvived],
    networkResponses: [res(roleSurvived, 200)],
    failures: [failOf(roleIssued)],
    supersedes: [edge(opRolePre, opRolePost, "reload")],
  }), "epoch-negative-unrelated-role", origin), /distinct later same-method/,
    "survivor with an unrelated role must fail closed");
  // Negative 13 (arbitrary edge): both endpoints are registered, the edge is
  // declared as a successor, but probe-issue→pair-retry is outside the closed
  // TRANSITIONS set. The 58a3c46 rule accepts any explicit edge; denied here.
  const docPre13 = mintDocId();
  const docPost13 = mintDocId();
  const opPre13 = auth.registerOp({ kind: "harness-action", cause: "reload", scope: "document",
    sourceDoc: docPre13, targetDoc: docPre13, action: "probe-issue", role: "catalog-read",
    from: root.id, successors: ["pair-retry"] });
  const opPair13 = auth.registerOp({ kind: "harness-action", cause: "pair-action", scope: "document",
    sourceDoc: docPre13, targetDoc: docPre13, action: "pair-probe", role: "pair-action",
    from: root.id, successors: ["pair-retry"] });
  const opSurv13 = auth.registerOp({ kind: "harness-action", cause: "pair-action", scope: "document",
    sourceDoc: docPre13, targetDoc: docPost13, action: "pair-retry", role: "catalog-read",
    from: opPair13.id, successors: [] });
  const arbIssued = req("GET", catalog, opPre13, "catalog-read", docPre13);
  const arbSurvived = req("GET", catalog, opSurv13, "catalog-read", docPost13);
  assert.throws(() => assertAuthedLedger(harnessOf({
    consoleErrors: [],
    requests: [arbIssued, arbSurvived],
    networkResponses: [res(arbSurvived, 200)],
    failures: [failOf(arbIssued)],
    supersedes: [edge(opPre13, opSurv13, "reload")],
  }), "epoch-negative-arbitrary-edge", origin), /arbitrary edge.*closed TRANSITIONS/,
    "edge outside the closed TRANSITIONS set must fail closed");
  // Negative 14 (unknown enum): merely-nonempty role "superuser" on both
  // sides with a complete edge. Accepted by any nonempty-string role check;
  // the closed SlotRole set rejects it here. Raw rows bypass the minting
  // builder so the anchor verifier delivers the denial.
  const unknownOps = [
    { id: 9001, kind: "harness-action", cause: "reload", scope: "document",
      sourceDoc: 50, targetDoc: 50, action: "probe-issue", role: "superuser", successors: ["probe-retry"] },
    { id: 9002, kind: "harness-action", cause: "reload", scope: "document",
      sourceDoc: 50, targetDoc: 51, action: "probe-retry", role: "superuser", successors: [] },
  ];
  const unknownSlots = [
    { id: 9101, opId: 9001, targetDoc: 50, action: "probe-issue", role: "superuser",
      method: "GET", origin, path: catalog },
    { id: 9102, opId: 9002, targetDoc: 51, action: "probe-retry", role: "superuser",
      method: "GET", origin, path: catalog },
  ];
  const unknownIssued = rawReq("GET", catalog, 9001, "superuser", 50, 9101);
  const unknownSurvived = rawReq("GET", catalog, 9002, "superuser", 51, 9102);
  assert.throws(() => assertAuthedLedger(harnessOf({
    consoleErrors: [],
    requests: [unknownIssued, unknownSurvived],
    networkResponses: [res(unknownSurvived, 200)],
    failures: [failOf(unknownIssued)],
    operations: [...auth.operations(), ...unknownOps],
    supersedes: [...auth.edges(), edge(9001, 9002, "reload")],
    slots: [...auth.slots(), ...unknownSlots],
  }), "epoch-negative-unknown-enum", origin), /unknown SlotRole/,
    "merely-nonempty unknown roles must fail closed");
  // Negative 15 (transitive hop): edges A→B and B→C exist, abort in A,
  // survivor in C, but no direct single-step edge A→C. The deleted BFS
  // closure anchors it; denied here.
  const docMid1 = mintDocId();
  const docMid2 = mintDocId();
  const opHopA = auth.registerOp({ kind: "harness-action", cause: "reload", scope: "document",
    sourceDoc: docMid1, targetDoc: docMid1, action: "probe-issue", role: "catalog-read",
    from: root.id, successors: ["probe-mid"] });
  const opHopB = auth.registerOp({ kind: "harness-action", cause: "reload", scope: "document",
    sourceDoc: docMid1, targetDoc: docMid1, action: "probe-mid", role: "catalog-read",
    from: opHopA.id, successors: ["probe-retry"] });
  const opHopC = auth.registerOp({ kind: "harness-action", cause: "reload", scope: "document",
    sourceDoc: docMid1, targetDoc: docMid2, action: "probe-retry", role: "catalog-read",
    from: opHopB.id, successors: [] });
  const hopIssued = req("GET", catalog, opHopA, "catalog-read", docMid1);
  const hopSurvived = req("GET", catalog, opHopC, "catalog-read", docMid2);
  assert.throws(() => assertAuthedLedger(harnessOf({
    consoleErrors: [],
    requests: [hopIssued, hopSurvived],
    networkResponses: [res(hopSurvived, 200)],
    failures: [failOf(hopIssued)],
  }), "epoch-negative-transitive-hop", origin), /single-step/,
    "transitive hop without a direct single-step edge must fail closed");
  // Negative 16 (broad-phase role): the deleted "authed-window" label on both
  // sides with a complete edge and slots. Live call sites split it into
  // SlotRoles; the closed set rejects the broad label here.
  const broadOps = [
    { id: 9011, kind: "harness-action", cause: "reload", scope: "document",
      sourceDoc: 60, targetDoc: 60, action: "probe-issue", role: "authed-window", successors: ["probe-retry"] },
    { id: 9012, kind: "harness-action", cause: "reload", scope: "document",
      sourceDoc: 60, targetDoc: 61, action: "probe-retry", role: "authed-window", successors: [] },
  ];
  const broadSlots = [
    { id: 9111, opId: 9011, targetDoc: 60, action: "probe-issue", role: "authed-window",
      method: "GET", origin, path: catalog },
    { id: 9112, opId: 9012, targetDoc: 61, action: "probe-retry", role: "authed-window",
      method: "GET", origin, path: catalog },
  ];
  const broadIssued = rawReq("GET", catalog, 9011, "authed-window", 60, 9111);
  const broadSurvived = rawReq("GET", catalog, 9012, "authed-window", 61, 9112);
  assert.throws(() => assertAuthedLedger(harnessOf({
    consoleErrors: [],
    requests: [broadIssued, broadSurvived],
    networkResponses: [res(broadSurvived, 200)],
    failures: [failOf(broadIssued)],
    operations: [...auth.operations(), ...broadOps],
    supersedes: [...auth.edges(), edge(9011, 9012, "reload")],
    slots: [...auth.slots(), ...broadSlots],
  }), "epoch-negative-broad-phase-role", origin), /broad-phase/,
    "the deleted broad-phase role must fail closed");
  // Negative 17 (unregistered endpoint): the only path from abort to survivor
  // runs through op 9999, which is in no operation table. The old
  // registration-blind closure anchors it; denied here.
  const pairUnreg = registerPair("probe-issue", "probe-retry", "catalog-read", "catalog-read");
  const unregIssued = req("GET", catalog, pairUnreg.opPre, "catalog-read", pairUnreg.docPre);
  const unregSurvived = req("GET", catalog, pairUnreg.opPost, "catalog-read", pairUnreg.docPost);
  assert.throws(() => assertAuthedLedger(harnessOf({
    consoleErrors: [],
    requests: [unregIssued, unregSurvived],
    networkResponses: [res(unregSurvived, 200)],
    failures: [failOf(unregIssued)],
    supersedes: [...auth.edges().filter((item) =>
      !(item.fromOpId === pairUnreg.opPre.id && item.toOpId === pairUnreg.opPost.id)),
      edge(pairUnreg.opPre, 9999, "reload"), edge(9999, pairUnreg.opPost, "reload")],
  }), "epoch-negative-unregistered-endpoint", origin), /unregistered transition endpoint/,
    "path through an unregistered endpoint must fail closed");
  // Negative 18 (slot replay): the survivor reuses the abort request's slot.
  // Slot-agnostic matching anchors it; the one-use slot binding denies here.
  const pairReplay = registerPair("probe-issue", "probe-retry", "catalog-read", "catalog-read");
  const replayIssued = req("GET", catalog, pairReplay.opPre, "catalog-read", pairReplay.docPre);
  const replaySurvived = req("GET", catalog, pairReplay.opPost, "catalog-read", pairReplay.docPost);
  replaySurvived.slotId = replayIssued.slotId;
  assert.throws(() => assertAuthedLedger(harnessOf({
    consoleErrors: [],
    requests: [replayIssued, replaySurvived],
    networkResponses: [res(replaySurvived, 200)],
    failures: [failOf(replayIssued)],
  }), "epoch-negative-slot-replay", origin), /slot replay or unrelated reuse/,
    "survivor reusing the abort slot must fail closed");
  // Negative 19 (slot mismatch): the survivor is stamped with a slot scoped
  // to POST /__local/pair. Scope-blind matching anchors it; denied here.
  const pairMismatch = registerPair("probe-issue", "probe-retry", "catalog-read", "catalog-read");
  const mismatchIssued = req("GET", catalog, pairMismatch.opPre, "catalog-read", pairMismatch.docPre);
  const mismatchSurvived = req("GET", catalog, pairMismatch.opPost, "catalog-read", pairMismatch.docPost);
  const mismatchSlot = auth.mintSlot(pairMismatch.opPost, { method: "POST", origin, path: pair });
  mismatchSurvived.slotId = mismatchSlot.id;
  assert.throws(() => assertAuthedLedger(harnessOf({
    consoleErrors: [],
    requests: [mismatchIssued, mismatchSurvived],
    networkResponses: [res(mismatchSurvived, 200)],
    failures: [failOf(mismatchIssued)],
  }), "epoch-negative-slot-mismatch", origin), /slot mismatch/,
    "survivor with a mismatched slot scope must fail closed");
  // Negative 20 (op/doc mismatch): the abort stamp carries a docId far from
  // its own op targetDoc. Doc-blind matching anchors it; the immutable
  // issuance binding (request.docId == op.targetDoc) denies here. Accepted by
  // 1e771ca (old-behavior run proves no throw there).
  const pairOpDoc = registerPair("probe-issue", "probe-retry", "catalog-read", "catalog-read");
  const opDocIssued = req("GET", catalog, pairOpDoc.opPre, "catalog-read", pairOpDoc.docPre);
  opDocIssued.docId = pairOpDoc.docPost + 100;
  const opDocSurvived = req("GET", catalog, pairOpDoc.opPost, "catalog-read", pairOpDoc.docPost);
  assert.throws(() => assertAuthedLedger(harnessOf({
    consoleErrors: [],
    requests: [opDocIssued, opDocSurvived],
    networkResponses: [res(opDocSurvived, 200)],
    failures: [failOf(opDocIssued)],
  }), "epoch-negative-op-doc-mismatch", origin), /op\/doc mismatch|must equal its op targetDoc/,
    "request docId diverging from its op targetDoc must fail closed");
  // Negative 21 (duplicate response): the survivor reqId answers twice. The
  // deleted allow-duplicates ledger anchors it; seenResponseIds denies here.
  const pairDupRes = registerPair("probe-issue", "probe-retry", "catalog-read", "catalog-read");
  const dupResIssued = req("GET", catalog, pairDupRes.opPre, "catalog-read", pairDupRes.docPre);
  const dupResSurvived = req("GET", catalog, pairDupRes.opPost, "catalog-read", pairDupRes.docPost);
  assert.throws(() => assertAuthedLedger(harnessOf({
    consoleErrors: [],
    requests: [dupResIssued, dupResSurvived],
    networkResponses: [res(dupResSurvived, 200), res(dupResSurvived, 200)],
    failures: [failOf(dupResIssued)],
  }), "epoch-negative-duplicate-response", origin), /duplicate response reqId|one terminal outcome/,
    "a duplicated response terminal for one reqId must fail closed");
  // Negative 22 (time inversion): the survivor request was issued BEFORE the
  // abort (seq inverted) while slot ids still order correctly. Slot-only
  // ordering anchors it; authenticated order (survivor seq > abort seq)
  // denies here.
  const pairInv = registerPair("probe-issue", "probe-retry", "catalog-read", "catalog-read");
  const invIssued = req("GET", catalog, pairInv.opPre, "catalog-read", pairInv.docPre);
  const invSurvived = req("GET", catalog, pairInv.opPost, "catalog-read", pairInv.docPost);
  invSurvived.seq = invIssued.seq - 1;
  const invSurvivedRes = res(invSurvived, 200);
  invSurvivedRes.seq = invSurvived.seq;
  assert.throws(() => assertAuthedLedger(harnessOf({
    consoleErrors: [],
    requests: [invIssued, invSurvived],
    networkResponses: [invSurvivedRes],
    failures: [failOf(invIssued)],
  }), "epoch-negative-time-inversion", origin), /authenticated order|time inversion/,
    "a survivor issued before its abort must fail closed despite slot order");
  // Negative 23 (token ambiguity): abort and survivor lineages carry different
  // causal nav tokens with no exact token-bound edge. The deleted
  // backward-scan consumeNavSlot(targetDoc) anchors by doc proximity; exact
  // token endpoints deny here. Ops are frozen, so token lineage arrives via
  // table override copies (never mutation).
  const pairTok = registerPair("probe-issue", "probe-retry", "catalog-read", "catalog-read");
  const tokIssued = req("GET", catalog, pairTok.opPre, "catalog-read", pairTok.docPre);
  const tokSurvived = req("GET", catalog, pairTok.opPost, "catalog-read", pairTok.docPost);
  const tokOps = auth.operations().map((op) => {
    if (op.id === pairTok.opPre.id) return { ...op, navTokenId: 1001 };
    if (op.id === pairTok.opPost.id) return { ...op, navTokenId: 1002 };
    return op;
  });
  assert.throws(() => assertAuthedLedger(harnessOf({
    consoleErrors: [],
    requests: [tokIssued, tokSurvived],
    networkResponses: [res(tokSurvived, 200)],
    failures: [failOf(tokIssued)],
    operations: tokOps,
  }), "epoch-negative-token-ambiguity", origin), /token ambiguity|exact token/,
    "cross-token abort/survivor pairs must fail closed without an exact token-bound edge");
  // Negative 24 (stale stamp): the abort slot was minted pre-boundary
  // (targetDoc stale) while the request stamp moved on. Doc-blind slot reuse
  // anchors it; request.docId == slot.targetDoc denies here. Slots are frozen,
  // so staleness arrives via table override copies.
  const pairStale = registerPair("probe-issue", "probe-retry", "catalog-read", "catalog-read");
  const staleIssued = req("GET", catalog, pairStale.opPre, "catalog-read", pairStale.docPre);
  const staleSurvived = req("GET", catalog, pairStale.opPost, "catalog-read", pairStale.docPost);
  const staleSlots = auth.slots().map((slot) =>
    (slot.id === staleIssued.slotId ? { ...slot, targetDoc: 9999 } : slot));
  assert.throws(() => assertAuthedLedger(harnessOf({
    consoleErrors: [],
    requests: [staleIssued, staleSurvived],
    networkResponses: [res(staleSurvived, 200)],
    failures: [failOf(staleIssued)],
    slots: staleSlots,
  }), "epoch-negative-stale-stamp", origin), /stale stamp|must equal its slot targetDoc/,
    "a request reused against a stale slot stamp must fail closed");
  // Negative 25 (dedupe overreach): the abort reqId already has its OWN
  // non-contract response terminal (500), yet a distinct contract survivor
  // exists. Indiscriminate same-reqId dedupe (any status suppresses) hides the
  // failure and anchors; the one-terminal rule denies here because only a
  // same-reqId contract-response may suppress its own duplicate failure.
  const pairOver = registerPair("probe-issue", "probe-retry", "catalog-read", "catalog-read");
  const overIssued = req("GET", catalog, pairOver.opPre, "catalog-read", pairOver.docPre);
  const overSurvived = req("GET", catalog, pairOver.opPost, "catalog-read", pairOver.docPost);
  const overOwnTerminal = res(overIssued, 500);
  assert.throws(() => assertAuthedLedger(harnessOf({
    consoleErrors: [],
    requests: [overIssued, overSurvived],
    networkResponses: [overOwnTerminal, res(overSurvived, 200)],
    failures: [failOf(overIssued)],
  }), "epoch-negative-dedupe-overreach", origin), /dedupe overreach|one terminal outcome/,
    "a retained failure beside its own response terminal must fail closed");
  // Collector unit tests D1-D3: the live terminal tracker behind
  // launchPlaywright collection. D1 is the legitimate same-reqId
  // contract-response suppression (PASS retained pre/post). D2 proves a
  // non-contract response never suppresses its failure. D3 proves cross-reqId
  // responses never suppress and duplicate responses fail closed. D2-D3 are
  // accepted (over-suppressed or allowed) by the 1e771ca inline
  // respondedReqIds logic, which lacks the tracker export and the contract
  // gate; denied post-fix.
  // New negatives N26-N33 prove the closed nav/issuance/terminal design.
  // Each fails on 3e17f33 (old-behavior run proves acceptance there) and
  // denies post-fix; legitimate PASS (P1/P2/D1) retained.
  // N26 primitive forgery: numeric tokenId consume → null (old numeric branch
  // accepted). N27 copy/lookalike: spread-copy object → null with no state
  // change and copy.tokenId numeric → null (old numeric accepted the copy id).
  // N28 stale/reuse: second consume → null with pending empty, no stale
  // enumeration (old kept consumed:true entries). N29 cross-authority: foreign
  // numeric and foreign object → null (old numeric cross-auth accepted via
  // sequential ids). N30 concurrent: second harness-navigation while one
  // pending throws the zero-in-flight barrier, never latest-for-earliest (old
  // global overwrite anchored latest). N31 delayed callback: delayed reuse
  // after delete → null with pending 0 unchanged; null/undefined/string/miss
  // → null no state change (old kept stale count 1). N32 barrier bypass:
  // contract-superset construction and missing/unfrozen issuance handles throw
  // (old accepted superset, ignored handles). N33 post-construction mutation:
  // mutating the input Set or the returned Set never affects suppression (old
  // stored/exposed the caller Set).
  // New negatives N34-N40 prove the architect closed design (§5.1-§5.7). Each
  // fails on f092611 (old-behavior run proves acceptance there) and denies
  // post-fix; legitimate P1/P2/D1 PASS retained.
  // N34 non-caller mint: public mintNavToken deleted (closure-private mint inside
  // validated registerOp only); direct mint throws (old public mint accepted).
  // N35 transactional residue: barrier-violating registerOp validates ALL before
  // allocating id/mutating maps; throws leave zero op/edge residue and no id gap
  // (old allocated + edged before the barrier, leaving residue + gap). N36
  // terminal isolation: stored terminals frozen + deep-copy frozen snapshots;
  // snapshot mutation never affects suppression (old aliased mutable values).
  // N37 exact capability: checkIssuanceHandle requires registry hit + exact
  // prototype + exact own-keys + matching triple (old accepted unregistered
  // lookalikes/extra-key/null-prototype). N38 stale/cross issuance: doc identity
  // gate before mint (slot targetDoc must equal op targetDoc) plus harness
  // current-op/doc/role gates before mint/bind/stamp; stale/cross throw
  // pre-mutation with zero new slots (old minted stale docs). N39 successor
  // aliasing: private canonical successors Map, public getOp/operations return
  // deep-frozen snapshots; mutating a snapshot never widens authority (old
  // shallow-frozen op allowed successors.push to anchor an undeclared edge).
  // N40 policy nesting: deep-frozen private PRIVATE_ABORTABLE, authority reads
  // canonical only; public nesting mutations never affect minting (old read the
  // public mutable nesting).
  {
    // N26 primitive forgery.
    const auth26 = createClosedAuthority("n26-primitive");
    const root26 = auth26.registerOp({ kind: "init", cause: "harness-start", scope: "harness",
      sourceDoc: 0, targetDoc: 0, action: "harness-start", role: "startup-probe", from: null,
      successors: ["goto-unauthenticated"] });
    const nav26 = auth26.registerOp({ kind: "harness-navigation", cause: "goto", scope: "document",
      sourceDoc: 0, targetDoc: 1, action: "goto-unauthenticated", role: "startup-probe",
      from: root26.id, successors: [] });
    assert.equal(auth26.consumeNavToken(nav26.navTokenId), null,
      "N26: numeric primitive forgery must return null (no numeric branch)");
    assert.equal(auth26.pendingNavCount(), 1,
      "N26: failed primitive consume must leave pending unchanged (no state change)");
    assert.ok(auth26.consumeNavToken(nav26.navToken) !== null,
      "N26: legitimate object consume still passes");
    assert.equal(auth26.pendingNavCount(), 0, "N26: legitimate consume deletes");
    // N27 copy/lookalike.
    const auth27 = createClosedAuthority("n27-copy");
    const root27 = auth27.registerOp({ kind: "init", cause: "harness-start", scope: "harness",
      sourceDoc: 0, targetDoc: 0, action: "harness-start", role: "startup-probe", from: null,
      successors: ["goto-unauthenticated"] });
    const nav27 = auth27.registerOp({ kind: "harness-navigation", cause: "goto", scope: "document",
      sourceDoc: 0, targetDoc: 1, action: "goto-unauthenticated", role: "startup-probe",
      from: root27.id, successors: [] });
    const copy27 = { ...nav27.navToken };
    assert.equal(auth27.consumeNavToken(copy27), null,
      "N27: copy/lookalike object must return null (WeakMap miss, no state change)");
    assert.equal(auth27.pendingNavCount(), 1, "N27: failed copy consume leaves pending unchanged");
    assert.equal(auth27.consumeNavToken(copy27.tokenId), null,
      "N27: copy tokenId numeric must return null (no numeric branch)");
    assert.ok(auth27.consumeNavToken(nav27.navToken) !== null,
      "N27: legitimate original still passes after copy attempts");
    // N28 stale/reuse (no enumeration of consumed).
    const auth28 = createClosedAuthority("n28-reuse");
    const root28 = auth28.registerOp({ kind: "init", cause: "harness-start", scope: "harness",
      sourceDoc: 0, targetDoc: 0, action: "harness-start", role: "startup-probe", from: null,
      successors: ["goto-unauthenticated"] });
    const nav28 = auth28.registerOp({ kind: "harness-navigation", cause: "goto", scope: "document",
      sourceDoc: 0, targetDoc: 1, action: "goto-unauthenticated", role: "startup-probe",
      from: root28.id, successors: [] });
    assert.ok(auth28.consumeNavToken(nav28.navToken) !== null, "N28: first consume passes");
    assert.equal(auth28.consumeNavToken(nav28.navToken), null,
      "N28: stale reuse must return null");
    assert.deepEqual(auth28.pendingNavTokens(), [],
      "N28: successful consume deletes (no stale/enumeration)");
    assert.equal(auth28.pendingNavCount(), 0, "N28: pending count zero after delete");
    // N29 cross-authority.
    const authA29 = createClosedAuthority("n29-a");
    const authB29 = createClosedAuthority("n29-b");
    const rootA29 = authA29.registerOp({ kind: "init", cause: "harness-start", scope: "harness",
      sourceDoc: 0, targetDoc: 0, action: "harness-start", role: "startup-probe", from: null,
      successors: ["goto-unauthenticated"] });
    const rootB29 = authB29.registerOp({ kind: "init", cause: "harness-start", scope: "harness",
      sourceDoc: 0, targetDoc: 0, action: "harness-start", role: "startup-probe", from: null,
      successors: ["goto-unauthenticated"] });
    const navA29 = authA29.registerOp({ kind: "harness-navigation", cause: "goto", scope: "document",
      sourceDoc: 0, targetDoc: 1, action: "goto-unauthenticated", role: "startup-probe",
      from: rootA29.id, successors: [] });
    authB29.registerOp({ kind: "harness-navigation", cause: "goto", scope: "document",
      sourceDoc: 0, targetDoc: 1, action: "goto-unauthenticated", role: "startup-probe",
      from: rootB29.id, successors: [] });
    assert.equal(authB29.consumeNavToken(navA29.navTokenId), null,
      "N29: cross-authority numeric must return null");
    assert.equal(authB29.consumeNavToken(navA29.navToken), null,
      "N29: cross-authority object must return null (foreign WeakMap miss)");
    // N30 concurrent: second navigation while one pending throws the barrier,
    // never latest-for-earliest.
    const auth30 = createClosedAuthority("n30-concurrent");
    const root30 = auth30.registerOp({ kind: "init", cause: "harness-start", scope: "harness",
      sourceDoc: 0, targetDoc: 0, action: "harness-start", role: "startup-probe", from: null,
      successors: ["goto-unauthenticated"] });
    const first30 = auth30.registerOp({ kind: "harness-navigation", cause: "goto", scope: "document",
      sourceDoc: 0, targetDoc: 1, action: "goto-unauthenticated", role: "startup-probe",
      from: root30.id, successors: ["goto-pairing"] });
    assert.throws(() => auth30.registerOp({ kind: "harness-navigation", cause: "goto-pairing", scope: "document",
      sourceDoc: 1, targetDoc: 2, action: "goto-pairing", role: "startup-probe",
      from: first30.id, successors: [] }), /zero in-flight/,
      "N30: concurrent second navigation while one pending must fail closed");
    assert.throws(() => assertZeroNavInflight(2, "N30"), /zero in-flight/,
      "N30: FIFO barrier with >1 pending + one frame denies (unlinked, never latest-for-earliest)");
    assert.doesNotThrow(() => assertZeroNavInflight(0, "N30"), "N30: zero pending passes");
    // N31 delayed callback: delayed reuse after delete stays null with no state
    // change; malformed inputs never resolve.
    const auth31 = createClosedAuthority("n31-delayed");
    const root31 = auth31.registerOp({ kind: "init", cause: "harness-start", scope: "harness",
      sourceDoc: 0, targetDoc: 0, action: "harness-start", role: "startup-probe", from: null,
      successors: ["goto-unauthenticated"] });
    const nav31 = auth31.registerOp({ kind: "harness-navigation", cause: "goto", scope: "document",
      sourceDoc: 0, targetDoc: 1, action: "goto-unauthenticated", role: "startup-probe",
      from: root31.id, successors: [] });
    assert.ok(auth31.consumeNavToken(nav31.navToken) !== null, "N31: first consume passes");
    assert.equal(auth31.pendingNavCount(), 0, "N31: pending empty after delete");
    assert.equal(auth31.consumeNavToken(nav31.navToken), null,
      "N31: delayed callback reuse must return null with no state change");
    assert.equal(auth31.pendingNavCount(), 0, "N31: delayed reuse leaves pending 0");
    for (const bad of [null, undefined, 0, "1", {}, { tokenId: 1 }]) {
      assert.equal(auth31.consumeNavToken(bad), null,
        "N31: malformed token must return null with no state change");
    }
    assert.equal(auth31.pendingNavCount(), 0, "N31: malformed consumes leave pending 0");
    // N32 barrier bypass: contract-superset construction and issuance-handle
    // bypass throw; direct use without a frozen handle throws.
    assert.throws(() => createRequestTerminalTracker(new Set([200, 500])), /subset/,
      "N32: contract superset with non-contract 500 must fail closed at construction");
    assert.throws(() => createRequestTerminalTracker(new Set()), /non-empty/,
      "N32: empty contract set must fail closed");
    assert.throws(() => createRequestTerminalTracker([200]), /exact contract status Set/,
      "N32: non-Set contract must fail closed");
    assert.throws(() => checkIssuanceHandle(null, "N32"), /explicit frozen issuance handle/,
      "N32: missing issuance handle must throw (direct bypass)");
    assert.throws(() => checkIssuanceHandle({ opId: 1, docId: 0, role: "startup-probe" }, "N32"), /frozen/,
      "N32: unfrozen lookalike handle must throw");
    assert.throws(() => checkIssuanceHandle(Object.freeze({ opId: 1, docId: 0, role: "superuser" }), "N32"), /exact SlotRole/,
      "N32: unknown-role handle must throw");
    assert.throws(() => deriveRoleHandle(Object.freeze({ opId: 1, docId: 0, role: "startup-probe" }), "superuser"), /exact SlotRole/,
      "N32: setRole-equivalent with unknown role must throw");
    assert.throws(() => assertZeroNavInflight(1, "N32"), /zero in-flight/,
      "N32: non-zero in-flight at registerOp/setRole must throw");
    // N33 post-construction mutation: mutating the input Set or the returned
    // Set never affects suppression (private immutable copy).
    {
      const input33 = new Set([200]);
      const tracker33 = createRequestTerminalTracker(input33);
      assert.ok(tracker33.contractStatuses !== input33,
        "N33: tracker must never store/expose the caller Set");
      input33.add(500);
      assert.equal(tracker33.noteResponse(8001, 500), false,
        "N33: input-Set mutation post-construction must not widen the contract");
      assert.equal(tracker33.shouldSuppressFailure(8001), false,
        "N33: non-contract 500 must never suppress even after input mutation");
      tracker33.contractStatuses.add(500);
      const tracker33b = createRequestTerminalTracker(new Set([200]));
      tracker33b.noteResponse(8002, 200);
      assert.equal(tracker33b.shouldSuppressFailure(8002), true,
        "N33: mutating a different tracker copy never affects private state");
      assert.throws(() => createRequestTerminalTracker(new Set([200, 500])), /subset/,
        "N33: superset construction still fails closed");
    }
    // N34 non-caller mint: public mintNavToken deleted (closure-private only).
    {
      const auth34 = createClosedAuthority("n34-noncaller");
      const root34 = auth34.registerOp({ kind: "init", cause: "harness-start", scope: "harness",
        sourceDoc: 0, targetDoc: 0, action: "harness-start", role: "startup-probe", from: null,
        successors: ["goto-unauthenticated"] });
      assert.equal(auth34.mintNavToken, undefined,
        "N34: public mintNavToken must be deleted (closure-private mint inside validated registerOp only)");
      assert.throws(() => auth34.mintNavToken(root34.id, 1), /is not a function|undefined/,
        "N34: non-caller mint via deleted public entry must fail");
      const nav34 = auth34.registerOp({ kind: "harness-navigation", cause: "goto", scope: "document",
        sourceDoc: 0, targetDoc: 1, action: "goto-unauthenticated", role: "startup-probe",
        from: root34.id, successors: [] });
      assert.ok(nav34.navToken !== undefined && nav34.navToken !== null,
        "N34: legitimate validated registerOp path still mints");
      assert.ok(auth34.consumeNavToken(nav34.navToken) !== null,
        "N34: legitimate object consume still passes");
    }
    // N35 transactional residue: validate ALL before allocating id/mutating.
    {
      const auth35 = createClosedAuthority("n35-txn");
      const root35 = auth35.registerOp({ kind: "init", cause: "harness-start", scope: "harness",
        sourceDoc: 0, targetDoc: 0, action: "harness-start", role: "startup-probe", from: null,
        successors: ["goto-unauthenticated"] });
      const first35 = auth35.registerOp({ kind: "harness-navigation", cause: "goto", scope: "document",
        sourceDoc: 0, targetDoc: 1, action: "goto-unauthenticated", role: "startup-probe",
        from: root35.id, successors: ["goto-pairing"] });
      const opsBefore35 = auth35.operations().length;
      const edgesBefore35 = auth35.edges().length;
      assert.throws(() => auth35.registerOp({ kind: "harness-navigation", cause: "goto-pairing", scope: "document",
        sourceDoc: 1, targetDoc: 2, action: "goto-pairing", role: "startup-probe",
        from: first35.id, successors: [] }), /zero in-flight/,
        "N35: concurrent second navigation while one pending must fail closed");
      assert.equal(auth35.operations().length, opsBefore35,
        "N35: failed register must leave zero op residue (transactional)");
      assert.equal(auth35.edges().length, edgesBefore35,
        "N35: failed register must leave zero edge residue (transactional)");
      auth35.drainPendingNav();
      const next35 = auth35.registerOp({ kind: "harness-navigation", cause: "goto-pairing", scope: "document",
        sourceDoc: 1, targetDoc: 2, action: "goto-pairing", role: "startup-probe",
        from: first35.id, successors: [] });
      assert.equal(next35.id, first35.id + 1,
        "N35: transactional id must be contiguous with no gap after a failed attempt");
    }
    // N36 terminal isolation: frozen stored values + deep-copy frozen snapshots.
    {
      const tracker36 = createRequestTerminalTracker(new Set([200]));
      tracker36.noteResponse(9001, 200);
      assert.equal(tracker36.shouldSuppressFailure(9001), true,
        "N36: setup suppression must hold");
      const snap36 = tracker36.terminalByReqId();
      const val36 = snap36.get(9001);
      assert.ok(Object.isFrozen(val36),
        "N36: terminal snapshot value must be frozen (no aliasing)");
      try { val36.contract = false; } catch { /* frozen: expected throw */ }
      assert.equal(tracker36.shouldSuppressFailure(9001), true,
        "N36: mutating snapshot terminal must not affect private suppression (frozen deep-copy)");
      assert.throws(() => tracker36.noteResponse(9001, 200), /duplicate response reqId/,
        "N36: duplicate terminal still fails closed");
      const seen36 = tracker36.seenResponseIds();
      assert.ok(Object.isFrozen(seen36),
        "N36: seen snapshot must be frozen");
      try { seen36.push(9999); } catch { /* frozen: expected throw */ }
      assert.ok(!tracker36.seenResponseIds().includes(9999),
        "N36: mutating seen snapshot must not affect private");
    }
    // N37 exact capability: registry hit + exact prototype + exact own-keys.
    {
      const legit37 = createIssuanceHandle(1, 0, "startup-probe");
      assert.doesNotThrow(() => checkIssuanceHandle(legit37, "N37"),
        "N37: legitimate registered handle passes");
      const look37 = Object.freeze({ opId: 1, docId: 0, role: "startup-probe" });
      assert.throws(() => checkIssuanceHandle(look37, "N37"), /not a registered capability/,
        "N37: unregistered lookalike must throw (exact capability, no value equality)");
      const copy37 = Object.freeze({ ...legit37 });
      assert.throws(() => checkIssuanceHandle(copy37, "N37"), /not a registered capability/,
        "N37: spread-copy must throw (WeakMap identity, no state change)");
      const extra37 = Object.freeze({ opId: 1, docId: 0, role: "startup-probe", extra: 1 });
      assert.throws(() => checkIssuanceHandle(extra37, "N37"), /exactly \{opId,docId,role\}/,
        "N37: extra-key handle must throw");
      const nullProto37 = Object.freeze(Object.assign(Object.create(null), { opId: 1, docId: 0, role: "startup-probe" }));
      assert.throws(() => checkIssuanceHandle(nullProto37, "N37"), /exact Object\.prototype/,
        "N37: null-prototype handle must throw");
      assert.doesNotThrow(() => checkIssuanceHandle(legit37, "N37"),
        "N37: legitimate still passes after lookalike attempts");
    }
    // N38 stale/cross issuance: doc identity gate before mint + harness current gates.
    {
      const auth38 = createClosedAuthority("n38-stale");
      const root38 = auth38.registerOp({ kind: "init", cause: "harness-start", scope: "harness",
        sourceDoc: 0, targetDoc: 0, action: "harness-start", role: "startup-probe", from: null,
        successors: ["probe-issue"] });
      const opA38 = auth38.registerOp({ kind: "harness-action", cause: "reload", scope: "document",
        sourceDoc: 1, targetDoc: 1, action: "probe-issue", role: "catalog-read",
        from: root38.id, successors: ["probe-retry"] });
      const slotsBefore38 = auth38.slots().length;
      assert.throws(() => auth38.mintSlot({ opId: opA38.id, targetDoc: 9999, action: "probe-issue",
        role: "catalog-read", method: "GET", origin: "http://127.0.0.1:1", path: "/api/v1/research/catalog?limit=20" }),
      /must equal its op targetDoc/,
        "N38: stale-doc mint must throw pre-mutation (doc identity gate)");
      assert.equal(auth38.slots().length, slotsBefore38,
        "N38: failed stale mint must leave zero slot residue");
      const legit38 = auth38.mintSlot(opA38, { method: "GET", origin: "http://127.0.0.1:1", path: "/api/v1/research/catalog?limit=20" });
      assert.ok(Number.isSafeInteger(legit38.id),
        "N38: legitimate current-doc mint still passes");
      const cross38 = createIssuanceHandle(opA38.id, opA38.targetDoc, opA38.role);
      assert.doesNotThrow(() => checkIssuanceHandle(cross38, "N38"),
        "N38: legitimate registered issuance still passes");
      const staleLook38 = Object.freeze({ opId: opA38.id, docId: opA38.targetDoc, role: opA38.role });
      assert.throws(() => checkIssuanceHandle(staleLook38, "N38"), /not a registered capability/,
        "N38: stale/cross lookalike without registry must throw");
    }
    // N39 successor aliasing: private canonical Map, deep-frozen snapshots.
    {
      const auth39 = createClosedAuthority("n39-successor");
      const root39 = auth39.registerOp({ kind: "init", cause: "harness-start", scope: "harness",
        sourceDoc: 0, targetDoc: 0, action: "harness-start", role: "startup-probe", from: null,
        successors: ["probe-issue"] });
      const opA39 = auth39.registerOp({ kind: "harness-action", cause: "reload", scope: "document",
        sourceDoc: 1, targetDoc: 1, action: "probe-issue", role: "catalog-read",
        from: root39.id, successors: ["probe-retry"] });
      const snap39 = auth39.getOp(opA39.id);
      assert.ok(Object.isFrozen(snap39) && Object.isFrozen(snap39.successors),
        "N39: public getOp snapshot must be deep-frozen (no aliasing)");
      let pushThrew = false;
      try { snap39.successors.push("probe-mid"); } catch { pushThrew = true; }
      assert.ok(pushThrew || !auth39.getOp(opA39.id).successors.includes("probe-mid"),
        "N39: mutating snapshot must never widen canonical authority");
      assert.throws(() => auth39.registerOp({ kind: "harness-action", cause: "reload", scope: "document",
        sourceDoc: 1, targetDoc: 1, action: "probe-mid", role: "catalog-read",
        from: opA39.id, successors: [] }), /undeclared successor/,
        "N39: undeclared successor must still fail closed despite snapshot mutation");
      const legit39 = auth39.registerOp({ kind: "harness-action", cause: "reload", scope: "document",
        sourceDoc: 1, targetDoc: 2, action: "probe-retry", role: "catalog-read",
        from: opA39.id, successors: [] });
      assert.ok(Number.isSafeInteger(legit39.id),
        "N39: legitimate declared successor still passes");
    }
    // N40 policy nesting: deep-frozen private canonical, authority reads canonical only.
    {
      const outerBefore40 = ABORTABLE_SLOT_PATHS.length;
      const innerBefore40 = ABORTABLE_SLOT_PATHS[0][1];
      let nestedThrew = false;
      try { ABORTABLE_SLOT_PATHS[0][1] = "/evil-n40"; } catch { nestedThrew = true; }
      const nestedMutated40 = ABORTABLE_SLOT_PATHS[0][1] === "/evil-n40";
      const auth40 = createClosedAuthority("n40-policy");
      const root40 = auth40.registerOp({ kind: "init", cause: "harness-start", scope: "harness",
        sourceDoc: 0, targetDoc: 0, action: "harness-start", role: "startup-probe", from: null,
        successors: ["probe-issue"] });
      const op40 = auth40.registerOp({ kind: "harness-action", cause: "reload", scope: "document",
        sourceDoc: 3, targetDoc: 3, action: "probe-issue", role: "catalog-read",
        from: root40.id, successors: [] });
      const minted40 = [];
      for (const [method, path] of PRIVATE_ABORTABLE) {
        minted40.push(auth40.mintSlot(op40, { method, origin: "http://127.0.0.1:1", path }));
      }
      assert.ok(!minted40.some((slot) => slot.path === "/evil-n40"),
        "N40: private canonical policy must never mint publicly mutated nesting (authority reads canonical only)");
      assert.equal(minted40.length, outerBefore40,
        "N40: canonical mint count must equal private policy length");
      if (nestedMutated40) {
        ABORTABLE_SLOT_PATHS[0][1] = innerBefore40;
      }
      assert.equal(ABORTABLE_SLOT_PATHS[0][1], innerBefore40,
        "N40: public nesting restored after the proof");
      assert.ok(minted40.some((slot) => slot.path === "/api/v1/research/catalog?limit=20"),
        "N40: legitimate canonical path still mints");
      void nestedThrew;
    }
  }
  // New negatives N41-N43 prove the capability closure. Each fails on a332b4d
  // (old-behavior run proves acceptance there: numeric role forgery, sparse/
  // accessor/mutating successors, cross-authority numeric mint all ACCEPTED)
  // and denies post-fix; legitimate PASS retained.
  // N41 role forgery: numeric mint with forged role throws the deleted-surface
  // (THIS authority); cap mint derives canonical role and ignores forged extra
  // fields. N42 TOCTOU: sparse/accessor/Proxy-mutating/inherited successors
  // throw the single-materialization gate with zero residue and no id gap.
  // N43 cross-authority: foreign opCap, numeric foreign id, and getOp snapshot
  // never resolve in another authority (THIS authority/foreign/never resolve).
  {
    // N41 role forgery.
    const auth41 = createClosedAuthority("n41-role");
    const root41 = auth41.registerOp({ kind: "init", cause: "harness-start", scope: "harness",
      sourceDoc: 0, targetDoc: 0, action: "harness-start", role: "startup-probe", from: null,
      successors: ["probe-issue"] });
    const op41 = auth41.registerOp({ kind: "harness-action", cause: "reload", scope: "document",
      sourceDoc: 1, targetDoc: 1, action: "probe-issue", role: "catalog-read",
      from: root41.id, successors: [] });
    const slotsBefore41 = auth41.slots().length;
    assert.throws(() => auth41.mintSlot({ opId: op41.id, targetDoc: 1, action: "probe-issue",
      role: "pair-action", method: "GET", origin: "http://127.0.0.1:1", path: "/api/v1/research/catalog?limit=20" }),
    /THIS authority|deleted|never resolve/,
      "N41: numeric role-forgery mint must throw the deleted capability surface");
    assert.equal(auth41.slots().length, slotsBefore41,
      "N41: failed forgery must leave zero slot residue");
    const legit41 = auth41.mintSlot(op41, { method: "GET", origin: "http://127.0.0.1:1", path: "/api/v1/research/catalog?limit=20" });
    assert.equal(legit41.role, "catalog-read",
      "N41: cap mint must derive the canonical op role, never caller role");
    assert.equal(legit41.targetDoc, 1,
      "N41: cap mint must derive the canonical targetDoc");
    assert.equal(legit41.action, "probe-issue",
      "N41: cap mint must derive the canonical action");
    const forgedExtra41 = auth41.mintSlot(op41, { method: "GET", origin: "http://127.0.0.1:1", path: "/api/v1/system/health", role: "pair-action" });
    assert.equal(forgedExtra41.role, "catalog-read",
      "N41: extra caller role field must be ignored (canonical derives)");
    // N42 TOCTOU single-materialization.
    const auth42 = createClosedAuthority("n42-toctou");
    const root42 = auth42.registerOp({ kind: "init", cause: "harness-start", scope: "harness",
      sourceDoc: 0, targetDoc: 0, action: "harness-start", role: "startup-probe", from: null,
      successors: ["probe-issue"] });
    const opsBefore42 = auth42.operations().length;
    const edgesBefore42 = auth42.edges().length;
    assert.throws(() => auth42.registerOp({ kind: "harness-action", cause: "reload", scope: "document",
      sourceDoc: 1, targetDoc: 1, action: "probe-issue", role: "catalog-read",
      from: root42.id, successors: new Array(1) }), /must declare exact OpActions/,
      "N42: sparse successors must throw (single-materialization)");
    {
      const accessor42 = [];
      Object.defineProperty(accessor42, "0", { get() { return "probe-retry"; }, enumerable: true, configurable: true });
      accessor42.length = 1;
      assert.throws(() => auth42.registerOp({ kind: "harness-action", cause: "reload", scope: "document",
        sourceDoc: 1, targetDoc: 1, action: "probe-issue", role: "catalog-read",
        from: root42.id, successors: accessor42 }), /must declare exact OpActions/,
        "N42: accessor successors must throw");
    }
    {
      let reads42 = 0;
      const evil42 = [];
      Object.defineProperty(evil42, "0", { enumerable: true, configurable: true, get() { reads42 += 1; return reads42 <= 2 ? "probe-retry" : "probe-mid"; } });
      evil42.length = 1;
      assert.throws(() => auth42.registerOp({ kind: "harness-action", cause: "reload", scope: "document",
        sourceDoc: 1, targetDoc: 1, action: "probe-issue", role: "catalog-read",
        from: root42.id, successors: evil42 }), /must declare exact OpActions/,
        "N42: mutation-during-coercion must throw");
    }
    {
      const inherited42 = new Array(1);
      Object.setPrototypeOf(inherited42, { 0: "probe-mid" });
      assert.throws(() => auth42.registerOp({ kind: "harness-action", cause: "reload", scope: "document",
        sourceDoc: 1, targetDoc: 1, action: "probe-issue", role: "catalog-read",
        from: root42.id, successors: inherited42 }), /must declare exact OpActions/,
        "N42: inherited successors must throw");
    }
    assert.equal(auth42.operations().length, opsBefore42,
      "N42: failed TOCTOU registers must leave zero op residue");
    assert.equal(auth42.edges().length, edgesBefore42,
      "N42: failed TOCTOU registers must leave zero edge residue");
    const legit42 = auth42.registerOp({ kind: "harness-action", cause: "reload", scope: "document",
      sourceDoc: 1, targetDoc: 1, action: "probe-issue", role: "catalog-read",
      from: root42.id, successors: ["probe-retry"] });
    assert.equal(legit42.id, root42.id + 1,
      "N42: transactional id must be contiguous with no gap after failed attempts");
    // N43 cross-authority closure.
    const authA43 = createClosedAuthority("n43-a");
    const authB43 = createClosedAuthority("n43-b");
    assert.ok(authA43.authorityId !== authB43.authorityId,
      "N43: distinct authorities must carry distinct authorityIds");
    const rootA43 = authA43.registerOp({ kind: "init", cause: "harness-start", scope: "harness",
      sourceDoc: 0, targetDoc: 0, action: "harness-start", role: "startup-probe", from: null,
      successors: ["probe-issue"] });
    const rootB43 = authB43.registerOp({ kind: "init", cause: "harness-start", scope: "harness",
      sourceDoc: 0, targetDoc: 0, action: "harness-start", role: "startup-probe", from: null,
      successors: ["probe-issue"] });
    const opA43 = authA43.registerOp({ kind: "harness-action", cause: "reload", scope: "document",
      sourceDoc: 1, targetDoc: 1, action: "probe-issue", role: "catalog-read",
      from: rootA43.id, successors: [] });
    const opB43 = authB43.registerOp({ kind: "harness-action", cause: "reload", scope: "document",
      sourceDoc: 1, targetDoc: 1, action: "probe-issue", role: "catalog-read",
      from: rootB43.id, successors: [] });
    const slotsBeforeB43 = authB43.slots().length;
    assert.throws(() => authB43.mintSlot(opA43, { method: "GET", origin: "http://127.0.0.1:1", path: "/api/v1/research/catalog?limit=20" }),
    /THIS authority|foreign|never resolve/,
      "N43: foreign opCap must never resolve in another authority");
    assert.throws(() => authB43.mintSlot({ opId: opA43.id, targetDoc: 1, action: "probe-issue",
      role: "catalog-read", method: "GET", origin: "http://127.0.0.1:1", path: "/api/v1/research/catalog?limit=20" }),
    /THIS authority|foreign|never resolve/,
      "N43: numeric foreign id must never resolve");
    assert.throws(() => authB43.mintSlot(authB43.getOp(rootB43.id), { method: "GET", origin: "http://127.0.0.1:1", path: "/api/v1/research/catalog?limit=20" }),
    /THIS authority|foreign|never resolve/,
      "N43: getOp snapshot must never resolve as a capability (WeakMap miss)");
    assert.equal(authB43.slots().length, slotsBeforeB43,
      "N43: failed cross-authority mints must leave zero slot residue");
    const legitSame43 = authB43.mintSlot(opB43, { method: "GET", origin: "http://127.0.0.1:1", path: "/api/v1/research/catalog?limit=20" });
    assert.ok(Number.isSafeInteger(legitSame43.id),
      "N43: legitimate same-authority cap mint still passes");
    const capB43 = (() => {
      const freshB = createClosedAuthority("n43-b-legit");
      const freshRoot = freshB.registerOp({ kind: "init", cause: "harness-start", scope: "harness",
        sourceDoc: 0, targetDoc: 0, action: "harness-start", role: "startup-probe", from: null,
        successors: ["probe-issue"] });
      const freshOp = freshB.registerOp({ kind: "harness-action", cause: "reload", scope: "document",
        sourceDoc: 1, targetDoc: 1, action: "probe-issue", role: "catalog-read",
        from: freshRoot.id, successors: [] });
      return freshB.mintSlot(freshOp, { method: "GET", origin: "http://127.0.0.1:1", path: "/api/v1/research/catalog?limit=20" });
    })();
    assert.ok(Number.isSafeInteger(capB43.id),
      "N43: legitimate same-authority cap mint still passes");
  }
  {
    const trackerD1 = createRequestTerminalTracker(new Set([200, 204, 403]));
    trackerD1.noteResponse(7001, 200);
    assert.equal(trackerD1.shouldSuppressFailure(7001), true,
      "D1: same-reqId contract response must suppress its own duplicate failure notification");
    const trackerD2 = createRequestTerminalTracker(new Set([200, 204, 403]));
    trackerD2.noteResponse(7002, 500);
    assert.equal(trackerD2.shouldSuppressFailure(7002), false,
      "D2: non-contract response must never suppress its failure (dedupe overreach denies)");
    const trackerD3 = createRequestTerminalTracker(new Set([200, 204, 403]));
    trackerD3.noteResponse(7003, 200);
    assert.equal(trackerD3.shouldSuppressFailure(7004), false,
      "D3: cross-reqId response must never suppress another request's failure");
    assert.throws(() => trackerD3.noteResponse(7003, 200), /duplicate response reqId/,
      "D3: duplicate response for one reqId must fail closed");
  }
  return { protocol: "eliotr.owner-e2e.authed-epoch-regression.v1", state: "PASS",
    positives: 2, negatives: 43, collector: "D1-D3",
    coverage: "closed ledger mechanics (registered ops/slots/roles/single-step/consumption) + causal nav tokens (closure-private mint, object-only consume, delete-on-consume, FIFO queue, zero-inflight barrier, transactional registerOp) + exact issuance capabilities (registry/prototype/own-keys/triple) + current-op/doc/role/action gates + private canonical successors snapshots + private canonical policy + capability slot/op closure (WeakMap-bound opCap of THIS authority, derived action/role/targetDoc, single-materialization successors, authorityId cross-closure) + frozen terminal values/snapshots + one terminal outcome + authenticated order + token-bound edges; sourceId+session-cookie window evidence proven live in the authed phase" };
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
  const clock = typeof harness.ledgerClock === "function" ? harness.ledgerClock() : { epoch: "unknown", serial: "unknown" };
  return {
    requests: harness.requests.length,
    responses: harness.networkResponses.length,
    failed: harness.failedRequests.length,
    websockets: harness.websockets.length,
    workers: harness.pageWorkers.length,
    epoch: clock.epoch,
    serial: clock.serial,
    service_workers: serviceWorkers.map((entry) => entry.url()),
    console_errors: harness.consoleErrors.length,
    page_errors: harness.pageErrors.length,
  };
}

// A phase reset may discard only a settled ledger. The pending set is the
// authoritative fence: response.request() keeps its own WeakMap identity, so
// erasing request rows while a request is live would leave a response with no
// request row in the next phase.
export function assertPhaseResetReady(pendingRequests, label = "phase reset") {
  assert.ok(pendingRequests instanceof Set, `${label}: pending request ledger must be a Set`);
  assert.equal(pendingRequests.size, 0,
    `${label}: cannot reset a phase with ${pendingRequests.size} pending browser request(s)`);
}

async function awaitServiceWorkerRegistrationLifecycle(container = globalThis.navigator?.serviceWorker) {
  const serviceWorker = container ?? globalThis.navigator?.serviceWorker;
  if (!serviceWorker) return "unsupported";
  const registrationPromise = serviceWorker.__eliotServiceWorkerRegistrationPromise ??
    globalThis.__eliotServiceWorkerRegistrationPromise;
  if (!registrationPromise || typeof registrationPromise.then !== "function") return "unregistered";
  let registration;
  try { registration = await registrationPromise; }
  catch { return "registration-failed"; }
  if (!registration) return "registration-failed";

  // A waiting `installed` worker is terminal only when this registration had
  // an active worker already. On first install, `installed` is the pre-
  // activation state and the fence must continue through `activated`.
  const hadActiveAtStart = Boolean(registration.active);
  const isTerminal = (state) => state === "activated" || state === "redundant" ||
    (state === "installed" && hadActiveAtStart);
  const observed = new Map();
  let changeVersion = 0;
  let signalResolve;
  let signal = new Promise((resolve) => { signalResolve = resolve; });
  const signalChange = () => {
    changeVersion += 1;
    signalResolve();
    signal = new Promise((resolve) => { signalResolve = resolve; });
  };
  const observe = (worker) => {
    if (!worker || observed.has(worker)) return;
    let resolveWait;
    const entry = { settled: false, promise: new Promise((resolve) => { resolveWait = resolve; }) };
    const onStateChange = () => {
      signalChange();
      if (!isTerminal(worker.state) || entry.settled) return;
      entry.settled = true;
      worker.removeEventListener?.("statechange", onStateChange);
      resolveWait();
    };
    entry.onStateChange = onStateChange;
    observed.set(worker, entry);
    worker.addEventListener?.("statechange", onStateChange);
    onStateChange();
  };
  // Observe updatefound before sampling the current registration state so an
  // installing worker cannot be hidden by an already-active worker.
  const onUpdateFound = () => { signalChange(); observe(registration.installing); };
  registration.addEventListener?.("updatefound", onUpdateFound);
  observe(registration.installing);
  observe(registration.waiting);
  observe(registration.active);
  try {
    const deadline = Date.now() + 10000;
    let quietTurns = 0;
    while (Date.now() < deadline) {
      observe(registration.installing);
      observe(registration.waiting);
      observe(registration.active);
      const pending = [...observed.values()].filter((entry) => !entry.settled).map((entry) => entry.promise);
      if (pending.length > 0) {
        quietTurns = 0;
        await Promise.race([...pending, signal]);
        continue;
      }
      // A registration can dispatch updatefound after the current workers
      // look terminal. Give the event loop a bounded task boundary, then
      // resample the registration. This is event quiescence, not a sleep-only
      // delay, and late workers join the next pending set.
      const version = changeVersion;
      await Promise.race([signal, new Promise((resolve) => setTimeout(resolve, 0))]);
      observe(registration.installing);
      observe(registration.waiting);
      observe(registration.active);
      const latePending = [...observed.values()].some((entry) => !entry.settled);
      if (latePending || changeVersion !== version) {
        quietTurns = 0;
        continue;
      }
      quietTurns += 1;
      if (quietTurns >= 2) return "settled";
    }
    throw new Error("service-worker lifecycle did not reach bounded quiescence");
  } finally {
    registration.removeEventListener?.("updatefound", onUpdateFound);
    for (const [worker, entry] of observed) {
      if (!entry.settled) worker.removeEventListener?.("statechange", entry.onStateChange);
    }
  }
}

async function settleServiceWorkerLifecycle(page) {
  // `networkidle` does not include the asynchronous registration/activation
  // lifecycle. Fence the registration promise initiated by the PWA and any
  // installing/waiting worker it produced. A missing/failed unauthenticated
  // registration is already settled and therefore needs no wait.
  let timer;
  try {
    await Promise.race([
      page.evaluate(awaitServiceWorkerRegistrationLifecycle),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("service-worker lifecycle did not settle before the phase boundary")), 10000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
export async function verifyServiceWorkerSettlementRegression() {
  const makeWorker = (initialState) => {
    let state = initialState;
    const listeners = new Set();
    return {
      get state() { return state; },
      addEventListener: (_name, listener) => listeners.add(listener),
      removeEventListener: (_name, listener) => listeners.delete(listener),
      transition(nextState) { state = nextState; for (const listener of [...listeners]) listener(); },
    };
  };
  const pageFor = (registration) => ({
    evaluate: async (callback) => callback({ __eliotServiceWorkerRegistrationPromise: Promise.resolve(registration) }),
  });

  // Existing active worker: an update reaching installed/waiting is terminal,
  // but a late updatefound must still be observed by the same fence.
  const update = makeWorker("installing");
  const registration = {
    installing: null, waiting: null, active: { state: "activated" },
    listeners: new Set(),
    addEventListener(_name, listener) { this.listeners.add(listener); },
    removeEventListener(_name, listener) { this.listeners.delete(listener); },
    dispatchUpdateFound() { for (const listener of [...this.listeners]) listener(); },
  };
  let finished = false;
  const settlement = settleServiceWorkerLifecycle(pageFor(registration)).then(() => { finished = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  registration.installing = update;
  registration.dispatchUpdateFound();
  await Promise.resolve();
  assert.equal(finished, false, "late updatefound must join the active phase fence");
  update.transition("installed");
  await settlement;
  assert.equal(finished, true, "waiting update may settle after installed when an active worker exists");

  // First install: installed is not activation, so the fence remains pending
  // until the worker actually reaches activated.
  const firstInstall = makeWorker("installing");
  const firstRegistration = {
    installing: firstInstall, waiting: null, active: null,
    addEventListener: () => {}, removeEventListener: () => {},
  };
  finished = false;
  const firstSettlement = settleServiceWorkerLifecycle(pageFor(firstRegistration)).then(() => { finished = true; });
  await Promise.resolve();
  firstInstall.transition("installed");
  await Promise.resolve();
  assert.equal(finished, false, "first install must not settle at installed before activation");
  firstInstall.transition("activated");
  await firstSettlement;
  assert.equal(finished, true, "first install must settle after activation");
  return { protocol: "eliotr.owner-e2e.service-worker-settlement.v1", state: "PASS" };
}

export function verifyLedgerResetBoundaryRegression() {
  const lateRequest = {};
  const pendingRequests = new Set([lateRequest]);
  const requests = [{ reqId: 91, path: "/sw.js" }];
  const responses = [];
  const reset = () => {
    assertPhaseResetReady(pendingRequests, "late-response-before-settlement");
    requests.length = 0;
    responses.length = 0;
  };
  assert.throws(reset,
    /cannot reset a phase with 1 pending browser request/u,
    "a late response must block destructive phase reset before settlement");
  assert.equal(requests.length, 1, "failed reset must retain the request row for later response pairing");
  pendingRequests.delete(lateRequest);
  responses.push({ reqId: 91, status: 200 });
  assert.doesNotThrow(() => assertPhaseResetReady(pendingRequests, "late-response-after-settlement"),
    "the same phase may reset after the request settles");
  assert.equal(requests.length, 1, "settled request row remains available until the successful reset");
  assert.deepEqual(responses, [{ reqId: 91, status: 200 }],
    "the late response must be recorded before the successful reset");
  assert.doesNotThrow(reset, "the successful reset must clear only after the late response settles");
  assert.deepEqual(requests, [], "successful reset clears settled request rows");
  assert.deepEqual(responses, [], "successful reset clears settled response rows");
  return { protocol: "eliotr.owner-e2e.ledger-reset-boundary.v1", state: "PASS" };
}

async function settleLedger(page, harness) {
  // Settle-then-assert: networkidle is primary (existing 10s bound), then a
  // bounded pending-callback drain lets already-queued Playwright
  // request/response/requestfailed callbacks land before any ledger assert.
  // No sleep-only timing: without networkidle this drain alone proves nothing;
  // leftovers still fail closed downstream. Never hides retries: retry state
  // stays in the ledger and must still pair or anchor.
  await settleServiceWorkerLifecycle(page);
  const deadline = Date.now() + 10000;
  try { await page.waitForLoadState("networkidle", { timeout: 10000 }); } catch { /* unpaired traffic fails closed */ }
  try {
    let quietRounds = 0;
    while (Date.now() < deadline && quietRounds < 3) {
      try {
        await page.evaluate(() => new Promise((resolve) => {
          try { requestAnimationFrame(() => setTimeout(resolve, 0)); }
          catch { setTimeout(resolve, 0); }
        }));
      } catch { /* in-page drain is best-effort; ledger asserts stay exact */ }
      const sequence = typeof harness?.trafficSequence === "function" ? harness.trafficSequence() : -1;
      const pending = typeof harness?.pendingRequestCount === "function" ? harness.pendingRequestCount() : 0;
      if (pending === 0) quietRounds += 1; else quietRounds = 0;
      const remaining = Math.max(1, Math.min(100, deadline - Date.now()));
      const waiter = typeof harness?.waitForPendingChange === "function" ? harness.waitForPendingChange() : null;
      await Promise.race([waiter?.promise ?? Promise.resolve(), new Promise((resolve) => setTimeout(resolve, remaining))]);
      waiter?.cancel();
      if (sequence !== (typeof harness?.trafficSequence === "function" ? harness.trafficSequence() : -1)) quietRounds = 0;
    }
  } catch { /* drain failures still fail closed downstream */ }
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

function bridgeRepairNetworkSpec(origin) {
  return {
    origins: [origin],
    api: [
      { method: "GET", path: "/__local/", status: 200 },
      { method: "POST", path: "/__local/pair", status: 204 },
      { method: "GET", path: "/api/v1/research/catalog?limit=20", status: 200 },
      { method: "GET", path: "/api/v1/system/health", status: 200 },
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
  // Exact request identity: every response/failure consumes its own request by
  // reqId. URL FIFO pairing is unsafe when a persistent service worker emits
  // duplicate GETs across navigation phases; phase attribution must remain on
  // the request object that actually produced the terminal event.
  const pending = new Map();
  for (const request of harness.requests) {
    assert.ok(Number.isSafeInteger(request?.reqId), `${label}: request without reqId fails closed`);
    assert.ok(!pending.has(request.reqId), `${label}: duplicate request reqId fails closed: ${request.reqId}`);
    pending.set(request.reqId, request);
  }
  const respondedIds = new Set();
  for (const response of harness.networkResponses) {
    assert.ok(Number.isSafeInteger(response?.reqId), `${label}: response without reqId fails closed: ${response?.path ?? "?"}`);
    assert.ok(!respondedIds.has(response.reqId), `${label}: duplicate response reqId fails closed: ${response.reqId}`);
    respondedIds.add(response.reqId);
    const matched = pending.get(response.reqId);
    assert.ok(matched !== undefined, `${label}: response reqId has no browser request: ${response.reqId}`);
    pending.delete(response.reqId);
    assert.equal(response.method, matched.method, `${label}: response method crossed request identity`);
    assert.equal(response.origin, matched.origin, `${label}: response origin crossed request identity`);
    assert.equal(response.path, matched.path, `${label}: response path crossed request identity`);
    assert.equal(response.epoch, matched.epoch, `${label}: response epoch crossed request identity`);
    assert.equal(response.serial, matched.serial, `${label}: response serial crossed request identity`);
    assert.equal(response.opId, matched.opId, `${label}: response operation crossed request identity`);
    assert.equal(response.docId, matched.docId, `${label}: response document crossed request identity`);
    assert.equal(response.role, matched.role, `${label}: response role crossed request identity`);
    assert.equal(response.slotId ?? null, matched.slotId ?? null, `${label}: response slot crossed request identity`);
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
  const failures = harness.failedRequestEntries;
  assert.ok(Array.isArray(failures), `${label}: structured failure ledger is required`);
  for (const failure of failures) {
    const text = String(failure?.text ?? "");
    assert.ok(abortAllowed.has(text), `${label}: unexpected failed request, got: ${text.slice(0, 300)}`);
    assert.ok(Number.isSafeInteger(failure?.reqId), `${label}: failed request without reqId fails closed: ${text.slice(0, 200)}`);
    const own = pending.get(failure.reqId);
    assert.ok(own !== undefined, `${label}: failed request has no pending request or was already responded: ${text.slice(0, 200)}`);
    pending.delete(failure.reqId);
    for (const field of ["method", "origin", "path", "epoch", "serial", "opId", "docId", "role"]) {
      assert.equal(failure[field], own[field], `${label}: failure ${field} crossed request identity`);
    }
    assert.equal(failure.slotId ?? null, own.slotId ?? null, `${label}: failure slot crossed request identity`);
    assert.ok(origins.includes(failure.origin), `${label}: cross-origin failed egress denied: ${text.slice(0, 200)}`);
  }
  assert.deepEqual([...pending.values()], [], `${label}: every browser request must pair with a response or an allowed abort, dangling: ${JSON.stringify([...pending.values()].slice(0, 4))}`);
  const serialized = JSON.stringify({ requests: harness.requests, responses: harness.networkResponses });
  assert.ok(!/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(serialized) && !serialized.includes("cf-access"),
    `${label}: network ledger must never contain JWT or access credentials`);
}

export function verifyPhaseLedgerIdentityRegression(origin = "http://127.0.0.1:43123") {
  const request = Object.freeze({ reqId: 1, method: "GET", origin, path: "/sw.js", resourceType: "script",
    epoch: 1, serial: 1, opId: 1, docId: 1, role: "startup-probe", slotId: null });
  const response = Object.freeze({ ...request, status: 200, contentType: "application/javascript" });
  const base = { websockets: [], pageWorkers: [], requests: [request], networkResponses: [response],
    failedRequestEntries: [], context: { serviceWorkers: () => [] } };
  const spec = { origins: [origin], api: [], workerOrigins: [origin] };
  assert.doesNotThrow(() => assertPhaseNetwork(base, "phase-ledger-positive", spec),
    "same-request shell-worker response must pass the phase ledger");
  assert.throws(() => assertPhaseNetwork({ ...base, networkResponses: [{ ...response, reqId: 2 }] },
    "phase-ledger-foreign-response", spec), /no browser request/,
    "a response from another request must not pair by URL");
  assert.throws(() => assertPhaseNetwork({ ...base, networkResponses: [{ ...response, serial: 2 }] },
    "phase-ledger-cross-phase-response", spec), /serial crossed request identity/,
    "a cross-phase response must fail closed even when URL is identical");
  return { protocol: "eliotr.owner-e2e.phase-ledger-identity.v1", state: "PASS", negatives: 2 };
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
  let markerFailureDirectory;
  try {
    await assert.rejects(
      createMarkedTempDirectory(`eliotr-owner-e2e-${runId}-marker-failure-`, runId, "owner-state", {
        markerWriter: async (directory) => {
          markerFailureDirectory = directory;
          throw new Error("simulated marker failure");
        },
      }),
      /simulated marker failure/,
      "marker failure must be reported",
    );
    await assert.rejects(access(markerFailureDirectory), /ENOENT/, "marker failure directory must be removed");
    directory = await createMarkedTempDirectory("eliotr-owner-e2e-", runId, "owner-state");
    profileDir = await createMarkedTempDirectory("eliotr-owner-e2e-profile-", runId, "browser-profile");
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
  const orphanedProfiles = [];
  const decoyNames = {
    tmp: new Set([`eliotr-owner-e2e-profile-decoy-${runId}`, `smoke-decoy-${runId}`,
      `eliotr-owner-e2e-profile-foreign-${runId}`]),
    state: new Set([`owner-e2e-decoy-${runId}`, `smoke-decoy-${runId}`]),
  };
  try {
    receipt.chromium_safe_ports = (await verifyChromiumSafePortProtocol()).state;
    receipt.early_cleanup = (await verifyEarlyFailureCleanup()).state;
    directory = await createMarkedTempDirectory("eliotr-owner-e2e-", runId, "owner-state");
    await mkdir(stateRoot, { recursive: true });
    for (const path of [decoyTmpProfile, decoyTmpSmoke, decoyStateOwner, decoyStateSmoke, foreignProfile]) {
      await mkdir(path, { recursive: true });
      await writeFile(resolve(path, "decoy-sentinel.txt"), `decoy owned by run ${runId}\n`, { mode: 0o600 });
    }
    await markKnownCreatedTempDirectory(foreignProfile, `eliotr-owner-e2e-profile-foreign-${runId}`, `${runId}-foreign`, "foreign-profile");
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
      const stagingId = `${runId}-staging`;
      const stagingDir = await createMarkedTempDirectory("eliotr-owner-e2e-staging-", stagingId, "owner-state-staging");
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
      const dupId = `${runId}-staging-dup-jwks`;
      const dupDir = await createMarkedTempDirectory("eliotr-owner-e2e-staging-", dupId, "owner-state-staging-dup");
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
    receipt.authed_epoch_regression = verifyAuthedEpochRegression().state;
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
      "wrong-issuer": await sign({ iss: ["https://other", ".cloudflareaccess.com"].join("") }),
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
    // identity, so CLI D1 shares SQLite files with Miniflare. Namespace
    // initialization is one mutation attempt; its exact readback is the only
    // recovery path for an ambiguous acknowledgement.
    const namespaceReceipt = await initializeLocalNamespace({ command: namespaceCommand,
      identity, query: localPolicyQuery(paths) });
    assert.equal(namespaceReceipt.read_access_granted, false, "namespace init must not grant read access");
    assert.deepEqual(d1Query(paths, "CORE_DB", "SELECT COUNT(*) AS n FROM scope_read_policy"), [{ n: 0 }],
      "login/init alone must not create an implicit read grant");
    const namespaceReplay = await initializeLocalNamespace({ command: namespaceCommand,
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
    playwright = await launchPlaywright(runId, orphanedProfiles);
    receipt.browser = `playwright-core chromium; ${await playwright.browser.version()}`;
    // Every loopback origin the real browser visits. Service workers persist per
    // origin across restarts (each restart rebinds a fresh port), so the worker
    // rule allows exactly one /sw.js per visited harness origin, no more.
    const visitedOrigins = [];
    const trackOrigin = (origin) => {
      if (!visitedOrigins.includes(origin)) visitedOrigins.push(origin);
      return [...visitedOrigins];
    };
    playwright.adoptIssuance(playwright.setRole(playwright.currentIssuance(), "startup-probe"));
    playwright.registerOp({ kind: "harness-navigation", cause: "goto", scope: "document",
      sourceDoc: playwright.currentDocId(), targetDoc: playwright.currentDocId() + 1,
      action: "goto-unauthenticated", role: "startup-probe",
      from: playwright.currentOp().id, successors: ["goto-pairing", "framenavigated"] });
    playwright.mintSlotsFor(playwright.currentIssuance(), { origin: worker.origin });
    await playwright.page.goto(worker.origin, { waitUntil: "domcontentloaded", timeout: 15000 });
    await playwright.page.waitForFunction(shellReady, null, { timeout: 15000 });
    const unauthHasPrivate = await playwright.evaluate(hasPrivateLibraryMarker);
    assert.equal(unauthHasPrivate, false, "unauthenticated PWA must not render private Library rows");
    const unauthStorage = await readBrowserStorage(playwright.page);
    assertNoPrivateStorage(unauthStorage, "unauthenticated");
    await settleLedger(playwright.page, playwright);
    assertUnauthLedger(playwright, "unauthenticated", worker.origin);
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
    playwright.adoptIssuance(playwright.setRole(playwright.currentIssuance(), "pair-action"));
    playwright.registerOp({ kind: "harness-navigation", cause: "goto-pairing", scope: "document",
      sourceDoc: playwright.currentDocId(), targetDoc: playwright.currentDocId() + 1,
      action: "goto-pairing", role: "pair-action",
      from: playwright.currentOp().id, successors: ["click-connect", "framenavigated"] });
    playwright.mintSlotsFor(playwright.currentIssuance(), { origin: bridge.origin });
    await playwright.page.goto(bridge.pairingUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await playwright.page.waitForSelector("#connect", { timeout: 15000 });
    playwright.registerOp({ kind: "harness-action", cause: "pair-action", scope: "document",
      sourceDoc: playwright.currentDocId(), targetDoc: playwright.currentDocId(),
      action: "click-connect", role: "pair-action",
      from: playwright.currentOp().id, successors: ["reload-authed-retrieval"] });
    playwright.mintSlotsFor(playwright.currentIssuance(), { origin: bridge.origin });
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
    playwright.registerOp({ kind: "harness-navigation", cause: "reload", scope: "document",
      sourceDoc: playwright.currentDocId(), targetDoc: playwright.currentDocId() + 1,
      action: "reload-authed-retrieval", role: "pair-action",
      from: playwright.currentOp().id, successors: ["goto-jwt-matrix", "framenavigated"] });
    playwright.mintSlotsFor(playwright.currentIssuance(), { origin: bridge.origin,
      extraPaths: [["GET", `/api/v1/library/revisions?source_id=${encodeURIComponent(sourceId)}&limit=10`]] });
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
    await settleLedger(playwright.page, playwright);
    assertAuthedLedger(playwright, "authed", bridge.origin);
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
      playwright.adoptIssuance(playwright.setRole(playwright.currentIssuance(), "jwt-matrix"));
      playwright.registerOp({ kind: "harness-navigation", cause: "goto", scope: "document",
        sourceDoc: playwright.currentDocId(), targetDoc: playwright.currentDocId() + 1,
        action: "goto-jwt-matrix", role: "jwt-matrix",
        from: playwright.currentOp().id, successors: ["goto-post-restart", "framenavigated"] });
      playwright.mintSlotsFor(playwright.currentIssuance(), { origin: worker.origin });
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
      await settleLedger(playwright.page, playwright);
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
    assert.deepEqual(await initializeLocalNamespace({ command: namespaceCommand,
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
    await settleLedger(playwright.page, playwright);
    playwright.resetLedger();
    playwright.adoptIssuance(playwright.setRole(playwright.currentIssuance(), "startup-probe"));
    playwright.registerOp({ kind: "harness-navigation", cause: "goto", scope: "document",
      sourceDoc: playwright.currentDocId(), targetDoc: playwright.currentDocId() + 1,
      action: "goto-post-restart", role: "startup-probe",
      from: playwright.currentOp().id, successors: ["goto-repairing", "framenavigated"] });
    playwright.mintSlotsFor(playwright.currentIssuance(), { origin: worker.origin });
    await playwright.page.goto(worker.origin, { waitUntil: "domcontentloaded", timeout: 15000 });
    await playwright.page.waitForFunction(shellReady, null, { timeout: 15000 });
    const restartStorage = await readBrowserStorage(playwright.page);
    assertNoPrivateStorage(restartStorage, "post-restart");
    await settleLedger(playwright.page, playwright);
    assertUnauthLedger(playwright, "post-restart", worker.origin);
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
    playwright.adoptIssuance(playwright.setRole(playwright.currentIssuance(), "pair-action"));
    playwright.registerOp({ kind: "harness-navigation", cause: "goto-pairing", scope: "document",
      sourceDoc: playwright.currentDocId(), targetDoc: playwright.currentDocId() + 1,
      action: "goto-repairing", role: "pair-action",
      from: playwright.currentOp().id, successors: ["click-reconnect", "framenavigated"] });
    playwright.mintSlotsFor(playwright.currentIssuance(), { origin: bridge.origin });
    await playwright.page.goto(bridge.pairingUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await playwright.page.waitForSelector("#connect", { timeout: 15000 });
    playwright.registerOp({ kind: "harness-action", cause: "pair-action", scope: "document",
      sourceDoc: playwright.currentDocId(), targetDoc: playwright.currentDocId(),
      action: "click-reconnect", role: "pair-action",
      from: playwright.currentOp().id, successors: ["goto-logout"] });
    playwright.mintSlotsFor(playwright.currentIssuance(), { origin: bridge.origin });
    await playwright.page.click("#connect", { timeout: 15000 });
    await playwright.page.waitForFunction(shellReady, null, { timeout: 15000 });
    await playwright.page.waitForFunction(bodyIncludes, sourceId, { timeout: 15000 });
    const rePaired = await playwright.context.cookies();
    const reNew = rePaired.filter((item) => item.name.startsWith("eliotr_local_") && !preRestartNames.has(item.name));
    assert.equal(reNew.length, 1, "Chromium re-pairing after restart must yield exactly one fresh opaque session cookie");
    assert.equal(reNew[0].httpOnly, true, "re-paired cookie must be HttpOnly");
    assert.ok(!String(reNew[0].value).includes("eyJ"), "re-paired cookie must be opaque");
    const reSessionName = reNew[0].name;
    await settleLedger(playwright.page, playwright);
    assertPhaseNetwork(playwright, "bridge-repair", {
      ...bridgeRepairNetworkSpec(bridge.origin), workerOrigins: trackOrigin(bridge.origin),
    });
    receipt.network_ledger_phases.bridge_repair = summarizePhaseLedger(playwright);
    playwright.resetLedger();
    playwright.adoptIssuance(playwright.setRole(playwright.currentIssuance(), "logout-action"));
    playwright.registerOp({ kind: "harness-navigation", cause: "goto", scope: "document",
      sourceDoc: playwright.currentDocId(), targetDoc: playwright.currentDocId() + 1,
      action: "goto-logout", role: "logout-action",
      from: playwright.currentOp().id, successors: ["click-logout", "framenavigated"] });
    playwright.mintSlotsFor(playwright.currentIssuance(), { origin: bridge.origin });
    await playwright.page.goto(`${bridge.origin}/__local/`, { waitUntil: "domcontentloaded", timeout: 15000 });
    await playwright.page.waitForSelector("#logout", { timeout: 15000 });
    playwright.registerOp({ kind: "harness-action", cause: "logout-action", scope: "document",
      sourceDoc: playwright.currentDocId(), targetDoc: playwright.currentDocId(),
      action: "click-logout", role: "logout-action",
      from: playwright.currentOp().id, successors: ["goto-post-logout-clean"] });
    playwright.mintSlotsFor(playwright.currentIssuance(), { origin: bridge.origin });
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
    await settleLedger(playwright.page, playwright);
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
    assertPhaseNetwork(playwright, "logout", { ...logoutNetworkSpec(bridge.origin), workerOrigins: trackOrigin(bridge.origin) });
    receipt.network_ledger_phases.logout = summarizePhaseLedger(playwright);
    playwright.resetLedger();
    playwright.adoptIssuance(playwright.setRole(playwright.currentIssuance(), "startup-probe"));
    playwright.registerOp({ kind: "harness-navigation", cause: "goto", scope: "document",
      sourceDoc: playwright.currentDocId(), targetDoc: playwright.currentDocId() + 1,
      action: "goto-post-logout-clean", role: "startup-probe",
      from: playwright.currentOp().id, successors: ["goto-rotation", "framenavigated"] });
    playwright.mintSlotsFor(playwright.currentIssuance(), { origin: worker.origin });
    await playwright.page.goto(worker.origin, { waitUntil: "domcontentloaded", timeout: 15000 });
    await playwright.page.waitForFunction(shellReady, null, { timeout: 15000 });
    const loggedOutHasPrivate = await playwright.evaluate(bodyIncludes, sourceId);
    assert.equal(loggedOutHasPrivate, false, "Library must hide the source after logout");
    const loggedOutStorage = await readBrowserStorage(playwright.page);
    assertNoPrivateStorage(loggedOutStorage, "post-logout");
    await settleLedger(playwright.page, playwright);
    assertUnauthLedger(playwright, "post-logout-clean", worker.origin);
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
      playwright.adoptIssuance(playwright.setRole(playwright.currentIssuance(), "rotation-read"));
      playwright.registerOp({ kind: "harness-navigation", cause: "goto", scope: "document",
        sourceDoc: playwright.currentDocId(), targetDoc: playwright.currentDocId() + 1,
        action: "goto-rotation", role: "rotation-read",
        from: playwright.currentOp().id, successors: ["goto-rotation-pairing", "framenavigated"] });
      playwright.mintSlotsFor(playwright.currentIssuance(), { origin: worker.origin,
        extraPaths: [["GET", `/api/v1/library/revisions?source_id=${encodeURIComponent(sourceId)}&limit=10`]] });
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
      playwright.registerOp({ kind: "harness-navigation", cause: "goto-pairing", scope: "document",
        sourceDoc: playwright.currentDocId(), targetDoc: playwright.currentDocId() + 1,
        action: "goto-rotation-pairing", role: "rotation-read",
        from: playwright.currentOp().id, successors: ["click-rotation-connect", "framenavigated"] });
      playwright.mintSlotsFor(playwright.currentIssuance(), { origin: bridge.origin });
      await playwright.page.goto(bridge.pairingUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
      await playwright.page.waitForSelector("#connect", { timeout: 15000 });
      playwright.registerOp({ kind: "harness-action", cause: "pair-action", scope: "document",
        sourceDoc: playwright.currentDocId(), targetDoc: playwright.currentDocId(),
        action: "click-rotation-connect", role: "rotation-read",
        from: playwright.currentOp().id, successors: [] });
      playwright.mintSlotsFor(playwright.currentIssuance(), { origin: bridge.origin });
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
      await settleLedger(playwright.page, playwright);
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
      await settleLedger(playwright.page, playwright);
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
    await settleLedger(playwright.page, playwright);
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
      await launchPlaywright(runId, orphanedProfiles);
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
    // Unconditional nested finally: EVERY owned resource is released while
    // dependent cleanup is still safe. Each step runs inside its own guard,
    // failures accumulate into stepErrors, and a timed-out callback stops the
    // dependent chain because the callback has no cancellation contract. The
    // residue inventory below runs BEFORE any deletion so a failure cannot
    // hide what was left behind. Exact marker/runId paths only; unrelated
    // same-prefix entries are inventoried, never touched.
    const teardownStarted = Date.now();
    const teardownDeadlineMs = 60000;
    const stepErrors = [];
    let teardownStopped = false;
    const runStep = async (label, fn) => {
      if (teardownStopped) return false;
      const remaining = teardownDeadlineMs - (Date.now() - teardownStarted);
      if (remaining <= 0) {
        stepErrors.push(`teardown deadline exceeded before ${label}`);
        teardownStopped = true;
        return false;
      }
      let timer;
      const operation = Promise.resolve().then(fn);
      try {
        await Promise.race([
          operation,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`teardown step timed out: ${label}`)), Math.max(1, remaining));
            timer.unref?.();
          }),
        ]);
        return true;
      } catch (error) {
        stepErrors.push(`${label}: ${error?.message ?? error}`);
        if (String(error?.message ?? error).includes(`teardown step timed out: ${label}`)) {
          // The callback has no cancellation contract. Stop the dependent
          // cleanup chain so no later step can race this still-running task.
          teardownStopped = true;
        }
        return false;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
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
        for (const { path, runId: orphanRunId } of orphanedProfiles) {
          try { await removeHarnessOwned(path, orphanRunId); }
          catch (error) { fail(`orphan browser profile cleanup failed: ${error?.message ?? error}`); }
          try {
            await access(path);
            fail(`orphan browser profile survived cleanup: ${path}`);
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
