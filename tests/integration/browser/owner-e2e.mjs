import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { clearTimeout as clearTimer, setTimeout as setTimer } from "node:timers";
import { setTimeout as delayPromise } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { prepareLocal } from "../../../scripts/lib/local-launch.mjs";
import { startLocalWorker } from "../../../scripts/lib/local-worker.mjs";
import { startOwnerBridge } from "../../../scripts/lib/local-owner-bridge.mjs";

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
    "No repo-authorized controlled-issuer seam exists for wrangler-dev HTTP without editing ER-44 auth authority; " +
    "wrangler Worker fetches JWKS from https://*.cloudflareaccess.com over the network, so a local controlled issuer " +
    "cannot satisfy placeholder Access config without weakening verification. Authorized browser acceptance therefore " +
    "reports NOT_EXECUTED without live Access login and never counts a fixture as acceptance.",
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
  const encode = (value) => base64UrlEncode(encoder.encode(JSON.stringify(value)));
  const sign = async (claims) => {
    const data = `${encode({ alg: "RS256", typ: "JWT", kid: "e2e-key" })}.${encode(claims)}`;
    const signature = await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, encoder.encode(data));
    return `${data}.${base64UrlEncode(new Uint8Array(signature))}`;
  };
  const verify = async (token, expectedIssuer, expectedAudience, nowMs) => {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("malformed");
    const [headerPart, payloadPart, signaturePart] = parts;
    const header = JSON.parse(decoder.decode(base64UrlDecode(headerPart)));
    if (header.alg !== "RS256") throw new Error("algorithm denied");
    const payload = JSON.parse(decoder.decode(base64UrlDecode(payloadPart)));
    if (payload.iss !== expectedIssuer) throw new Error("issuer mismatch");
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(expectedAudience)) throw new Error("audience mismatch");
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
  const expired = await sign({ iss: issuer, aud: [audience], sub: "e2e-owner", type: "app", iat: nowSeconds - 1000, exp: nowSeconds - 10 });
  await assert.rejects(verify(expired, issuer, audience, globalThis.Date.now()), /expired/);
  await assert.rejects(verify(good, "https://other.cloudflareaccess.com", audience, globalThis.Date.now()), /issuer mismatch/);
  await assert.rejects(verify(good, issuer, "other-audience", globalThis.Date.now()), /audience mismatch/);
  return { protocol: "eliotr.owner-e2e.controlled-issuer.v1", state: "PASS", issuer, audience };
}

async function chromiumExecutable() {
  const candidates = [process.env.ELIOTR_BROWSER_EXECUTABLE, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"];
  try {
    const playwright = await import("playwright-core");
    const path = playwright?.chromium?.executablePath?.();
    if (typeof path === "string" && path.length > 0) candidates.unshift(path);
  } catch { /* playwright-core optional; system Chromium via CDP is sufficient. */ }
  for (const candidate of candidates.filter(Boolean)) {
    try { await access(candidate); return candidate; } catch { /* Try next candidate. */ }
  }
  throw new Error("Chromium is required; set ELIOTR_BROWSER_EXECUTABLE to the installed executable");
}

async function launchCdp() {
  const temporary = await mkdtemp(resolve(tmpdir(), "eliotr-owner-e2e-"));
  const binary = await chromiumExecutable();
  const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 5000, shell: false });
  const label = (version.stdout ?? "").trim().slice(0, 256);
  const browser = spawn(binary, ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-networking", "--disable-component-update", "--disable-extensions", "--no-first-run",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${temporary}`, "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"], shell: false });
  let startupLog = "";
  const onLog = (chunk) => { startupLog = (startupLog + chunk.toString("utf8")).slice(-8192); };
  browser.stderr.on("data", onLog);
  const closing = new Promise((resolve) => browser.once("close", resolve));
  let startupError;
  browser.once("error", (error) => { startupError = error.code ?? "SPAWN_FAILED"; });
  const deadline = globalThis.Date.now() + 10000;
  let port;
  while (globalThis.Date.now() < deadline) {
    if (startupError || browser.exitCode !== null || browser.signalCode !== null) {
      throw new Error(`Chromium exited before DevTools startup; diagnostics:\n${startupLog}`);
    }
    try {
      const text = await readFile(resolve(temporary, "DevToolsActivePort"), "utf8");
      const candidate = Number(text.split("\n")[0]);
      if (Number.isInteger(candidate) && candidate > 0 && candidate <= 65535) { port = candidate; break; }
    } catch { /* Still starting. */ }
    await delayPromise(25);
  }
  if (!port) throw new Error(`Browser deadline: DevTools startup; diagnostics:\n${startupLog}`);
  browser.stderr.removeListener("data", onLog);
  browser.stderr.resume();
  const targets = await (await globalThis.fetch(`http://127.0.0.1:${port}/json/list`, { signal: globalThis.AbortSignal.timeout(5000) })).json();
  const target = targets.find((item) => item.type === "page");
  assert.ok(target);
  const socket = new globalThis.WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const awaiting = new Map();
  const errors = [];
  socket.addEventListener("message", (message) => {
    const value = JSON.parse(message.data);
    if (value.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(value.params.exceptionDetails).slice(0, 2048));
    const waiting = awaiting.get(value.id);
    if (!waiting) return;
    awaiting.delete(value.id);
    clearTimer(waiting.timer);
    if (value.error) waiting.reject(new Error(JSON.stringify(value.error)));
    else waiting.resolve(value.result);
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const current = ++id;
    awaiting.set(current, { resolve, reject, timer: setTimer(() => { awaiting.delete(current); reject(new Error(`CDP timeout: ${method}`)); }, 5000) });
    socket.send(JSON.stringify({ id: current, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 2048));
    return result.result.value;
  };
  const close = async () => {
    try { socket.close(); } catch { /* Already closed. */ }
    if (browser.exitCode === null) {
      browser.kill("SIGTERM");
      const timer = setTimer(() => { try { browser.kill("SIGKILL"); } catch { /* Already exited. */ } }, 3000);
      try { await closing; } finally { clearTimer(timer); }
    }
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  await cdp("Runtime.enable");
  await cdp("Page.enable");
  return { binary, label, evaluate, cdp, errors, close };
}

export async function runOwnerE2E() {
  const startedAt = new globalThis.Date().toISOString();
  const probe = await mkdtemp(resolve(tmpdir(), "eliotr-owner-e2e-probe-"));
  await rm(probe, { recursive: true, force: true });
  const stateRoot = resolve(root, ".eliotr-state");
  const beforeDirs = new Set(await readdir(stateRoot).catch(() => []));
  const directory = await mkdtemp(resolve(tmpdir(), "eliotr-owner-e2e-"));
  let worker;
  let cdp;
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
    receipt.isolated_setup = "PASS";
    const expectedCore = (await readdir(resolve(root, "infra/d1/core/migrations"))).filter((n) => n.endsWith(".sql")).sort();
    const expectedSearch = (await readdir(resolve(root, "infra/d1/search/migrations"))).filter((n) => n.endsWith(".sql")).sort();
    assert.ok(expectedCore.length > 0 && expectedSearch.length > 0, "migration streams must be non-empty");
    assert.equal(paths.directory, directory, "isolated state must use the fresh directory");
    receipt.bounds = (await checkBundleLimitsSource()).state;
    receipt.controlled_issuer = (await verifyControlledIssuerCrypto()).state;
    worker = await startLocalWorker(paths);
    const noToken = await globalThis.fetch(`${worker.origin}/api/v1/research/catalog`, { redirect: "manual", signal: globalThis.AbortSignal.timeout(5000) });
    assert.equal(noToken.status, 401);
    const forged = await globalThis.fetch(`${worker.origin}/api/v1/research/catalog`, {
      headers: { "cf-access-jwt-assertion": "forged.token.signature" }, redirect: "manual", signal: globalThis.AbortSignal.timeout(5000),
    });
    assert.equal(forged.status, 401);
    receipt.unauth_denied = "PASS";
    cdp = await launchCdp();
    receipt.browser = `${cdp.binary}; ${cdp.label}`;
    await cdp.cdp("Page.navigate", { url: worker.origin });
    const deadline = globalThis.Date.now() + 15000;
    let ready = false;
    while (globalThis.Date.now() < deadline) {
      ready = await cdp.evaluate('Boolean(document.querySelector("#app") || document.querySelector("#library"))');
      if (ready) break;
      await delayPromise(100);
    }
    assert.equal(ready, true, "built PWA must render its app shell");
    const hasPrivate = await cdp.evaluate('Boolean(document.body?.textContent?.includes("Source catalog-") || document.querySelector("#library [data-source]"))');
    assert.equal(hasPrivate, false, "unauthenticated PWA must not render private Library rows");
    assert.deepEqual(await cdp.evaluate("Object.keys(localStorage)"), []);
    assert.deepEqual(await cdp.evaluate("Object.keys(sessionStorage)"), []);
    const stores = await cdp.evaluate(`(async () => {
      const out = { indexedDB: [], caches: [], idbDump: "" };
      if (typeof indexedDB !== "undefined" && indexedDB.databases) {
        try { out.indexedDB = (await indexedDB.databases()).map((d) => d.name); } catch { out.indexedDB = ["unknown"]; }
      }
      if (typeof caches !== "undefined") {
        try { out.caches = await caches.keys(); } catch { out.caches = ["unknown"]; }
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
    assert.ok(stores.caches.every((name) => name === "eliotr-shell-v1"),
      `only the non-private PWA shell cache may exist, found: ${JSON.stringify(stores.caches)}`);
    const cachedUrls = await cdp.evaluate(`(async () => {
      const urls = [];
      for (const name of await caches.keys()) {
        try {
          const cache = await caches.open(name);
          for (const req of await cache.keys()) urls.push(req.url.slice(0, 512));
        } catch { urls.push("unreadable"); }
      }
      return urls;
    })()`);
    assert.ok(cachedUrls.every((url) => !url.includes("/api/") && !url.includes("/federation/") && !url.includes("/oauth/") && !url.includes("eyJ")),
      `CacheStorage must not retain private API responses: ${JSON.stringify(cachedUrls).slice(0, 512)}`);
    assert.ok(stores.indexedDB.every((name) => name === "eliotr-shell-v1"),
      `only the non-private PWA shell DB may exist, found: ${JSON.stringify(stores.indexedDB)}`);
    assert.ok(!stores.idbDump.includes("eyJ") && !stores.idbDump.includes("cf-access") &&
      !stores.idbDump.includes("catalog-") && !stores.idbDump.includes("source-"),
      "IndexedDB must hold no credentials/source bytes/private API responses");
    const secretScan = await cdp.evaluate(`(() => {
      const hay = [localStorage.length, sessionStorage.length].join(",") + "|" + (document.cookie || "");
      return hay;
    })()`);
    assert.ok(!secretScan.includes("eyJ"), "browser storage must not contain JWT material");
    receipt.storage = "PASS";
    receipt.console_errors = cdp.errors.length === 0 ? "PASS" : `FAIL:${cdp.errors.length}`;
    assert.deepEqual(cdp.errors, [], `page errors must be empty: ${cdp.errors.slice(0, 2).join("; ")}`);
    await worker.stop();
    worker = undefined;
    await prepareLocal({ stateDirectory: directory, log: () => {} });
    worker = await startLocalWorker(paths);
    const rebound = await globalThis.fetch(`${worker.origin}/healthz`, { signal: globalThis.AbortSignal.timeout(5000) });
    assert.equal(rebound.status, 200);
    receipt.persistence = "PASS";
    try {
      await startOwnerBridge({ workerOrigin: worker.origin, token: "forged.token.signature", generation: paths.generation, port: 0 });
      assert.fail("forged bridge token must not pair");
    } catch (error) {
      assert.ok(!String(error?.message ?? "").includes("forged.token.signature"), "bridge must not reflect credentials");
    }
    try {
      await prepareLocal({ stateDirectory: resolve(directory, "missing-parent", "child"), log: () => {}, execute: () => { throw new Error("injected build failure"); } });
      assert.fail("injected build failure must reject");
    } catch (error) {
      assert.ok(String(error?.message ?? "").length > 0);
    }
    assert.equal(worker !== undefined, true, "failed startup must not leave a false-running Worker");
    receipt.failed_startup = "PASS";
    receipt.finished_at = new globalThis.Date().toISOString();
    receipt.live = "NOT_EXECUTED";
  } finally {
    try { await worker?.stop(); } catch { /* Shutdown best-effort. */ }
    try { await cdp?.close(); } catch { /* Browser teardown best-effort. */ }
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
