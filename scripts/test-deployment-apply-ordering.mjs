// Deployment apply ordering under the test-only gate: deterministic, mocked,
// no live calls. The full deploy apply sequence (local gates, usage gate,
// check-only, archive, apply, config readback, dry-run, D1 migrations,
// upload, worker readback, smoke, save) is load-bearing ordering that
// in-process test-only inputs can never reach (ADMITTED alone denies without
// the same-process admission capability — see
// test-deployment-orchestration.mjs). This file therefore re-executes ITSELF
// as a child under the test-only --import gate: the deployer's admission
// import then resolves to the test standin, which mints TEST capabilities
// for ADMITTED fixtures, so the fake-observed apply proves the ordering with
// the capability mechanics engaged. Production entry paths never load that
// standin (ambient NODE_OPTIONS loader tokens refuse the redirect; the
// respawn below scrubs them from the child env), so production behavior is
// unchanged. Run with:
//   node scripts/test-deployment-apply-ordering.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deployCloudflare, parseDeploymentArguments } from "./deploy-cloudflare.mjs";
import { readCompositionCapabilityProfile } from "./check-launch-code.mjs";
import { readDeploymentMigrationPlan } from "./lib/deployment-migrations.mjs";
import { digestAccountId } from "./lib/cloudflare-usage-envelope.mjs";
import { dailyWindowFor, monthlyWindowFor } from "./lib/cloudflare-usage-collection.mjs";
import { stripNodeOptionsLoaderTokens } from "./lib/cloudflare-wrangler-oauth.mjs";
import { loadResearchRuntimeEnvironment, RESEARCH_RUNTIME_CONFIGURATION_KEYS,
  RESEARCH_RUNTIME_SEMANTIC_TRANSPORT_KEYS, semanticConfigurationTransport } from "./lib/research-runtime-config.mjs";

const directExecution = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (directExecution && process.env.ELIOTR_TEST_GATE_REDIRECTED !== "1") {
  const shimHref = new URL("./test-usage-gate-shim.mjs", import.meta.url).href;
  const childEnv = { ...process.env, ELIOTR_TEST_GATE_REDIRECTED: "1" };
  if (childEnv.NODE_OPTIONS !== undefined && childEnv.NODE_OPTIONS !== null) {
    const stripped = stripNodeOptionsLoaderTokens(childEnv.NODE_OPTIONS);
    if (String(stripped).trim() === "") delete childEnv.NODE_OPTIONS;
    else childEnv.NODE_OPTIONS = stripped;
  }
  const child = spawnSync(process.execPath, ["--import", shimHref, fileURLToPath(import.meta.url)], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: childEnv,
    stdio: "inherit",
  });
  if (child.error || child.status !== 0) {
    console.error(`Deployment apply ordering redirected child failed (status ${child.status ?? "unknown"}).`);
    process.exit(child.status ?? 1);
  }
  process.exit(0);
}

async function removeFixtureTemporaryDirectory(temporaryDirectory, temporaryRoot, temporaryPrefix) {
  const resolvedTemporaryDirectory = resolve(temporaryDirectory);
  if (resolvedTemporaryDirectory === temporaryRoot ||
      dirname(resolvedTemporaryDirectory) !== temporaryRoot ||
      !basename(resolvedTemporaryDirectory).startsWith(temporaryPrefix)) {
    throw new Error("Refusing to remove an unexpected deployment fixture temporary path");
  }
  await rm(resolvedTemporaryDirectory, { recursive: true, force: true });
}

async function main() {
const temporaryRoot = resolve(tmpdir());
const temporaryPrefix = "eliot-deployment-apply-ordering-";
let temporaryDirectory;
try {
  temporaryDirectory = await mkdtemp(join(temporaryRoot, temporaryPrefix));
  const resolvedTemporaryDirectory = resolve(temporaryDirectory);
  if (dirname(resolvedTemporaryDirectory) !== temporaryRoot ||
      !basename(resolvedTemporaryDirectory).startsWith(temporaryPrefix)) {
    throw new Error("Deployment fixture temporary directory escaped the OS temp root");
  }
const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const candidateCapabilityProfile = await readCompositionCapabilityProfile({ root: repositoryRoot });
function observedCapabilities(generation) {
  return {
    protocol: candidateCapabilityProfile.protocol,
    deployment_generation: generation,
    google_external_transport: "gemini-mcp",
    enabled_slices: [...candidateCapabilityProfile.enabled_slices],
    partial_slices: [...candidateCapabilityProfile.partial_slices],
    disabled_slices: [...candidateCapabilityProfile.disabled_slices],
    federation_configured: false,
    orientation_profile: candidateCapabilityProfile.orientation_profile,
    orientation_max_sources: candidateCapabilityProfile.orientation_max_sources,
    orientation_max_results: candidateCapabilityProfile.orientation_max_results,
    routes: candidateCapabilityProfile.routes.map((route) => ({ ...route })),
    ...candidateCapabilityProfile.safety_invariants,
  };
}
const runtimeConfigPath = resolve(resolvedTemporaryDirectory, "research-runtime.json");
const ownerPrincipal = "fixture-owner-principal";
function spendTemplate(protocol = "eliotr.research-owner-spend-template.v1", generation = "git-test", suffix = "v1") {
  return {
    protocol, approved: true, policy_ref: `fixture:owner-spend-${suffix}`,
    config_provenance_ref: `fixture:owner-spend-config-${suffix}`, principal_ref: ownerPrincipal,
    client_class: "owner_pwa", ...(protocol.endsWith(".v1") ? { deployment_generation: generation } : {}),
    expires_at: "2026-12-31T00:00:00.000Z", rules: [{ stage: "SYNTHESIZE" }],
  };
}
function reportTemplate(protocol = "eliotr.research-owner-report-admission-template.v1", generation = "git-test", suffix = "v1") {
  return { schema: "eliotr.research.report-config.v1", admission_policy: {
    protocol, ...(protocol.endsWith(".v1") ? { deployment_generation: generation } : {}),
    config_provenance_ref: `fixture:owner-report-config-${suffix}`,
    principal_ref: ownerPrincipal, policy_ref: `fixture:owner-report-${suffix}`,
  }, artifact_policy: { fixture: suffix } };
}
function modelProfile(schema = "eliotr.research.model-profile-definition.v1", suffix = "v1") {
  return { schema, config_provenance_ref: `fixture:model-profile-config-${suffix}`,
    model_profile_ref: "research-model-v1" };
}
const runtimeConfig = { protocol: "eliotr.research-runtime.v1", vars: {
  ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: { protocol: "eliotr.research-semantic-config.test.v1", profile: "fixture" },
  ELIOTR_MODEL_PROFILE_DEFINITION_JSON: modelProfile(),
  ELIOTR_MODEL_PROFILE_PROVENANCE_REF: "fixture:model-profile",
  ELIOTR_MODEL_SPEND_POLICY_JSON: spendTemplate(),
  ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: "fixture:model-spend-policy",
  ELIOTR_RESEARCH_REPORT_CONFIG_JSON: reportTemplate(),
  ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: "fixture:research-report-policy",
  ELIOTR_WORKSPACE_OWNER_BINDINGS_JSON: { protocol: "eliotr.workspace-owner-bindings.v1", owners: [] },
  ELIOTR_NAMESPACE_BOOTSTRAP_PROFILES_JSON: { protocol: "eliotr.namespace-bootstrap-profiles.v1", profiles: [] },
} };
await writeFile(runtimeConfigPath, `${JSON.stringify(runtimeConfig)}\n`, { flag: "wx", mode: 0o600 });

const now = Date.parse("2026-09-04T23:00:00.000Z");
function admittedSnapshotJson(accountId = "test-account", at = now) {
  const metrics = {
    workers_requests: 100, workers_cpu_ms: 100,
    d1_storage_bytes: 100, d1_rows_read: 100, d1_rows_written: 100,
    r2_storage_gb_month: 1, r2_class_a_ops: 100, r2_class_b_ops: 100,
    queue_ops: 100, do_requests: 100, do_gb_seconds: 100,
    do_sql_reads: 100, do_sql_writes: 100, do_storage_bytes: 100,
    workers_ai_neurons_per_day: 100, ai_search_instances: 5,
    ai_search_queries_month: 100,
    vectorize_queried_dims_month: 100, vectorize_stored_dims_month: 100,
  };
  return JSON.stringify({
    protocol: "eliotr.cloudflare-usage-snapshot.v1",
    account_id_digest: digestAccountId(accountId),
    account_ref: "cloudflare-account:test-a…ount",
    collected_at: new Date(at - 60_000).toISOString(),
    window: monthlyWindowFor(at),
    daily_window: dailyWindowFor(at),
    source: "test-fixture",
    readback: { whoami_verified: true },
    metrics,
  });
}
const baseEnvironment = { CLOUDFLARE_ACCOUNT_ID: "test-account", CLOUDFLARE_API_TOKEN: "secret-token",
  ELIOTR_ENVIRONMENT: "staging", ELIOTR_DEPLOYMENT_GENERATION: "git-test", ELIOTR_CUSTOM_DOMAIN: "1",
  ELIOTR_ACCESS_HOSTNAME: "research.example.com", ELIOTR_OWNER_EMAILS: "owner@example.com",
  ELIOTR_STAGING_TARGET_JSON: JSON.stringify({ protocol: "eliotr.staging-target.v1", isolation: "dedicated-account",
    account_id: "test-account", protected_account_ids: ["production-test-account"], access_hostname: "research.example.com" }),
  ELIOTR_ACCESS_TEAM_DOMAIN: "https://team-example.cloudflareaccess.com", ELIOTR_ACCESS_AUDIENCE: "test-aud",
  ELIOTR_ACCESS_SERVICE_PRINCIPALS: "", ELIOTR_ACCESS_SMOKE_COOKIE: "secret-cookie", ELIOTR_GOOGLE_EXTERNAL_TRANSPORT: "gemini-mcp" };
const environment = await loadResearchRuntimeEnvironment({ ...baseEnvironment, ELIOTR_RESEARCH_CONFIG_FILE: runtimeConfigPath }, repositoryRoot);
function runtimeConfigVariables(runtimeEnvironment) {
  const variables = Object.fromEntries(RESEARCH_RUNTIME_CONFIGURATION_KEYS
    .filter((key) => !RESEARCH_RUNTIME_SEMANTIC_TRANSPORT_KEYS.includes(key) && typeof runtimeEnvironment[key] === "string")
    .map((key) => [key, runtimeEnvironment[key]]));
  Object.assign(variables, semanticConfigurationTransport(runtimeEnvironment).vars);
  return variables;
}
const runtimeConfigVars = runtimeConfigVariables(environment);
// This valid fixture keeps the 18 unresolved billing counters UNKNOWN. A
// deployment must not read or promote them into an exact admission receipt.
const unknownUsageSnapshot = JSON.parse(admittedSnapshotJson());
for (const key of Object.keys(unknownUsageSnapshot.metrics)) {
  if (key !== "ai_search_instances") unknownUsageSnapshot.metrics[key] = "unknown";
}
process.env.ELIOTR_TEST_SPAWN_SNAPSHOT_JSON = JSON.stringify(unknownUsageSnapshot);
const config = { name: "eliotr-core", minify: true, preview_urls: false, compatibility_date: "2026-08-28",
  vars: { DEPLOYMENT_GENERATION: "git-test", ENVIRONMENT: "staging",
    AI_GATEWAY_REASONING_URL: "https://gateway.ai.cloudflare.com/v1/test-account/eliotr-reasoning",
    AI_GATEWAY_RETRIEVAL_URL: "https://gateway.ai.cloudflare.com/v1/test-account/eliotr-retrieval",
    ACCESS_TEAM_DOMAIN: "https://team-example.cloudflareaccess.com",
    ACCESS_AUDIENCE: "test-aud", ACCESS_SERVICE_PRINCIPALS: "", GOOGLE_EXTERNAL_TRANSPORT: "gemini-mcp", ...runtimeConfigVars },
  d1_databases: [
    { binding: "CORE_DB", database_name: "eliotr-core", database_id: "11111111-1111-4111-8111-111111111111", migrations_dir: "../../infra/d1/core/migrations" },
    { binding: "SEARCH_DB", database_name: "eliotr-search", database_id: "22222222-2222-4222-8222-222222222222", migrations_dir: "../../infra/d1/search/migrations" },
  ] };
Object.assign(config, {
  assets: { binding: "ASSETS", directory: "../eliotr-pwa/dist" }, exports: { ResearchSession: { type: "durable-object", storage: "sqlite" } },
  r2_buckets: [], queues: { producers: [] }, durable_objects: { bindings: [{ name: "RESEARCH_SESSION", class_name: "ResearchSession" }] },
  workflows: [], analytics_engine_datasets: [],
});
let candidateFixtureSequence = 0;
async function candidateFixture(deploymentGeneration, templateGeneration = deploymentGeneration, ownerRuntimeVersion = "v1") {
  candidateFixtureSequence += 1;
  const candidateRuntimePath = resolve(resolvedTemporaryDirectory,
    `research-runtime-${candidateFixtureSequence}-${deploymentGeneration}-${templateGeneration}.json`);
  const candidateRuntime = structuredClone(runtimeConfig);
  const profileSchema = ownerRuntimeVersion === "v2"
    ? "eliotr.research.model-profile-definition.v2" : "eliotr.research.model-profile-definition.v1";
  const spendProtocol = `eliotr.research-owner-spend-template.${ownerRuntimeVersion}`;
  const reportProtocol = `eliotr.research-owner-report-admission-template.${ownerRuntimeVersion}`;
  candidateRuntime.vars.ELIOTR_MODEL_PROFILE_DEFINITION_JSON = modelProfile(profileSchema, deploymentGeneration);
  candidateRuntime.vars.ELIOTR_MODEL_PROFILE_PROVENANCE_REF = `fixture:model-profile-${deploymentGeneration}`;
  candidateRuntime.vars.ELIOTR_MODEL_SPEND_POLICY_JSON = spendTemplate(spendProtocol,
    templateGeneration, deploymentGeneration);
  candidateRuntime.vars.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF = `fixture:model-spend-policy-${deploymentGeneration}`;
  candidateRuntime.vars.ELIOTR_RESEARCH_REPORT_CONFIG_JSON = reportTemplate(reportProtocol,
    templateGeneration, deploymentGeneration);
  candidateRuntime.vars.ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF = `fixture:research-report-policy-${deploymentGeneration}`;
  await writeFile(candidateRuntimePath, `${JSON.stringify(candidateRuntime)}\n`, { flag: "wx", mode: 0o600 });
  const candidateEnvironment = await loadResearchRuntimeEnvironment({ ...baseEnvironment,
    ELIOTR_DEPLOYMENT_GENERATION: deploymentGeneration,
    ELIOTR_RESEARCH_CONFIG_FILE: candidateRuntimePath }, repositoryRoot);
  const candidateConfig = structuredClone(config);
  candidateConfig.vars = { ...candidateConfig.vars, ...runtimeConfigVariables(candidateEnvironment),
    DEPLOYMENT_GENERATION: deploymentGeneration };
  const baselineRuntime = structuredClone(runtimeConfig);
  baselineRuntime.vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON = {
    protocol: "eliotr.research-semantic-config.test.v1", profile: "observed-v1-baseline",
  };
  baselineRuntime.vars.ELIOTR_MODEL_PROFILE_DEFINITION_JSON = modelProfile(
    "eliotr.research.model-profile-definition.v1", "observed-v1-baseline");
  baselineRuntime.vars.ELIOTR_MODEL_PROFILE_PROVENANCE_REF = "fixture:model-profile-observed-v1";
  baselineRuntime.vars.ELIOTR_MODEL_SPEND_POLICY_JSON = spendTemplate(
    "eliotr.research-owner-spend-template.v1", "git-recorded-owner", "observed-v1-baseline");
  baselineRuntime.vars.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF = "fixture:model-spend-policy-observed-v1";
  baselineRuntime.vars.ELIOTR_RESEARCH_REPORT_CONFIG_JSON = reportTemplate(
    "eliotr.research-owner-report-admission-template.v1", "git-recorded-owner", "observed-v1-baseline");
  baselineRuntime.vars.ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF = "fixture:research-report-policy-observed-v1";
  const baselineRuntimePath = resolve(resolvedTemporaryDirectory, `research-runtime-${candidateFixtureSequence}-baseline.json`);
  await writeFile(baselineRuntimePath, `${JSON.stringify(baselineRuntime)}\n`, { flag: "wx", mode: 0o600 });
  const baselineEnvironment = await loadResearchRuntimeEnvironment({ ...baseEnvironment,
    ELIOTR_DEPLOYMENT_GENERATION: "git-test", ELIOTR_RESEARCH_CONFIG_FILE: baselineRuntimePath }, repositoryRoot);
  const baselineConfig = structuredClone(config);
  baselineConfig.vars = { ...config.vars, ...runtimeConfigVariables(baselineEnvironment), DEPLOYMENT_GENERATION: "git-test" };
  return { environment: candidateEnvironment, candidateConfig, baselineConfig };
}
const assetBytes = "<!doctype html><main>fixture</main>";
const assetManifest = {"protocol":"eliotr.cloudflare-assets-manifest.v1","state":"LOCAL_ONLY","directory":"apps/eliotr-pwa/dist","files":[{"path":"index.html","bytes":35,"sha256":"a02618fd171637ef11b3b4d923cb91cf9837c902dbd7aca5bd69f8eeb465c59f"}],"excluded_routing_files":["_headers","_redirects"],"manifest_sha256":"42a56ab403ebc72972cf5e99795838d1f331afec0cd0a9aea5a8b128fb5203fd"};
const alternateVersionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const versionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const migrationPlan = await readDeploymentMigrationPlan(config, { root: repositoryRoot });
const generatedConfigPath = resolve(repositoryRoot, "apps/eliotr-core/wrangler.deploy.jsonc");
const workerEntrypoint = resolve(repositoryRoot, "apps/eliotr-core/src/index.ts");
const buildInputManifest = Object.freeze({ protocol: "eliotr.deployment-build-inputs.v1",
  root: repositoryRoot, sha256: "a".repeat(64) });
const bundleSha256 = "b".repeat(64);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function harness(overrides = {}) {
  const candidateConfig = overrides.candidateConfig ?? config;
  const baselineConfig = overrides.baselineConfig ?? candidateConfig;
  const candidateEnvironment = overrides.environment ?? environment;
  const candidateBytes = Buffer.from(JSON.stringify(candidateConfig));
  const calls = [];
  const receipts = [];
  const provisionerEnvs = [];
  const deploymentRows = new Map();
  let authorityWrites = 0;
  let authorityReads = 0;
  let capabilityReads = 0;
  let fingerprintReads = 0;
  let uploadStarted = false;
  let workerVersionReads = 0;
  let reads = 0;
  let manifestReads = 0;
  let deploymentsRead = 0;
  let assetReads = 0;
  let buildInputChecks = 0;
  let bundleChecks = 0;
  let bundleAttestations = 0;
  let generatedConfigPins = 0;
  const buildEvents = [];
  for (const row of overrides.authorityRows ?? []) deploymentRows.set(row.deployment_generation, { ...row });
  const options = { readAssetManifest: async () => { manifestReads += 1; return overrides.assetDriftAt === manifestReads ? { ...assetManifest, manifest_sha256: "0".repeat(64) } : assetManifest; },
    readBackendFingerprint: () => "a".repeat(64),
    ...(overrides.backendDriftAt === undefined ? {} : { readBackendFingerprint: () => {
      fingerprintReads += 1;
      return fingerprintReads === overrides.backendDriftAt ? "0".repeat(64) : "a".repeat(64);
    } }),
    confirmLive: true, verifyCode: async () => { buildEvents.push("verify-code"); }, environment: candidateEnvironment, now: () => now, log: () => {},
    captureBuildInputs: async () => { buildEvents.push("capture-build-inputs"); return buildInputManifest; },
    checkBuildInputs: async () => {
      buildInputChecks += 1;
      buildEvents.push(`check-build-inputs-${buildInputChecks}`);
      if (overrides.buildInputDriftAt === buildInputChecks) throw new Error("fixture deployment build input drift");
      return true;
    },
    pinGeneratedConfig: async () => {
      generatedConfigPins += 1;
      buildEvents.push("pin-generated-config");
      return { path: "apps/eliotr-core/wrangler.deploy.jsonc", sha256: sha256(candidateBytes), byte_length: candidateBytes.byteLength,
        worker_name: "eliotr-core", worker_main: "apps/eliotr-core/src/index.ts", assets_directory: "apps/eliotr-pwa/dist" };
    },
    attestBundle: async ({ outdir, metafilePath, generatedConfigPin }) => {
      bundleAttestations += 1;
      buildEvents.push("attest-worker-bundle");
      assert.ok(resolve(outdir).startsWith(resolve(repositoryRoot, ".eliotr-state")));
      assert.ok(resolve(metafilePath).startsWith(resolve(outdir)));
      assert.equal(generatedConfigPin.sha256, sha256(candidateBytes));
      return { protocol: "eliotr.deployment-worker-bundle.v1", root: repositoryRoot,
        manifest_sha256: buildInputManifest.sha256, generated_config: generatedConfigPin,
        outdir: resolve(outdir), entrypoint: workerEntrypoint, sha256: bundleSha256 };
    },
    checkBundle: async () => {
      bundleChecks += 1;
      buildEvents.push(`check-worker-bundle-${bundleChecks}`);
      if (overrides.bundleDriftAt === bundleChecks) throw new Error("fixture prepared Worker artifact drift");
      return true;
    },
    execute(command, args, cwd, env) {
      const name = `${command} ${args.join(" ")}`; calls.push(name);
      if (name.startsWith("pnpm ")) buildEvents.push(`command:${name}`);
      if (command === "pnpm" && args[0] === "exec" && args[1] === "wrangler" && args[2] === "deploy" &&
          args[3] === workerEntrypoint && args.includes("--no-bundle")) uploadStarted = true;
      if (args[0]?.startsWith("scripts/provision-")) provisionerEnvs.push({ name: args[0], env: { ...env } });
      assert.equal(env.ELIOTR_DEPLOYMENT_GENERATION, candidateEnvironment.ELIOTR_DEPLOYMENT_GENERATION);
      assert.equal(resolve(cwd), resolve(fileURLToPath(new URL("../", import.meta.url)),
        args.includes("--config") ? "apps/eliotr-core" : "."));
      if (name === overrides.failCommand) throw new Error("injected command failure");
    },
    archive: async () => { calls.push("archive"); },
    read: async (path, encoding) => {
      if (resolve(path) !== generatedConfigPath) return readFile(path, encoding);
      reads += 1;
      return overrides.driftAt === reads ? Buffer.from("{}") : candidateBytes;
    },
    save: async (receipt) => { calls.push("save"); receipts.push(receipt); },
    readReleaseBlockers: async () => { buildEvents.push("read-full-release-blockers"); return ["fixture full-release blocker"]; },
    readCapabilityProfile: async () => { buildEvents.push("read-candidate-capability-profile"); return candidateCapabilityProfile; },
    captureBudget: (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      return { status: 1, stdout: "Source budgets: FAIL (17 violations)\n", stderr: "", error: null };
    },
    readCapabilities: async () => {
      capabilityReads += 1;
      const capabilities = observedCapabilities("git-test");
      if (overrides.expandCapabilitiesAt === capabilityReads) capabilities.enabled_slices.push("MAINTENANCE_EXPANSION");
      return { generation: "git-test", capabilities };
    },
    fetchImpl: async (url, init = {}) => {
      const method = init.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (method === "POST" && String(url).includes("/d1/database/")) {
        const query = JSON.parse(init.body);
        if (Array.isArray(query.batch)) {
          const authorityRead = query.batch.some(({ sql }) => sql.startsWith("SELECT deployment_generation,state,created_at,backend_fingerprint"));
          if (authorityRead && query.batch.every(({ sql }) => sql.startsWith("SELECT "))) {
            authorityReads += 1;
            if (overrides.authorityDriftAt === authorityReads) {
              const active = [...deploymentRows.values()].find((row) => row.state === "ACTIVE");
              if (active !== undefined) active.created_at = "2026-09-03T00:00:00.000Z";
            }
          }
          if (query.batch.some(({ sql }) => !sql.startsWith("SELECT "))) authorityWrites += 1;
        }
        if (overrides.failAuthoritySync && Array.isArray(query.batch) &&
            query.batch.some(({ sql }) => !sql.startsWith("SELECT "))) {
          return globalThis.Response.json({ success: false, errors: [{ code: 1001 }], result: [] });
        }
        if (query.sql?.startsWith("SELECT name FROM d1_migrations")) {
          const stream = migrationPlan.find((entry) => String(url).includes(entry.database_id));
          const names = [...stream.migration_names];
          if (overrides.ledgerDrift === stream.binding) names.pop();
          return globalThis.Response.json({ success: true, result: [{ success: true,
            results: names.map((name) => ({ name })), meta: { rows_written: 0, changed_db: false } }] });
        }
        if (query.sql === "SELECT value FROM schema_state WHERE key = 'schema_generation' LIMIT 2") {
          const stream = migrationPlan.find((entry) => String(url).includes(entry.database_id));
          const required = stream.binding === "CORE_DB" ? "core-v11-owner-orientation" : "search-v4-ai-search-generation-registry";
          const value = overrides.schemaMismatch === stream.binding ? "stale-generation" : required;
          return globalThis.Response.json({ success: true, result: [{ success: true,
            results: [{ value }], meta: { changed_db: false, rows_written: 0 } }] });
        }
        const batch = query.batch;
        const result = batch.map(({ sql, params }) => {
          let changes = 0;
          let results = [];
          if (sql.startsWith("SELECT deployment_generation,state,created_at,backend_fingerprint")) {
            const selected = new Set(params);
            results = [...deploymentRows.values()].filter((row) => row.state === "ACTIVE" || selected.has(row.deployment_generation));
          } else if (sql.startsWith("UPDATE investigation_current_deployment SET state='RETIRED'")) {
            const row = deploymentRows.get(params[0]);
            if (row?.state === "ACTIVE") { row.state = "RETIRED"; changes = 1; }
          } else if (sql.startsWith("INSERT INTO investigation_current_deployment")) {
            const [generation, created_at, backend_fingerprint] = params;
            const row = deploymentRows.get(generation);
            if (row === undefined) {
              deploymentRows.set(generation, { deployment_generation: generation, state: "ACTIVE", created_at, backend_fingerprint });
              changes = 1;
            } else if (row.state === "RETIRED" && row.backend_fingerprint === backend_fingerprint) {
              row.state = "ACTIVE";
              row.created_at = created_at;
              changes = 1;
            }
          } else {
            throw new Error(`unexpected deployment authority SQL: ${sql}`);
          }
          return { success: true, results, meta: { changes } };
        });
        return globalThis.Response.json({ success: true, result });
      }
      if (overrides.failReadback && uploadStarted) return new globalThis.Response("login", { headers: { "content-type": "text/html" } });
      if (String(url).endsWith("/workers/scripts")) return globalThis.Response.json({ success: true, result: [
        { id: "eliotr-core", compatibility_date: "2026-08-28", has_assets: true,
          exports: { ResearchSession: { type: "durable-object" } } },
      ] });
      if (String(url) === "https://research.example.com/") {
        assetReads += 1;
        return new globalThis.Response(overrides.assetMismatch ? "wrong body" : assetBytes);
      }
      if (String(url).endsWith("/deployments")) deploymentsRead += 1;
      if (String(url).endsWith("/deployments")) return globalThis.Response.json({ success: true, result: { deployments: [{
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", created_on: new Date(now).toISOString(), strategy: "percentage",
        versions: [{ version_id: overrides.versionDrift && deploymentsRead > 1 ? alternateVersionId : versionId, percentage: overrides.partialTraffic ? 50 : 100 }],
      }] } });
      if (String(url).endsWith("/versions/" + versionId) || String(url).endsWith("/versions/" + alternateVersionId)) {
        workerVersionReads += 1;
        const versionConfig = uploadStarted ? candidateConfig : baselineConfig;
        const observedVars = structuredClone(versionConfig.vars);
        if (!uploadStarted && overrides.baselineDriftAt === workerVersionReads) observedVars.ACCESS_AUDIENCE = "drifted-audience";
        return globalThis.Response.json({ success: true, result: {
        id: String(url).endsWith(alternateVersionId) ? alternateVersionId : versionId, number: 9, resources: {
          bindings: { ...Object.fromEntries(Object.entries(observedVars).map(([name, value]) => [name, typeof value === "string" ? { type: "plain_text", text: value } : { type: "json", json: value }])),
            ...overrides.bindingDrift, CORE_DB: { type: "d1", id: candidateConfig.d1_databases[0].database_id },
            SEARCH_DB: { type: "d1", id: candidateConfig.d1_databases[1].database_id }, ASSETS: { type: "assets" },
            RESEARCH_SESSION: { type: "durable_object_namespace", class_name: "ResearchSession" } },
          script: { etag: "fixture-etag" }, script_runtime: { compatibility_date: candidateConfig.compatibility_date,
            compatibility_flags: [], exports: { default: { type: "worker" }, ...candidateConfig.exports } },
        },
      } });
      }
      const activeGeneration = uploadStarted ? candidateEnvironment.ELIOTR_DEPLOYMENT_GENERATION : baselineConfig.vars.DEPLOYMENT_GENERATION;
      if (String(url).endsWith("/healthz")) return globalThis.Response.json({ ready: true,
        deployment_generation: activeGeneration, checked_at: new Date(now).toISOString() });
      return globalThis.Response.json({ trace_id: "trace-test", deployment_generation: activeGeneration, data: {
        protocol: "eliotr.capabilities.v1", deployment_generation: activeGeneration, enabled_slices: ["HEALTH", "ACCESS"],
        disabled_slices: ["RESEARCH"], exact_evidence_resolution_required: true,
        transport_completion_is_research_completion: false, ingest_live_qualified: false,
      } });
    }, ...overrides.options };
  return { calls, receipts, provisionerEnvs, options, assetReads: () => assetReads,
    authorityReads: () => authorityReads, authorityWrites: () => authorityWrites,
    deploymentRows: () => [...deploymentRows.values()].map((row) => ({ ...row })),
    workerVersionReads: () => workerVersionReads,
    capabilityReads: () => capabilityReads, fingerprintReads: () => fingerprintReads,
    buildInputChecks: () => buildInputChecks, bundleChecks: () => bundleChecks,
    bundleAttestations: () => bundleAttestations, generatedConfigPins: () => generatedConfigPins,
    buildEvents: () => [...buildEvents] };
}
let cases = 0;
const check = async (name, action) => { await action(); cases += 1; console.log(`Deployment apply ordering: ${name}: PASS`); };
const deployCommand = `pnpm exec wrangler deploy ${workerEntrypoint} --no-bundle --config wrangler.deploy.jsonc`;
const deploymentSecretName = "ELIOTR_MODEL_PROVIDER_CONTROL_TOKEN";
const deploymentSecretValue = "fixture-control-token-value";
const generatedDryRunPrefix = "pnpm exec wrangler deploy --dry-run --minify --config wrangler.deploy.jsonc --outdir ";
const generatedDryRunIndex = (calls) => calls.findIndex((call) => call.startsWith(generatedDryRunPrefix));

await check("secrets-file CLI parsing is explicit and rejects missing, duplicate or unsafe inputs", async () => {
  const secretPath = join(resolvedTemporaryDirectory, "deployment-secrets.json");
  assert.deepEqual(parseDeploymentArguments(["--confirm-live", "--maintenance", "--secrets-file", secretPath]), {
    confirmLive: true, purpose: "MAINTENANCE", secretsFilePath: secretPath,
  });
  for (const args of [
    ["--secrets-file"], ["--secrets-file", secretPath, "--secrets-file", secretPath],
    ["--confirm-live", "--confirm-live"], ["--secrets-file", "relative-secrets.json"],
    ["--secrets-file", "C:\\Temp\\secret%PATH%.json"], ["--unknown"],
  ]) assert.throws(() => parseDeploymentArguments(args), /Deployment/u);
});

await check("dedicated control-token file is attached only to the final guarded Worker deploy", async () => {
  const secretPath = join(resolvedTemporaryDirectory, "deployment-secrets.json");
  await writeFile(secretPath, `${JSON.stringify({ [deploymentSecretName]: deploymentSecretValue })}\n`,
    { flag: "wx", mode: 0o600 });
  const test = harness({ options: { secretsFilePath: secretPath } });
  const execute = test.options.execute;
  test.options.execute = (command, args, cwd, env) => {
    if (args.includes("--secrets-file")) {
      assert.equal(command, "pnpm");
      assert.deepEqual(args.slice(-2), ["--secrets-file", secretPath]);
      assert.notEqual(env[deploymentSecretName], deploymentSecretValue);
    }
    return execute(command, args, cwd, env);
  };
  const receipt = await deployCloudflare(test.options);
  assert.deepEqual(test.calls.filter((call) => call.includes("--secrets-file")), [
    `${deployCommand} --secrets-file ${secretPath}`,
  ]);
  assert.ok(!test.calls.some((call) => call.includes("--dry-run") && call.includes("--secrets-file")));
  assert.equal(test.calls.filter((call) => call.startsWith(`pnpm exec wrangler deploy ${workerEntrypoint}`)).length, 1);
  assert.ok(!JSON.stringify(receipt).includes(deploymentSecretName));
  assert.ok(!JSON.stringify(receipt).includes(deploymentSecretValue));
  assert.ok(!JSON.stringify(receipt).includes(secretPath));
  assert.ok(!JSON.stringify(test.calls).includes(deploymentSecretValue));
});

await check("secrets-file validation and input drift fail before Worker upload", async () => {
  for (const [name, contents] of [
    ["unknown binding", JSON.stringify({ ELIOTR_UNAPPROVED_SECRET: deploymentSecretValue })],
    ["non-string value", JSON.stringify({ [deploymentSecretName]: 42 })],
    ["oversized file", JSON.stringify({ [deploymentSecretName]: "x".repeat(16 * 1024) })],
  ]) {
    const secretPath = join(resolvedTemporaryDirectory, `invalid-${name.replaceAll(" ", "-")}.json`);
    await writeFile(secretPath, contents, { flag: "wx", mode: 0o600 });
    const invalid = harness({ options: { secretsFilePath: secretPath } });
    await assert.rejects(deployCloudflare(invalid.options), /Deployment secrets file/u, name);
    assert.deepEqual(invalid.calls, [], name);
    assert.deepEqual(invalid.buildEvents(), [], name);
  }

  const unconfirmedPath = join(resolvedTemporaryDirectory, "unconfirmed-secrets.json");
  const unconfirmed = harness({ options: { confirmLive: false, secretsFilePath: unconfirmedPath } });
  await assert.rejects(deployCloudflare(unconfirmed.options), /requires a confirmed live deployment/u);
  assert.deepEqual(unconfirmed.calls, []);
  assert.deepEqual(unconfirmed.buildEvents(), []);

  const driftPath = join(resolvedTemporaryDirectory, "drifting-secrets.json");
  await writeFile(driftPath, `${JSON.stringify({ [deploymentSecretName]: deploymentSecretValue })}\n`,
    { flag: "wx", mode: 0o600 });
  let changed = false;
  const drift = harness({ options: { secretsFilePath: driftPath, checkBundle: async () => {
    if (!changed) {
      await writeFile(driftPath, `${JSON.stringify({ [deploymentSecretName]: "changed-control-token-value" })}\n`);
      changed = true;
    }
    return true;
  } } });
  await assert.rejects(deployCloudflare(drift.options), /Deployment secrets file changed after validation/u);
  assert.equal(changed, true);
  assert.ok(!drift.calls.some((call) => call.startsWith(`pnpm exec wrangler deploy ${workerEntrypoint}`)));
  assert.equal(drift.authorityWrites(), 0);
  assert.equal(drift.receipts.length, 0);
});

await check("existing Worker deploy proceeds with 18 UNKNOWN counters and no migration apply", async () => {
  const test = harness();
  const receipt = await deployCloudflare(test.options);
  const snapshot = JSON.parse(process.env.ELIOTR_TEST_SPAWN_SNAPSHOT_JSON);
  assert.equal(Object.values(snapshot.metrics).filter((value) => value === "unknown").length, 18);
  assert.equal(snapshot.metrics.ai_search_instances, 5);
  assert.deepEqual(Object.fromEntries(RESEARCH_RUNTIME_SEMANTIC_TRANSPORT_KEYS
    .filter((key) => Object.hasOwn(config.vars, key)).map((key) => [key, config.vars[key]])),
  semanticConfigurationTransport(environment).vars);
  assert.equal(test.calls.filter((call) => call === deployCommand).length, 1);
  const events = test.buildEvents();
  assert.equal(events[0], "capture-build-inputs");
  assert.ok(events.indexOf("capture-build-inputs") < events.indexOf("verify-code"));
  assert.ok(events.indexOf("command:pnpm --filter @eliotr/core deploy:dry-run") < events.indexOf("check-build-inputs-1"));
  assert.ok(generatedDryRunIndex(test.calls) < test.calls.indexOf(deployCommand));
  assert.ok(!test.calls.some((call) => call.includes("wrangler d1 migrations apply")));
  assert.ok(!test.calls.some((call) => /\/(?:billable|billing)\/usage(?:\?|$)/u.test(call)));
  assert.equal(test.calls.filter((call) => call.endsWith("--check-only")).length, 4);
  assert.deepEqual(test.calls.filter((call) => call.endsWith("--verify-existing")), [
    "node scripts/provision-cloudflare-access.mjs --verify-existing",
    "node scripts/provision-cloudflare-core.mjs --verify-existing",
    "node scripts/provision-ai-search.mjs --verify-existing",
    "node scripts/provision-ai-gateways.mjs --verify-existing",
  ]);
  assert.ok(test.calls.includes("pnpm check"), "default FULL_RELEASE retains the full repository check");
  assert.ok(test.calls.some((call) => call.startsWith("POST ") && call.includes("/d1/database/") &&
    call.includes("/query")), "existing migration and schema state is read before upload");
  assert.ok(!test.calls.some((call) => call.includes("--keep-vars")));
  assert.ok(test.calls.indexOf("archive") < test.calls.indexOf("node scripts/provision-cloudflare-access.mjs --verify-existing"));
  assert.equal(receipt.remote_http_smoke.state, "PASS");
  assert.deepEqual(receipt.worker.vars_readback, { state: "PASS", binding_count: Object.keys(config.vars).length });
  assert.equal(receipt.assets.readback.state, "PASS");
  assert.equal(receipt.assets.readback.active_version_unchanged, "PASS");
  assert.equal(receipt.assets.readback.version_id, receipt.worker.version_id);
  assert.ok(Object.values(receipt.live_conformance).every((state) => state === "NOT_EXECUTED"));
  assert.equal(test.receipts.length, 1);
  assert.ok(!JSON.stringify(receipt).includes("secret-"));
  const schema = JSON.parse(await readFile(new URL("../infra/cloudflare/deployment-receipt.schema.json", import.meta.url), "utf8"));
  for (const key of schema.required) assert.ok(Object.hasOwn(receipt, key), `required receipt field is missing: ${key}`);
  for (const key of Object.keys(receipt)) assert.ok(Object.hasOwn(schema.properties, key), `receipt field is absent from schema: ${key}`);
  assert.match(receipt.backend_fingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(receipt.deployment_authority_sync.backend_fingerprint, receipt.backend_fingerprint);
  assert.equal(receipt.deployment_authority_sync.deployment_generation, receipt.deployment_generation);
  assert.equal(receipt.deployment_authority_sync.readback, "PASS");
  const itemSchema = schema.properties.remote_http_smoke.oneOf.find((branch) => branch.properties.state.const === "PASS").properties.results.items;
  assert.deepEqual(Object.keys(receipt.remote_http_smoke.results[0]).sort(), itemSchema.required.slice().sort());
});
await check("generation A baseline explicitly transitions to current owner-template generation B", async () => {
  const candidate = await candidateFixture("git-candidate");
  assert.equal(candidate.baselineConfig.vars.DEPLOYMENT_GENERATION, "git-test");
  assert.equal(JSON.parse(candidate.baselineConfig.vars.ELIOTR_MODEL_SPEND_POLICY_JSON).deployment_generation,
    "git-recorded-owner");
  assert.equal(JSON.parse(candidate.baselineConfig.vars.ELIOTR_RESEARCH_REPORT_CONFIG_JSON)
    .admission_policy.deployment_generation, "git-recorded-owner");
  assert.equal(JSON.parse(candidate.candidateConfig.vars.ELIOTR_MODEL_SPEND_POLICY_JSON).deployment_generation,
    "git-candidate");
  assert.equal(JSON.parse(candidate.candidateConfig.vars.ELIOTR_RESEARCH_REPORT_CONFIG_JSON)
    .admission_policy.deployment_generation, "git-candidate");
  const baselineFingerprint = "a".repeat(64);
  const test = harness({ ...candidate,
    authorityRows: [{ deployment_generation: "git-test", state: "ACTIVE",
      created_at: "2026-09-01T00:00:00.000Z", backend_fingerprint: baselineFingerprint }],
    options: { readBackendFingerprint: () => "b".repeat(64) },
  });
  const receipt = await deployCloudflare(test.options);
  assert.equal(receipt.deployment_generation, "git-candidate");
  assert.equal(test.calls.filter((call) => call === deployCommand).length, 1);
  assert.equal(test.authorityWrites(), 1);
  assert.deepEqual(test.deploymentRows().map(({ deployment_generation, state }) => [deployment_generation, state]).sort(), [
    ["git-candidate", "ACTIVE"], ["git-test", "RETIRED"],
  ]);
  assert.deepEqual(receipt.worker.vars_readback, { state: "PASS", binding_count: Object.keys(candidate.candidateConfig.vars).length });
  assert.equal(test.receipts.length, 1);
});

await check("approved v1 owner runtime transitions to v2 templates and profile", async () => {
  const candidate = await candidateFixture("git-candidate-v2", "git-candidate-v2", "v2");
  const baselineSpend = JSON.parse(candidate.baselineConfig.vars.ELIOTR_MODEL_SPEND_POLICY_JSON);
  const candidateSpend = JSON.parse(candidate.candidateConfig.vars.ELIOTR_MODEL_SPEND_POLICY_JSON);
  const baselineReport = JSON.parse(candidate.baselineConfig.vars.ELIOTR_RESEARCH_REPORT_CONFIG_JSON);
  const candidateReport = JSON.parse(candidate.candidateConfig.vars.ELIOTR_RESEARCH_REPORT_CONFIG_JSON);
  const baselineProfile = JSON.parse(candidate.baselineConfig.vars.ELIOTR_MODEL_PROFILE_DEFINITION_JSON);
  const candidateProfile = JSON.parse(candidate.candidateConfig.vars.ELIOTR_MODEL_PROFILE_DEFINITION_JSON);
  assert.equal(baselineSpend.protocol, "eliotr.research-owner-spend-template.v1");
  assert.equal(baselineSpend.deployment_generation, "git-recorded-owner");
  assert.equal(candidateSpend.protocol, "eliotr.research-owner-spend-template.v2");
  assert.equal(Object.hasOwn(candidateSpend, "deployment_generation"), false);
  assert.equal(baselineReport.admission_policy.protocol, "eliotr.research-owner-report-admission-template.v1");
  assert.equal(candidateReport.admission_policy.protocol, "eliotr.research-owner-report-admission-template.v2");
  assert.equal(baselineProfile.schema, "eliotr.research.model-profile-definition.v1");
  assert.equal(candidateProfile.schema, "eliotr.research.model-profile-definition.v2");
  const test = harness(candidate);
  const receipt = await deployCloudflare(test.options);
  assert.equal(receipt.deployment_generation, "git-candidate-v2");
  assert.equal(test.calls.filter((call) => call === deployCommand).length, 1);
  assert.equal(test.authorityWrites(), 1);
  assert.equal(test.receipts.length, 1);
});

await check("owner bindings and namespace bootstrap remain outside generic runtime transitions", async () => {
  for (const name of ["ELIOTR_WORKSPACE_OWNER_BINDINGS_JSON", "ELIOTR_NAMESPACE_BOOTSTRAP_PROFILES_JSON"]) {
    const candidate = await candidateFixture("git-candidate");
    const baselineConfig = structuredClone(candidate.baselineConfig);
    const observed = JSON.parse(baselineConfig.vars[name]);
    observed.revision = "separate-baseline-authority";
    baselineConfig.vars[name] = JSON.stringify(observed);
    const test = harness({ ...candidate, baselineConfig });
    await assert.rejects(deployCloudflare(test.options), /Worker version variable readback drift/u);
    assert.equal(test.calls.filter((call) => call === deployCommand).length, 0);
    assert.equal(test.authorityWrites(), 0);
    assert.equal(test.receipts.length, 0);
  }
});

await check("unrelated Access drift is rejected against the observed baseline", async () => {
  const candidate = await candidateFixture("git-candidate");
  const baselineConfig = structuredClone(candidate.baselineConfig);
  baselineConfig.vars.ACCESS_AUDIENCE = "different-access-audience";
  const test = harness({ ...candidate, baselineConfig });
  await assert.rejects(deployCloudflare(test.options), /Worker version variable readback drift/u);
  assert.equal(test.calls.filter((call) => call === deployCommand).length, 0);
  assert.equal(test.authorityWrites(), 0);
  assert.equal(test.receipts.length, 0);
});

await check("stale owner-template generation is refused before D1 preflight or upload", async () => {
  const candidate = await candidateFixture("git-candidate", "git-test");
  const test = harness(candidate);
  await assert.rejects(deployCloudflare(test.options), /Generated owner template generation does not match candidate/u);
  assert.equal(test.authorityReads(), 0);
  assert.equal(test.authorityWrites(), 0);
  assert.ok(!test.calls.includes(deployCommand));
  assert.ok(!test.calls.some((call) => call.includes("wrangler d1 migrations apply")));
  assert.equal(test.receipts.length, 0);
});

await check("reused generation with a different backend fingerprint stops before upload or authority writes", async () => {
  const candidate = await candidateFixture("git-candidate");
  const test = harness({ ...candidate,
    authorityRows: [
      { deployment_generation: "git-test", state: "ACTIVE", created_at: "2026-09-01T00:00:00.000Z", backend_fingerprint: "a".repeat(64) },
      { deployment_generation: "git-candidate", state: "RETIRED", created_at: "2026-09-02T00:00:00.000Z", backend_fingerprint: "a".repeat(64) },
    ],
    options: { readBackendFingerprint: () => "b".repeat(64) },
  });
  await assert.rejects(deployCloudflare(test.options), /generation already records a different backend fingerprint/u);
  assert.equal(test.authorityReads(), 1);
  assert.equal(test.authorityWrites(), 0);
  assert.ok(!test.calls.includes(deployCommand));
  assert.ok(!test.calls.some((call) => call.includes("wrangler d1 migrations apply")));
  assert.equal(test.receipts.length, 0);
});

await check("Worker and authority baseline drift during preparation block pre-upload", async () => {
  const workerDrift = harness({ baselineDriftAt: 4 });
  await assert.rejects(deployCloudflare(workerDrift.options), /Worker version variable readback drift/u);
  assert.equal(workerDrift.workerVersionReads(), 4, "the fourth version read is the immutable pre-upload config re-read");
  assert.ok(!workerDrift.calls.includes(deployCommand));
  assert.equal(workerDrift.authorityWrites(), 0);
  assert.equal(workerDrift.receipts.length, 0);

  const authorityDrift = harness({
    authorityDriftAt: 2,
    authorityRows: [{ deployment_generation: "git-test", state: "ACTIVE",
      created_at: "2026-09-01T00:00:00.000Z", backend_fingerprint: "a".repeat(64) }],
    options: { readBackendFingerprint: () => "a".repeat(64) },
  });
  await assert.rejects(deployCloudflare(authorityDrift.options), /Research deployment authority changed during deployment preflight/u);
  assert.equal(authorityDrift.authorityReads(), 2, "the authority baseline is read again immediately before upload");
  assert.ok(!authorityDrift.calls.includes(deployCommand));
  assert.equal(authorityDrift.authorityWrites(), 0);
  assert.equal(authorityDrift.receipts.length, 0);
});

await check("MCP Access child receives no injected Wrangler bearer", async () => {
  const test = harness({ options: { environment: { ...environment, ELIOTR_ACCESS_TRANSPORT: "cloudflare-mcp" } } });
  await deployCloudflare(test.options);
  assert.equal(test.provisionerEnvs.length, 8);
  const accessEnvs = test.provisionerEnvs.filter((value) => value.name === "scripts/provision-cloudflare-access.mjs");
  assert.equal(accessEnvs.length, 2);
  for (const value of accessEnvs) assert.equal(value.env.CLOUDFLARE_API_TOKEN, undefined);
  const otherEnvs = test.provisionerEnvs.filter((value) => value.name !== "scripts/provision-cloudflare-access.mjs");
  assert.equal(otherEnvs.length, 6);
  for (const value of otherEnvs) assert.equal(value.env.CLOUDFLARE_API_TOKEN, "secret-token");
});
await check("missing cookie retains NOT_EXECUTED", async () => {
  const test = harness({ options: { environment: { ...environment, ELIOTR_ACCESS_SMOKE_COOKIE: undefined } } });
  const receipt = await deployCloudflare(test.options);
  assert.equal(receipt.remote_http_smoke.state, "NOT_EXECUTED");
  assert.equal(receipt.assets.readback.state, "NOT_EXECUTED");
  assert.equal(test.assetReads(), 0);
  assert.ok(test.calls.some((call) => call.startsWith("GET ")), "existing Worker identity stays read-only checked");
});
await check("Worker deployment failure cannot publish PASS", async () => {
  const test = harness({ failCommand: deployCommand });
  await assert.rejects(deployCloudflare(test.options));
  assert.equal(test.receipts.length, 0);
  assert.ok(test.calls.some((call) => call.startsWith("GET ")), "active Worker identity is checked before the failed upload");
  assert.ok(!test.calls.some((call) => call.includes("wrangler d1 migrations apply")));
  assert.equal(test.authorityWrites(), 0);
});
await check("readback failure after upload is not successful deployment", async () => {
  const test = harness({ failReadback: true });
  await assert.rejects(deployCloudflare(test.options));
  assert.equal(test.calls.filter((call) => call === deployCommand).length, 1);
  assert.ok(test.calls.includes("archive"));
  assert.equal(test.receipts.length, 0);
});
await check("deployment-authority synchronization failure after upload cannot publish PASS", async () => {
  const test = harness({ failAuthoritySync: true });
  await assert.rejects(deployCloudflare(test.options));
  assert.ok(test.calls.includes(deployCommand));
  assert.ok(test.calls.some((call) => call.startsWith("POST ") && call.includes("/query")));
  assert.equal(test.receipts.length, 0);
});

await check("migration ledger mismatch stops before Worker upload and authority writes", async () => {
  for (const binding of ["CORE_DB", "SEARCH_DB"]) {
    const test = harness({ ledgerDrift: binding });
    await assert.rejects(deployCloudflare(test.options), /migration plan or ledger/u);
    assert.ok(!test.calls.includes(deployCommand));
    assert.ok(test.calls.some((call) => call.startsWith("GET ")), "identity readback precedes the ledger refusal");
    assert.equal(test.authorityWrites(), 0);
    assert.equal(test.receipts.length, 0);
  }
});
await check("required schema-generation drift stops before Worker upload", async () => {
  for (const binding of ["CORE_DB", "SEARCH_DB"]) {
    const test = harness({ schemaMismatch: binding });
    await assert.rejects(deployCloudflare(test.options), /schema generation/u);
    assert.ok(!test.calls.includes(deployCommand));
    assert.equal(test.calls.filter((call) => call.startsWith("POST ")).length, binding === "CORE_DB" ? 4 : 5,
      "both ledgers are read and schema marker checks stop at the first mismatch");
    assert.equal(test.receipts.length, 0);
  }
});
await check("partial active traffic stops before upload and authority synchronization", async () => {
  const test = harness({ partialTraffic: true });
  await assert.rejects(deployCloudflare(test.options), /active 100% Worker/u);
  assert.ok(!test.calls.includes(deployCommand));
  assert.equal(test.calls.filter((call) => call.startsWith("POST ")).length, 0,
    "partial traffic fails the active identity read before D1 or upload");
  assert.equal(test.authorityWrites(), 0);
  assert.equal(test.receipts.length, 0);
});


await check("asset content or active-version mismatch stops at its intended stage", async () => {
  for (const [override, expectedUpload, expectedD1Reads] of [
    [{ assetMismatch: true }, true, 6], [{ versionDrift: true }, false, 1],
  ]) {
    const test = harness(override);
    await assert.rejects(deployCloudflare(test.options), /asset readback|deployment changed|active configured resource identities/u);
    assert.equal(test.calls.includes(deployCommand), expectedUpload);
    assert.equal(test.calls.filter((call) => call.startsWith("POST ")).length, expectedD1Reads);
    assert.equal(test.authorityWrites(), 0);
    assert.equal(test.receipts.length, 0);
  }
});

await check("local asset drift stops before Worker upload", async () => {
  const test = harness({ assetDriftAt: 2 });
  await assert.rejects(deployCloudflare(test.options), /assets changed during release/u);
  assert.ok(!test.calls.some((call) => call.includes("wrangler d1 migrations apply")));
  assert.ok(!test.calls.includes(deployCommand));
  assert.equal(test.receipts.length, 0);
});

await check("semantic configuration transport drift stops before Worker upload", async () => {
  const changed = structuredClone(config);
  const key = "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0";
  changed.vars[key] = `${changed.vars[key]}x`;
  const test = harness({ options: { read: async () => Buffer.from(JSON.stringify(changed)) } });
  await assert.rejects(deployCloudflare(test.options), /Generated deployment semantic configuration drift \(ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0\)/u);
  assert.ok(!test.calls.some((call) => call.includes("wrangler d1 migrations apply")));
  assert.ok(!test.calls.includes(deployCommand));
  assert.equal(test.receipts.length, 0);
});

await check("unreviewed bindings and stale runtime vars cannot sync authority or publish PASS", async () => {
  const drifts = [
    { EXTRA: { type: "plain_text", text: "foreign" } },
    { EXTRA: { type: "json", json: { foreign: true } } },
    { EXTRA: { type: "secret_text" } },
    { ACCESS_AUDIENCE: { type: "plain_text", text: "stale-audience" } },
    { ACCESS_AUDIENCE: undefined },
    { ENVIRONMENT: { type: "json", json: "staging" } },
    { ELIOTR_MODEL_GATEWAY_TOKEN: { type: "plain_text", text: "secret-reflected" } },
  ];
  for (const bindingDrift of drifts) {
    const test = harness({ bindingDrift });
    await assert.rejects(deployCloudflare(test.options));
    assert.ok(!test.calls.includes(deployCommand));
    assert.equal(test.authorityWrites(), 0,
      "unreviewed runtime bindings fail before upload and authority synchronization");
    assert.equal(test.receipts.length, 0);
  }
});
await check("missing or default migration directories stop before Worker upload", async () => {
  for (const migrations_dir of [undefined, "migrations", "../../foreign"]) {
    const changed = structuredClone(config);
    if (migrations_dir === undefined) delete changed.d1_databases[0].migrations_dir;
    else changed.d1_databases[0].migrations_dir = migrations_dir;
    const test = harness({ options: { read: async () => Buffer.from(JSON.stringify(changed)) } });
    await assert.rejects(deployCloudflare(test.options), /migration plan or ledger/u);
    assert.equal(generatedDryRunIndex(test.calls), -1);
    assert.ok(!test.calls.some((call) => call.includes("wrangler d1 migrations apply")));
    assert.ok(!test.calls.includes(deployCommand));
    assert.equal(test.calls.filter((call) => call.startsWith("POST ")).length, 0);
    assert.equal(test.receipts.length, 0);
  }
});

await check("maintenance deploy records blockers and budget findings without claiming a full release", async () => {
  const logs = [];
  const test = harness({ options: { purpose: "MAINTENANCE", log: (message) => logs.push(message) } });
  const receipt = await deployCloudflare(test.options);
  const snapshot = JSON.parse(process.env.ELIOTR_TEST_SPAWN_SNAPSHOT_JSON);
  assert.equal(Object.values(snapshot.metrics).filter((value) => value === "unknown").length, 18);
  assert.equal(snapshot.metrics.ai_search_instances, 5);
  assert.equal(test.calls.filter((call) => call.endsWith("--verify-existing")).length, 3);
  assert.deepEqual(test.calls.filter((call) => call.endsWith("--verify-existing")), [
    "node scripts/provision-cloudflare-access.mjs --verify-existing",
    "node scripts/provision-cloudflare-core.mjs --verify-existing",
    "node scripts/provision-ai-gateways.mjs --verify-existing",
  ]);
  assert.ok(!test.calls.some((call) => call.startsWith("node scripts/provision-ai-search.mjs")),
    "verified-absent AI Search remains unprovisioned during maintenance");
  assert.ok(test.calls.includes("pnpm budgets:check"));
  assert.ok(!test.calls.includes("pnpm check"));
  assert.ok(test.calls.indexOf("pnpm boundaries:check") < test.calls.indexOf("pnpm boundaries:negative"));
  assert.equal(test.calls.filter((call) => call === deployCommand).length, 1);
  const events = test.buildEvents();
  assert.equal(events[0], "capture-build-inputs");
  assert.ok(events.indexOf("capture-build-inputs") < events.indexOf("read-full-release-blockers"));
  assert.ok(events.indexOf("read-full-release-blockers") < events.indexOf("read-candidate-capability-profile"));
  assert.ok(events.indexOf("command:pnpm --filter @eliotr/core deploy:dry-run") < events.indexOf("check-build-inputs-1"));
  assert.equal(test.generatedConfigPins(), 1);
  assert.equal(test.bundleAttestations(), 1);
  assert.ok(test.buildInputChecks() >= 8, "sealed repository inputs are rechecked throughout the maintenance flow");
  assert.ok(test.bundleChecks() >= 5, "the prepared bundle is rechecked before upload and authority synchronization");
  assert.ok(test.calls.includes(deployCommand) && deployCommand.includes(`${workerEntrypoint} --no-bundle`));
  assert.ok(!test.calls.some((call) => /\/(?:billable|billing)\/usage(?:\?|$)/u.test(call)));
  const identityReads = test.calls.map((call, index) => ({ call, index }))
    .filter(({ call }) => call.startsWith("GET ") && call.endsWith("/deployments"));
  const firstGate = test.calls.findIndex((call) => call.endsWith("--check-only"));
  const dryRunIndex = generatedDryRunIndex(test.calls);
  const uploadIndex = test.calls.indexOf(deployCommand);
  assert.ok(identityReads.some(({ index }) => index < firstGate), "active Worker is pinned before provisioning checks");
  assert.ok(identityReads.some(({ index }) => dryRunIndex < index && index < uploadIndex),
    "active Worker identity is rechecked before upload");
  assert.ok(identityReads.some(({ index }) => index > uploadIndex), "candidate Worker identity is read back after upload");
  assert.ok(test.capabilityReads() >= 3, "active and candidate capability profiles are read before authority sync");
  assert.ok(!test.calls.some((call) => call.includes("wrangler d1 migrations apply")));
  assert.ok(receipt.note.includes("fixture full-release blocker"));
  assert.ok(receipt.note.includes("Source-maintainability budget gate: FAIL (17 violations)"));
  assert.ok(receipt.note.includes("D1 migrations were not applied"));
  assert.ok(logs.some((message) => message.includes("Source budgets: FAIL (17 violations)")));
  assert.equal(test.receipts.length, 1);
});

await check("live maintenance can pin and preserve existing AI Gateway inventory through all deployment stages", async () => {
  const sequence = [];
  const profile = Object.freeze({ state: "PINNED", protocol: "eliotr.maintenance-ai-gateway-profile.v1",
    profile_sha256: "c".repeat(64),
    targets: Object.freeze({ reasoning_url: config.vars.AI_GATEWAY_REASONING_URL,
      retrieval_url: config.vars.AI_GATEWAY_RETRIEVAL_URL }),
    gateways: Object.freeze({ reasoning: Object.freeze({ id: "eliotr-reasoning", authentication: true,
      cache_invalidate_on_update: false, cache_ttl: 0, collect_logs: false,
      rate_limiting_interval: 0, rate_limiting_limit: 0 }), retrieval: null }) });
  let readbackCount = 0;
  const gatewayEnvironment = { ...environment, ELIOTR_MAINTENANCE_PRESERVE_AI_GATEWAYS: "existing",
    ELIOTR_CLOUDFLARE_AUTH_MODE: "wrangler-oauth", ELIOTR_CLOUDFLARE_MCP_CWD: "C:\\Development\\Cloudflare" };
  const test = harness({ options: { purpose: "MAINTENANCE", environment: gatewayEnvironment,
    readWranglerFile: async () => 'oauth_token = "fixture-oauth"\nexpiration_time = 4102444800\n',
    runWranglerWhoami: async () => "Account test-account via browser OAuth",
    captureAiGateways: async ({ env, input, activeWorkerIdentity, candidate, observed }) => {
      sequence.push("capture");
      assert.equal(env.ELIOTR_MAINTENANCE_PRESERVE_AI_GATEWAYS, "existing");
      assert.equal(input.origin, "https://research.example.com");
      assert.deepEqual(activeWorkerIdentity.ai_gateway_urls, {
        reasoning: config.vars.AI_GATEWAY_REASONING_URL, retrieval: config.vars.AI_GATEWAY_RETRIEVAL_URL,
      });
      assert.ok(candidate.disabled_slices.includes("RETRIEVAL"));
      assert.ok(observed.disabled_slices.includes("RETRIEVAL"));
      return profile;
    },
    checkAiGateways: async ({ profile: pinned, activeWorkerIdentity }) => {
      readbackCount += 1;
      sequence.push(`gateway-readback-${readbackCount}`);
      assert.equal(pinned, profile);
      assert.deepEqual(activeWorkerIdentity.ai_gateway_urls, {
        reasoning: profile.targets.reasoning_url, retrieval: profile.targets.retrieval_url,
      });
      return Object.freeze({ state: "PASS", protocol: profile.protocol, profile_sha256: profile.profile_sha256,
        gateway_presence: Object.freeze({ reasoning: "PRESENT", retrieval: "ABSENT" }) });
    } } });
  const execute = test.options.execute;
  test.options.execute = (command, args, cwd, env) => {
    const name = `${command} ${args.join(" ")}`;
    if (args[0]?.startsWith("scripts/provision-") && args.includes("--check-only")) sequence.push("provisioner-check");
    if (name === deployCommand) sequence.push("upload");
    return execute(command, args, cwd, env);
  };
  const fetch = test.options.fetchImpl;
  test.options.fetchImpl = (url, init) => {
    const query = JSON.parse(init?.body ?? "{}");
    if (init?.method === "POST" && Array.isArray(query.batch) &&
        query.batch.some(({ sql }) => !sql.startsWith("SELECT "))) sequence.push("authority-sync");
    return fetch(url, init);
  };

  const receipt = await deployCloudflare(test.options);
  assert.equal(readbackCount, 3);
  assert.ok(sequence.indexOf("capture") < sequence.indexOf("provisioner-check"));
  assert.ok(sequence.indexOf("gateway-readback-1") < sequence.indexOf("upload"));
  assert.ok(sequence.indexOf("upload") < sequence.indexOf("gateway-readback-2"));
  assert.ok(sequence.indexOf("gateway-readback-2") < sequence.indexOf("authority-sync"));
  assert.ok(sequence.indexOf("authority-sync") < sequence.indexOf("gateway-readback-3"));
  assert.ok(!test.calls.some((call) => call.startsWith("node scripts/provision-ai-gateways.mjs")));
  assert.deepEqual(test.calls.filter((call) => call.endsWith("--check-only")), [
    "node scripts/provision-cloudflare-access.mjs --check-only",
    "node scripts/provision-cloudflare-core.mjs --check-only",
  ]);
  assert.deepEqual(receipt.maintenance_ai_gateways.gateways, {
    reasoning: { id: "eliotr-reasoning", presence: "PRESENT", settings: profile.gateways.reasoning },
    retrieval: { id: "eliotr-retrieval", presence: "ABSENT" },
  });
  assert.deepEqual(receipt.maintenance_ai_gateways.readbacks, {
    before_upload: { state: "PASS", profile_sha256: profile.profile_sha256,
      gateway_presence: { reasoning: "PRESENT", retrieval: "ABSENT" } },
    after_upload_before_authority_sync: { state: "PASS", profile_sha256: profile.profile_sha256,
      gateway_presence: { reasoning: "PRESENT", retrieval: "ABSENT" } },
    after_authority_sync: { state: "PASS", profile_sha256: profile.profile_sha256,
      gateway_presence: { reasoning: "PRESENT", retrieval: "ABSENT" } },
  });
  assert.match(receipt.note, /does not qualify a full release/u);
  assert.match(receipt.note, /retrieval remained absent/u);
  assert.equal(test.authorityWrites(), 1);
  assert.equal(test.receipts.length, 1);
});

await check("gateway preservation opt-in rejects dry-run and full-release requests before gates", async () => {
  const gatewayEnvironment = { ...environment, ELIOTR_MAINTENANCE_PRESERVE_AI_GATEWAYS: "existing",
    ELIOTR_CLOUDFLARE_AUTH_MODE: "wrangler-oauth", ELIOTR_CLOUDFLARE_MCP_CWD: "C:\\Development\\Cloudflare" };
  for (const options of [
    { purpose: "MAINTENANCE", confirmLive: false },
    { purpose: "FULL_RELEASE", confirmLive: true },
  ]) {
    const test = harness({ options: { ...options, environment: gatewayEnvironment } });
    await assert.rejects(deployCloudflare(test.options), /AI Gateway preservation requires confirmed live maintenance/u);
    assert.deepEqual(test.calls, []);
    assert.deepEqual(test.buildEvents(), []);
  }
});

await check("gateway baseline failure and fresh readback drift fail closed around upload and authority", async () => {
  const gatewayEnvironment = { ...environment, ELIOTR_MAINTENANCE_PRESERVE_AI_GATEWAYS: "existing",
    ELIOTR_CLOUDFLARE_AUTH_MODE: "wrangler-oauth", ELIOTR_CLOUDFLARE_MCP_CWD: "C:\\Development\\Cloudflare" };
  const profile = { state: "PINNED", protocol: "eliotr.maintenance-ai-gateway-profile.v1",
    profile_sha256: "d".repeat(64), targets: { reasoning_url: config.vars.AI_GATEWAY_REASONING_URL,
      retrieval_url: config.vars.AI_GATEWAY_RETRIEVAL_URL },
    gateways: { reasoning: { id: "eliotr-reasoning", authentication: true, cache_invalidate_on_update: false,
      cache_ttl: 0, collect_logs: false, rate_limiting_interval: 0, rate_limiting_limit: 0 }, retrieval: null } };
  const base = { purpose: "MAINTENANCE", environment: gatewayEnvironment,
    readWranglerFile: async () => 'oauth_token = "fixture-oauth"\nexpiration_time = 4102444800\n',
    runWranglerWhoami: async () => "Account test-account via browser OAuth" };
  const baselineFailure = harness({ options: { ...base, captureAiGateways: async () => {
    throw new Error("fixture AI Gateway baseline readback failed");
  } } });
  await assert.rejects(deployCloudflare(baselineFailure.options), /fixture AI Gateway baseline readback failed/u);
  assert.ok(!baselineFailure.calls.some((call) => call.endsWith("--check-only")));
  assert.ok(!baselineFailure.calls.includes(deployCommand));
  assert.equal(baselineFailure.receipts.length, 0);

  for (const failureReadback of [1, 2]) {
    let readbackCount = 0;
    const drift = harness({ options: { ...base, captureAiGateways: async () => profile,
      checkAiGateways: async () => {
        readbackCount += 1;
        return { state: failureReadback === readbackCount ? "FAIL" : "PASS", protocol: profile.protocol,
          profile_sha256: profile.profile_sha256,
          gateway_presence: { reasoning: "PRESENT", retrieval: "ABSENT" } };
      } } });
    await assert.rejects(deployCloudflare(drift.options), /Maintenance AI Gateway readback/u);
    assert.equal(drift.calls.filter((call) => call === deployCommand).length, failureReadback === 1 ? 0 : 1);
    assert.equal(drift.authorityWrites(), 0);
    assert.equal(drift.receipts.length, 0);
  }
});

await check("capability expansion after upload is refused before deployment-authority synchronization", async () => {
  const test = harness({ expandCapabilitiesAt: 3, options: { purpose: "MAINTENANCE" } });
  await assert.rejects(deployCloudflare(test.options), /Maintenance capability enabled_slices would change or broaden/u);
  assert.equal(test.capabilityReads(), 3, "the changed third profile read is the candidate pre-CAS readback");
  assert.equal(test.calls.filter((call) => call === deployCommand).length, 1);
  assert.equal(test.authorityWrites(), 0);
  assert.equal(test.receipts.length, 0);
});

await check("backend input drift at dry-run, preupload and pre-CAS boundaries cannot advance authority or receipts", async () => {
  for (const [stage, driftAt, expectedUpload, expectedD1Reads] of [
    ["after dry-run", 2, false, 1], ["immediately preupload", 5, false, 5], ["pre-CAS after upload", 8, true, 6],
  ]) {
    const test = harness({ backendDriftAt: driftAt, options: { purpose: "MAINTENANCE" } });
    await assert.rejects(deployCloudflare(test.options), /Backend execution inputs changed during deployment/u, stage);
    assert.equal(test.fingerprintReads(), driftAt, stage);
    assert.equal(test.calls.includes(deployCommand), expectedUpload, stage);
    assert.equal(test.calls.filter((call) => call.startsWith("POST ")).length, expectedD1Reads, stage);
    assert.equal(test.authorityWrites(), 0, stage);
    assert.equal(test.receipts.length, 0, stage);
  }
});

await check("source seal drift before build and prepared bundle drift before CAS block their next effect", async () => {
  const sourceDrift = harness({ buildInputDriftAt: 2, options: { purpose: "MAINTENANCE" } });
  await assert.rejects(deployCloudflare(sourceDrift.options), /fixture deployment build input drift/u);
  assert.equal(sourceDrift.buildInputChecks(), 2);
  assert.equal(generatedDryRunIndex(sourceDrift.calls), -1);
  assert.equal(sourceDrift.calls.includes(deployCommand), false);
  assert.equal(sourceDrift.authorityWrites(), 0);
  assert.equal(sourceDrift.receipts.length, 0);

  const bundleDrift = harness({ bundleDriftAt: 7, options: { purpose: "MAINTENANCE" } });
  await assert.rejects(deployCloudflare(bundleDrift.options), /fixture prepared Worker artifact drift/u);
  assert.equal(bundleDrift.bundleChecks(), 7);
  assert.equal(bundleDrift.calls.filter((call) => call === deployCommand).length, 1);
  assert.equal(bundleDrift.calls.filter((call) => call.startsWith("POST ")).length, 6);
  assert.equal(bundleDrift.authorityWrites(), 0);
  assert.equal(bundleDrift.receipts.length, 0);
});

console.log(`Deployment apply ordering: ${cases} groups passed; live Cloudflare NOT_EXECUTED`);
} finally {
  if (temporaryDirectory !== undefined) {
    await removeFixtureTemporaryDirectory(temporaryDirectory, temporaryRoot, temporaryPrefix);
  }
}
}

await main();
