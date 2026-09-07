import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deployCloudflare } from "./deploy-cloudflare.mjs";
import { digestAccountId } from "./lib/cloudflare-usage-envelope.mjs";
import { dailyWindowFor, monthlyWindowFor } from "./lib/cloudflare-usage-collection.mjs";

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
function sealedSnapshotJson(accountId = "test-account", at = now) {
  const parsed = JSON.parse(admittedSnapshotJson(accountId, at));
  parsed.metrics.queue_ops = "unknown";
  return JSON.stringify(parsed);
}
const environment = { CLOUDFLARE_ACCOUNT_ID: "test-account", CLOUDFLARE_API_TOKEN: "secret-token",
  ELIOTR_ENVIRONMENT: "staging", ELIOTR_DEPLOYMENT_GENERATION: "git-test", ELIOTR_CUSTOM_DOMAIN: "1",
  ELIOTR_ACCESS_HOSTNAME: "research.example.com", ELIOTR_OWNER_EMAILS: "owner@example.com",
  ELIOTR_ACCESS_TEAM_DOMAIN: "https://team-example.cloudflareaccess.com", ELIOTR_ACCESS_AUDIENCE: "test-aud",
  ELIOTR_ACCESS_SERVICE_PRINCIPALS: "", ELIOTR_ACCESS_SMOKE_COOKIE: "secret-cookie" };
// Staged snapshots travel via the explicit `usageSnapshot` deploy option
// (test-called builder path), never ambient env: production never passes it.
const defaultUsageSnapshot = admittedSnapshotJson();
const config = { name: "eliotr-core", minify: true, preview_urls: false, compatibility_date: "2026-08-28",
  vars: { DEPLOYMENT_GENERATION: "git-test", ENVIRONMENT: "staging", ACCESS_TEAM_DOMAIN: "https://team-example.cloudflareaccess.com",
    ACCESS_AUDIENCE: "test-aud", ACCESS_SERVICE_PRINCIPALS: "" },
  d1_databases: [
    { binding: "CORE_DB", database_name: "eliotr-core", database_id: "11111111-1111-4111-8111-111111111111" },
    { binding: "SEARCH_DB", database_name: "eliotr-search", database_id: "22222222-2222-4222-8222-222222222222" },
  ] };
const bytes = Buffer.from(JSON.stringify(config));
function harness(overrides = {}) {
  const calls = [];
  const receipts = [];
  let reads = 0;
  const options = { confirmLive: true, verifyCode: async () => {}, environment, usageSnapshot: defaultUsageSnapshot, now: () => now, log: () => {},
    execute(command, args, cwd, env) {
      const name = `${command} ${args.join(" ")}`; calls.push(name);
      assert.equal(env.ELIOTR_DEPLOYMENT_GENERATION, "git-test");
      assert.equal(resolve(cwd), resolve(fileURLToPath(new URL("../", import.meta.url)),
        args.includes("--config") ? "apps/eliotr-core" : "."));
      if (name === overrides.failCommand) throw new Error("injected command failure");
    },
    archive: async () => { calls.push("archive"); },
    read: async () => { reads += 1; return overrides.driftAt === reads ? Buffer.from("{}") : bytes; },
    save: async (receipt) => { calls.push("save"); receipts.push(receipt); },
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
const searchMigration = "pnpm exec wrangler d1 migrations apply SEARCH_DB --remote --config wrangler.deploy.jsonc";

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
await check("config drift blocks the next release effect", async () => {
  for (const [driftAt, prohibited] of [[1, generatedDryRun], [2, coreMigration], [3, searchMigration], [4, deployCommand], [5, "save"]]) {
    const test = harness({ driftAt });
    await assert.rejects(deployCloudflare(test.options));
    assert.ok(!test.calls.includes(prohibited));
    assert.equal(test.receipts.length, 0);
  }
});
// FIX11: moved to test-deployment-apply-ordering.mjs (see above).
// FIX11: post-gate failure ordering (migration/deploy failure, readback
// failure after upload) moved to test-deployment-apply-ordering.mjs —
// reaching the upload requires passing the usage gate, which in-process
// test-only inputs can never do without a capability (see the
// admitted-without-capability check below). The redirected ordering suite
// covers those failures with the capability mechanics engaged.
await check("admitted snapshot without capability denies before archive and mutation", async () => {
  // FIX11: the staged ADMITTED snapshot below proves the evaluation premise,
  // but deploy apply additionally requires the same-process admission
  // capability (minted only by fresh live collection), so apply denies with
  // zero remote effects. Positive apply ordering moved to
  // test-deployment-apply-ordering.mjs, which runs under the test-only
  // --import gate where TEST capabilities authorize the fake-observed apply.
  const test = harness();
  await assert.rejects(deployCloudflare(test.options), /admission capability/u);
  assert.deepEqual(test.calls, ["pnpm check", "pnpm build:pwa", "pnpm --filter @eliotr/core cf:types",
    "pnpm --filter @eliotr/core deploy:dry-run"]);
  assert.ok(!test.calls.includes("archive"));
  assert.ok(!test.calls.some((call) => call.includes("d1 migrations apply")));
  assert.ok(!test.calls.some((call) => call.startsWith("GET ")));
  assert.equal(test.receipts.length, 0);
});
await check("missing cookie still denies on capability before smoke", async () => {
  const test = harness({ options: { environment: { ...environment, ELIOTR_ACCESS_SMOKE_COOKIE: undefined } } });
  await assert.rejects(deployCloudflare(test.options), /admission capability/u);
  assert.equal(test.calls.filter((call) => call.startsWith("GET ")).length, 0);
  assert.equal(test.receipts.length, 0);
});
await check("BLOCKED usage denies every remote mutation with zero billable calls", async () => {
  const over = JSON.parse(admittedSnapshotJson());
  over.metrics.queue_ops = 900_000;
  const test = harness({ options: { usageSnapshot: JSON.stringify(over) } });
  const billable = [];
  test.options.fetchImpl = async (url) => { billable.push(url); throw new Error("billable must not be invoked"); };
  await assert.rejects(deployCloudflare(test.options), /BLOCKED/);
  assert.ok(!test.calls.some((call) => call.includes("d1 migrations apply")));
  assert.ok(!test.calls.includes(deployCommand));
  assert.ok(!test.calls.some((call) => call.startsWith("GET ")));
  assert.equal(billable.length, 0);
  assert.equal(test.receipts.length, 0);
});
await check("SEALED usage denies Worker upload and D1 migrations (adversarial unknown)", async () => {
  const test = harness({ options: { usageSnapshot: sealedSnapshotJson() } });
  const billable = [];
  test.options.fetchImpl = async (url) => { billable.push(url); throw new Error("billable must not be invoked"); };
  await assert.rejects(deployCloudflare(test.options), /SEALED/);
  assert.ok(!test.calls.some((call) => call.includes("d1 migrations apply")));
  assert.ok(!test.calls.includes(deployCommand));
  assert.ok(!test.calls.some((call) => call.startsWith("GET ")));
  assert.equal(billable.length, 0);
  assert.equal(test.receipts.length, 0);
});
await check("access-first: access check precedes core apply and partial failure exposes no workers.dev", async () => {
  const test = harness({ failCommand: "node scripts/provision-cloudflare-access.mjs" });
  await assert.rejects(deployCloudflare(test.options));
  assert.ok(!test.calls.includes(deployCommand));
  assert.ok(!test.calls.some((call) => call.includes("d1 migrations apply")));
  assert.equal(test.receipts.length, 0);
});
console.log(`Deployment orchestration: ${cases} groups passed; live Cloudflare NOT_EXECUTED`);
