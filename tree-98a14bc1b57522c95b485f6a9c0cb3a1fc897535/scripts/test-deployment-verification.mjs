import assert from "node:assert/strict";
import { readDeploymentJson, readDeploymentWorker, validateDeploymentInput,
  validateGeneratedDeployment, verifyDeploymentSmoke } from "./lib/deployment-verification.mjs";

const now = Date.parse("2026-09-04T23:00:00.000Z");
const environment = {
  CLOUDFLARE_ACCOUNT_ID: "test-account", CLOUDFLARE_API_TOKEN: "secret-token",
  ELIOTR_ENVIRONMENT: "staging", ELIOTR_DEPLOYMENT_GENERATION: "git-test",
  ELIOTR_ACCESS_HOSTNAME: "research.example.com", ELIOTR_CUSTOM_DOMAIN: "1",
  ELIOTR_OWNER_EMAILS: "owner@example.com", ELIOTR_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
  ELIOTR_ACCESS_AUDIENCE: "test-aud", ELIOTR_ACCESS_SERVICE_PRINCIPALS: "agent",
  ELIOTR_ACCESS_SMOKE_COOKIE: "secret-cookie",
};
const config = {
  name: "eliotr-core", minify: true, preview_urls: false, compatibility_date: "2026-08-28",
  vars: { DEPLOYMENT_GENERATION: "git-test", ENVIRONMENT: "staging",
    ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com", ACCESS_AUDIENCE: "test-aud", ACCESS_SERVICE_PRINCIPALS: "agent" },
  d1_databases: [
    { binding: "CORE_DB", database_name: "eliotr-core", database_id: "11111111-1111-4111-8111-111111111111" },
    { binding: "SEARCH_DB", database_name: "eliotr-search", database_id: "22222222-2222-4222-8222-222222222222" },
  ],
};
const health = () => ({ ready: true, deployment_generation: "git-test", checked_at: new Date(now).toISOString() });
const capabilities = () => ({ trace_id: "trace-test", deployment_generation: "git-test", data: {
  protocol: "eliotr.capabilities.v1", deployment_generation: "git-test", enabled_slices: ["HEALTH", "ACCESS", "CATALOG"],
  disabled_slices: ["RESEARCH"], exact_evidence_resolution_required: true,
  transport_completion_is_research_completion: false, ingest_live_qualified: false,
} });
const json = (body) => globalThis.Response.json(body);
const input = validateDeploymentInput(environment);
let cases = 0;
const check = async (name, action) => {
  await action(); cases += 1; console.log(`Deployment verification: ${name}: PASS`);
};
const smoke = (fetchImpl, env = environment) => verifyDeploymentSmoke(env, validateDeploymentInput(env), { fetchImpl, now: () => now });

await check("exact generation and readiness", async () => {
  const calls = [];
  const result = await smoke(async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, "manual");
    assert.equal(options.cache, "no-store");
    assert.equal(options.headers.Cookie, "CF_Authorization=secret-cookie");
    return json(url.endsWith("/healthz") ? health() : capabilities());
  });
  assert.deepEqual(result, { state: "PASS", results: [
    { path: "/healthz", status: 200 },
    { path: "/api/v1/system/capabilities", status: 200 },
  ] });
  assert.equal(calls.length, 2);
  assert.ok(!JSON.stringify(result).includes("secret-cookie"));
});
await check("no credentials means no request, never PASS", async () => {
  const result = await smoke(() => assert.fail("no request allowed"), { ...environment, ELIOTR_ACCESS_SMOKE_COOKIE: undefined });
  assert.equal(result.state, "NOT_EXECUTED");
});
await check("reject credential destination and header injection before requests", () => {
  for (const value of ["http://research.example.com", "https://other.example.com", "https://research.example.com:444",
    "https://research.example.com/path", "https://research.example.com/?x=1", "https://research.example.com/#x",
    "https://u:p@research.example.com", "https://research.example.com/../", "https://research.example.com\\other"]) {
    assert.throws(() => validateDeploymentInput({ ...environment, ELIOTR_SMOKE_BASE_URL: value }));
  }
  for (const cookie of ["a; injected=1", "a\r\nX-Test: injected", "a b", "x".repeat(16_385)]) {
    assert.throws(() => validateDeploymentInput({ ...environment, ELIOTR_ACCESS_SMOKE_COOKIE: cookie }));
  }
  assert.throws(() => validateDeploymentInput({ ...environment, CLOUDFLARE_API_BASE_URL: "https://attacker.example/client/v4" }));
  assert.throws(() => validateDeploymentInput({ ...environment, CLOUDFLARE_API_BASE_URL: "http://localhost/client/v4?token=x" }));
  assert.equal(validateDeploymentInput({ ...environment, CLOUDFLARE_API_BASE_URL: "http://127.0.0.1:1234/client/v4/" }).apiBase,
    "http://127.0.0.1:1234/client/v4");
});
await check("HTML fallback and redirect are not healthy APIs", async () => {
  for (const response of [new globalThis.Response("<html>login</html>", { headers: { "content-type": "text/html" } }),
    new globalThis.Response(null, { status: 302, headers: { location: "https://other.example/" } }),
    new globalThis.Response(null, { status: 204 }), new globalThis.Response("{}", { status: 503 })]) {
    await assert.rejects(smoke(async () => response));
  }
});
await check("health readiness, generation, timestamp and extra authority fields", async () => {
  for (const fields of [{ ready: false }, { ready: "true" }, { deployment_generation: "old" },
    { checked_at: "invalid" }, { checked_at: new Date(now - 120_001).toISOString() },
    { checked_at: new Date(now + 120_001).toISOString() }, { privileged: true }]) {
    await assert.rejects(smoke(async () => json({ ...health(), ...fields })));
  }
});
await check("capability envelope and authority cannot disagree", async () => {
  const mutations = [
    (value) => { value.deployment_generation = "old"; },
    (value) => { value.trace_id = ""; },
    (value) => { value.data.deployment_generation = "old"; },
    (value) => { value.data.protocol = "future"; },
    (value) => { value.data.exact_evidence_resolution_required = false; },
    (value) => { value.data.transport_completion_is_research_completion = true; },
    (value) => { value.data.ingest_live_qualified = "true"; },
    (value) => { value.data.enabled_slices = ["HEALTH"]; },
    (value) => { value.data.enabled_slices.push("HEALTH"); },
    (value) => { value.data.disabled_slices = ["ACCESS"]; },
    (value) => { value.data.disabled_slices = "RESEARCH"; },
    (value) => { value.data.disabled_slices = [null]; },
    (value) => { value.data.disabled_slices = Array(65).fill("RESEARCH"); },
    (value) => { value.unexpected = true; },
  ];
  for (const mutate of mutations) {
    const body = capabilities(); mutate(body);
    await assert.rejects(smoke(async (url) => json(url.endsWith("/healthz") ? health() : body)));
  }
});
await check("malformed and non-UTF8 JSON fail without secret reflection", async () => {
  for (const body of ["{secret-cookie", "null", "[]", Buffer.from([0xff])]) {
    await assert.rejects(smoke(async () => new globalThis.Response(body, { headers: { "content-type": "application/json" } })),
      (error) => !error.message.includes("secret-cookie"));
  }
  await assert.rejects(smoke(() => { throw new Error("upstream reflected secret-cookie"); }),
    (error) => !error.message.includes("secret-cookie"));
});
await check("declared and chunked body limits", async () => {
  for (const headers of [{ "content-length": "999999999" }, { "content-length": "NaN" }, {}]) {
    await assert.rejects(readDeploymentJson("https://example.com", {}, {
      maxBytes: 64, fetchImpl: async () => new globalThis.Response(JSON.stringify({ body: "x".repeat(65) }),
        { headers: { "content-type": "application/json", ...headers } }),
    }));
  }
});
await check("connection and streaming-body deadlines abort", async () => {
  let connectionSignal;
  await assert.rejects(readDeploymentJson("https://example.com", {}, { timeoutMs: 10,
    fetchImpl: (_url, options) => { connectionSignal = options.signal; return new Promise(() => {}); } }));
  assert.equal(connectionSignal.aborted, true);
  let cancelled = false;
  const stream = new globalThis.ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(readDeploymentJson("https://example.com", {}, { timeoutMs: 10,
    fetchImpl: async () => new globalThis.Response(stream, { headers: { "content-type": "application/json" } }) }));
  assert.equal(cancelled, true);
});
await check("generated identity, Access and D1 config", () => {
  const bytes = Buffer.from(JSON.stringify(config));
  assert.deepEqual(validateGeneratedDeployment(bytes, environment, input), config);
  for (const mutate of [
    (value) => { value.vars.DEPLOYMENT_GENERATION = "old"; },
    (value) => { value.vars.ACCESS_AUDIENCE = "other"; },
    (value) => { value.vars.ENVIRONMENT = "development"; },
    (value) => { value.keep_vars = true; },
    (value) => { value.d1_databases[1].database_id = value.d1_databases[0].database_id; },
    (value) => { value.d1_databases[0].database_id = "placeholder"; },
    (value) => { value.d1_databases[1].binding = "CORE_DB"; },
  ]) {
    const value = structuredClone(config); mutate(value);
    assert.throws(() => validateGeneratedDeployment(Buffer.from(JSON.stringify(value)), environment, input));
  }
});
await check("Worker inventory export/compatibility/assets fail closed", async () => {
  const worker = { id: "eliotr-core", compatibility_date: "2026-08-28", has_assets: true,
    exports: { ResearchSession: { type: "durable-object" } } };
  const read = (payload) => readDeploymentWorker(environment, input, config, { fetchImpl: async () => json(payload) });
  assert.equal((await read({ success: true, result: [worker] })).durable_object_export, "durable-object");
  for (const payload of [{ success: false, result: [worker] }, { result: [worker] },
    { success: true, result: [] }, { success: true, result: [worker, worker] },
    { success: true, result: [{ ...worker, has_assets: false }] },
    { success: true, result: [{ ...worker, compatibility_date: "old" }] },
    { success: true, result: [{ ...worker, exports: {} }] }]) await assert.rejects(read(payload));
});
console.log(`Deployment verification: ${cases} groups passed; live Cloudflare NOT_EXECUTED`);
