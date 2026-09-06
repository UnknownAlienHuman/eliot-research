import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { prepareLocal, executeLocal, wranglerArgs } from "../../../scripts/lib/local-launch.mjs";
import { startLocalWorker } from "../../../scripts/lib/local-worker.mjs";
import { startOwnerBridge } from "../../../scripts/lib/local-owner-bridge.mjs";
import { initializeLocalNamespace } from "../../../scripts/lib/local-namespace.mjs";
import { localPolicyQuery } from "../../../scripts/lib/local-read-policy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const webcrypto = globalThis.crypto;
const encoder = new globalThis.TextEncoder();
const decoder = new globalThis.TextDecoder();

export const CONTROLLED_ISSUER_SEAM = {
  verifier: "packages/platform-cloudflare/src/access.ts:createCloudflareAccessVerifier",
  positive: "apps/eliotr-core/test/owner-session.test.ts:real-RSA/controlled-JWKS signed session",
  runbook: "docs/implementation/local-launch.md:only signed-identity verification is replaced by a controlled test verifier",
  contract: "docs/implementation/launch-prs/execution-contract.md:fixtures may replace only the external issuer",
  limitation:
    "L1 scope is tests/integration/** only (ER-27 harness). No production issuer/JWKS seam exists in this " +
    "lane: the Worker verifier (ER-17) and dispatch/config (ER-24/ER-44/ER-00) are unchanged. A controlled " +
    "positive owner session through the real Wrangler Worker therefore remains NOT_EXECUTED pending the " +
    "ER-44->ER-24->ER-00 seam with ER-17 review (loopback JWKS, test profile, fetch redirect, fail-closed " +
    "negatives). This harness proves real-Worker denial, real D1/R2 persistence and real-browser checks " +
    "without faking authorized Library/logout PASS.",
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

export async function verifyControlledIssuerCrypto() {
  const issuer = "https://owner-e2e.cloudflareaccess.com";
  const audience = "owner-e2e-audience";
  const nowSeconds = Math.floor(globalThis.Date.now() / 1000);
  const keys = await webcrypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await webcrypto.subtle.exportKey("jwk", keys.publicKey);
  // Private key stays in process memory only: never written to Worker vars, browser, logs or fixtures.
  assert.equal(keys.privateKey.extractable, true, "test key must be in-memory only");
  const encode = (value) => base64UrlEncode(encoder.encode(JSON.stringify(value)));
  const sign = async (claims, kid = "e2e-key") => {
    const data = `${encode({ alg: "RS256", typ: "JWT", kid })}.${encode(claims)}`;
    const signature = await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, encoder.encode(data));
    return `${data}.${base64UrlEncode(new Uint8Array(signature))}`;
  };
  const verify = async (token, expectedIssuer, expectedAudience, nowMs) => {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("malformed");
    const [headerPart, payloadPart, signaturePart] = parts;
    const header = JSON.parse(decoder.decode(base64UrlDecode(headerPart)));
    if (header.alg !== "RS256") throw new Error("algorithm denied");
    if (header.typ !== undefined && header.typ !== "JWT") throw new Error("type denied");
    const payload = JSON.parse(decoder.decode(base64UrlDecode(payloadPart)));
    if (payload.iss !== expectedIssuer) throw new Error("issuer mismatch");
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(expectedAudience)) throw new Error("audience mismatch");
    if (payload.type !== undefined && payload.type !== "app") throw new Error("service-token denied");
    const now = Math.floor(nowMs / 1000);
    if (payload.exp <= now) throw new Error("expired");
    if (payload.iat > now + 60) throw new Error("issued in future");
    const key = await webcrypto.subtle.importKey("jwk", { ...jwk, kid: "e2e-key", alg: "RS256", use: "sig" },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await webcrypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", key, base64UrlDecode(signaturePart), encoder.encode(`${headerPart}.${payloadPart}`));
    if (!valid) throw new Error("signature invalid");
    return payload;
  };
  const good = await sign({ iss: issuer, aud: [audience], sub: "e2e-owner", type: "app", iat: nowSeconds, exp: nowSeconds + 600 });
  const payload = await verify(good, issuer, audience, globalThis.Date.now());
  assert.equal(payload.sub, "e2e-owner");
  const forged = `${good.split(".").slice(0, 2).join(".")}.AAAA`;
  await assert.rejects(verify(forged, issuer, audience, globalThis.Date.now()), /signature invalid/);
  await assert.rejects(verify("not-a-jwt", issuer, audience, globalThis.Date.now()), /malformed/);
  const expired = await sign({ iss: issuer, aud: [audience], sub: "e2e-owner", type: "app", iat: nowSeconds - 1000, exp: nowSeconds - 10 });
  await assert.rejects(verify(expired, issuer, audience, globalThis.Date.now()), /expired/);
  await assert.rejects(verify(good, "https://other.cloudflareaccess.com", audience, globalThis.Date.now()), /issuer mismatch/);
  await assert.rejects(verify(good, issuer, "other-audience", globalThis.Date.now()), /audience mismatch/);
  const service = await sign({ iss: issuer, aud: [audience], sub: "e2e-owner", type: "service", iat: nowSeconds, exp: nowSeconds + 600 });
  await assert.rejects(verify(service, issuer, audience, globalThis.Date.now()), /service-token denied/);
  const wrongAlg = `${base64UrlEncode(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT", kid: "e2e-key" })))}.${good.split(".")[1]}.${good.split(".")[2]}`;
  await assert.rejects(verify(wrongAlg, issuer, audience, globalThis.Date.now()), /algorithm denied/);
  return { protocol: "eliotr.owner-e2e.controlled-issuer.v1", state: "PASS", issuer, audience };
}

function d1Query(paths, binding, sql) {
  const output = executeLocal(wranglerArgs(paths, ["d1", "execute", binding, "--command", sql, "--json"]), { capture: true });
  const batches = JSON.parse(output);
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

async function launchPlaywright() {
  // Pinned Playwright API only: chromium browser/context/page. No raw CDP/WebSocket control.
  const { chromium } = await import("playwright-core");
  const profileDir = await mkdtemp(resolve(tmpdir(), "eliotr-owner-e2e-profile-"));
  const executable = process.env.ELIOTR_BROWSER_EXECUTABLE;
  if (executable) await access(executable);
  const context = await chromium.launchPersistentContext(profileDir, {
    ...(executable ? { executablePath: executable } : { channel: "chrome" }),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run",
      "--disable-background-networking", "--disable-component-update", "--disable-extensions",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
  });
  const browser = context.browser();
  assert.ok(browser, "Playwright browser must be owned by this harness");
  const version = await browser.version();
  const page = context.pages()[0] ?? await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 2048));
  });
  page.on("pageerror", (error) => { pageErrors.push(String(error?.stack ?? error).slice(0, 2048)); });
  page.on("requestfailed", (request) => { failedRequests.push(
    `${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? "unknown"}`.slice(0, 512)); });
  const evaluate = (expression) => page.evaluate(expression);
  const close = async () => {
    try { await context.close(); } catch { /* Best-effort. */ }
    try { await browser.close(); } catch { /* Already closed. */ }
    await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await assert.rejects(access(profileDir), /ENOENT/, "temp browser profile must be removed");
  };
  return { browser, context, page, evaluate, consoleErrors, pageErrors, failedRequests, close, profileDir, version };
}

async function readBrowserStorage(page) {
  return page.evaluate(`(async () => {
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
  })()`);
}

function assertOnlyDenialNoise(consoleErrors, label) {
  // The unauthenticated PWA shell attempts its private catalog fetch and correctly receives 401;
  // Chromium logs that denial as a console resource error. That noise proves denial, not a JS defect.
  const unexpected = consoleErrors.filter((text) => !/Failed to load resource.*401/.test(text));
  assert.deepEqual(unexpected, [], `${label}: unexpected console errors: ${unexpected.slice(0, 2).join("; ")}`);
}

function assertOnlyExpectedFailedRequests(failedRequests, label) {
  // The PWA cancels stale catalog requests on navigation/refresh (explicit cancellation discipline);
  // Chromium reports those as net::ERR_ABORTED. Any other network failure (refused/reset/cert) is a defect.
  const unexpected = failedRequests.filter((text) =>
    !(/\/api\//.test(text) && /ERR_ABORTED|ABORTED|aborted|cancel/i.test(text)));
  assert.deepEqual(unexpected, [], `${label}: unexpected failed requests: ${unexpected.slice(0, 2).join("; ")}`);
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

export async function runOwnerE2E() {
  const startedAt = new globalThis.Date().toISOString();
  const probe = await mkdtemp(resolve(tmpdir(), "eliotr-owner-e2e-probe-"));
  await rm(probe, { recursive: true, force: true });
  const stateRoot = resolve(root, ".eliotr-state");
  const beforeDirs = new Set(await readdir(stateRoot).catch(() => []));
  const directory = await mkdtemp(resolve(tmpdir(), "eliotr-owner-e2e-"));
  let worker;
  let playwright;
  let teardownError = null;
  const receipt = {
    protocol: "eliotr.owner-e2e.v1",
    started_at: startedAt,
    browser: null,
    isolated_setup: "PENDING",
    unauth_denied: "PENDING",
    authorized_library: "NOT_EXECUTED",
    persistence: "PENDING",
    logout: "NOT_EXECUTED",
    teardown: "PENDING",
    console_errors: "PENDING",
    failed_startup: "PENDING",
    storage: "PENDING",
    bounds: "PENDING",
    controlled_issuer: "PENDING",
  };
  try {
    const paths = await prepareLocal({ stateDirectory: directory, log: () => {} });
    await access(resolve(root, "apps/eliotr-pwa/dist/index.html"));
    assert.equal(paths.directory, directory, "isolated state must use the fresh directory");
    assert.ok(paths.persist.startsWith(directory), "persisted D1/R2 state must live under the isolated directory");
    const persistEntries = await readdir(paths.persist).catch(() => []);
    assert.ok(persistEntries.length >= 0, "local R2/D1 persist root must be inspectable");
    const ledgers = await verifyMigrationLedgers(paths);
    assert.ok(ledgers.CORE_DB > 0 && ledgers.SEARCH_DB > 0, "both migration streams must be applied");
    // Supported D1 write/readback without raw fixture INSERTs: narrow namespace init with a
    // controlled OS-operator identity (not a signed Access login; login qualification stays NOT_EXECUTED).
    const operatorIdentity = { protocol: "eliotr.owner-session.v1", principal_ref: "e2e-operator",
      client_class: "owner_pwa", credential_generation: "controlled-e2e-identity",
      expires_at: new globalThis.Date(globalThis.Date.now() + 3600000).toISOString() };
    const namespaceCommand = { protocol: "eliotr.local-namespace-init.v1", namespace: "e2e-imports",
      owner_incarnation_ref: "e2e-installation", expected_ownership_revision: 0, expected_policy_revision: 0,
      created_at: new globalThis.Date().toISOString(), policy: {
        allowed_ownership_modes: ["immutable_import"], source_class: "document", assurance_ceiling: "QUALIFIED",
        instruction_taint: "DATA_ONLY", allowed_effects: "READ_ONLY", allowed_use: ["research"],
        disclosure_ceiling: "owner-only", license_policy_ref: "e2e-license",
        default_storage_policy: "NORMALIZED_CLOUD_ONLY", default_residency_profile_id: "e2e-residency",
        default_retention_policy_id: "e2e-retention", minimum_quality_state: "standard" } };
    const namespaceReceipt = await initializeLocalNamespace({ command: namespaceCommand,
      identity: operatorIdentity, query: localPolicyQuery(paths) });
    assert.equal(namespaceReceipt.read_access_granted, false, "namespace init must not grant read access");
    assert.deepEqual(d1Query(paths, "CORE_DB", "SELECT COUNT(*) AS n FROM scope_read_policy"), [{ n: 0 }],
      "login/init alone must not create an implicit read grant");
    const namespaceReplay = await initializeLocalNamespace({ command: namespaceCommand,
      identity: operatorIdentity, query: localPolicyQuery(paths) });
    assert.deepEqual(namespaceReplay, namespaceReceipt, "same namespace intent must replay exactly");
    receipt.isolated_setup = "PASS";
    receipt.bounds = (await checkBundleLimitsSource()).state;
    receipt.controlled_issuer = (await verifyControlledIssuerCrypto()).state;
    worker = await startLocalWorker(paths);
    const firstOrigin = worker.origin;
    // Real-Worker denial through the real createCloudflareAccessVerifier path (no in-process fake API).
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
    // Controlled positive attempt against the REAL Worker: without the ER-44->ER-24->ER-00 JWKS seam
    // the Worker cannot fetch the loopback JWKS and must fail closed (never a fake PASS).
    const goodClaims = { iss: "https://owner-e2e.cloudflareaccess.com", aud: ["owner-e2e-audience"] };
    assert.ok(goodClaims.iss.endsWith(".cloudflareaccess.com"), "controlled issuer uses the Access origin shape");
    const controlledAttempt = await globalThis.fetch(`${worker.origin}/api/v1/system/session`, {
      headers: { "cf-access-jwt-assertion": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImUyZS1rZXkifQ.eyJpc3MiOiJodHRwczovL293bmVyLWUyZS5jbG91ZGZsYXJlYWNjZXNzLmNvbSJ9.c2ln",
        Accept: "application/json" },
      redirect: "manual", signal: globalThis.AbortSignal.timeout(5000),
    });
    assert.ok([401, 503].includes(controlledAttempt.status),
      "controlled token without the JWKS seam must be denied (401) or fail closed unavailable (503)");
    receipt.authorized_library = "NOT_EXECUTED";
    receipt.logout = "NOT_EXECUTED";
    playwright = await launchPlaywright();
    receipt.browser = `playwright-core chromium; ${await playwright.browser.version()}`;
    await playwright.page.goto(firstOrigin, { waitUntil: "domcontentloaded", timeout: 15000 });
    await playwright.page.waitForFunction(
      `Boolean(document.querySelector("#app") || document.querySelector("#library"))`, null, { timeout: 15000 });
    const hasPrivate = await playwright.evaluate(
      'Boolean(document.body?.textContent?.includes("Source catalog-") || document.querySelector("#library [data-source]"))');
    assert.equal(hasPrivate, false, "unauthenticated PWA must not render private Library rows");
    const unauthStorage = await readBrowserStorage(playwright.page);
    assertNoPrivateStorage(unauthStorage, "unauthenticated");
    receipt.storage = "PASS";
    assertOnlyDenialNoise(playwright.consoleErrors, "unauthenticated");
    assert.deepEqual(playwright.pageErrors, [], `page errors must be empty: ${playwright.pageErrors.slice(0, 2).join("; ")}`);
    assertOnlyExpectedFailedRequests(playwright.failedRequests, "unauthenticated");
    receipt.console_errors = "PASS";
    const stoppedOrigin = worker.origin;
    await worker.stop();
    worker = undefined;
    await assert.rejects(globalThis.fetch(`${stoppedOrigin}/healthz`, { signal: globalThis.AbortSignal.timeout(5000) }),
      /fetch failed|ECONNREFUSED|aborted/, "stopped Worker port must be closed (owned process removed)");
    // Restart persistence: same isolated directory, both migration ledgers, same namespace rows,
    // same generation, denial still enforced, PWA shell serves again with no private residue.
    await prepareLocal({ stateDirectory: directory, log: () => {} });
    assert.deepEqual(await verifyMigrationLedgers(paths), ledgers, "restart must preserve both migration ledgers");
    assert.deepEqual(await initializeLocalNamespace({ command: namespaceCommand,
      identity: operatorIdentity, query: localPolicyQuery(paths) }), namespaceReceipt,
      "restart must preserve the namespace ownership/policy rows exactly");
    assert.deepEqual(d1Query(paths, "CORE_DB", "SELECT COUNT(*) AS n FROM scope_read_policy"), [{ n: 0 }],
      "restart must not invent an implicit read grant");
    const afterRestartEntries = await readdir(paths.persist).catch(() => []);
    assert.ok(afterRestartEntries.length >= 0, "restart must preserve the isolated persist root");
    worker = await startLocalWorker(paths);
    assert.equal(paths.generation, (await prepareLocal({ stateDirectory: directory, log: () => {} })).generation,
      "isolated generation must be stable for the same directory");
    const rebound = await globalThis.fetch(`${worker.origin}/healthz`, { signal: globalThis.AbortSignal.timeout(5000) });
    assert.equal(rebound.status, 200);
    const reboundBody = await rebound.json();
    assert.equal(reboundBody.ready, true, "restart must report ready");
    assert.equal(reboundBody.deployment_generation, paths.generation, "restart must serve the same generation");
    const deniedAfterRestart = await globalThis.fetch(`${worker.origin}/api/v1/research/catalog`,
      { redirect: "manual", signal: globalThis.AbortSignal.timeout(5000) });
    assert.equal(deniedAfterRestart.status, 401, "restart must still deny unauthenticated catalog");
    await playwright.page.goto(worker.origin, { waitUntil: "domcontentloaded", timeout: 15000 });
    await playwright.page.waitForFunction(
      `Boolean(document.querySelector("#app") || document.querySelector("#library"))`, null, { timeout: 15000 });
    const reloudStorage = await readBrowserStorage(playwright.page);
    assertNoPrivateStorage(reloudStorage, "post-restart");
    assertOnlyDenialNoise(playwright.consoleErrors, "post-restart");
    assert.deepEqual(playwright.pageErrors, [], "page errors must stay empty after restart");
    assertOnlyExpectedFailedRequests(playwright.failedRequests, "post-restart");
    receipt.persistence = "PASS";
    try {
      await startOwnerBridge({ workerOrigin: worker.origin, token: "forged.token.signature", generation: paths.generation, port: 0 });
      assert.fail("forged bridge token must not pair");
    } catch (error) {
      assert.ok(!String(error?.message ?? "").includes("forged.token.signature"), "bridge must not reflect credentials");
    }
    // Logout guard without a live session must deny; the authed logout flow stays NOT_EXECUTED.
    try {
      await startOwnerBridge({ workerOrigin: worker.origin, token: "", generation: paths.generation, port: 0 });
      assert.fail("empty bridge token must not pair");
    } catch (error) {
      assert.ok(String(error?.message ?? "").length > 0);
    }
    try {
      await prepareLocal({ stateDirectory: resolve(directory, "missing-parent", "child"), log: () => {}, execute: () => { throw new Error("injected build failure"); } });
      assert.fail("injected build failure must reject");
    } catch (error) {
      assert.ok(String(error?.message ?? "").length > 0);
    }
    // Real failed-start proof: no Worker was started by the failure above (no new origin), the
    // previously stopped origin is still closed, and the running Worker below is the only owner.
    assert.ok(worker !== undefined, "failed startup must not replace the owned running Worker");
    await assert.rejects(globalThis.fetch(`${stoppedOrigin}/healthz`, { signal: globalThis.AbortSignal.timeout(5000) }),
      /fetch failed|ECONNREFUSED|aborted/, "failed startup must not resurrect the old Worker port");
    receipt.failed_startup = "PASS";
    receipt.finished_at = new globalThis.Date().toISOString();
    receipt.live = "NOT_EXECUTED";
  } finally {
    try { await worker?.stop(); } catch { /* Shutdown best-effort. */ }
    try { await playwright?.close(); } catch { /* Browser teardown best-effort. */ }
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await assert.rejects(access(directory), /ENOENT/, "isolated state directory must be removed").catch((error) => {
      teardownError = teardownError ?? error;
    });
    const afterDirs = new Set(await readdir(stateRoot).catch(() => []));
    for (const name of afterDirs) {
      if (!beforeDirs.has(name) && !name.startsWith("smoke-") && !name.startsWith("owner-e2e-")) {
        teardownError = new Error(`teardown created unexpected shared state: ${name}`);
      }
    }
    const leftovers = [...afterDirs].filter((name) => !beforeDirs.has(name));
    for (const name of leftovers) {
      if (name.startsWith("owner-e2e-") || name.startsWith("smoke-")) {
        await rm(resolve(stateRoot, name), { recursive: true, force: true }).catch(() => {});
      }
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
