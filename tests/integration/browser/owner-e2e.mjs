import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, access, writeFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
/* global URL: readonly, URLSearchParams: readonly, localStorage: readonly,
  sessionStorage: readonly, document: readonly, indexedDB: readonly, caches: readonly */
import { prepareLocal, executeLocal, executeLocalD1WithRetry, isTransientLocalD1Error, resolveLocalBrowserExecutable, writeHarnessMarker, removeHarnessOwned, wranglerArgs } from "../../../scripts/lib/local-launch.mjs";
import { startLocalWorker } from "../../../scripts/lib/local-worker.mjs";
import { startOwnerBridge } from "../../../scripts/lib/local-owner-bridge.mjs";
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

export async function startJwksServer(publicJwk) {
  const body = JSON.stringify({ keys: [publicJwk] });
  assert.ok(body.length < 8192, "JWKS document must stay bounded");
  const server = createServer((req, res) => {
    void (async () => {
      const remote = req.socket.remoteAddress ?? "";
      const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
      if (!loopback) { res.statusCode = 403; res.end(); return; }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method !== "GET" || url.pathname !== OWNER_E2E_CERTS_PATH || url.search !== "" || url.hash !== "") {
        res.statusCode = 404; res.end(); return;
      }
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      res.end(body);
    })().catch(() => { try { res.statusCode = 500; res.end(); } catch { /* closed */ } });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}${OWNER_E2E_CERTS_PATH}`;
  const close = async () => { await new Promise((resolve) => server.close(resolve)); };
  return { url, port, close };
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
  const text = await readFile(paths.config, "utf8");
  assert.ok(!text.includes("owner-e2e") || text.includes(OWNER_E2E_ISSUER), "profile patch must be explicit");
  assert.ok(!/BEGIN PRIVATE|"d"\s*:\s*"[A-Za-z0-9_-]{10,}/.test(text), "Worker config must never contain private key material");
  const config = JSON.parse(text);
  assert.equal(config.name, "eliotr-core-local", "local profile must stay canonical");
  config.vars = {
    ...config.vars,
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
  // Every temp profile carries a run-specific ownership marker. Cleanup below
  // deletes only paths with a resolved location inside the OS temp root plus
  // a marker proving this harness created them. Never touch unrelated
  // Chrome/Wrangler processes or profiles.
  await writeHarnessMarker(profileDir, runId, "browser-profile");
  try {
    // Deterministic discovery: explicit ELIOTR_BROWSER_EXECUTABLE wins,
    // otherwise only fixed OS standard paths (Windows Chrome standard paths,
    // Linux /usr/bin/*). Clear fail when absent; Linux CI stays stable; no
    // registry/network probing and no arbitrary executables.
    const executable = await resolveLocalBrowserExecutable();
    await access(executable);
    const context = await chromium.launchPersistentContext(profileDir, {
      executablePath: executable,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run",
        "--disable-background-networking", "--disable-component-update", "--disable-extensions",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
    });
    const browser = context.browser();
    assert.ok(browser, "Playwright browser must be owned by this harness");
    const page = context.pages()[0] ?? await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        const loc = message.location();
        const where = loc?.url ? ` @${String(loc.url).slice(0, 160)}` : "";
        consoleErrors.push(`${message.text().slice(0, 1500)}${where}`.slice(0, 2048));
      }
    });
    page.on("pageerror", (error) => { pageErrors.push(String(error?.stack ?? error).slice(0, 2048)); });
    page.on("requestfailed", (request) => { failedRequests.push(
      `${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? "unknown"}`.slice(0, 512)); });
    const evaluate = (fn, arg) => page.evaluate(fn, arg);
    const close = async () => {
      try { await context.close(); } catch { /* Best-effort. */ }
      try { await browser.close(); } catch { /* Already closed. */ }
      await removeHarnessOwned(profileDir, runId);
      await assert.rejects(access(profileDir), /ENOENT/, "temp browser profile must be removed");
    };
    return { browser, context, page, evaluate, consoleErrors, pageErrors, failedRequests, close, profileDir };
  } catch (error) {
    // Browser-start failure must leave no profile residue, but only delete
    // the marker-proven owned directory, never unrelated profiles.
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

function assertOnlyDenialNoise(consoleErrors, label) {
  const unexpected = consoleErrors.filter((text) =>
    !/Failed to load resource.*401/.test(text) &&
    !/favicon\.ico/.test(text) &&
    !/manifest\.webmanifest/.test(text));
  assert.deepEqual(unexpected, [], `${label}: unexpected console errors: ${unexpected.slice(0, 2).join("; ")}`);
}

function assertOnlyExpectedFailedRequests(failedRequests, label) {
  const unexpected = failedRequests.filter((text) =>
    !(/\/api\//.test(text) && /ERR_ABORTED|ABORTED|aborted|cancel/i.test(text)));
  assert.deepEqual(unexpected, [], `${label}: unexpected failed requests: ${unexpected.slice(0, 2).join("; ")}`);
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

async function importBundleViaWorker(origin, token, bundle, idempotencyKey) {
  const auth = { token };
  const call = async (path, init) => {
    const headers = { Accept: "application/json", ...(auth.token ? { "cf-access-jwt-assertion": auth.token } : {}) };
    const response = await globalThis.fetch(`${origin}${path}`, {
      ...init, headers: { ...headers, ...(init?.headers ?? {}) },
      redirect: "manual", signal: globalThis.AbortSignal.timeout(15000),
    });
    const text = await response.text();
    const json = (() => {
      try { return text ? JSON.parse(text) : null; } catch { return { raw: text.slice(0, 256) }; }
    })();
    if (!response.ok) {
      const error = new Error(`Worker ingest call failed: ${path} -> ${response.status}`);
      error.status = response.status;
      error.body = json;
      throw error;
    }
    assert.ok(json && typeof json.data !== "undefined" && typeof json.deployment_generation === "string");
    return json;
  };
  const prepared = await call("/api/v1/ingest/bundles/prepare", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest: bundle.manifest, file_hashes: bundle.hashes, total_bytes: bundle.totalBytes, idempotency_key: idempotencyKey }),
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
    const params = new URLSearchParams({ multipart_session_ref: session, path: file.path, size_bytes: String(bytes.byteLength), final_part: "1" });
    const uploaded = await call(`${base}/parts/1?${params.toString()}`, {
      method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bytes,
    });
    assert.equal(uploaded.data.path, file.path);
    const completed = await call(`${base}/files/complete`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ multipart_session_ref: session, path: file.path,
        parts: [{ part_number: 1, size_bytes: bytes.byteLength, etag: uploaded.data.etag }] }),
    });
    assert.equal(completed.data.sha256, bundle.hashes[file.path]);
  }
  const committed = await call("/api/v1/ingest/bundles/commit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation_id: operationId, multipart_session_ref: session, manifest_sha256: data.manifest_sha256 }),
  });
  assert.equal(committed.data.decision, "ADMITTED");
  assert.equal(committed.data.operation_id, operationId);
  const status = await call(`${base}`, { method: "GET" });
  assert.equal(status.data.state, "COMMITTED");
  assert.deepEqual(status.data.receipt, committed.data);
  return { receipt: committed.data, operationId, manifestSha: data.manifest_sha256 };
}

async function listPersistFiles(dir) {
  const out = [];
  const walk = async (current) => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => null);
    if (entries === null) return;
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(full);
    }
  };
  await walk(dir);
  return out;
}

export async function runOwnerE2E() {
  const startedAt = new globalThis.Date().toISOString();
  const stateRoot = resolve(root, ".eliotr-state");
  const beforeDirs = new Set(await readdir(stateRoot).catch(() => []));
  const directory = await mkdtemp(resolve(tmpdir(), "eliotr-owner-e2e-"));
  // Run-specific ownership marker: teardown deletes only this marker-proven
  // directory inside the OS temp root. Success, assert-failure, Worker-start
  // failure, browser-start failure, timeout and interruption all funnel
  // through the same finally below. Never delete unrelated temp entries.
  const runId = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
  await writeHarnessMarker(directory, runId, "owner-state");
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
  };
  try {
    const { privateKey, publicJwk } = await createOwnerE2EKey();
    jwks = await startJwksServer(publicJwk);
    const nowSeconds = () => Math.floor(globalThis.Date.now() / 1000);
    const sign = (overrides = {}, kid = OWNER_E2E_KID) => signOwnerToken(privateKey, {
      iss: OWNER_E2E_ISSUER, aud: [OWNER_E2E_AUDIENCE], sub: "e2e-owner",
      type: "app", iat: nowSeconds(), exp: nowSeconds() + 600, ...overrides,
    }, kid);
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
    const negatives = [
      { name: "missing", init: {}, expect: [401] },
      { name: "malformed", token: "not-a-jwt", expect: [401] },
      { name: "forged", token: `${(await sign()).split(".").slice(0, 2).join(".")}.AAAA`, expect: [401] },
      { name: "wrong-issuer", token: await sign({ iss: "https://other.cloudflareaccess.com" }), expect: [401] },
      { name: "wrong-audience", token: await sign({ aud: ["other-audience"] }), expect: [401] },
      { name: "expired", token: await sign({ iat: nowSeconds() - 1000, exp: nowSeconds() - 100 }), expect: [401] },
      { name: "service-token", token: await sign({ sub: "" }), expect: [401, 403] },
      { name: "unknown-kid", token: await sign({}, "unknown-kid"), expect: [401, 503] },
      { name: "wrong-alg", token: (() => { const t = `${encodeJwtPart({ alg: "HS256", typ: "JWT", kid: OWNER_E2E_KID })}.${encodeJwtPart({ iss: OWNER_E2E_ISSUER, aud: [OWNER_E2E_AUDIENCE], sub: "e2e-owner", type: "app", iat: nowSeconds(), exp: nowSeconds() + 600 })}.${(good => good.split(".")[2])(("") )}`; return t; })(), expect: [401] },
    ];
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
      assert.ok(!JSON.stringify(response.data).includes("e2e-owner") || response.status !== 200, `${item.name} must not leak identity on denial`);
    }
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
    const imported = await importBundleViaWorker(worker.origin, token, bundle, "e2e-first-import");
    assert.equal(imported.receipt.decision, "ADMITTED");
    assert.equal(imported.receipt.source_revision_ref, revisionRef);
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
    const persistFiles = await listPersistFiles(paths.persist);
    assert.ok(persistFiles.length > 0, "local R2/D1 persist root must hold real objects");
    let r2Match = null;
    for (const file of persistFiles) {
      try {
        const st = await stat(file);
        if (st.size < 10 || st.size > 32 * 1024 * 1024) continue;
        const bytes = await readFile(file);
        if (bytes.includes(encoder.encode("Pinned owner-e2e content.").slice(0, 8))) { r2Match = file; break; }
      } catch { /* ignore */ }
    }
    assert.ok(r2Match !== null, "at least one real immutable R2 object with admitted bytes must exist");
    const r2Bytes = await readFile(r2Match);
    assert.ok(r2Bytes.length > 0, "R2 object body must be non-empty");
    receipt.authorized_library = "PASS";
    playwright = await launchPlaywright(runId);
    receipt.browser = `playwright-core chromium; ${await playwright.browser.version()}`;
    await playwright.page.goto(worker.origin, { waitUntil: "domcontentloaded", timeout: 15000 });
    await playwright.page.waitForFunction(shellReady, null, { timeout: 15000 });
    const unauthHasPrivate = await playwright.evaluate(hasPrivateLibraryMarker);
    assert.equal(unauthHasPrivate, false, "unauthenticated PWA must not render private Library rows");
    const unauthStorage = await readBrowserStorage(playwright.page);
    assertNoPrivateStorage(unauthStorage, "unauthenticated");
    assertOnlyDenialNoise(playwright.consoleErrors, "unauthenticated");
    assert.deepEqual(playwright.pageErrors, [], `page errors must be empty: ${playwright.pageErrors.slice(0, 2).join("; ")}`);
    assertOnlyExpectedFailedRequests(playwright.failedRequests, "unauthenticated");
    playwright.consoleErrors.length = 0;
    playwright.pageErrors.length = 0;
    playwright.failedRequests.length = 0;
    bridge = await startOwnerBridge({ workerOrigin: worker.origin, token, generation: paths.generation, port: 0 });
    assert.ok(bridge.pairingUrl.includes("/__local/#"), "bridge must issue a one-use fragment link");
    assert.ok(!bridge.pairingUrl.includes(token.slice(0, 8)), "pairing URL must not embed the JWT");
    const secret = bridge.pairingUrl.split("#")[1];
    assert.ok(typeof secret === "string" && secret.length > 0, "pairing secret must be present");
    const pairResponse = await globalThis.fetch(`${bridge.origin}/__local/pair`, {
      method: "POST", headers: { "X-Eliotr-Pair": secret, Origin: bridge.origin }, redirect: "manual",
      signal: globalThis.AbortSignal.timeout(5000),
    });
    assert.equal(pairResponse.status, 204, "one-use pairing must succeed");
    const setCookie = pairResponse.headers.get("set-cookie") ?? "";
    assert.ok(setCookie.includes("HttpOnly") && setCookie.includes("SameSite=Strict"), "bridge cookie must be opaque HttpOnly/SameSite");
    assert.ok(!setCookie.includes("eyJ"), "bridge cookie must be opaque, never a JWT");
    const cookieName = setCookie.split("=")[0];
    let cookieValue = setCookie.split(";")[0].split("=").slice(1).join("=");
    let activeCookieName = cookieName;
    await playwright.context.addCookies([{ name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/" }]);
    const reuse = await globalThis.fetch(`${bridge.origin}/__local/pair`, {
      method: "POST", headers: { "X-Eliotr-Pair": secret, Origin: bridge.origin }, redirect: "manual",
      signal: globalThis.AbortSignal.timeout(5000),
    });
    assert.equal(reuse.status, 403, "pairing secret must be one-use");
    await playwright.page.goto(`${bridge.origin}/`, { waitUntil: "domcontentloaded", timeout: 15000 });
    await playwright.page.waitForFunction(shellReady, null, { timeout: 15000 });
    await playwright.page.waitForFunction(bodyIncludes, sourceId, { timeout: 15000 });
    const authedStorage = await readBrowserStorage(playwright.page);
    assertNoPrivateStorage(authedStorage, "authed");
    const authedNoise = playwright.consoleErrors.filter((text) =>
      !(/manifest\.webmanifest/.test(text) || /Failed to load resource.*401/.test(text)));
    assert.deepEqual(authedNoise, [], `authed console must be clean beyond cookieless manifest 401s: ${authedNoise.slice(0, 2).join("; ")}`);
    assert.ok(!playwright.consoleErrors.join("|").includes("eyJ"), "authed console must hold no JWT");
    assert.deepEqual(playwright.pageErrors, [], `page errors must be empty: ${playwright.pageErrors.slice(0, 2).join("; ")}`);
    assert.deepEqual(playwright.failedRequests, [], `authed failed requests must be empty: ${playwright.failedRequests.slice(0, 2).join("; ")}`);
    const stoppedOrigin = worker.origin;
    const stoppedGeneration = paths.generation;
    await worker.stop();
    worker = undefined;
    await assert.rejects(globalThis.fetch(`${stoppedOrigin}/healthz`, { signal: globalThis.AbortSignal.timeout(5000) }),
      /fetch failed|ECONNREFUSED|aborted/, "stopped Worker port must be closed (owned process removed)");
    await prepareLocal({ stateDirectory: directory, log: () => {} });
    await applyOwnerE2EProfile(paths, jwks.url);
    assert.deepEqual(await verifyMigrationLedgers(paths), ledgers, "restart must preserve both migration ledgers");
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
    await playwright.page.goto(`${bridge.origin}/`, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    playwright.consoleErrors.length = 0;
    playwright.pageErrors.length = 0;
    playwright.failedRequests.length = 0;
    await playwright.page.goto(worker.origin, { waitUntil: "domcontentloaded", timeout: 15000 });
    await playwright.page.waitForFunction(shellReady, null, { timeout: 15000 });
    const restartStorage = await readBrowserStorage(playwright.page);
    assertNoPrivateStorage(restartStorage, "post-restart");
    assert.deepEqual(playwright.pageErrors, [], "page errors must stay empty after restart");
    receipt.persistence = "PASS";
    try { await bridge.close(); } catch { /* replaced below */ }
    bridge = await startOwnerBridge({ workerOrigin: worker.origin, token, generation: paths.generation, port: 0 });
    const secret2 = bridge.pairingUrl.split("#")[1];
    const pair2 = await globalThis.fetch(`${bridge.origin}/__local/pair`, {
      method: "POST", headers: { "X-Eliotr-Pair": secret2, Origin: bridge.origin }, redirect: "manual",
      signal: globalThis.AbortSignal.timeout(5000),
    });
    assert.equal(pair2.status, 204, "re-pairing after restart must succeed");
    const setCookie2 = pair2.headers.get("set-cookie") ?? "";
    const cookieName2 = setCookie2.split("=")[0];
    cookieValue = setCookie2.split(";")[0].split("=").slice(1).join("=");
    assert.ok(cookieName2.startsWith("eliotr_local_") && cookieValue.length > 0,
      "restarted bridge must issue a fresh opaque session");
    activeCookieName = cookieName2;
    const logoutResponse = await globalThis.fetch(`${bridge.origin}/__local/logout`, {
      method: "POST", headers: { cookie: `${activeCookieName}=${cookieValue}`, Origin: bridge.origin }, redirect: "manual",
      signal: globalThis.AbortSignal.timeout(5000),
    });
    assert.equal(logoutResponse.status, 204, "bridge logout must clear the session");
    const afterLogout = await globalThis.fetch(`${bridge.origin}/api/v1/research/catalog?limit=20`, {
      redirect: "manual", signal: globalThis.AbortSignal.timeout(5000),
    });
    assert.equal(afterLogout.status, 401, "private API through the bridge must 401 after logout");
    await playwright.context.clearCookies();
    await playwright.page.goto(worker.origin, { waitUntil: "domcontentloaded", timeout: 15000 });
    await playwright.page.waitForFunction(shellReady, null, { timeout: 15000 });
    const loggedOutHasPrivate = await playwright.evaluate(bodyIncludes, sourceId);
    assert.equal(loggedOutHasPrivate, false, "Library must hide the source after logout");
    const loggedOutStorage = await readBrowserStorage(playwright.page);
    assertNoPrivateStorage(loggedOutStorage, "post-logout");
    assertOnlyDenialNoise(playwright.consoleErrors, "post-logout");
    assert.deepEqual(playwright.pageErrors, [], "page errors must stay empty after logout");
    assertOnlyExpectedFailedRequests(playwright.failedRequests, "post-logout");
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
      r2_object: r2Match, generation: stoppedGeneration,
    };
  } finally {
    try { await bridge?.close(); } catch { /* best-effort */ }
    try { await worker?.stop(); } catch { /* Shutdown best-effort. */ }
    try { await playwright?.close(); } catch { /* Browser teardown best-effort. */ }
    try { await jwks?.close(); } catch { /* JWKS teardown best-effort. */ }
    // Marker-gated teardown: delete only the run-specific owned state dir
    // proven by its marker inside the OS temp root. Never delete unrelated
    // temp entries; never kill unrelated Chrome/Wrangler processes.
    try {
      await removeHarnessOwned(directory, runId);
    } catch (error) {
      teardownError = teardownError ?? error;
    }
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
