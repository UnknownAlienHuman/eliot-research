import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deployCloudflare } from "./deploy-cloudflare.mjs";
import { readCompositionCapabilityProfile } from "./check-launch-code.mjs";
import { loadResearchRuntimeEnvironment, RESEARCH_RUNTIME_CONFIGURATION_KEYS,
  RESEARCH_RUNTIME_SEMANTIC_TRANSPORT_KEYS, semanticConfigurationTransport } from "./lib/research-runtime-config.mjs";
// Deployment checks exercise launch order and do not model billing admission.

async function removeFixture(directory, temporaryRoot, prefix) {
  const absolute = resolve(directory);
  if (dirname(absolute) !== temporaryRoot || !basename(absolute).startsWith(prefix)) {
    throw new Error("Refusing to remove an unexpected orchestration fixture path");
  }
  await rm(absolute, { recursive: true, force: true });
}

async function main() {
const temporaryRoot = resolve(tmpdir());
const prefix = "eliotr-deployment-orchestration-";
const temporaryDirectory = await mkdtemp(join(temporaryRoot, prefix));
try {
const runtimeConfigPath = resolve(temporaryDirectory, "research-runtime.json");
await writeFile(runtimeConfigPath, JSON.stringify({ protocol: "eliotr.research-runtime.v1", vars: {
  ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: { protocol: "eliotr.research-semantic-config.test.v1", profile: "orchestration-fixture" },
  ELIOTR_MODEL_PROFILE_DEFINITION_JSON: { schema: "eliotr.research.model-profile-definition.v1",
    config_provenance_ref: "fixture:model-profile", model_profile_ref: "research-model-v1" },
  ELIOTR_MODEL_PROFILE_PROVENANCE_REF: "fixture:model-profile",
  ELIOTR_MODEL_SPEND_POLICY_JSON: { protocol: "eliotr.research-owner-spend-template.v1", approved: true,
    policy_ref: "fixture:owner-spend", config_provenance_ref: "fixture:model-spend-policy",
    principal_ref: "fixture-owner", client_class: "owner_pwa", deployment_generation: "git-test",
    expires_at: "2026-12-31T00:00:00.000Z", rules: [] },
  ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: "fixture:model-spend-policy",
  ELIOTR_RESEARCH_REPORT_CONFIG_JSON: { schema: "eliotr.research.report-config.v1",
    admission_policy: { protocol: "eliotr.research-owner-report-admission-template.v1", deployment_generation: "git-test",
      config_provenance_ref: "fixture:research-report-policy", principal_ref: "fixture-owner", policy_ref: "fixture:report" },
    artifact_policy: {} },
  ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: "fixture:research-report-policy",
} }), { flag: "wx", mode: 0o600 });
const now = Date.parse("2026-09-04T23:00:00.000Z");
/*
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
*/
const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const environment = await loadResearchRuntimeEnvironment({ CLOUDFLARE_ACCOUNT_ID: "test-account", CLOUDFLARE_API_TOKEN: "secret-token",
  ELIOTR_ENVIRONMENT: "staging", ELIOTR_DEPLOYMENT_GENERATION: "git-test", ELIOTR_CUSTOM_DOMAIN: "1",
  ELIOTR_ACCESS_HOSTNAME: "research.example.com", ELIOTR_OWNER_EMAILS: "owner@example.com",
  ELIOTR_STAGING_TARGET_JSON: JSON.stringify({ protocol: "eliotr.staging-target.v1", isolation: "dedicated-account",
    account_id: "test-account", protected_account_ids: ["production-test-account"], access_hostname: "research.example.com" }),
  ELIOTR_ACCESS_TEAM_DOMAIN: "https://team-example.cloudflareaccess.com", ELIOTR_ACCESS_AUDIENCE: "test-aud",
  ELIOTR_ACCESS_SERVICE_PRINCIPALS: "", ELIOTR_ACCESS_SMOKE_COOKIE: "secret-cookie", ELIOTR_GOOGLE_EXTERNAL_TRANSPORT: "gemini-mcp",
  ELIOTR_RESEARCH_CONFIG_FILE: runtimeConfigPath }, repositoryRoot);
const runtimeConfigVars = Object.fromEntries(RESEARCH_RUNTIME_CONFIGURATION_KEYS
  .filter((key) => !RESEARCH_RUNTIME_SEMANTIC_TRANSPORT_KEYS.includes(key) && typeof environment[key] === "string")
  .map((key) => [key, environment[key]]));
const config = { name: "eliotr-core", minify: true, preview_urls: false, compatibility_date: "2026-08-28",
  vars: { ...runtimeConfigVars, ...semanticConfigurationTransport(environment).vars,
    DEPLOYMENT_GENERATION: "git-test", ENVIRONMENT: "staging", ACCESS_TEAM_DOMAIN: "https://team-example.cloudflareaccess.com",
    ACCESS_AUDIENCE: "test-aud", ACCESS_SERVICE_PRINCIPALS: "", GOOGLE_EXTERNAL_TRANSPORT: "gemini-mcp" },
  d1_databases: [
    { binding: "CORE_DB", database_name: "eliotr-core", database_id: "11111111-1111-4111-8111-111111111111", migrations_dir: "../../infra/d1/core/migrations" },
    { binding: "SEARCH_DB", database_name: "eliotr-search", database_id: "22222222-2222-4222-8222-222222222222", migrations_dir: "../../infra/d1/search/migrations" },
  ] };
const bytes = Buffer.from(JSON.stringify(config));
const buildInputManifest = Object.freeze({ protocol: "eliotr.deployment-build-inputs.v1",
  root: repositoryRoot, sha256: "a".repeat(64) });
const workerEntrypoint = resolve(repositoryRoot, ".eliotr-state/deployment-worker-12345678-1234-4234-8234-123456789abc/index.js");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const generatedConfigPin = { path: "apps/eliotr-core/wrangler.deploy.jsonc", sha256: sha256(bytes),
  byte_length: bytes.byteLength, worker_name: "eliotr-core", worker_main: "apps/eliotr-core/src/index.ts",
  assets_directory: "apps/eliotr-pwa/dist" };
const assetManifest = { protocol: "eliotr.cloudflare-assets-manifest.v1", manifest_sha256: "c".repeat(64) };
const schemaManifestResultFixture = {
  expectedManifest: { protocol: "eliotr.cloudflare-d1.application-schema-manifest.v1", streams: [] },
  provenance: { protocol: "eliotr.cloudflare-d1.expected-schema-manifest-provenance.v1",
    scope: "application_schema", exclusions: [], generated_config: {
      path: generatedConfigPin.path, sha256: generatedConfigPin.sha256, byte_length: generatedConfigPin.byte_length,
    }, streams: [], expected_manifest_sha256: "f".repeat(64), expected_manifest_byte_length: 0 },
};
const applicationSchemaAttestationFixture = {
  protocol: "eliotr.cloudflare-d1.application-schema-attestation.v1",
  state: "PASS",
  scope: "application_schema",
  catalogue_protocol: "eliotr.cloudflare-d1.application-schema-catalogue.v1",
  exclusions: [],
  streams: [],
};
function harness(overrides = {}) {
  const calls = [];
  const receipts = [];
  let reads = 0;
  const events = overrides.events ?? [];
  const options = { confirmLive: true, verifyCode: async () => { events.push("verify-code"); }, environment, now: () => now, log: () => {},
    captureBuildInputs: async () => { events.push("capture-build-inputs"); return buildInputManifest; },
    checkBuildInputs: async () => { events.push("check-build-inputs"); return true; },
    pinGeneratedConfig: async () => generatedConfigPin,
    readAssetManifest: async () => assetManifest,
    readBackendFingerprint: () => "d".repeat(64),
    createSchemaManifest: async () => schemaManifestResultFixture,
    readApplicationSchemas: async () => applicationSchemaAttestationFixture,
    attestBundle: async () => ({ protocol: "eliotr.deployment-worker-bundle.v1", sha256: "e".repeat(64),
      manifest_sha256: buildInputManifest.sha256, generated_config: generatedConfigPin, entrypoint: workerEntrypoint }),
    checkBundle: async () => true,
    readWorker: async (_environment, _input, _config, readOptions = {}) => {
      const worker = { deployment_id: "active-deployment", version_id: "active-version" };
      if (readOptions.observedDeploymentGeneration !== undefined) {
        worker.configuration_baseline = {
          deployment_id: "active-deployment", version_id: "active-version",
          deployment_generation: readOptions.observedDeploymentGeneration,
          configuration_sha256: "c".repeat(64), configuration: { fixture: true },
        };
        if (readOptions.expectedConfigurationBaseline !== undefined) {
          assert.deepEqual(worker.configuration_baseline, readOptions.expectedConfigurationBaseline);
        }
      }
      return worker;
    },
    readSchemaGenerations: async () => ({ state: "PASS", streams: [] }),
    execute(command, args, cwd, env) {
      const name = `${command} ${args.join(" ")}`; calls.push(name);
      events.push(`command:${name}`);
      assert.equal(env.ELIOTR_RESEARCH_CONFIG_FILE, runtimeConfigPath);
      assert.equal(env.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON, environment.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON);
      if (env.ELIOTR_DEPLOYMENT_GENERATION !== undefined) assert.equal(env.ELIOTR_DEPLOYMENT_GENERATION, "git-test");
      assert.equal(resolve(cwd), resolve(fileURLToPath(new URL("../", import.meta.url)),
        args.includes("--config") ? "apps/eliotr-core" : "."));
      if (name === overrides.failCommand || (typeof overrides.failCommand === "string" && name.startsWith(overrides.failCommand))) {
        throw new Error("injected command failure");
      }
    },
    archive: async () => { calls.push("archive"); },
    read: async () => { reads += 1; return overrides.driftAt === reads ? Buffer.from("{}") : bytes; },
    save: async (receipt) => { calls.push("save"); receipts.push(receipt); },
    readActiveWorker: async () => ({ deployment_id: "active-deployment", version_id: "active-version", generation: "git-test" }),
    fetchImpl: async (url, init = {}) => {
      const method = init.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (method === "POST") {
        const query = JSON.parse(init.body);
        return globalThis.Response.json({ success: true, result: query.batch.map(() => ({
          success: true, results: [], meta: { changes: 0 },
        })) });
      }
      if (overrides.failReadback) return new globalThis.Response("login", { headers: { "content-type": "text/html" } });
      if (url.endsWith("/workers/scripts")) return globalThis.Response.json({ success: true, result: [
        { id: "eliotr-core", compatibility_date: "2026-08-28", has_assets: true,
          exports: { ResearchSession: { type: "durable-object" } } },
      ] });
      if (url.endsWith("/healthz")) return globalThis.Response.json({ ready: true,
        deployment_generation: "git-test", checked_at: new Date(now).toISOString() });
      return globalThis.Response.json({ trace_id: "trace-test", deployment_generation: "git-test", data: {
        protocol: "eliotr.capabilities.v1", deployment_generation: "git-test", enabled_slices: ["HEALTH", "ACCESS"],
        disabled_slices: ["RESEARCH"], exact_evidence_resolution_required: true,
        transport_completion_is_research_completion: false, ingest_live_qualified: false,
      } });
    }, ...overrides.options };
  options.environment = { ...options.environment, ELIOTR_RESEARCH_CONFIG_FILE: runtimeConfigPath };
  return { calls, receipts, options, events };
}
let cases = 0;
const check = async (name, action) => { await action(); cases += 1; console.log(`Deployment ordering: ${name}: PASS`); };
const deployCommand = `pnpm exec wrangler deploy ${workerEntrypoint} --no-bundle --config wrangler.deploy.jsonc`;
const generatedDryRun = "pnpm exec wrangler deploy --dry-run --minify --config wrangler.deploy.jsonc --outdir ";
const coreMigration = "pnpm exec wrangler d1 migrations apply CORE_DB --remote --config wrangler.deploy.jsonc";

await check("dry run has no remote or receipt effects", async () => {
  const test = harness({ options: { confirmLive: false, environment: {} } });
  test.options.execute = (command, args, _cwd, env) => {
    const name = `${command} ${args.join(" ")}`;
    test.calls.push(name);
    test.events.push(`command:${name}`);
    assert.equal(env.ELIOTR_RESEARCH_CONFIG_FILE, runtimeConfigPath);
    assert.equal(env.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON, environment.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON);
  };
  assert.equal(await deployCloudflare(test.options), null);
  assert.deepEqual(test.calls, ["pnpm check", "pnpm --filter @eliotr/core cf:types",
    "pnpm budgets:emitted"]);
  assert.equal(test.events[0], "capture-build-inputs");
  assert.ok(test.events.indexOf("command:pnpm budgets:emitted") < test.events.indexOf("check-build-inputs"));
});
await check("invalid smoke input fails even before local commands", async () => {
  const test = harness({ options: { environment: { ...environment, ELIOTR_SMOKE_BASE_URL: "https://wrong.example" } } });
  await assert.rejects(deployCloudflare(test.options));
  assert.deepEqual(test.calls, []);
});
await check("AI Search bootstrap is confirmed-maintenance-only and exclusive with absent preservation", async () => {
  const intentPath = ".eliotr-state/maintenance-ai-search-bootstrap-fixture.json";
  const release = harness({ options: { environment: { ...environment,
    ELIOTR_MAINTENANCE_AI_SEARCH_BOOTSTRAP_FILE: intentPath } } });
  await assert.rejects(deployCloudflare(release.options), /confirmed live maintenance deployment/u);
  assert.deepEqual(release.calls, []);
  const maintenance = harness({ options: { purpose: "MAINTENANCE", environment: { ...environment,
    ELIOTR_MAINTENANCE_AI_SEARCH_BOOTSTRAP_FILE: intentPath,
    ELIOTR_MAINTENANCE_PRESERVE_AI_SEARCH: "absent" } } });
  await assert.rejects(deployCloudflare(maintenance.options), /cannot be combined with absent-binding preservation/u);
  assert.deepEqual(maintenance.calls, []);
});
await check("every failed preflight precedes archive and mutation", async () => {
  for (const name of ["provision-cloudflare-core", "provision-ai-search", "provision-ai-gateways", "provision-cloudflare-access"]) {
    const test = harness({ failCommand: `node scripts/${name}.mjs --check-only` });
    await assert.rejects(deployCloudflare(test.options));
    assert.ok(!test.calls.includes("archive"));
    assert.equal(test.receipts.length, 0);
    assert.ok(!test.calls.some((call) => call.startsWith("node ") && !call.endsWith("--check-only")));
  }
});
await check("generated config dry-run fails before remote D1 mutation", async () => {
  const test = harness({ failCommand: generatedDryRun });
  await assert.rejects(deployCloudflare(test.options), /injected command failure/u);
  assert.ok(test.calls.some((call) => call.startsWith(generatedDryRun)),
    `the frozen-entry bundle dry-run was actually reached; calls: ${JSON.stringify(test.calls)}`);
  assert.ok(!test.calls.includes(coreMigration));
  assert.ok(!test.calls.includes(deployCommand));
  assert.equal(test.receipts.length, 0);
});
await check("generated config drift blocks dry-run and Worker upload", async () => {
  for (const driftAt of [2, 3]) {
    const test = harness({ driftAt });
    await assert.rejects(deployCloudflare(test.options));
    assert.ok(!test.calls.includes(deployCommand));
    assert.ok(!test.calls.some((call) => call.startsWith(generatedDryRun)));
    assert.equal(test.receipts.length, 0);
  }
});
await check("default full release preserves the launch-code gate after capturing inputs", async () => {
  const events = [];
  const test = harness({ events, options: { verifyCode: async () => { events.push("verify-code"); throw new Error("LIVE_DEPLOY_BLOCKED"); } } });
  await assert.rejects(deployCloudflare(test.options), /LIVE_DEPLOY_BLOCKED/u);
  assert.deepEqual(test.calls, []);
  assert.deepEqual(test.events, ["capture-build-inputs", "verify-code"]);
  assert.equal(test.receipts.length, 0);
});
await check("transport preservation rejects full release and enabling selectors before gates", async () => {
  for (const [purpose, preserve] of [["FULL_RELEASE", "disabled"], ["MAINTENANCE", "gemini-mcp"],
    ["MAINTENANCE", "unknown"]]) {
    const test = harness({ options: { purpose, environment: { ...environment,
      ELIOTR_MAINTENANCE_PRESERVE_GOOGLE_TRANSPORT: preserve } } });
    await assert.rejects(deployCloudflare(test.options), /maintenance-only/u);
    assert.deepEqual(test.calls, []);
  }
});
await check("confirmed disabled reaches every read-only provisioner without changing canonical transport", async () => {
  const candidate = await readCompositionCapabilityProfile({ root: repositoryRoot });
  const capabilities = { protocol: candidate.protocol, deployment_generation: "git-test",
    google_external_transport: "disabled", enabled_slices: candidate.enabled_slices,
    partial_slices: candidate.partial_slices, disabled_slices: candidate.disabled_slices,
    federation_configured: false, orientation_profile: candidate.orientation_profile,
    orientation_max_sources: candidate.orientation_max_sources,
    orientation_max_results: candidate.orientation_max_results, routes: candidate.routes, ...candidate.safety_invariants };
  const test = harness({ failCommand: "node scripts/provision-cloudflare-access.mjs --verify-existing", options: {
    purpose: "MAINTENANCE", environment: { ...environment, ELIOTR_MAINTENANCE_PRESERVE_GOOGLE_TRANSPORT: "disabled" },
    readCapabilityProfile: async () => candidate, readReleaseBlockers: async () => [],
    captureBudget: () => ({ status: 0, stdout: "Source budgets: PASS\n", stderr: "", error: null }),
    readActiveWorker: async () => ({ deployment_id: "active-deployment", version_id: "active-version", generation: "git-test",
      google_external_transport: "disabled", federation_principal_ref: null, federation_cursor_key_bound: false,
      ai_search_bound: false }),
    readCapabilities: async () => ({ generation: "git-test", capabilities }),
  } });
  const execute = test.options.execute;
  test.options.execute = (command, args, cwd, env) => {
    assert.equal(env.ELIOTR_GOOGLE_EXTERNAL_TRANSPORT, "disabled");
    assert.equal(env.ELIOTR_MAINTENANCE_PRESERVE_GOOGLE_TRANSPORT, "disabled");
    if (command === "node") assert.equal(env.ELIOTR_MAINTENANCE_PRESERVE_AI_SEARCH, "absent");
    return execute(command, args, cwd, env);
  };
  await assert.rejects(deployCloudflare(test.options), /injected command failure/u);
  assert.ok(test.calls.includes("node scripts/provision-cloudflare-core.mjs --check-only"));
  assert.ok(test.calls.includes("node scripts/provision-cloudflare-access.mjs --verify-existing"));
  assert.ok(!test.calls.some((call) => call.startsWith("node scripts/provision-ai-search.mjs")));
  assert.ok(!test.calls.includes(deployCommand));
  assert.equal(config.vars.GOOGLE_EXTERNAL_TRANSPORT, "gemini-mcp");
});
await check("maintenance records launch blockers and budget findings", async () => {
  const logs = [];
  const events = [];
  const test = harness({ events, options: { confirmLive: false, environment: {}, purpose: "MAINTENANCE",
    readReleaseBlockers: async () => { events.push("read-full-release-blockers"); return ["known launch blocker"]; },
    readCapabilityProfile: async () => { events.push("read-candidate-capability-profile"); return { protocol: "eliotr.capabilities.v1" }; },
    captureBudget: () => { events.push("capture-source-budget"); return { status: 1, stdout: "Source budgets: FAIL (17 violations)\n", stderr: "", error: null }; },
    log: (message) => logs.push(message) } });
  assert.equal(await deployCloudflare(test.options), null);
  assert.deepEqual(test.calls, ["pnpm --filter @eliotr/core typecheck",
    "pnpm exec eslint scripts/deploy-cloudflare.mjs scripts/lib/deployment-maintenance.mjs scripts/lib/deployment-ai-search-bootstrap.mjs scripts/test-deployment-ai-search-bootstrap.mjs scripts/lib/deployment-route-update.mjs scripts/test-deployment-route-update.mjs scripts/lib/deployment-ai-gateways.mjs scripts/test-deployment-ai-gateways.mjs scripts/test-deployment-maintenance.mjs scripts/test-deployment-apply-ordering.mjs scripts/test-deployment-orchestration.mjs scripts/lib/deployment-build-inputs.mjs scripts/check-launch-code.mjs",
    "pnpm boundaries:check", "pnpm boundaries:negative", "pnpm --filter @eliotr/core cf:types",
    "pnpm budgets:emitted"]);
  assert.ok(logs.some((message) => message.includes("known launch blocker")));
  assert.ok(logs.some((message) => message.includes("Source budgets: FAIL (17 violations)")));
  assert.ok(!test.calls.includes("pnpm check"));
  assert.ok(!test.calls.some((call) => call.startsWith("GET ") || call.startsWith("POST ")));
  assert.equal(test.events[0], "capture-build-inputs");
  assert.ok(test.events.indexOf("capture-build-inputs") < test.events.indexOf("read-full-release-blockers"));
  assert.ok(test.events.indexOf("capture-source-budget") < test.events.indexOf("command:pnpm budgets:emitted"));
  assert.ok(test.events.indexOf("command:pnpm budgets:emitted") < test.events.indexOf("check-build-inputs"));
});
await check("maintenance compile, lint, boundary and artifact gates still block", async () => {
  const commands = ["pnpm --filter @eliotr/core typecheck",
    "pnpm exec eslint scripts/deploy-cloudflare.mjs scripts/lib/deployment-maintenance.mjs scripts/lib/deployment-ai-search-bootstrap.mjs scripts/test-deployment-ai-search-bootstrap.mjs scripts/lib/deployment-route-update.mjs scripts/test-deployment-route-update.mjs scripts/lib/deployment-ai-gateways.mjs scripts/test-deployment-ai-gateways.mjs scripts/test-deployment-maintenance.mjs scripts/test-deployment-apply-ordering.mjs scripts/test-deployment-orchestration.mjs scripts/lib/deployment-build-inputs.mjs scripts/check-launch-code.mjs",
    "pnpm boundaries:check", "pnpm boundaries:negative", "pnpm --filter @eliotr/core cf:types",
    "pnpm budgets:emitted"];
  for (const command of commands) {
    const test = harness({ failCommand: command, options: { confirmLive: false, environment: {}, purpose: "MAINTENANCE",
      readReleaseBlockers: async () => [], readCapabilityProfile: async () => ({ protocol: "eliotr.capabilities.v1" }),
      captureBudget: () => ({ status: 0, stdout: "Source budgets: PASS\n", stderr: "", error: null }) } });
    await assert.rejects(deployCloudflare(test.options), /injected command failure/u);
    assert.ok(!test.calls.some((call) => call.startsWith("GET ") || call.startsWith("POST ")));
  }
});
await check("unclassifiable maintenance budget result fails before local gates", async () => {
  const test = harness({ options: { confirmLive: false, environment: {}, purpose: "MAINTENANCE",
    readReleaseBlockers: async () => [], readCapabilityProfile: async () => ({ protocol: "eliotr.capabilities.v1" }),
    captureBudget: () => ({ status: 2, stdout: "unknown output", stderr: "", error: null }) } });
  await assert.rejects(deployCloudflare(test.options), /budget result could not be classified/u);
  assert.deepEqual(test.calls, []);
});
await check("Access verify-existing refusal stops before Worker upload", async () => {
  const test = harness({ failCommand: "node scripts/provision-cloudflare-access.mjs --verify-existing" });
  await assert.rejects(deployCloudflare(test.options));
  assert.ok(!test.calls.includes(deployCommand));
  assert.ok(!test.calls.some((call) => call.includes("d1 migrations apply")));
  assert.equal(test.receipts.length, 0);
});
console.log(`Deployment orchestration: ${cases} groups passed; live Cloudflare NOT_EXECUTED`);
} finally {
  await removeFixture(temporaryDirectory, temporaryRoot, prefix);
}
}

await main();
