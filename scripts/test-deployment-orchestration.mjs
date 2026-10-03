import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deployCloudflare } from "./deploy-cloudflare.mjs";
// Deployment no longer consumes a billing-envelope snapshot.

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
const environment = { CLOUDFLARE_ACCOUNT_ID: "test-account", CLOUDFLARE_API_TOKEN: "secret-token",
  ELIOTR_ENVIRONMENT: "staging", ELIOTR_DEPLOYMENT_GENERATION: "git-test", ELIOTR_CUSTOM_DOMAIN: "1",
  ELIOTR_ACCESS_HOSTNAME: "research.example.com", ELIOTR_OWNER_EMAILS: "owner@example.com",
  ELIOTR_STAGING_TARGET_JSON: JSON.stringify({ protocol: "eliotr.staging-target.v1", isolation: "dedicated-account",
    account_id: "test-account", protected_account_ids: ["production-test-account"], access_hostname: "research.example.com" }),
  ELIOTR_ACCESS_TEAM_DOMAIN: "https://team-example.cloudflareaccess.com", ELIOTR_ACCESS_AUDIENCE: "test-aud",
  ELIOTR_ACCESS_SERVICE_PRINCIPALS: "", ELIOTR_ACCESS_SMOKE_COOKIE: "secret-cookie", ELIOTR_GOOGLE_EXTERNAL_TRANSPORT: "gemini-mcp" };
const config = { name: "eliotr-core", minify: true, preview_urls: false, compatibility_date: "2026-08-28",
  vars: { DEPLOYMENT_GENERATION: "git-test", ENVIRONMENT: "staging", ACCESS_TEAM_DOMAIN: "https://team-example.cloudflareaccess.com",
    ACCESS_AUDIENCE: "test-aud", ACCESS_SERVICE_PRINCIPALS: "", GOOGLE_EXTERNAL_TRANSPORT: "gemini-mcp" },
  d1_databases: [
    { binding: "CORE_DB", database_name: "eliotr-core", database_id: "11111111-1111-4111-8111-111111111111", migrations_dir: "../../infra/d1/core/migrations" },
    { binding: "SEARCH_DB", database_name: "eliotr-search", database_id: "22222222-2222-4222-8222-222222222222", migrations_dir: "../../infra/d1/search/migrations" },
  ] };
const bytes = Buffer.from(JSON.stringify(config));
function harness(overrides = {}) {
  const calls = [];
  const receipts = [];
  let reads = 0;
  const options = { confirmLive: true, verifyCode: async () => {}, environment, now: () => now, log: () => {},
    execute(command, args, cwd, env) {
      const name = `${command} ${args.join(" ")}`; calls.push(name);
      if (env.ELIOTR_DEPLOYMENT_GENERATION !== undefined) assert.equal(env.ELIOTR_DEPLOYMENT_GENERATION, "git-test");
      assert.equal(resolve(cwd), resolve(fileURLToPath(new URL("../", import.meta.url)),
        args.includes("--config") ? "apps/eliotr-core" : "."));
      if (name === overrides.failCommand) throw new Error("injected command failure");
    },
    archive: async () => { calls.push("archive"); },
    read: async () => { reads += 1; return overrides.driftAt === reads ? Buffer.from("{}") : bytes; },
    save: async (receipt) => { calls.push("save"); receipts.push(receipt); },
    readActiveWorker: async () => ({ deployment_id: "active-deployment", version_id: "active-version", generation: "git-test" }),
    fetchImpl: async (url) => {
      calls.push(`GET ${url}`);
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
  return { calls, receipts, options };
}
let cases = 0;
const check = async (name, action) => { await action(); cases += 1; console.log(`Deployment ordering: ${name}: PASS`); };
const deployCommand = "pnpm exec wrangler deploy --config wrangler.deploy.jsonc";
const generatedDryRun = "pnpm exec wrangler deploy --dry-run --minify --config wrangler.deploy.jsonc";
const coreMigration = "pnpm exec wrangler d1 migrations apply CORE_DB --remote --config wrangler.deploy.jsonc";

await check("dry run has no remote or receipt effects", async () => {
  const test = harness({ options: { confirmLive: false, environment: {} } });
  test.options.execute = (command, args) => test.calls.push(`${command} ${args.join(" ")}`);
  assert.equal(await deployCloudflare(test.options), null);
  assert.deepEqual(test.calls, ["pnpm check", "pnpm build:pwa", "pnpm --filter @eliotr/core cf:types",
    "pnpm --filter @eliotr/core deploy:dry-run"]);
});
await check("invalid smoke input fails even before local commands", async () => {
  const test = harness({ options: { environment: { ...environment, ELIOTR_SMOKE_BASE_URL: "https://wrong.example" } } });
  await assert.rejects(deployCloudflare(test.options));
  assert.deepEqual(test.calls, []);
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
  await assert.rejects(deployCloudflare(test.options));
  assert.ok(!test.calls.includes(coreMigration));
  assert.ok(!test.calls.includes(deployCommand));
  assert.equal(test.receipts.length, 0);
});
await check("generated config drift blocks dry-run and Worker upload", async () => {
  for (const driftAt of [2, 3]) {
    const test = harness({ driftAt });
    await assert.rejects(deployCloudflare(test.options));
    assert.ok(!test.calls.includes(deployCommand));
    assert.ok(!test.calls.includes(generatedDryRun));
    assert.equal(test.receipts.length, 0);
  }
});
await check("default full release preserves the launch-code gate", async () => {
  const test = harness({ options: { verifyCode: async () => { throw new Error("LIVE_DEPLOY_BLOCKED"); } } });
  await assert.rejects(deployCloudflare(test.options), /LIVE_DEPLOY_BLOCKED/u);
  assert.deepEqual(test.calls, []);
  assert.equal(test.receipts.length, 0);
});
await check("maintenance records launch blockers and budget findings", async () => {
  const logs = [];
  const test = harness({ options: { confirmLive: false, environment: {}, purpose: "MAINTENANCE",
    readReleaseBlockers: async () => ["known launch blocker"],
    readCapabilityProfile: async () => ({ protocol: "eliotr.capabilities.v1" }),
    captureBudget: () => ({ status: 1, stdout: "Source budgets: FAIL (17 violations)\n", stderr: "", error: null }),
    log: (message) => logs.push(message) } });
  assert.equal(await deployCloudflare(test.options), null);
  assert.deepEqual(test.calls, ["pnpm --filter @eliotr/core typecheck",
    "pnpm exec eslint scripts/deploy-cloudflare.mjs scripts/lib/deployment-maintenance.mjs scripts/check-launch-code.mjs",
    "pnpm boundaries:negative", "pnpm build:pwa", "pnpm --filter @eliotr/core cf:types",
    "pnpm --filter @eliotr/core deploy:dry-run"]);
  assert.ok(logs.some((message) => message.includes("known launch blocker")));
  assert.ok(logs.some((message) => message.includes("Source budgets: FAIL (17 violations)")));
  assert.ok(!test.calls.includes("pnpm check"));
  assert.ok(!test.calls.some((call) => call.startsWith("GET ") || call.startsWith("POST ")));
});
await check("maintenance compile, lint, boundary and artifact gates still block", async () => {
  const commands = ["pnpm --filter @eliotr/core typecheck",
    "pnpm exec eslint scripts/deploy-cloudflare.mjs scripts/lib/deployment-maintenance.mjs scripts/check-launch-code.mjs",
    "pnpm boundaries:negative", "pnpm build:pwa", "pnpm --filter @eliotr/core cf:types",
    "pnpm --filter @eliotr/core deploy:dry-run"];
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
