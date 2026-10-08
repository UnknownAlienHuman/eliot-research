import assert from "node:assert/strict";
import { assertGeneratedOwnerTemplatesCurrent, isApprovedOwnerTemplateGenerationTransition,
  readDeploymentJson, readDeploymentWorker, validateDeploymentInput,
  validateGeneratedDeployment, verifyDeploymentSmoke } from "./lib/deployment-verification.mjs";

const now = Date.parse("2026-09-04T23:00:00.000Z");
const environment = {
  CLOUDFLARE_ACCOUNT_ID: "test-account", CLOUDFLARE_API_TOKEN: "secret-token",
  ELIOTR_ENVIRONMENT: "staging", ELIOTR_DEPLOYMENT_GENERATION: "git-test",
  ELIOTR_ACCESS_HOSTNAME: "research.example.com", ELIOTR_CUSTOM_DOMAIN: "1",
  ELIOTR_OWNER_EMAILS: "owner@example.com", ELIOTR_ACCESS_TEAM_DOMAIN: "https://team-example.cloudflareaccess.com",
  ELIOTR_ACCESS_AUDIENCE: "test-aud", ELIOTR_ACCESS_SERVICE_PRINCIPALS: "agent",
  ELIOTR_GOOGLE_EXTERNAL_TRANSPORT: "gemini-mcp",
  ELIOTR_ACCESS_SMOKE_COOKIE: "secret-cookie",
};
const config = {
  name: "eliotr-core", minify: true, preview_urls: false, compatibility_date: "2026-08-28",
  assets: { binding: "ASSETS" }, exports: { ResearchSession: { type: "durable-object", storage: "sqlite" } },
  r2_buckets: [
    { binding: "EVIDENCE_BUCKET", bucket_name: "eliotr-evidence" },
    { binding: "WORK_BUCKET", bucket_name: "eliotr-work" },
  ],
  queues: { producers: [{ binding: "JOB_QUEUE", queue: "eliotr-jobs" }], consumers: [] },
  durable_objects: { bindings: [{ name: "RESEARCH_SESSION", class_name: "ResearchSession" }] },
  workflows: [{ binding: "RESEARCH_WORKFLOW", name: "eliotr-research-workflow", class_name: "ResearchWorkflow" }],
  ai_search_namespaces: [{ binding: "AI_SEARCH", namespace: "eliotr" }], ai: { binding: "AI" },
  wasm_modules: { KERNEL_WASM: "../../crates/kernel-wasm/pkg/eliotr_kernel_wasm_bg.wasm" },
  analytics_engine_datasets: [{ binding: "METRICS", dataset: "eliotr_metrics" }],
  vars: { DEPLOYMENT_GENERATION: "git-test", ENVIRONMENT: "staging", GOOGLE_EXTERNAL_TRANSPORT: "gemini-mcp",
    ACCESS_TEAM_DOMAIN: "https://team-example.cloudflareaccess.com", ACCESS_AUDIENCE: "test-aud", ACCESS_SERVICE_PRINCIPALS: "agent",
    JSON_PROFILE: { mode: "strict", limits: [1, 2] } },
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

await check("owner-template transition permits only observed C-to-candidate B generation changes", () => {
  const candidate = structuredClone(config);
  candidate.vars.DEPLOYMENT_GENERATION = "git-candidate";
  candidate.vars.ELIOTR_MODEL_SPEND_POLICY_JSON = JSON.stringify({
    protocol: "eliotr.research-owner-spend-template.v1",
    deployment_generation: "git-candidate",
    budget_ref: "owner-budget-v1",
  });
  candidate.vars.ELIOTR_RESEARCH_REPORT_CONFIG_JSON = JSON.stringify({
    schema: "eliotr.research.report-config.v1",
    admission_policy: {
      protocol: "eliotr.research-owner-report-admission-template.v1",
      deployment_generation: "git-candidate",
      policy_ref: "owner-report-v1",
    },
  });
  const observedSpend = JSON.stringify({
    protocol: "eliotr.research-owner-spend-template.v1",
    deployment_generation: "git-recorded-owner",
    budget_ref: "owner-budget-v1",
  });
  const observedReport = JSON.stringify({
    schema: "eliotr.research.report-config.v1",
    admission_policy: {
      protocol: "eliotr.research-owner-report-admission-template.v1",
      deployment_generation: "git-recorded-owner",
      policy_ref: "owner-report-v1",
    },
  });
  assert.equal(assertGeneratedOwnerTemplatesCurrent(candidate), "git-candidate");
  assert.equal(isApprovedOwnerTemplateGenerationTransition("ELIOTR_MODEL_SPEND_POLICY_JSON",
    observedSpend, candidate.vars.ELIOTR_MODEL_SPEND_POLICY_JSON, "git-candidate"), true);
  assert.equal(isApprovedOwnerTemplateGenerationTransition("ELIOTR_RESEARCH_REPORT_CONFIG_JSON",
    observedReport, candidate.vars.ELIOTR_RESEARCH_REPORT_CONFIG_JSON, "git-candidate"), true);
  const driftedSpend = JSON.parse(observedSpend);
  driftedSpend.budget_ref = "different-budget";
  assert.equal(isApprovedOwnerTemplateGenerationTransition("ELIOTR_MODEL_SPEND_POLICY_JSON",
    JSON.stringify(driftedSpend), candidate.vars.ELIOTR_MODEL_SPEND_POLICY_JSON, "git-candidate"), false);
  assert.equal(candidate.vars.DEPLOYMENT_GENERATION, "git-candidate", "candidate config stays immutable");
  const stale = structuredClone(candidate);
  const staleReport = JSON.parse(stale.vars.ELIOTR_RESEARCH_REPORT_CONFIG_JSON);
  staleReport.admission_policy.deployment_generation = "git-baseline";
  stale.vars.ELIOTR_RESEARCH_REPORT_CONFIG_JSON = JSON.stringify(staleReport);
  assert.throws(() => assertGeneratedOwnerTemplatesCurrent(stale), /generation does not match candidate/u);
});

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
await check("OAuth-pending deployment validation is explicit and does not claim a credential", () => {
  const pendingEnvironment = { ...environment, CLOUDFLARE_API_TOKEN: "" };
  const pending = validateDeploymentInput(pendingEnvironment, { authMode: "wrangler-oauth" });
  assert.equal(pending.apiBase, "https://api.cloudflare.com/client/v4");
  assert.equal(Object.hasOwn(pending, "CLOUDFLARE_API_TOKEN"), false);
  assert.throws(() => validateDeploymentInput(pendingEnvironment), /Missing CLOUDFLARE_API_TOKEN/u);
  assert.throws(() => validateDeploymentInput(pendingEnvironment, { authMode: "api-token" }), /Missing CLOUDFLARE_API_TOKEN/u);
  assert.throws(() => validateDeploymentInput(pendingEnvironment, { authMode: "wrangler-oauth-unknown" }),
    /Unknown ELIOTR_CLOUDFLARE_AUTH_MODE/u);
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
    (value) => { value.vars.GOOGLE_EXTERNAL_TRANSPORT = "drive-exchange"; },
    (value) => { value.vars.ACCESS_AUDIENCE = "other"; },
    (value) => { value.vars.ENVIRONMENT = "development"; },
    (value) => { value.vars.GOOGLE_CLIENT_SECRET = "must-be-secret_text"; },
    (value) => { value.vars.ELIOTR_MODEL_PROVIDER_CONTROL_TOKEN = "must-be-secret_text"; },
    (value) => { value.vars = null; },
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
  const bindings = {
    CORE_DB: { type: "d1", id: config.d1_databases[0].database_id },
    SEARCH_DB: { type: "d1", id: config.d1_databases[1].database_id },
    EVIDENCE_BUCKET: { type: "r2_bucket", bucket_name: "eliotr-evidence" },
    WORK_BUCKET: { type: "r2_bucket", bucket_name: "eliotr-work" },
    JOB_QUEUE: { type: "queue", queue_name: "eliotr-jobs" },
    RESEARCH_SESSION: { type: "durable_object_namespace", class_name: "ResearchSession" },
    RESEARCH_WORKFLOW: { type: "workflow", name: "eliotr-research-workflow", class_name: "ResearchWorkflow" },
    AI_SEARCH: { type: "ai_search_namespace", namespace: "eliotr" },
    AI: { type: "ai" }, METRICS: { type: "analytics_engine", dataset: "eliotr_metrics" },
    KERNEL_WASM: { type: "wasm_module" },
    ASSETS: { type: "assets" },
    ...Object.fromEntries(Object.entries(config.vars).map(([name, value]) => [name,
      typeof value === "string" ? { type: "plain_text", text: value } : { type: "json", json: value }])),
    GOOGLE_CLIENT_SECRET: { type: "secret_text", text: "never-return-this-secret-value" },
  };
  const active = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", created_on: "2026-09-04T22:59:00.000Z",
    strategy: "percentage", versions: [{ version_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", percentage: 100 }] };
  const version = { id: active.versions[0].version_id, number: 9, resources: {
    bindings, script: { etag: "cloudflare-etag-opaque" }, script_runtime: {
      compatibility_date: "2026-08-28T00:00:00Z", compatibility_flags: [],
      exports: { default: { type: "worker" }, ResearchSession: { type: "durable-object", storage: "sqlite" } },
    },
  } };
  const read = (overrides = {}, configOverride = config) => readDeploymentWorker(environment, input, configOverride, { fetchImpl: async (url) => {
    if (String(url).endsWith("/workers/scripts")) return json(overrides.inventory ?? { success: true, result: [worker] });
    if (String(url).endsWith("/deployments")) return json(overrides.deployments ?? { success: true, result: { deployments: [active] } });
    if (String(url).endsWith(`/versions/${active.versions[0].version_id}`)) {
      return json(overrides.versionResponse ?? { success: true, result: version });
    }
    assert.fail(`unexpected readback URL: ${url}`);
  } });
  const attestation = await read();
  assert.equal(attestation.durable_object_export, "durable-object");
  assert.equal(attestation.deployment_id, active.id);
  assert.equal(attestation.version_id, version.id);
  assert.equal(attestation.version_number, 9);
  assert.equal(attestation.version_etag, "cloudflare-etag-opaque");
  assert.equal(attestation.traffic_percentage, 100);
  assert.equal(attestation.deployment_generation_binding, "PASS");
  assert.equal(attestation.binding_readback.length, 12);
  assert.deepEqual(attestation.vars_readback, { state: "PASS", binding_count: Object.keys(config.vars).length });
  assert.ok(!JSON.stringify(attestation).includes("test-aud"));
  assert.ok(!JSON.stringify(attestation).includes("never-return-this-secret-value"));
  const withoutOptionalSecret = structuredClone(version);
  delete withoutOptionalSecret.resources.bindings.GOOGLE_CLIENT_SECRET;
  assert.deepEqual((await read({ versionResponse: { success: true, result: withoutOptionalSecret } })).vars_readback,
    attestation.vars_readback);
  const withProviderControlSecret = structuredClone(version);
  withProviderControlSecret.resources.bindings.ELIOTR_MODEL_PROVIDER_CONTROL_TOKEN = {
    type: "secret_text", text: "nonsecret-test-sentinel",
  };
  const providerControlSecretReadback = await read({ versionResponse: {
    success: true, result: withProviderControlSecret,
  } });
  assert.deepEqual(providerControlSecretReadback, attestation);
  assert.ok(!JSON.stringify(providerControlSecretReadback).includes("nonsecret-test-sentinel"));
  await check("optional compatibility flags normalize only omission, preserving malformed and drift rejection", async () => {
    const omitted = structuredClone(version);
    delete omitted.resources.script_runtime.compatibility_flags;
    assert.deepEqual(await read({ versionResponse: { success: true, result: omitted } }), attestation);
    const required = { ...config, compatibility_flags: ["nodejs_compat"] };
    await assert.rejects(read({ versionResponse: { success: true, result: omitted } }, required), /flags drift/u);
    await assert.rejects(read({}, required), /flags drift/u);
    const matching = structuredClone(version);
    matching.resources.script_runtime.compatibility_flags = ["nodejs_compat"];
    assert.deepEqual(await read({ versionResponse: { success: true, result: matching } }, required), attestation);
    await assert.rejects(read({ versionResponse: { success: true, result: matching } }), /flags drift/u);
    for (const flags of [null, "nodejs_compat", {}, [null], [1], ["other_flag"]]) {
      const malformed = structuredClone(version);
      malformed.resources.script_runtime.compatibility_flags = flags;
      await assert.rejects(read({ versionResponse: { success: true, result: malformed } }, required), /flags drift/u);
    }
  });
  for (const inventory of [{ success: false, result: [worker] }, { result: [worker] },
    { success: true, result: [] }, { success: true, result: [worker, worker] },
    { success: true, result: [{ ...worker, has_assets: false }] },
    { success: true, result: [{ ...worker, compatibility_date: "old" }] }]) {
    await assert.rejects(read({ inventory }));
  }
  for (const deployments of [{ success: true, result: { deployments: [] } },
    { success: true, result: { deployments: [{ ...active, versions: [active.versions[0], active.versions[0]] }] } },
    { success: true, result: { deployments: [{ ...active, versions: [{ ...active.versions[0], percentage: 90 }] }] } }]) {
    await assert.rejects(read({ deployments }));
  }
  for (const mutate of [
    (value) => { value.id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; },
    (value) => { value.resources.script_runtime.compatibility_date = "2026-01-01T00:00:00Z"; },
    (value) => { value.resources.script_runtime.exports.ResearchSession.storage = "legacy-kv"; },
    (value) => { value.resources.bindings.CORE_DB.id = "ffffffff-ffff-4fff-8fff-ffffffffffff"; },
    (value) => { delete value.resources.bindings.ASSETS; },
    (value) => { value.resources.bindings.DEPLOYMENT_GENERATION.text = "stale-generation"; },
    (value) => { value.resources.bindings.ACCESS_AUDIENCE.text = "stale-audience"; },
    (value) => { value.resources.bindings.ACCESS_AUDIENCE.type = "json"; },
    (value) => { delete value.resources.bindings.ACCESS_AUDIENCE; },
    (value) => { value.resources.bindings.JSON_PROFILE.type = "plain_text"; },
    (value) => { value.resources.bindings.JSON_PROFILE.json = { limits: [1, 2], mode: "stale" }; },
    (value) => { value.resources.bindings.EXTRA_VAR = { type: "plain_text", text: "unexpected" }; },
    (value) => { value.resources.bindings.EXTRA_JSON = { type: "json", json: { enabled: true } }; },
    (value) => { value.resources.bindings.UNKNOWN_SECRET = { type: "secret_text" }; },
    (value) => { value.resources.bindings.GOOGLE_CLIENT_SECRET.type = "plain_text"; },
    (value) => { value.resources.bindings.ELIOTR_MODEL_PROVIDER_CONTROL_TOKEN = {
      type: "plain_text", text: "must-be-secret_text",
    }; },
    (value) => { value.resources.bindings.RESEARCH_SESSION.script_name = "foreign-worker"; },
    (value) => { value.resources.bindings.RESEARCH_SESSION.environment = "preview"; },
    (value) => { value.resources.bindings.EXTRA = { type: "r2_bucket", bucket_name: "other" }; },
    (value) => { value.resources.bindings.CORE_DB_DUP = { ...value.resources.bindings.CORE_DB, name: "CORE_DB" }; },
  ]) {
    const changed = structuredClone(version); mutate(changed);
    await assert.rejects(read({ versionResponse: { success: true, result: changed } }));
  }
  const malformedConfig = structuredClone(config);
  delete malformedConfig.d1_databases[0].database_id;
  await assert.rejects(read({}, malformedConfig));
});
console.log(`Deployment verification: ${cases} groups passed; live Cloudflare NOT_EXECUTED`);
