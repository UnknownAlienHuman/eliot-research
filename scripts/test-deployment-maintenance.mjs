import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCompositionCapabilityProfile } from "./check-launch-code.mjs";
import { assertMaintenanceCapabilityProfile, readActiveDeploymentIdentity,
  readAuthenticatedCapabilities, requireSameMaintenanceCapabilityReadback,
  selectDeploymentGoogleTransport, selectDeploymentAiSearchNamespaces,
  verifyDeploymentSchemaGenerations } from "./lib/deployment-maintenance.mjs";
import { loadMaintenanceRouteUpdate } from "./lib/deployment-route-update.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const candidate = await readCompositionCapabilityProfile({ root });
const generation = "git-fixture-active";
const identity = { federation_principal_ref: null, federation_cursor_key_bound: false, ai_search_bound: false };
const config = { vars: { GOOGLE_EXTERNAL_TRANSPORT: "gemini-mcp" } };
const observed = { protocol: candidate.protocol, deployment_generation: generation,
  google_external_transport: "gemini-mcp", enabled_slices: candidate.enabled_slices,
  partial_slices: candidate.partial_slices, disabled_slices: candidate.disabled_slices,
  federation_configured: false, orientation_profile: candidate.orientation_profile,
  orientation_max_sources: candidate.orientation_max_sources,
  orientation_max_results: candidate.orientation_max_results, routes: candidate.routes,
  ...candidate.safety_invariants };
const compare = (replacement = candidate, actual = observed, generatedConfig = config, active = identity) =>
  assertMaintenanceCapabilityProfile({ candidate: replacement, observed: actual,
    generatedConfig, activeWorkerIdentity: active });
let cases = 0;
const check = async (name, action) => { await action(); cases += 1; console.log(`Maintenance: ${name}: PASS`); };

await check("full release keeps canonical transport; maintenance preserves only confirmed disabled", () => {
  const canonicalTransport = "gemini-mcp";
  assert.equal(selectDeploymentGoogleTransport({ purpose: "FULL_RELEASE", canonicalTransport,
    observedTransport: "disabled" }), canonicalTransport);
  assert.equal(selectDeploymentGoogleTransport({ purpose: "MAINTENANCE", canonicalTransport,
    preserve: "disabled", observedTransport: "disabled" }), "disabled");
  assert.equal(compare(candidate, { ...observed, google_external_transport: "disabled" },
    { vars: { GOOGLE_EXTERNAL_TRANSPORT: "disabled" } }).state, "PASS");
  for (const fields of [
    { purpose: "FULL_RELEASE", preserve: "disabled", observedTransport: "disabled" },
    { preserve: "disabled" }, { preserve: "disabled", observedTransport: "unknown" },
    { preserve: "disabled", observedTransport: "gemini-mcp" },
    { preserve: "disabled", observedTransport: "drive-exchange" },
    { preserve: "gemini-mcp", observedTransport: "gemini-mcp" },
    { preserve: "drive-exchange", observedTransport: "drive-exchange" },
    { preserve: "unknown", observedTransport: "disabled" },
  ]) assert.throws(() => selectDeploymentGoogleTransport({ purpose: "MAINTENANCE", canonicalTransport, ...fields }));
});

await check("source-derived profile matches unchanged authenticated capabilities", () => {
  assert.equal(compare().state, "PASS");
  assert.ok(candidate.routes.length > 0);
  assert.ok(candidate.disabled_slices.includes("ERASURE"));
  assert.ok(candidate.disabled_slices.includes("RETRIEVAL"));
});
await check("maintenance preserves verified absent AI Search without changing full-release bindings", () => {
  const canonicalConfig = { ai_search_namespaces: [{ binding: "AI_SEARCH", namespace: "eliotr", remote: true }] };
  const fields = { purpose: "MAINTENANCE", canonicalConfig, preserve: "absent", activeWorkerIdentity: identity, candidate };
  assert.deepEqual(selectDeploymentAiSearchNamespaces(fields), []);
  assert.deepEqual(selectDeploymentAiSearchNamespaces({ ...fields, purpose: "FULL_RELEASE", preserve: undefined }),
    canonicalConfig.ai_search_namespaces);
  for (const changed of [
    { purpose: "FULL_RELEASE" }, { preserve: "present" }, { activeWorkerIdentity: {} },
    { activeWorkerIdentity: { ...identity, ai_search_bound: true } },
    { canonicalConfig: { ai_search_namespaces: [{ binding: "AI_SEARCH", namespace: "other", remote: true }] } },
    { canonicalConfig: { ...canonicalConfig, ai_search: [{ binding: "OTHER_SEARCH", instance_name: "other" }] } },
    { canonicalConfig: { ...canonicalConfig, ai_search: {} } },
    { candidate: { ...candidate, enabled_slices: [...candidate.enabled_slices, "RETRIEVAL"] } },
    { candidate: { ...candidate, disabled_slices: ["RETRIEVAL"] } },
  ]) assert.throws(() => selectDeploymentAiSearchNamespaces({ ...fields, ...changed }));
  assert.throws(() => compare(candidate, observed, { ...config, ...canonicalConfig }), /binding presence would change/u);
});
await check("maintenance refuses slices, route limits, transport and federation expansion", () => {
  assert.throws(() => compare({ ...candidate, enabled_slices: [...candidate.enabled_slices, "ERASURE"] }));
  assert.throws(() => compare({ ...candidate, routes: candidate.routes.map((route, index) => index === 0
    ? { ...route, maximum_request_bytes: route.maximum_request_bytes + 1 } : route) }));
  assert.throws(() => compare(candidate, observed, { vars: { GOOGLE_EXTERNAL_TRANSPORT: "disabled" } }));
  assert.throws(() => compare(candidate, observed, config,
    { federation_principal_ref: "new-principal", federation_cursor_key_bound: true }));
});
await check("unknown capability fields and weakened evidence/completion invariants fail closed", () => {
  assert.throws(() => compare(candidate, { ...observed, future_authority: true }));
  assert.throws(() => compare(candidate, { ...observed, exact_evidence_resolution_required: false }));
  assert.throws(() => compare(candidate, { ...observed, transport_completion_is_research_completion: true }));
  assert.throws(() => compare(candidate, { ...observed, routes: [...observed.routes, observed.routes[0]] }));
});
await check("generation may change only while the complete capability profile stays equal", () => {
  const baseline = { generation, capabilities: observed };
  const current = { generation: "git-fixture-candidate", capabilities: { ...observed,
    deployment_generation: "git-fixture-candidate" } };
  assert.equal(requireSameMaintenanceCapabilityReadback({ baseline, current }).state, "PASS");
  assert.throws(() => requireSameMaintenanceCapabilityReadback({ baseline,
    current: { ...current, capabilities: { ...current.capabilities, orientation_max_sources: 128 } } }));
  assert.throws(() => requireSameMaintenanceCapabilityReadback({ baseline,
    current: { ...current, generation: "git-unrelated" } }));
});

const updateRouteBefore = { method: "GET", path: "/api/v1/system/health", operation: "system.health",
  auth: "owner", maximum_request_bytes: 0, response_mode: "json" };
const updateRouteAfter = { ...updateRouteBefore, auth: "owner_or_service" };
const updateRouteAdded = { method: "GET", path: "/api/v1/system/capabilities", operation: "system.capabilities",
  auth: "owner", maximum_request_bytes: 0, response_mode: "json" };
const updateBaselineRoutes = [updateRouteBefore];
const updateCandidateRoutes = [updateRouteAfter, updateRouteAdded].sort((left, right) =>
  `${left.method}\n${left.path}`.localeCompare(`${right.method}\n${right.path}`));
const routeDigest = (routes) => createHash("sha256").update(JSON.stringify(routes)).digest("hex");
const updateSourceHead = "0123456789abcdef0123456789abcdef01234567";
const updateCandidateGeneration = `git-${updateSourceHead.slice(0, 12)}`;
const updateDeploymentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const updateVersionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const updateIdentity = { worker_id: "eliotr-core", deployment_id: updateDeploymentId, version_id: updateVersionId,
  generation, federation_principal_ref: null, federation_cursor_key_bound: false, ai_search_bound: false,
  access_service_principals: "" };
const updateIntent = {
  protocol: "eliotr.maintenance-route-update.v1",
  account_id: "fixture-account",
  hostname: "fixture.example.com",
  baseline: { deployment_id: updateDeploymentId, version_id: updateVersionId, generation,
    routes_sha256: routeDigest(updateBaselineRoutes) },
  candidate: { source_head: updateSourceHead, generation: updateCandidateGeneration,
    routes_sha256: routeDigest(updateCandidateRoutes) },
  baseline_routes: updateBaselineRoutes,
  candidate_routes: updateCandidateRoutes,
  added_routes: [updateRouteAdded],
  changed_routes: [{ before: updateRouteBefore, after: updateRouteAfter }],
  service_principals: "",
};
const updateIntentPath = resolve(root, ".eliotr-state", `deployment-route-update-fixture-${randomUUID()}.json`);
await writeFile(updateIntentPath, `${JSON.stringify(updateIntent)}\n`, { flag: "wx" });
try {
  const routeUpdate = await loadMaintenanceRouteUpdate({ path: updateIntentPath, root,
    sourceHead: updateSourceHead, candidateGeneration: updateCandidateGeneration,
    accountId: "fixture-account", hostname: "fixture.example.com", activeWorkerIdentity: updateIdentity,
    candidateRoutes: updateCandidateRoutes, observedRoutes: updateBaselineRoutes });
  const candidateWithUpdate = { ...candidate, routes: updateCandidateRoutes };
  const baselineWithUpdate = { ...observed, routes: updateBaselineRoutes };
  const configWithEmptyPrincipals = { ...config, vars: { ...config.vars, ACCESS_SERVICE_PRINCIPALS: "" } };
  const checkRouteProfile = (routes, phase, active = updateIdentity, generated = configWithEmptyPrincipals) =>
    assertMaintenanceCapabilityProfile({ candidate: candidateWithUpdate,
      observed: { ...observed, routes }, generatedConfig: generated,
      activeWorkerIdentity: active, routeUpdate, routeUpdatePhase: phase });
  await check("default maintenance still rejects route differences", () => {
    assert.throws(() => compare(candidateWithUpdate, baselineWithUpdate), /route surface/u);
  });
  await check("pinned route update accepts exact before and after route snapshots", () => {
    assert.equal(checkRouteProfile(updateBaselineRoutes, "before").profile, "pinned-route-update");
    assert.equal(checkRouteProfile(updateCandidateRoutes, "after").intent_sha256, routeUpdate.intent_sha256);
    const baseline = { generation, capabilities: baselineWithUpdate };
    const current = { generation: updateCandidateGeneration,
      capabilities: { ...observed, routes: updateCandidateRoutes,
        deployment_generation: updateCandidateGeneration } };
    assert.equal(requireSameMaintenanceCapabilityReadback({ baseline, current, routeUpdate }).profile,
      "pinned-route-update");
    assert.throws(() => checkRouteProfile([...updateCandidateRoutes, updateRouteAdded], "after"));
  });
  await check("pinned route update rejects service admission and non-route drift", () => {
    assert.throws(() => checkRouteProfile(updateBaselineRoutes, "before",
      { ...updateIdentity, access_service_principals: "agent.access" }), /service-principal allowlist/u);
    assert.throws(() => checkRouteProfile(updateBaselineRoutes, "before", updateIdentity,
      { ...configWithEmptyPrincipals, vars: { ...configWithEmptyPrincipals.vars,
        ACCESS_SERVICE_PRINCIPALS: "agent.access" } }), /service-principal allowlist/u);
    const baseline = { generation, capabilities: baselineWithUpdate };
    const current = { generation: updateCandidateGeneration,
      capabilities: { ...observed, routes: updateCandidateRoutes,
        deployment_generation: updateCandidateGeneration,
        orientation_max_sources: candidateWithUpdate.orientation_max_sources + 1 } };
    assert.throws(() => requireSameMaintenanceCapabilityReadback({ baseline, current, routeUpdate }),
      /profile changed/u);
  });
} finally {
  await unlink(updateIntentPath);
}

async function alteredSource(path, change) {
  const target = resolve(root, path);
  const source = await readFile(target, "utf8");
  const changed = change(source);
  assert.notEqual(changed, source, "fixture mutation must affect its source");
  return readCompositionCapabilityProfile({ root,
    read: (requested, encoding) => requested === target ? Promise.resolve(changed) : readFile(requested, encoding) });
}
await check("dynamic route mutation and import aliases cannot impersonate the static profile", async () => {
  await assert.rejects(alteredSource("packages/interfaces/src/routes.ts", (text) => `${text}\nROUTES.push({});\n`));
  await assert.rejects(alteredSource("packages/interfaces/src/routes.ts", (text) =>
    text.replace("import { RESEARCH_REQUEST_MAX_BYTES }", "import { RESEARCH_REQUEST_MAX_BYTES as OTHER_BYTES }")));
});
await check("duplicate, spread and dynamic capability fields are rejected", async () => {
  const path = "apps/eliotr-core/src/composition-root.ts";
  await assert.rejects(alteredSource(path, (text) => text.replace('protocol: "eliotr.capabilities.v1",',
    'protocol: "eliotr.capabilities.v1", protocol: "eliotr.capabilities.v1",')));
  await assert.rejects(alteredSource(path, (text) => text.replace('protocol: "eliotr.capabilities.v1",',
    'protocol: "eliotr.capabilities.v1", ...{},')));
  await assert.rejects(alteredSource(path, (text) => text.replace("transport_completion_is_research_completion: false,",
    "transport_completion_is_research_completion: Boolean(0),")));
});

const env = { CLOUDFLARE_ACCOUNT_ID: "fixture-account", CLOUDFLARE_API_TOKEN: "fixture-token" };
const input = { apiBase: "https://api.cloudflare.com/client/v4", origin: "https://fixture.example.com",
  cookie: "fixture-cookie" };
const deploymentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const versionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function workerReadback(change = () => {}) {
  const data = [
    { success: true, result: [{ id: "eliotr-core", compatibility_date: "2026-08-28", has_assets: true }] },
    { success: true, result: { deployments: [{ id: deploymentId, created_on: "2026-10-03T12:00:00.000Z",
      strategy: "percentage", versions: [{ version_id: versionId, percentage: 100 }] }] } },
    { success: true, result: { id: versionId, number: 9, resources: {
      script_runtime: { compatibility_date: "2026-08-28" },
      bindings: [{ name: "DEPLOYMENT_GENERATION", type: "plain_text", text: generation }],
    } } },
  ];
  change(data);
  let index = 0;
  return async () => ({ status: 200, data: data[index++] });
}
await check("existing Worker readback pins one 100 percent version and generation", async () => {
  const result = await readActiveDeploymentIdentity({ env, input, readJson: workerReadback() });
  assert.equal(result.generation, generation);
  assert.equal(result.version_id, versionId);
  assert.equal(result.traffic_percentage, 100);
  assert.equal(result.ai_search_bound, false);
  assert.equal(result.access_service_principals, null);
});
await check("active Worker service-principal readback preserves only exact plain-text values", async () => {
  const read = (binding) => readActiveDeploymentIdentity({ env, input, readJson: workerReadback((data) => {
    data[2].result.resources.bindings.push(binding);
  }) });
  assert.equal((await read({ name: "ACCESS_SERVICE_PRINCIPALS", type: "plain_text", text: "" }))
    .access_service_principals, "");
  assert.equal((await read({ name: "ACCESS_SERVICE_PRINCIPALS", type: "json", text: "" }))
    .access_service_principals, null);
});
await check("active Worker gateway URLs preserve only unique exact plain-text bindings", async () => {
  const reasoning = "https://gateway.ai.cloudflare.com/v1/fixture-account/eliotr-reasoning";
  const retrieval = "https://gateway.ai.cloudflare.com/v1/fixture-account/eliotr-retrieval";
  const read = (bindings) => readActiveDeploymentIdentity({ env, input, readJson: workerReadback((data) => {
    data[2].result.resources.bindings.push(...bindings);
  }) });
  assert.deepEqual((await read([
    { name: "AI_GATEWAY_REASONING_URL", type: "plain_text", text: reasoning },
    { name: "AI_GATEWAY_RETRIEVAL_URL", type: "plain_text", text: retrieval },
  ])).ai_gateway_urls, { reasoning, retrieval });
  assert.deepEqual((await read([])).ai_gateway_urls, { reasoning: null, retrieval: null });
  assert.deepEqual((await read([
    { name: "AI_GATEWAY_REASONING_URL", type: "json", text: reasoning },
    { name: "AI_GATEWAY_RETRIEVAL_URL", type: "plain_text", text: retrieval },
  ])).ai_gateway_urls, { reasoning: null, retrieval });
  await assert.rejects(read([
    { name: "AI_GATEWAY_REASONING_URL", type: "plain_text", text: reasoning },
    { name: "AI_GATEWAY_REASONING_URL", type: "plain_text", text: reasoning },
    { name: "AI_GATEWAY_RETRIEVAL_URL", type: "plain_text", text: retrieval },
  ]));
});
await check("active Worker readback detects AI Search handles under any binding name", async () => {
  for (const binding of [{ name: "AI_SEARCH", type: "ai_search_namespace" },
    { name: "CUSTOM_SEARCH", type: "ai_search_namespace" }, { name: "CUSTOM_SEARCH", type: "ai_search" }]) {
    const active = await readActiveDeploymentIdentity({ env, input, readJson: workerReadback((data) => {
      data[2].result.resources.bindings.push(binding);
    }) });
    assert.equal(active.ai_search_bound, true);
  }
});
await check("preserved transport requires a fresh exact active-version plain-text binding", async () => {
  const read = (binding) => readActiveDeploymentIdentity({ env, input, readJson: workerReadback((data) => {
    if (binding) data[2].result.resources.bindings.push(binding);
  }) });
  const binding = { name: "GOOGLE_EXTERNAL_TRANSPORT", type: "plain_text", text: "disabled" };
  const active = await read(binding);
  assert.equal(selectDeploymentGoogleTransport({ purpose: "MAINTENANCE", canonicalTransport: "gemini-mcp",
    preserve: "disabled", observedTransport: active.google_external_transport }), "disabled");
  for (const replacement of [null, { ...binding, type: "json" }, { ...binding, text: "unknown" },
    { ...binding, text: "gemini-mcp" }]) {
    const other = await read(replacement);
    assert.throws(() => selectDeploymentGoogleTransport({ purpose: "MAINTENANCE", canonicalTransport: "gemini-mcp",
      preserve: "disabled", observedTransport: other.google_external_transport }));
  }
});
await check("missing Worker, partial traffic, duplicate bindings and API errors deny", async () => {
  const mutations = [
    (data) => { data[0].result = []; },
    (data) => { data[1].result.deployments[0].versions[0].percentage = 50; },
    (data) => { data[2].result.resources.bindings.push({ name: "DEPLOYMENT_GENERATION", type: "plain_text", text: generation }); },
    (data) => { data[2].errors = [{ code: 1001 }]; },
  ];
  for (const change of mutations) await assert.rejects(readActiveDeploymentIdentity({ env, input,
    readJson: workerReadback(change) }));
});
await check("authenticated capabilities require exact envelope and generation agreement", async () => {
  const envelope = { trace_id: "fixture-trace", deployment_generation: generation, data: observed };
  const readJson = async () => ({ status: 200, data: envelope });
  assert.equal((await readAuthenticatedCapabilities({ input, readJson })).generation, generation);
  await assert.rejects(readAuthenticatedCapabilities({ input: { ...input, cookie: null }, readJson }));
  await assert.rejects(readAuthenticatedCapabilities({ input,
    readJson: async () => ({ status: 200, data: { ...envelope, unexpected: true } }) }));
  await assert.rejects(readAuthenticatedCapabilities({ input,
    readJson: async () => ({ status: 200, data: { ...envelope, deployment_generation: "git-other" } }) }));
});

const plan = [{ binding: "CORE_DB", database_id: "11111111-1111-4111-8111-111111111111" },
  { binding: "SEARCH_DB", database_id: "22222222-2222-4222-8222-222222222222" }];
async function schemaCheck({ stale = false, meta = { changed_db: false, rows_written: 0 } } = {}) {
  const requests = [];
  const result = await verifyDeploymentSchemaGenerations({ env, input, plan, root,
    fetchImpl: async (url, init) => {
      const query = JSON.parse(init.body);
      assert.equal(init.method, "POST");
      assert.equal(query.sql, "SELECT value FROM schema_state WHERE key = 'schema_generation' LIMIT 2");
      assert.deepEqual(query.params, []);
      requests.push(url);
      return globalThis.Response.json({ success: true, result: [{ success: true, meta,
        results: [{ value: stale ? "stale-schema" : url.includes(plan[0].database_id)
          ? "core-v11-owner-orientation" : "search-v4-ai-search-generation-registry" }] }] });
    } });
  return { result, requests };
}
await check("required schema generations use two bounded read-only queries", async () => {
  const { result, requests } = await schemaCheck();
  assert.equal(result.state, "PASS");
  assert.equal(requests.length, 2);
});
await check("schema mismatch and missing or write-bearing metadata refuse upload", async () => {
  await assert.rejects(schemaCheck({ stale: true }));
  await assert.rejects(schemaCheck({ meta: {} }));
  await assert.rejects(schemaCheck({ meta: { changed_db: true, rows_written: 0 } }));
  await assert.rejects(schemaCheck({ meta: { changed_db: false, rows_written: 1 } }));
});
console.log(`Deployment maintenance: ${cases} PASS (offline fixtures)`);
