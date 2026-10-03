import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assertRouteUpdateProfile, assertRouteUpdateReadback, loadMaintenanceRouteUpdate,
  requireUnchangedMaintenanceRouteUpdate } from "./lib/deployment-route-update.mjs";

const sourceHead = "a".repeat(40);
const candidateGeneration = `git-${sourceHead.slice(0, 12)}`;
const accountId = "0123456789abcdef0123456789abcdef";
const hostname = "eliot-fixture.example.com";
const activeWorkerIdentity = Object.freeze({ worker_id: "eliotr-core",
  deployment_id: "11111111-1111-4111-8111-111111111111",
  version_id: "22222222-2222-4222-8222-222222222222", generation: "git-66a0e20",
  access_service_principals: "" });
const baselineRoutes = Object.freeze([
  Object.freeze({ method: "GET", path: "/api/v1/research/catalog", operation: "catalog", auth: "owner",
    maximum_request_bytes: 1024, response_mode: "json" }),
  Object.freeze({ method: "POST", path: "/api/v1/research/run", operation: "run", auth: "owner",
    maximum_request_bytes: 4096, response_mode: "json" }),
]);
const candidateRoutes = Object.freeze([
  Object.freeze({ method: "GET", path: "/api/v1/research/agent-task/:task_id", operation: "agentTaskStatus",
    auth: "service", maximum_request_bytes: 1024, response_mode: "json" }),
  Object.freeze({ method: "GET", path: "/api/v1/research/catalog", operation: "catalog", auth: "owner",
    maximum_request_bytes: 1024, response_mode: "json" }),
  Object.freeze({ method: "POST", path: "/api/v1/research/run", operation: "run", auth: "owner_or_service",
    maximum_request_bytes: 4096, response_mode: "json" }),
]);

let checks = 0;
const check = async (name, action) => {
  await action();
  checks += 1;
  console.log(`Route update: ${name}: PASS`);
};

async function makeFixture({ base = baselineRoutes, candidate = candidateRoutes, mutateIntent, rawIntent } = {}) {
  const root = await mkdtemp(join(tmpdir(), "eliotr-route-update-"));
  const stateDir = resolve(root, ".eliotr-state");
  const filePath = resolve(stateDir, "maintenance-route-update.json");
  await mkdir(stateDir, { recursive: true });
  const intent = mutateIntent ? mutateIntent(makeIntent(base, candidate)) : makeIntent(base, candidate);
  await writeFile(filePath, rawIntent ?? JSON.stringify(intent), "utf8");
  return { root, filePath, intent, base, candidate };
}

function makeIntent(base, candidate) {
  const normalizedBase = normalizeRoutes(base);
  const normalizedCandidate = normalizeRoutes(candidate);
  const baseByKey = new Map(normalizedBase.map((route) => [routeKey(route), route]));
  const candidateByKey = new Map(normalizedCandidate.map((route) => [routeKey(route), route]));
  const added = normalizedCandidate.filter((route) => !baseByKey.has(routeKey(route)));
  const changed = [];
  for (const [key, before] of baseByKey) {
    const after = candidateByKey.get(key);
    if (after && JSON.stringify(before) !== JSON.stringify(after)) changed.push({ before, after });
  }
  return {
    protocol: "eliotr.maintenance-route-update.v1",
    account_id: accountId,
    hostname,
    baseline: { deployment_id: activeWorkerIdentity.deployment_id, version_id: activeWorkerIdentity.version_id,
      generation: activeWorkerIdentity.generation, routes_sha256: routeDigest(normalizedBase) },
    candidate: { source_head: sourceHead, generation: candidateGeneration,
      routes_sha256: routeDigest(normalizedCandidate) },
    baseline_routes: normalizedBase,
    candidate_routes: normalizedCandidate,
    added_routes: added,
    changed_routes: changed,
    service_principals: "",
  };
}

function normalizeRoutes(routes) {
  return routes.map((route) => ({ method: route.method, path: route.path, operation: route.operation,
    auth: route.auth, maximum_request_bytes: route.maximum_request_bytes, response_mode: route.response_mode }))
    .sort((left, right) => routeKey(left) < routeKey(right) ? -1 : routeKey(left) > routeKey(right) ? 1 : 0);
}
function routeKey(route) { return `${route.method}\n${route.path}`; }
function routeDigest(routes) { return createHash("sha256").update(JSON.stringify(routes), "utf8").digest("hex"); }
const load = (fixture, options = {}) => loadMaintenanceRouteUpdate({ path: fixture.filePath, root: fixture.root,
  sourceHead, candidateGeneration, accountId, hostname, activeWorkerIdentity,
  candidateRoutes: fixture.candidate, observedRoutes: fixture.base, ...options });
const clean = (fixture) => rm(fixture.root, { recursive: true, force: true });

try {
  await check("exact pinned route cutover and phase readbacks", async () => {
    const fixture = await makeFixture();
    try {
      let reads = 0;
      const routeUpdate = await load(fixture, { read: async (path) => { reads += 1; return readFile(path); } });
      assert.equal(routeUpdate.intent_sha256, createHash("sha256").update(await readFile(fixture.filePath)).digest("hex"));
      assert.equal(routeUpdate.added_routes.length, 1);
      assert.equal(routeUpdate.changed_routes.length, 1);
      assert.equal(Object.isFrozen(routeUpdate), true);
      assert.equal(Object.isFrozen(routeUpdate.candidate_routes[0]), true);
      assert.equal(assertRouteUpdateProfile({ routeUpdate, candidateRoutes: fixture.candidate,
        observedRoutes: fixture.base, phase: "before" }).state, "PASS");
      assert.equal((await requireUnchangedMaintenanceRouteUpdate({ routeUpdate })).state, "PASS");
      assert.equal(assertRouteUpdateProfile({ routeUpdate, candidateRoutes: fixture.candidate,
        observedRoutes: fixture.candidate, phase: "after" }).state, "PASS");
      assert.equal(assertRouteUpdateReadback({ routeUpdate, baselineRoutes: fixture.base,
        currentRoutes: fixture.candidate }).state, "PASS");
      assert.equal(reads, 2);
    } finally { await clean(fixture); }
  });

  await check("route hashes and source, generation, account, hostname and active Worker pins are exact", async () => {
    const fixture = await makeFixture();
    try {
      const wrongBaselineHash = await makeFixture({ mutateIntent: (intent) => ({ ...intent,
        baseline: { ...intent.baseline, routes_sha256: "0".repeat(64) } }) });
      try { await assert.rejects(load(wrongBaselineHash)); } finally { await clean(wrongBaselineHash); }
      const wrongCandidateHash = await makeFixture({ mutateIntent: (intent) => ({ ...intent,
        candidate: { ...intent.candidate, routes_sha256: "0".repeat(64) } }) });
      try { await assert.rejects(load(wrongCandidateHash)); } finally { await clean(wrongCandidateHash); }
      await assert.rejects(load(fixture, { sourceHead: "b".repeat(40) }));
      await assert.rejects(load(fixture, { candidateGeneration: "git-bbbbbbbbbbbb" }));
      await assert.rejects(load(fixture, { accountId: "fedcba9876543210fedcba9876543210" }));
      await assert.rejects(load(fixture, { hostname: "other.example.com" }));
      await assert.rejects(load(fixture, { activeWorkerIdentity: { ...activeWorkerIdentity,
        version_id: "33333333-3333-4333-8333-333333333333" } }));
      await assert.rejects(load(fixture, { activeWorkerIdentity: { ...activeWorkerIdentity, generation: "git-stale" } }));
      await assert.rejects(load(fixture, { activeWorkerIdentity: { ...activeWorkerIdentity,
        access_service_principals: "service-client" } }));
    } finally { await clean(fixture); }
  });

  await check("removals, non-auth route changes, public additions and undeclared deltas fail closed", async () => {
    const removed = await makeFixture({ candidate: [candidateRoutes[1]] });
    try { await assert.rejects(load(removed)); } finally { await clean(removed); }
    const operationChanged = baselineRoutes.map((route) => route.path.endsWith("/catalog")
      ? { ...route, operation: "catalogChanged" } : route);
    const changed = await makeFixture({ candidate: operationChanged });
    try { await assert.rejects(load(changed)); } finally { await clean(changed); }
    const publicAddition = await makeFixture({ candidate: [...candidateRoutes,
      { method: "GET", path: "/api/v1/public-added", operation: "publicAdded", auth: "public",
        maximum_request_bytes: 128, response_mode: "json" }] });
    try { await assert.rejects(load(publicAddition)); } finally { await clean(publicAddition); }
    const undeclared = await makeFixture({ mutateIntent: (intent) => ({ ...intent, added_routes: [] }) });
    try { await assert.rejects(load(undeclared)); } finally { await clean(undeclared); }
    const changedUndeclared = await makeFixture({ mutateIntent: (intent) => ({ ...intent, changed_routes: [] }) });
    try { await assert.rejects(load(changedUndeclared)); } finally { await clean(changedUndeclared); }
  });

  await check("unknown and duplicate fields, duplicate routes and nonempty service principals are rejected", async () => {
    const unknown = await makeFixture({ mutateIntent: (intent) => ({ ...intent, future_authority: true }) });
    try { await assert.rejects(load(unknown)); } finally { await clean(unknown); }
    const duplicateField = await makeFixture();
    const duplicateText = JSON.stringify(duplicateField.intent).replace(
      '"protocol":"eliotr.maintenance-route-update.v1",',
      '"protocol":"eliotr.maintenance-route-update.v1","protocol":"eliotr.maintenance-route-update.v1",');
    try {
      await writeFile(duplicateField.filePath, duplicateText, "utf8");
      await assert.rejects(load(duplicateField));
    } finally { await clean(duplicateField); }
    const duplicateRoute = await makeFixture();
    try { await assert.rejects(load(duplicateRoute, { candidateRoutes: [...duplicateRoute.candidate,
      duplicateRoute.candidate[0]] })); } finally { await clean(duplicateRoute); }
    const principals = await makeFixture({ mutateIntent: (intent) => ({ ...intent, service_principals: "svc-live" }) });
    try { await assert.rejects(load(principals)); } finally { await clean(principals); }
  });

  await check("intent file must stay inside state, unchanged, and phase/readback comparisons are exact", async () => {
    const fixture = await makeFixture();
    try {
      await assert.rejects(load(fixture, { path: resolve(fixture.root, "outside.json") }));
      const routeUpdate = await load(fixture);
      await writeFile(fixture.filePath, `${await readFile(fixture.filePath, "utf8")} `, "utf8");
      await assert.rejects(requireUnchangedMaintenanceRouteUpdate({ routeUpdate }));
    } finally { await clean(fixture); }
    const comparisons = await makeFixture();
    try {
      const routeUpdate = await load(comparisons);
      assert.throws(() => assertRouteUpdateProfile({ routeUpdate, candidateRoutes: comparisons.candidate,
        observedRoutes: comparisons.candidate, phase: "before" }));
      assert.throws(() => assertRouteUpdateProfile({ routeUpdate, candidateRoutes: comparisons.candidate,
        observedRoutes: comparisons.base, phase: "unknown" }));
      assert.throws(() => assertRouteUpdateReadback({ routeUpdate, baselineRoutes: comparisons.base,
        currentRoutes: comparisons.base }));
      assert.throws(() => assertRouteUpdateReadback({ routeUpdate: { ...routeUpdate },
        baselineRoutes: comparisons.base, currentRoutes: comparisons.candidate }));
    } finally { await clean(comparisons); }
  });

  console.log(`Route update fixtures: ${checks} cases PASS`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Route update fixture failed");
  process.exitCode = 1;
}
