import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { isChromiumSafePort, startOwnerBridge } from "./lib/local-owner-bridge.mjs";
import { startLocalWorker, reserveChromiumSafePort } from "./lib/local-worker.mjs";
import { loginOwner, readOwnerIdentity, validateWorkerOrigin } from "./lib/local-owner-login.mjs";
import { loadOwnerConfig, validateOwnerConfig } from "./lib/local-owner-config.mjs";

const TOKEN = "header.private.signature";
const SECTION_BYTES = Buffer.from("section readback bytes\n");
const SECTION_SHA256 = createHash("sha256").update(SECTION_BYTES).digest("hex");
const SECTION_PATH = "/api/v1/research/artifact/artifact-report-1%3A1/sections/section-intro%3A1";
const config = { app: "https://research.example.com", team: "https://team.cloudflareaccess.com", audience: "audience" };
const localOwnerSource = await readFile(resolve(process.cwd(), "scripts/local-owner.mjs"), "utf8");
const identity = () => ({ protocol: "eliotr.owner-session.v1", principal_ref: "owner-subject", client_class: "owner_pwa",
  credential_generation: "signed-generation", expires_at: new Date(Date.now() + 3600000).toISOString() });
let backend; let origin; const requests = []; let behavior = "normal"; let held;
before(async () => {
  backend = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push({ path: request.url, headers: request.headers, body: Buffer.concat(chunks).toString() });
    response.setHeader("content-type", "application/json");
    if (request.headers["cf-access-jwt-assertion"] !== TOKEN) { response.statusCode = 401; return response.end("{}"); }
    if (behavior === "artifact-section" && request.url.startsWith("/api/v1/research/artifact/")) {
      const compressed = gzipSync(SECTION_BYTES);
      response.statusCode = request.url.endsWith("/reauthorize") ? 206 : 200;
      response.setHeader("content-type", "application/octet-stream");
      response.setHeader("content-encoding", "gzip"); response.setHeader("content-length", String(compressed.byteLength));
      response.setHeader("x-eliotr-artifact-ref", encodeURIComponent("artifact-report-1:1"));
      response.setHeader("x-eliotr-section-ref", encodeURIComponent("section-intro:1"));
      response.setHeader("x-eliotr-section-object-ref", encodeURIComponent("artifact-draft/section/section-intro:1"));
      response.setHeader("x-eliotr-section-sha256", SECTION_SHA256);
      response.setHeader("x-eliotr-deployment-generation", "expected");
      response.setHeader("set-cookie", "upstream-session=private; HttpOnly");
      response.setHeader("authorization", "Bearer upstream-secret");
      response.setHeader("x-upstream-private-debug", "must-not-forward");
      response.setHeader("content-security-policy", "default-src *");
      return response.end(compressed);
    }
    if (behavior === "hold" && request.url === "/api/private") {
      held = () => response.end(JSON.stringify({ private: "secret-evidence" })); return;
    }
    if (behavior === "redirect" && request.url === "/api/private") {
      response.statusCode = 302; response.setHeader("location", "https://attacker.invalid/"); return response.end();
    }
    if (behavior === "reject" && request.url !== "/api/v1/system/session") { response.statusCode = 401; return response.end("{}"); }
    if (behavior === "oversize" && request.url === "/api/private") return response.end("x".repeat(8 * 1024 * 1024 + 1));
    const data = request.url === "/api/v1/system/session" ? identity() : { private: "secret-evidence", received: Buffer.concat(chunks).toString() };
    response.end(JSON.stringify({ data, trace_id: "verified-trace", deployment_generation: "expected" }));
  });
  await new Promise((done) => backend.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${backend.address().port}`;
});
after(async () => { const done = new Promise((resolve) => backend.close(resolve)); backend.closeAllConnections(); await done; });
const bridge = (options = {}) => startOwnerBridge({ workerOrigin: origin, token: TOKEN, generation: "expected", port: 0, ...options });
async function pair(value) {
  const response = await fetch(`${value.origin}/__local/pair`, { method: "POST", headers: {
    origin: value.origin, "X-Eliotr-Pair": new URL(value.pairingUrl).hash.slice(1),
  } });
  assert.equal(response.status, 204); return response.headers.get("set-cookie");
}
const raw = (value, path, headers) => new Promise((resolve, reject) => {
  const req = httpRequest(`${value.origin}${path}`, { headers }, (res) => {
    const body = []; res.on("data", (chunk) => body.push(chunk));
    res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(body).toString() }));
  }); req.on("error", reject); req.end();
});

test("Access config and CLI use only exact HTTPS origins and never shell/token arguments", async () => {
  assert.match(localOwnerSource, /reserveMiniflareForbiddenPorts/u);
  assert.match(localOwnerSource, /const portGuard = await reserveMiniflareForbiddenPorts\(\);[\s\S]*const paths = await prepareLocal\(\);/u);
  assert.match(localOwnerSource, /bridge\?\.close\(\)[\s\S]*worker\?\.stop\(\)[\s\S]*portGuard\.release\(\)/u);
  assert.deepEqual(validateOwnerConfig(config), config);
  for (const app of ["http://research.example.com", "https://research.example.com/path", "https://a:b@research.example.com", "https://research.example.com:444", "https://127.0.0.1", "https://research.example.com#secret"]) {
    assert.throws(() => validateOwnerConfig({ ...config, app }));
  }
  assert.throws(() => validateOwnerConfig({ ...config, team: "https://other.example.com" }));
  assert.throws(() => validateOwnerConfig({ ...config, unexpected: "secret" }));
  const calls = [];
  assert.equal(await loginOwner(config, { run: async (args, options) => { calls.push({ args, options }); return options?.capture ? TOKEN : ""; } }), TOKEN);
  assert.deepEqual(calls.map((call) => call.args), [["access", "login", "--quiet", config.app], ["access", "token", `--app=${config.app}`]]);
  await assert.rejects(loginOwner(config, { run: async () => "reflected private token" }), (error) => !error.message.includes("reflected"));
  for (const value of ["https://127.0.0.1:8000", "http://localhost:8000", "http://attacker.invalid:8000", "http://127.0.0.1:8000/path"]) assert.throws(() => validateWorkerOrigin(value));
});
test("explicit Worker port rejects unsafe and occupied listeners without fallback or foreign close", async () => {
  const occupiedPort = Number(new URL(origin).port);
  assert.ok(isChromiumSafePort(occupiedPort), `test backend must use a Chromium-safe port, got ${occupiedPort}`);
  assert.equal(backend.listening, true);
  await assert.rejects(startLocalWorker({ generation: "expected" }, { port: 0 }), /Chromium-unsafe or out of range/u);
  await assert.rejects(reserveChromiumSafePort({ port: occupiedPort }), /EADDRINUSE|address already in use/u);
  await assert.rejects(startLocalWorker({ generation: "expected" }, { port: occupiedPort }), /EADDRINUSE|address already in use/u);
  assert.equal(backend.listening, true, "occupied foreign listener must remain open after exact-port refusal");
});
test("initial settings populate only local Access vars, preserve existing settings and reject conflicts", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "eliotr-owner-config-"));
  try {
    await writeFile(resolve(directory, "owner.json"), JSON.stringify(config));
    assert.deepEqual(await loadOwnerConfig({ directory, prompt: false }), config);
    const vars = await readFile(resolve(directory, ".dev.vars"), "utf8");
    assert.ok(vars.includes(config.team)); assert.ok(vars.includes(config.audience));
    await loadOwnerConfig({ directory, prompt: false });
    assert.equal(await readFile(resolve(directory, ".dev.vars"), "utf8"), vars);
    await writeFile(resolve(directory, ".dev.vars"), 'ACCESS_AUDIENCE="other"\n');
    await assert.rejects(loadOwnerConfig({ directory, prompt: false }), /disagree/u);
    await writeFile(resolve(directory, ".dev.vars"), 'CLOUDFLARE_API_TOKEN="do-not-leak"\n');
    await assert.rejects(loadOwnerConfig({ directory, prompt: false }), (error) => !error.message.includes("do-not-leak"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("session validation requires the exact Worker generation, owner class, identity and lifetime", async () => {
  assert.equal((await readOwnerIdentity(origin, TOKEN, "expected")).principal_ref, "owner-subject");
  await assert.rejects(readOwnerIdentity(origin, TOKEN, "wrong"));
  for (const change of [{ client_class: "trusted_agent" }, { expires_at: "invalid" }, { expires_at: new Date(0).toISOString() },
    { principal_ref: "" }, { token: TOKEN }, { credential_generation: "\n" }]) {
    await assert.rejects(readOwnerIdentity(origin, TOKEN, "expected", { fetchImpl: async () => globalThis.Response.json({
      data: { ...identity(), ...change }, trace_id: "trace", deployment_generation: "expected",
    }) }));
  }
});
test("one-time pairing sets a private cookie; proxy sends only the server-held token", async () => {
  const value = await bridge();
  try {
    const page = await fetch(value.pairingUrl);
    assert.equal(page.status, 200); assert.ok(page.headers.get("content-security-policy").includes("sha256-"));
    assert.ok(!(await page.text()).includes(TOKEN));
    assert.equal((await fetch(`${value.origin}/api/private`)).status, 401);
    const cookie = await pair(value); assert.ok(cookie.includes("HttpOnly; SameSite=Strict")); assert.ok(!cookie.includes(TOKEN));
    const response = await fetch(`${value.origin}/api/private`, { method: "POST", headers: { cookie, origin: value.origin,
      "content-type": "application/json", "idempotency-key": "intent-1", "x-ignored": "never-forward" }, body: '{"hello":"world"}' });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(requests.at(-1).headers["cf-access-jwt-assertion"], TOKEN);
    assert.equal(requests.at(-1).headers.cookie, undefined); assert.equal(requests.at(-1).headers["x-ignored"], undefined);
    assert.equal(requests.at(-1).headers["idempotency-key"], "intent-1");
    assert.equal((await response.json()).data.received, '{"hello":"world"}');
    const replay = await fetch(`${value.origin}/__local/pair`, { method: "POST", headers: { origin: value.origin,
      "X-Eliotr-Pair": new URL(value.pairingUrl).hash.slice(1) } });
    assert.equal(replay.status, 403);
  } finally { await value.close(); }
});
test("raw capture metadata stays route-scoped while forwarding namespace and expected-head identity", async () => {
  const value = await bridge();
  try {
    const cookie = await pair(value);
    const metadata = {
      "x-eliotr-content-sha256": "a".repeat(64),
      "x-eliotr-original-file-name": encodeURIComponent("исследование.txt"),
      "x-eliotr-source-namespace-id": "owner-library-selected",
      "x-eliotr-target-source-id": "source-existing",
      "x-eliotr-expected-head-revision-ref": "revision-original",
    };
    const fileHeaders = { cookie, origin: value.origin, "content-type": "text/plain",
      "content-length": "4", ...metadata, "x-ignored": "never-forward" };
    const uploaded = await fetch(`${value.origin}/api/v1/ingest/raw`, { method: "POST", headers: fileHeaders, body: "data" });
    assert.equal(uploaded.status, 200);
    for (const [name, expected] of Object.entries(metadata)) assert.equal(requests.at(-1).headers[name], expected,
      "the exact selected namespace and source-head contract must reach the Worker unchanged");
    assert.equal(requests.at(-1).headers["content-length"], "4");
    assert.equal(requests.at(-1).headers["x-ignored"], undefined);
    assert.equal(requests.at(-1).headers.cookie, undefined);
    assert.equal(requests.at(-1).headers["cf-access-jwt-assertion"], TOKEN);
    // Other routes/methods cannot acquire the raw capture header surface.
    for (const [path, method] of [["/api/private", "POST"], ["/api/v1/ingest/raw/capture/markdown", "POST"],
      ["/api/v1/ingest/raw", "GET"], ["/api/v1/ingest/raw", "PUT"]]) {
      const headers = { ...fileHeaders };
      if (method === "GET") delete headers["content-length"];
      const response = await fetch(`${value.origin}${path}`, { method, headers,
        ...(method === "GET" ? {} : { body: "data" }) });
      assert.equal(response.status, 200);
      for (const name of Object.keys(metadata)) assert.equal(requests.at(-1).headers[name], undefined);
    }
    // Existing callers without optional namespace/target locators are not assigned invented ones.
    const legacyHeaders = { ...fileHeaders };
    for (const name of ["x-eliotr-source-namespace-id", "x-eliotr-target-source-id", "x-eliotr-expected-head-revision-ref"]) delete legacyHeaders[name];
    const legacy = await fetch(`${value.origin}/api/v1/ingest/raw`, { method: "POST", headers: legacyHeaders, body: "data" });
    assert.equal(legacy.status, 200);
    for (const name of ["x-eliotr-source-namespace-id", "x-eliotr-target-source-id", "x-eliotr-expected-head-revision-ref"]) assert.equal(requests.at(-1).headers[name], undefined);
  } finally { await value.close(); }
});
test("artifact section readback forwards only exact metadata and recomputes emitted length", async () => {
  const value = await bridge();
  const required = {
    "x-eliotr-artifact-ref": encodeURIComponent("artifact-report-1:1"),
    "x-eliotr-section-ref": encodeURIComponent("section-intro:1"),
    "x-eliotr-section-object-ref": encodeURIComponent("artifact-draft/section/section-intro:1"),
    "x-eliotr-section-sha256": SECTION_SHA256,
    "x-eliotr-deployment-generation": "expected",
  };
  try {
    const cookie = (await pair(value)).split(";")[0];
    behavior = "artifact-section";
    const cases = [[SECTION_PATH, "GET", 200], [SECTION_PATH + "/reauthorize", "POST", 206]];
    for (const [path, method, status] of cases) {
      const response = await fetch(value.origin + path, { method, headers: { cookie, origin: value.origin, accept: "application/octet-stream" } });
      assert.equal(response.status, status);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), SECTION_BYTES);
      assert.equal(response.headers.get("content-length"), String(SECTION_BYTES.byteLength));
      for (const [name, expected] of Object.entries(required)) assert.equal(response.headers.get(name), expected);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(response.headers.get("authorization"), null);
      assert.equal(response.headers.get("x-upstream-private-debug"), null);
      assert.equal(response.headers.get("content-encoding"), null);
      assert.equal(response.headers.get("content-security-policy"), "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    const unrelated = await fetch(value.origin + SECTION_PATH + "/citations", { headers: { cookie } });
    assert.equal(unrelated.status, 200);
    for (const name of Object.keys(required)) assert.equal(unrelated.headers.get(name), null);
    assert.equal(unrelated.headers.get("set-cookie"), null);
    assert.equal(unrelated.headers.get("authorization"), null);
    assert.equal(unrelated.headers.get("x-upstream-private-debug"), null);
  } finally { behavior = "normal"; await value.close(); }
});

test("cross-origin, DNS rebinding, cookie duplication and credential substitution never reach Worker", async () => {
  const value = await bridge();
  try {
    const cookie = (await pair(value)).split(";")[0]; const count = requests.length;
    for (const headers of [{ cookie, origin: "https://attacker.invalid" }, { cookie, host: "attacker.invalid" },
      { cookie, "sec-fetch-site": "same-site" }, { cookie, "sec-fetch-site": "cross-site" },
      { cookie, authorization: "Bearer forged" }, { cookie, "cf-access-jwt-assertion": "forged" },
      { cookie, "x-forwarded-host": "attacker.invalid" }]) assert.equal((await raw(value, "/api/private", headers)).status, 403);
    assert.equal((await raw(value, "/api/private", { cookie: `${cookie}; ${cookie}` })).status, 401);
    assert.equal((await fetch(`${value.origin}/api/private`, { method: "POST", headers: { cookie } })).status, 403);
    assert.equal((await raw(value, "//attacker.invalid/path", { cookie })).status, 403);
    assert.equal(requests.length, count);
  } finally { await value.close(); }
});
test("redirect, oversized response and upstream auth rejection cannot leak credentials or payload", async () => {
  const value = await bridge();
  try {
    const cookie = await pair(value);
    for (const mode of ["redirect", "oversize", "reject"]) {
      behavior = mode;
      const response = await fetch(`${value.origin}/api/private`, { headers: { cookie } });
      assert.equal(response.status, mode === "reject" ? 401 : 502);
      const text = await response.text(); assert.ok(!text.includes(TOKEN)); assert.ok(!text.includes("secret-evidence"));
    }
    behavior = "normal";
    assert.equal((await fetch(`${value.origin}/api/private`, { headers: { cookie } })).status, 401);
  } finally { behavior = "normal"; await value.close(); }
});
test("logout racing a private response clears the bearer and prevents disclosure", async () => {
  const value = await bridge();
  try {
    const cookie = await pair(value); behavior = "hold"; held = undefined;
    const pending = fetch(`${value.origin}/api/private`, { headers: { cookie } });
    while (!held) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await fetch(`${value.origin}/__local/logout`, { method: "POST", headers: { cookie, origin: value.origin } })).status, 204);
    held(); const response = await pending;
    assert.equal(response.status, 401); assert.ok(!(await response.text()).includes("secret-evidence"));
    assert.equal((await fetch(`${value.origin}/api/private`, { headers: { cookie } })).status, 401);
  } finally { behavior = "normal"; await value.close(); }
});
test("pairing timeout and session lifetime are enforced independently of the upstream JWT", async () => {
  let clock = Date.now(); const value = await bridge({ now: () => clock });
  try {
    clock += 60001;
    assert.equal((await fetch(`${value.origin}/__local/pair`, { method: "POST", headers: { origin: value.origin,
      "X-Eliotr-Pair": new URL(value.pairingUrl).hash.slice(1) } })).status, 403);
  } finally { await value.close(); }
  clock = Date.now(); const second = await bridge({ now: () => clock });
  try {
    const cookie = await pair(second); clock += 900001;
    assert.equal((await fetch(`${second.origin}/api/private`, { headers: { cookie } })).status, 401);
  } finally { await second.close(); }
});
test("a stalled private upstream is aborted at the deadline without exposing a body", async () => {
  const value = await bridge({ timeoutMs: 500 });
  try {
    const cookie = await pair(value); behavior = "hold"; held = undefined;
    const response = await fetch(`${value.origin}/api/private`, { headers: { cookie } });
    assert.equal(response.status, 502); assert.ok(!(await response.text()).includes(TOKEN));
  } finally { behavior = "normal"; held?.(); await value.close(); }
});
