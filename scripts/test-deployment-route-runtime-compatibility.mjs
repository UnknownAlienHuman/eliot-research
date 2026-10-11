import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadMaintenanceRouteUpdate, maintenanceRouteBaselineConfiguration,
  requireUnchangedMaintenanceRouteUpdate } from "./lib/deployment-route-update.mjs";
import { readDeploymentWorker } from "./lib/deployment-verification.mjs";

const root = await mkdtemp(resolve(tmpdir(), "eliotr-runtime-transition-"));
const file = resolve(root, ".eliotr-state/intent.json");
const sourceHead = "a".repeat(40), generation = "git-" + sourceHead.slice(0, 12);
const active = { worker_id: "eliotr-core", deployment_id: "11111111-1111-4111-8111-111111111111",
  version_id: "22222222-2222-4222-8222-222222222222", generation: "old", access_service_principals: "" };
const route = path => ({ method: "GET", path, operation: "OWNER_READ", auth: "owner",
  maximum_request_bytes: 0, response_mode: "json" });
const baselineRoutes = [route("/api/old")], addedRoute = route("/agents/research-session/probe");
const candidateRoutes = [addedRoute, ...baselineRoutes];
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const runtime = { compatibility_date: "2026-08-28", baseline_flags: [], candidate_flags: ["enhanced_error_serialization"] };
const makeIntent = () => ({ protocol: "eliotr.maintenance-route-update.v2", account_id: "a".repeat(32),
  hostname: "eliotr-core.example.workers.dev",
  baseline: { deployment_id: active.deployment_id, version_id: active.version_id, generation: active.generation,
    routes_sha256: digest(baselineRoutes) },
  candidate: { source_head: sourceHead, generation, routes_sha256: digest(candidateRoutes) },
  baseline_routes: baselineRoutes, candidate_routes: candidateRoutes, added_routes: [addedRoute],
  changed_routes: [], service_principals: "", runtime_compatibility: structuredClone(runtime) });
const load = async intent => {
  await writeFile(file, JSON.stringify(intent));
  return loadMaintenanceRouteUpdate({ path: file, root, sourceHead, candidateGeneration: generation,
    accountId: "a".repeat(32), hostname: "eliotr-core.example.workers.dev", activeWorkerIdentity: active,
    candidateRoutes, observedRoutes: baselineRoutes });
};
try {
  await mkdir(resolve(root, ".eliotr-state"));
  const intent = makeIntent(), approved = await load(intent);
  const config = { compatibility_date: runtime.compatibility_date, compatibility_flags: runtime.candidate_flags,
    vars: { ACCESS_AUDIENCE: "unchanged", DEPLOYMENT_GENERATION: generation },
    d1_databases: [{ binding: "CORE_DB", database_id: "unchanged" }], assets: { binding: "ASSETS" } };
  const snapshot = structuredClone(config);
  assert.deepEqual(maintenanceRouteBaselineConfiguration({ routeUpdate: approved, config }),
    { ...config, compatibility_flags: [] });
  assert.deepEqual(config, snapshot, "candidate and all non-flag fields must remain unchanged");
  for (const bindingBootstrap of [{ binding: "AI_SEARCH:eliotr" }, { binding: "PRIMARY" }]) {
    assert.throws(() => maintenanceRouteBaselineConfiguration({ routeUpdate: approved, config, bindingBootstrap }),
      /cannot be combined/u);
  }
  const workerConfig = { ...config, name: "eliotr-core" };
  const readWithFlags = (expected, actual, actualBrowser = false) => readDeploymentWorker({ CLOUDFLARE_ACCOUNT_ID: "fixture-account",
    CLOUDFLARE_API_TOKEN: "fixture-unused" }, { apiBase: "https://api.fixture.invalid" }, expected, {
    fetchImpl: async url => {
      let result;
      if (url.endsWith("/workers/scripts")) result = [{ id: "eliotr-core", compatibility_date: runtime.compatibility_date, has_assets: true }];
      else if (url.endsWith("/deployments")) result = { deployments: [{ id: active.deployment_id,
        created_on: "2026-10-11T00:00:00Z", strategy: "percentage", versions: [{ version_id: active.version_id, percentage: 100 }] }] };
      else if (url.endsWith("/versions/" + active.version_id)) result = { id: active.version_id, number: 1,
        resources: { bindings: [{ name: "DEPLOYMENT_GENERATION", type: "plain_text", text: expected.vars.DEPLOYMENT_GENERATION },
          ...(actualBrowser ? [{ name: "BROWSER", type: actualBrowser }] : [])], script: { etag: "fixture-etag" },
        script_runtime: { compatibility_date: runtime.compatibility_date, compatibility_flags: actual,
          exports: { ResearchSession: { type: "durable-object", storage: "sqlite" } } } } };
      else assert.fail("unexpected fixture endpoint");
      return new globalThis.Response(JSON.stringify({ success: true, result }), { headers: { "content-type": "application/json" } });
    },
  });
  await assert.rejects(readWithFlags(maintenanceRouteBaselineConfiguration({ routeUpdate: approved, config: workerConfig }),
    ["enhanced_error_serialization"]), /Worker version compatibility flags drift/u,
  "actual old-version flags must match the declared baseline");
  await assert.rejects(readWithFlags(workerConfig, []), /Worker version compatibility flags drift/u,
    "actual post-upload flags must match the unchanged candidate");
  await requireUnchangedMaintenanceRouteUpdate({ routeUpdate: approved });
  const browserIntent = makeIntent(); browserIntent.protocol = "eliotr.maintenance-route-update.v3";
  browserIntent.browser_binding = { baseline_present: false, candidate: { name: "BROWSER", type: "browser" } };
  const browserApproved = await load(browserIntent);
  const browserConfig = { name: "eliotr-core", compatibility_date: runtime.compatibility_date,
    compatibility_flags: runtime.candidate_flags, browser: { binding: "BROWSER" }, vars: { DEPLOYMENT_GENERATION: "old" },
    exports: { ResearchSession: { type: "durable-object", storage: "sqlite" } },
    d1_databases: [], r2_buckets: [], queues: { producers: [] }, durable_objects: { bindings: [] }, workflows: [], analytics_engine_datasets: [] };
  const browserSnapshot = structuredClone(browserConfig);
  const browserBaseline = maintenanceRouteBaselineConfiguration({ routeUpdate: browserApproved, config: browserConfig });
  assert.equal(Object.hasOwn(browserBaseline, "browser"), false);
  assert.deepEqual(browserConfig, browserSnapshot);
  await assert.rejects(readWithFlags(browserBaseline, [], "browser"), /undeclared binding or secret/u,
    "an existing old Browser binding must reject the declared absent baseline");
  for (const observed of [false, "service"]) {
    await assert.rejects(readWithFlags(browserConfig, runtime.candidate_flags, observed), /binding identity drift: BROWSER/u,
      "the new version must contain the exact Browser binding and type");
  }
  for (const change of [
    x => { x.browser_binding.baseline_present = true; },
    x => { x.browser_binding.candidate.name = "OTHER"; },
    x => { x.browser_binding.candidate.type = "service"; },
    x => { x.browser_binding.extra = true; },
  ]) {
    const invalid = structuredClone(browserIntent); change(invalid); await assert.rejects(load(invalid));
  }
  assert.throws(() => maintenanceRouteBaselineConfiguration({ routeUpdate: browserApproved,
    config: { ...browserConfig, browser: { binding: "OTHER" } } }), /does not match/u);
  for (const change of [
    x => { x.runtime_compatibility.compatibility_date = "2026-09-01"; },
    x => { x.runtime_compatibility.baseline_flags = ["nodejs_compat"]; },
    x => { x.runtime_compatibility.candidate_flags.push("nodejs_compat"); },
    x => { x.runtime_compatibility.candidate_flags = []; },
    x => { x.runtime_compatibility.extra = true; },
    x => { x.candidate.source_head = "b".repeat(40); },
    x => { x.baseline.version_id = "33333333-3333-4333-8333-333333333333"; },
  ]) {
    const invalid = makeIntent(); change(invalid); await assert.rejects(load(invalid));
  }
  assert.throws(() => maintenanceRouteBaselineConfiguration({ routeUpdate: approved,
    config: { ...config, compatibility_flags: [] } }), /does not match/u);
  assert.throws(() => maintenanceRouteBaselineConfiguration({ routeUpdate: { ...approved }, config }), /validated/u);
  const old = makeIntent(); old.protocol = "eliotr.maintenance-route-update.v1";
  await assert.rejects(load(old), /fields/u);
  delete old.runtime_compatibility;
  const oldApproved = await load(old);
  assert.equal(maintenanceRouteBaselineConfiguration({ routeUpdate: oldApproved, config }), config,
    "v1 keeps its exact candidate flags and existing strict verification");
  assert.equal(maintenanceRouteBaselineConfiguration({ routeUpdate: null, config }), config);
  await writeFile(file, JSON.stringify({ ...old, extra: true }));
  await assert.rejects(requireUnchangedMaintenanceRouteUpdate({ routeUpdate: oldApproved }), /changed/u);
  console.log("Runtime compatibility transition: PASS (closed v2/v3 profiles, exact identities, immutable candidate, actual old/new flag and Browser denials, v1 strict, changed/forged intent rejected).");
} finally { await rm(root, { recursive: true, force: true }); }
