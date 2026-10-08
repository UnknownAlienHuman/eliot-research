import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertMaintenanceCapabilityProfile, requireSameMaintenanceCapabilityReadback,
  selectDeploymentAiSearchNamespaces } from
  "./lib/deployment-maintenance.mjs";
import { assertMaintenanceAiSearchBootstrapProfile, loadMaintenanceAiSearchBootstrap,
  requireUnchangedMaintenanceAiSearchBootstrap } from "./lib/deployment-ai-search-bootstrap.mjs";
import { loadMaintenanceRouteUpdate } from "./lib/deployment-route-update.mjs";
import { readCompositionCapabilityProfile } from "./check-launch-code.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const sourceHead = "a".repeat(40);
const candidateGeneration = `git-${sourceHead.slice(0, 12)}`;
const baselineGeneration = "git-baseline-old";
const deploymentId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const accountId = "fixture-account";
const profile = await readCompositionCapabilityProfile({ root: repositoryRoot });
const candidateCapabilities = Object.freeze({
  ...profile,
  disabled_slices: [...profile.disabled_slices],
  enabled_slices: [...profile.enabled_slices],
  partial_slices: [...profile.partial_slices],
  routes: profile.routes.map((route) => ({ ...route })),
});
const observedCapabilities = (generation) => ({
  protocol: candidateCapabilities.protocol,
  deployment_generation: generation,
  google_external_transport: "gemini-mcp",
  enabled_slices: [...candidateCapabilities.enabled_slices],
  partial_slices: [...candidateCapabilities.partial_slices],
  disabled_slices: [...candidateCapabilities.disabled_slices],
  federation_configured: false,
  orientation_profile: candidateCapabilities.orientation_profile,
  orientation_max_sources: candidateCapabilities.orientation_max_sources,
  orientation_max_results: candidateCapabilities.orientation_max_results,
  routes: candidateCapabilities.routes.map((route) => ({ ...route })),
  ...candidateCapabilities.safety_invariants,
});
const baselineIdentity = {
  worker_id: "eliotr-core", deployment_id: deploymentId, version_id: versionId,
  generation: baselineGeneration, ai_search_bound: false,
  federation_principal_ref: null, federation_cursor_key_bound: false,
};
const baselineConfigSha256 = "b".repeat(64);
const candidateConfigurationSha256 = "c".repeat(64);
const baselineConfigurationBaseline = {
  deployment_id: deploymentId, version_id: versionId,
  deployment_generation: baselineGeneration, configuration_sha256: baselineConfigSha256,
};
const vars = { GOOGLE_EXTERNAL_TRANSPORT: "gemini-mcp", ACCESS_SERVICE_PRINCIPALS: "" };
const candidateConfig = {
  ai_search_namespaces: [{ binding: "AI_SEARCH", namespace: "eliotr", remote: true }],
  ai_search: [], vars,
};
const baselineConfig = { ...candidateConfig, ai_search_namespaces: [], ai_search: [] };
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
let cases = 0;
const check = async (name, action) => {
  await action();
  cases += 1;
  console.log(`AI Search bootstrap: ${name}: PASS`);
};

async function withFixture(action) {
  const temporaryRoot = resolve(tmpdir());
  const prefix = "eliotr-ai-search-bootstrap-";
  const root = await mkdtemp(join(temporaryRoot, prefix));
  if (dirname(resolve(root)) !== temporaryRoot || !basename(root).startsWith(prefix)) {
    throw new Error("AI Search bootstrap test fixture escaped the OS temporary root");
  }
  try {
    await mkdir(resolve(root, ".eliotr-state"));
    await mkdir(resolve(root, "infra", "ai-search"), { recursive: true });
    const manifestPath = resolve(root, "infra", "ai-search", "instances.json");
    const manifestBytes = Buffer.from('{"protocol":"fixture"}\n');
    await writeFile(manifestPath, manifestBytes, { flag: "wx" });
    const intentPath = resolve(root, ".eliotr-state", "ai-search-bootstrap-intent.json");
    const intent = {
      protocol: "eliotr.maintenance-ai-search-binding-bootstrap.v1",
      account_id: accountId,
      worker_id: "eliotr-core",
      binding: { name: "AI_SEARCH", type: "ai_search_namespace", namespace: "eliotr", remote: true },
      baseline: { deployment_id: deploymentId, version_id: versionId, generation: baselineGeneration,
        configuration_sha256: baselineConfigSha256 },
      candidate: { source_head: sourceHead, generation: candidateGeneration,
        configuration_sha256: candidateConfigurationSha256 },
      manifest_sha256: sha256(manifestBytes),
    };
    await writeFile(intentPath, `${JSON.stringify(intent)}\n`, { flag: "wx" });
    await action({ root, manifestPath, manifestBytes, intentPath, intent });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function loadFixture({ root, intentPath }) {
  const readback = { ...baselineConfigurationBaseline, configuration: { fixture: true } };
  const bootstrap = await loadMaintenanceAiSearchBootstrap({
    path: intentPath, root, accountId, sourceHead, candidateGeneration,
    candidateConfigurationSha256, candidateConfig, candidateCapabilities,
    activeWorkerIdentity: baselineIdentity, baselineConfigurationBaseline: readback,
    baselineConfig,
  });
  return { bootstrap, readback };
}

await check("one exact absent-to-bound namespace transition passes with disabled product slices", async () => {
  await withFixture(async ({ root, intentPath }) => {
    const { bootstrap } = await loadFixture({ root, intentPath });
    assert.equal(assertMaintenanceAiSearchBootstrapProfile({ bootstrap, phase: "before",
      generatedConfig: candidateConfig, activeWorkerIdentity: baselineIdentity }).state, "PASS");
    const selected = selectDeploymentAiSearchNamespaces({ purpose: "MAINTENANCE", canonicalConfig: candidateConfig,
      activeWorkerIdentity: baselineIdentity, candidate: candidateCapabilities, aiSearchBootstrap: bootstrap });
    assert.deepEqual(selected, candidateConfig.ai_search_namespaces);
    const baseline = assertMaintenanceCapabilityProfile({ candidate: candidateCapabilities,
      observed: observedCapabilities(baselineGeneration), generatedConfig: candidateConfig,
      activeWorkerIdentity: baselineIdentity, aiSearchBootstrap: bootstrap });
    assert.equal(baseline.profile, "ai-search-binding-bootstrap");
    const afterIdentity = { ...baselineIdentity, generation: candidateGeneration, ai_search_bound: true };
    assert.equal(assertMaintenanceAiSearchBootstrapProfile({ bootstrap, phase: "after",
      generatedConfig: candidateConfig, activeWorkerIdentity: afterIdentity }).state, "PASS");
    assert.equal(assertMaintenanceCapabilityProfile({ candidate: candidateCapabilities,
      observed: observedCapabilities(candidateGeneration), generatedConfig: candidateConfig,
      activeWorkerIdentity: afterIdentity, aiSearchBootstrap: bootstrap,
      aiSearchBootstrapPhase: "after" }).ai_search_binding_bootstrap, "PASS");
    assert.equal((await requireUnchangedMaintenanceAiSearchBootstrap({ bootstrap })).state, "PASS");
  });
});

await check("AI Search bootstrap composes with an independent exact pinned route update", async () => {
  await withFixture(async ({ root, intentPath }) => {
    const { bootstrap } = await loadFixture({ root, intentPath });
    const candidateRoutes = candidateCapabilities.routes.map((route) => ({ ...route }));
    const selected = candidateRoutes.find((route) => route.auth === "owner_or_service");
    assert.ok(selected, "fixture needs one source-owned owner_or_service route");
    const before = { ...selected, auth: "owner" };
    const baselineRoutes = candidateRoutes.map((route) => route === selected ? before : route)
      .sort((left, right) => `${left.method}\n${left.path}`.localeCompare(`${right.method}\n${right.path}`));
    const routeDigest = (routes) => sha256(JSON.stringify(routes));
    const routePath = resolve(root, ".eliotr-state", "route-update-intent.json");
    const routeIntent = {
      protocol: "eliotr.maintenance-route-update.v1", account_id: accountId,
      hostname: "research.example.com",
      baseline: { deployment_id: deploymentId, version_id: versionId, generation: baselineGeneration,
        routes_sha256: routeDigest(baselineRoutes) },
      candidate: { source_head: sourceHead, generation: candidateGeneration,
        routes_sha256: routeDigest(candidateRoutes) },
      baseline_routes: baselineRoutes,
      candidate_routes: candidateRoutes,
      added_routes: [], changed_routes: [{ before, after: selected }], service_principals: "",
    };
    await writeFile(routePath, `${JSON.stringify(routeIntent)}\n`, { flag: "wx" });
    const routeIdentity = { ...baselineIdentity, access_service_principals: "" };
    const routeUpdate = await loadMaintenanceRouteUpdate({ path: routePath, root, sourceHead,
      candidateGeneration, accountId, hostname: routeIntent.hostname,
      activeWorkerIdentity: routeIdentity, candidateRoutes, observedRoutes: baselineRoutes });
    const candidateWithRouteUpdate = { ...candidateCapabilities, routes: candidateRoutes };
    const beforeObserved = { ...observedCapabilities(baselineGeneration), routes: baselineRoutes };
    const afterObserved = { ...observedCapabilities(candidateGeneration), routes: candidateRoutes };
    const beforeProfile = assertMaintenanceCapabilityProfile({ candidate: candidateWithRouteUpdate,
      observed: beforeObserved, generatedConfig: candidateConfig, activeWorkerIdentity: routeIdentity,
      routeUpdate, routeUpdatePhase: "before", aiSearchBootstrap: bootstrap,
      aiSearchBootstrapPhase: "before" });
    assert.equal(beforeProfile.profile, "pinned-route-update");
    assert.equal(beforeProfile.ai_search_binding_bootstrap, "PASS");
    assertMaintenanceCapabilityProfile({ candidate: candidateWithRouteUpdate,
      observed: afterObserved, generatedConfig: candidateConfig,
      activeWorkerIdentity: { ...routeIdentity, generation: candidateGeneration, ai_search_bound: true },
      routeUpdate, routeUpdatePhase: "after", aiSearchBootstrap: bootstrap,
      aiSearchBootstrapPhase: "after" });
    assert.equal(requireSameMaintenanceCapabilityReadback({
      baseline: { generation: baselineGeneration, capabilities: beforeObserved },
      current: { generation: candidateGeneration, capabilities: afterObserved }, routeUpdate,
    }).profile, "pinned-route-update");
  });
});

await check("bootstrap cannot be used for full release or combined with absent preservation", async () => {
  await withFixture(async ({ root, intentPath }) => {
    const { bootstrap } = await loadFixture({ root, intentPath });
    assert.throws(() => selectDeploymentAiSearchNamespaces({ purpose: "FULL_RELEASE",
      canonicalConfig: candidateConfig, activeWorkerIdentity: baselineIdentity,
      candidate: candidateCapabilities, aiSearchBootstrap: bootstrap }), /maintenance-only/u);
    assert.throws(() => selectDeploymentAiSearchNamespaces({ purpose: "MAINTENANCE",
      canonicalConfig: candidateConfig, preserve: "absent", activeWorkerIdentity: baselineIdentity,
      candidate: candidateCapabilities, aiSearchBootstrap: bootstrap }), /cannot be combined/u);
  });
});

await check("unrelated resource bindings remain part of the exact baseline comparison", async () => {
  await withFixture(async ({ root, intentPath }) => {
    const changedBaseline = { ...baselineConfig,
      r2_buckets: [{ binding: "EVIDENCE", bucket_name: "other" }] };
    await assert.rejects(loadMaintenanceAiSearchBootstrap({ path: intentPath, root, accountId, sourceHead,
      candidateGeneration, candidateConfigurationSha256, candidateConfig, candidateCapabilities,
      activeWorkerIdentity: baselineIdentity, baselineConfigurationBaseline, baselineConfig: changedBaseline }),
    /only by the namespace binding/u);
  });
});

await check("invalid binding, enabled slices, candidate pin and extra intent fields fail closed", async () => {
  await withFixture(async ({ root, intentPath, intent }) => {
    const altered = { ...candidateConfig, ai_search_namespaces: [{ binding: "OTHER", namespace: "eliotr", remote: true }] };
    await assert.rejects(loadMaintenanceAiSearchBootstrap({ path: intentPath, root, accountId, sourceHead,
      candidateGeneration, candidateConfigurationSha256, candidateConfig: altered, candidateCapabilities,
      activeWorkerIdentity: baselineIdentity,
      baselineConfigurationBaseline, baselineConfig }));
    await assert.rejects(loadMaintenanceAiSearchBootstrap({ path: intentPath, root, accountId, sourceHead,
      candidateGeneration, candidateConfigurationSha256, candidateConfig,
      candidateCapabilities: { ...candidateCapabilities,
        enabled_slices: [...candidateCapabilities.enabled_slices, "RETRIEVAL"] },
      activeWorkerIdentity: baselineIdentity, baselineConfigurationBaseline, baselineConfig }));
    await writeFile(intentPath, `${JSON.stringify({ ...intent, candidate: {
      ...intent.candidate, configuration_sha256: "d".repeat(64) } })}\n`);
    await assert.rejects(loadMaintenanceAiSearchBootstrap({ path: intentPath, root, accountId, sourceHead,
      candidateGeneration, candidateConfigurationSha256, candidateConfig, candidateCapabilities,
      activeWorkerIdentity: baselineIdentity, baselineConfigurationBaseline, baselineConfig }));
    await writeFile(intentPath, `${JSON.stringify({ ...intent, unexpected: true })}\n`);
    await assert.rejects(loadMaintenanceAiSearchBootstrap({ path: intentPath, root, accountId, sourceHead,
      candidateGeneration, candidateConfigurationSha256, candidateConfig, candidateCapabilities,
      activeWorkerIdentity: baselineIdentity, baselineConfigurationBaseline, baselineConfig }));
  });
});

await check("manifest drift after intent validation blocks the deployment", async () => {
  await withFixture(async ({ root, intentPath, manifestPath }) => {
    const { bootstrap } = await loadFixture({ root, intentPath });
    await writeFile(manifestPath, '{"protocol":"changed"}\n');
    await assert.rejects(requireUnchangedMaintenanceAiSearchBootstrap({ bootstrap }), /manifest/u);
  });
});

console.log(`AI Search bootstrap focused tests: PASS (${cases} cases)`);
