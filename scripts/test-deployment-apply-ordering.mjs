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
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deployCloudflare } from "./deploy-cloudflare.mjs";
import { readDeploymentMigrationPlan } from "./lib/deployment-migrations.mjs";
import { digestAccountId } from "./lib/cloudflare-usage-envelope.mjs";
import { dailyWindowFor, monthlyWindowFor } from "./lib/cloudflare-usage-collection.mjs";
import { stripNodeOptionsLoaderTokens } from "./lib/cloudflare-wrangler-oauth.mjs";
import { loadResearchRuntimeEnvironment, RESEARCH_RUNTIME_CONFIGURATION_KEYS,
  RESEARCH_RUNTIME_SEMANTIC_TRANSPORT_KEYS, semanticConfigurationTransport } from "./lib/research-runtime-config.mjs";

if (process.env.ELIOTR_TEST_GATE_REDIRECTED !== "1") {
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
const runtimeConfigPath = resolve(resolvedTemporaryDirectory, "research-runtime.json");
const runtimeConfig = { protocol: "eliotr.research-runtime.v1", vars: {
  ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: { protocol: "eliotr.research-semantic-config.test.v1", profile: "fixture" },
  ELIOTR_MODEL_PROFILE_DEFINITION_JSON: { protocol: "eliotr.model-profile-definition.test.v1", profiles: [] },
  ELIOTR_MODEL_PROFILE_PROVENANCE_REF: "fixture:model-profile",
  ELIOTR_MODEL_SPEND_POLICY_JSON: { protocol: "eliotr.model-spend-policy.test.v1", policies: [] },
  ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: "fixture:model-spend-policy",
  ELIOTR_RESEARCH_REPORT_CONFIG_JSON: { protocol: "eliotr.research-report-config.test.v1" },
  ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: "fixture:research-report-policy",
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
const runtimeConfigVars = Object.fromEntries(RESEARCH_RUNTIME_CONFIGURATION_KEYS
  .filter((key) => !RESEARCH_RUNTIME_SEMANTIC_TRANSPORT_KEYS.includes(key) && typeof environment[key] === "string")
  .map((key) => [key, environment[key]]));
Object.assign(runtimeConfigVars, semanticConfigurationTransport(environment).vars);
// Staged snapshots travel via the explicit `usageSnapshot` deploy option
// (test-called builder path), never ambient env: production never passes it.
// Under this file's redirected child the standin additionally mints a TEST
// capability for the ADMITTED fixture, which is what authorizes the
// fake-observed apply below (production capabilities remain unmintable here).
const defaultUsageSnapshot = admittedSnapshotJson();
const config = { name: "eliotr-core", minify: true, preview_urls: false, compatibility_date: "2026-08-28",
  vars: { DEPLOYMENT_GENERATION: "git-test", ENVIRONMENT: "staging", ACCESS_TEAM_DOMAIN: "https://team-example.cloudflareaccess.com",
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
const assetBytes = "<!doctype html><main>fixture</main>";
const assetManifest = {"protocol":"eliotr.cloudflare-assets-manifest.v1","state":"LOCAL_ONLY","directory":"apps/eliotr-pwa/dist","files":[{"path":"index.html","bytes":35,"sha256":"a02618fd171637ef11b3b4d923cb91cf9837c902dbd7aca5bd69f8eeb465c59f"}],"excluded_routing_files":["_headers","_redirects"],"manifest_sha256":"42a56ab403ebc72972cf5e99795838d1f331afec0cd0a9aea5a8b128fb5203fd"};
const alternateVersionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const versionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const migrationPlan = await readDeploymentMigrationPlan(config, { root: repositoryRoot });
const bytes = Buffer.from(JSON.stringify(config));
function harness(overrides = {}) {
  const calls = [];
  const receipts = [];
  const provisionerEnvs = [];
  const deploymentRows = new Map();
  let reads = 0;
  let manifestReads = 0;
  let deploymentsRead = 0;
  let assetReads = 0;
  const options = { readAssetManifest: async () => { manifestReads += 1; return overrides.assetDriftAt === manifestReads ? { ...assetManifest, manifest_sha256: "0".repeat(64) } : assetManifest; }, confirmLive: true, verifyCode: async () => {}, environment, usageSnapshot: defaultUsageSnapshot, now: () => now, log: () => {},
    execute(command, args, cwd, env) {
      const name = `${command} ${args.join(" ")}`; calls.push(name);
      if (args[0]?.startsWith("scripts/provision-")) provisionerEnvs.push({ name: args[0], env: { ...env } });
      assert.equal(env.ELIOTR_DEPLOYMENT_GENERATION, "git-test");
      assert.equal(resolve(cwd), resolve(fileURLToPath(new URL("../", import.meta.url)),
        args.includes("--config") ? "apps/eliotr-core" : "."));
      if (name === overrides.failCommand) throw new Error("injected command failure");
    },
    archive: async () => { calls.push("archive"); },
    read: async () => { reads += 1; return overrides.driftAt === reads ? Buffer.from("{}") : bytes; },
    save: async (receipt) => { calls.push("save"); receipts.push(receipt); },
    fetchImpl: async (url, init = {}) => {
      const method = init.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (method === "POST" && String(url).includes("/d1/database/")) {
        const query = JSON.parse(init.body);
        if (query.sql?.startsWith("SELECT name FROM d1_migrations")) {
          const stream = migrationPlan.find((entry) => String(url).includes(entry.database_id));
          const names = [...stream.migration_names];
          if (overrides.ledgerDrift === stream.binding) names.pop();
          return globalThis.Response.json({ success: true, result: [{ success: true,
            results: names.map((name) => ({ name })), meta: { rows_written: 0, changed_db: false } }] });
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
      if (overrides.failReadback) return new globalThis.Response("login", { headers: { "content-type": "text/html" } });
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
      if (String(url).endsWith("/versions/" + versionId) || String(url).endsWith("/versions/" + alternateVersionId)) return globalThis.Response.json({ success: true, result: {
        id: String(url).endsWith(alternateVersionId) ? alternateVersionId : versionId, number: 9, resources: {
          bindings: { ...Object.fromEntries(Object.entries(config.vars).map(([name, text]) => [name, { type: "plain_text", text }])),
            ...overrides.bindingDrift, CORE_DB: { type: "d1", id: config.d1_databases[0].database_id },
            SEARCH_DB: { type: "d1", id: config.d1_databases[1].database_id }, ASSETS: { type: "assets" },
            RESEARCH_SESSION: { type: "durable_object_namespace", class_name: "ResearchSession" } },
          script: { etag: "fixture-etag" }, script_runtime: { compatibility_date: config.compatibility_date,
            compatibility_flags: [], exports: { default: { type: "worker" }, ...config.exports } },
        },
      } });
      if (String(url).endsWith("/healthz")) return globalThis.Response.json({ ready: true,
        deployment_generation: "git-test", checked_at: new Date(now).toISOString() });
      return globalThis.Response.json({ trace_id: "trace-test", deployment_generation: "git-test", data: {
        protocol: "eliotr.capabilities.v1", deployment_generation: "git-test", enabled_slices: ["HEALTH", "ACCESS"],
        disabled_slices: ["RESEARCH"], exact_evidence_resolution_required: true,
        transport_completion_is_research_completion: false, ingest_live_qualified: false,
      } });
    }, ...overrides.options };
  return { calls, receipts, provisionerEnvs, options, assetReads: () => assetReads };
}
let cases = 0;
const check = async (name, action) => { await action(); cases += 1; console.log(`Deployment apply ordering: ${name}: PASS`); };
const deployCommand = "pnpm exec wrangler deploy --config wrangler.deploy.jsonc";
const generatedDryRun = "pnpm exec wrangler deploy --dry-run --minify --config wrangler.deploy.jsonc";
const coreMigration = "pnpm exec wrangler d1 migrations apply CORE_DB --remote --config wrangler.deploy.jsonc";
const searchMigration = "pnpm exec wrangler d1 migrations apply SEARCH_DB --remote --config wrangler.deploy.jsonc";

await check("successful ordering and no implicit live qualification", async () => {
  const test = harness();
  const receipt = await deployCloudflare(test.options);
  assert.deepEqual(Object.fromEntries(RESEARCH_RUNTIME_SEMANTIC_TRANSPORT_KEYS
    .filter((key) => Object.hasOwn(config.vars, key)).map((key) => [key, config.vars[key]])),
  semanticConfigurationTransport(environment).vars);
  assert.equal(test.calls.filter((call) => call === deployCommand).length, 1);
  assert.ok(test.calls.indexOf(generatedDryRun) < test.calls.indexOf(coreMigration));
  assert.ok(test.calls.indexOf(coreMigration) < test.calls.indexOf(searchMigration));
  assert.ok(test.calls.indexOf(searchMigration) < test.calls.indexOf(deployCommand));
  assert.equal(test.calls.filter((call) => call.endsWith("--check-only")).length, 4);
  assert.ok(!test.calls.some((call) => call.includes("--keep-vars")));
  assert.ok(test.calls.indexOf("archive") < test.calls.indexOf("node scripts/provision-cloudflare-core.mjs"));
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
  assert.equal(test.calls.filter((call) => call.startsWith("GET ")).length, 3);
});
await check("migration or deployment failure cannot publish PASS", async () => {
  for (const command of [coreMigration, searchMigration, deployCommand]) {
    const test = harness({ failCommand: command });
    await assert.rejects(deployCloudflare(test.options));
    assert.equal(test.receipts.length, 0);
    assert.ok(!test.calls.some((call) => call.startsWith("GET ")));
  }
});
await check("readback failure after upload is not successful deployment", async () => {
  const test = harness({ failReadback: true });
  await assert.rejects(deployCloudflare(test.options));
  assert.equal(test.calls.filter((call) => call === deployCommand).length, 1);
  assert.ok(test.calls.includes("archive"));
  assert.equal(test.receipts.length, 0);
});

await check("migration ledger mismatch stops before Worker upload and authority writes", async () => {
  for (const binding of ["CORE_DB", "SEARCH_DB"]) {
    const test = harness({ ledgerDrift: binding });
    await assert.rejects(deployCloudflare(test.options), /migration plan or ledger/u);
    assert.ok(!test.calls.includes(deployCommand));
    assert.ok(!test.calls.some((call) => call.startsWith("GET ")));
    assert.equal(test.receipts.length, 0);
  }
});
await check("partial active traffic stops before deployment authority and PASS receipt", async () => {
  const test = harness({ partialTraffic: true });
  await assert.rejects(deployCloudflare(test.options), /active deployment/u);
  assert.ok(test.calls.includes(deployCommand));
  assert.equal(test.calls.filter((call) => call.startsWith("POST ")).length, 2, "only read-only ledger queries can precede refusal");
  assert.equal(test.receipts.length, 0);
});


await check("asset content or active-version mismatch stops before authority writes and receipt", async () => {
  for (const override of [{ assetMismatch: true }, { versionDrift: true }]) {
    const test = harness(override);
    await assert.rejects(deployCloudflare(test.options), /asset readback|deployment changed/u);
    assert.equal(test.calls.filter((call) => call.startsWith("POST ")).length, 2);
    assert.equal(test.receipts.length, 0);
  }
});

await check("local asset drift stops before remote migrations and Worker upload", async () => {
  const test = harness({ assetDriftAt: 2 });
  await assert.rejects(deployCloudflare(test.options), /assets changed during release/u);
  assert.ok(!test.calls.includes(coreMigration));
  assert.ok(!test.calls.includes(searchMigration));
  assert.ok(!test.calls.includes(deployCommand));
  assert.equal(test.receipts.length, 0);
});

await check("semantic configuration transport drift stops before D1 apply and Worker upload", async () => {
  const changed = structuredClone(config);
  const key = "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0";
  changed.vars[key] = `${changed.vars[key]}x`;
  const test = harness({ options: { read: async () => Buffer.from(JSON.stringify(changed)) } });
  await assert.rejects(deployCloudflare(test.options), /Generated deployment semantic configuration drift \(ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0\)/u);
  assert.ok(!test.calls.includes(coreMigration));
  assert.ok(!test.calls.includes(searchMigration));
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
    assert.ok(test.calls.includes(deployCommand));
    assert.equal(test.calls.filter((call) => call.startsWith("POST ")).length, 2,
      "only read-only ledger queries may precede refusal");
    assert.equal(test.receipts.length, 0);
  }
});
await check("missing or default migration directories stop before D1 apply and Worker upload", async () => {
  for (const migrations_dir of [undefined, "migrations", "../../foreign"]) {
    const changed = structuredClone(config);
    if (migrations_dir === undefined) delete changed.d1_databases[0].migrations_dir;
    else changed.d1_databases[0].migrations_dir = migrations_dir;
    const test = harness({ options: { read: async () => Buffer.from(JSON.stringify(changed)) } });
    await assert.rejects(deployCloudflare(test.options), /migration plan or ledger/u);
    assert.ok(!test.calls.includes(generatedDryRun));
    assert.ok(!test.calls.includes(coreMigration));
    assert.ok(!test.calls.includes(deployCommand));
    assert.equal(test.calls.filter((call) => call.startsWith("POST ")).length, 0);
    assert.equal(test.receipts.length, 0);
  }
});

console.log(`Deployment apply ordering: ${cases} groups passed; live Cloudflare NOT_EXECUTED`);
} finally {
  if (temporaryDirectory !== undefined) {
    await removeFixtureTemporaryDirectory(temporaryDirectory, temporaryRoot, temporaryPrefix);
  }
}
}

await main();
