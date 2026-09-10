import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { startOwnerBridge } from "./lib/local-owner-bridge.mjs";
import { loginOwner, readOwnerIdentity, validateWorkerOrigin } from "./lib/local-owner-login.mjs";
import { loadOwnerConfig, validateOwnerConfig } from "./lib/local-owner-config.mjs";

const TOKEN = "header.private.signature";
const config = { app: "https://research.example.com", team: "https://team.cloudflareaccess.com", audience: "audience" };
const identity = () => ({ protocol: "eliotr.owner-session.v1", principal_ref: "owner-subject", client_class: "owner_pwa",
  credential_generation: "signed-generation", expires_at: new Date(Date.now() + 3600000).toISOString() });
let backend; let origin; const requests = []; let behavior = "normal"; let held;
before(async () => {
  backend = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push({ path: request.url, headers: request.headers, body: Buffer.concat(chunks).toString() });
    response.setHeader("content-type", "application/json");
    if (request.headers["cf-access-jwt-assertion"] !== TOKEN) { response.statusCode = 401; return response.end("{}"); }
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
