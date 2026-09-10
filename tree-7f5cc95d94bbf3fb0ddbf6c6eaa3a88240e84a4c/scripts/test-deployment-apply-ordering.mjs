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
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deployCloudflare } from "./deploy-cloudflare.mjs";
import { digestAccountId } from "./lib/cloudflare-usage-envelope.mjs";
import { dailyWindowFor, monthlyWindowFor } from "./lib/cloudflare-usage-collection.mjs";
import { stripNodeOptionsLoaderTokens } from "./lib/cloudflare-wrangler-oauth.mjs";

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
const environment = { CLOUDFLARE_ACCOUNT_ID: "test-account", CLOUDFLARE_API_TOKEN: "secret-token",
  ELIOTR_ENVIRONMENT: "staging", ELIOTR_DEPLOYMENT_GENERATION: "git-test", ELIOTR_CUSTOM_DOMAIN: "1",
  ELIOTR_ACCESS_HOSTNAME: "research.example.com", ELIOTR_OWNER_EMAILS: "owner@example.com",
  ELIOTR_ACCESS_TEAM_DOMAIN: "https://team-example.cloudflareaccess.com", ELIOTR_ACCESS_AUDIENCE: "test-aud",
  ELIOTR_ACCESS_SERVICE_PRINCIPALS: "", ELIOTR_ACCESS_SMOKE_COOKIE: "secret-cookie" };
// Staged snapshots travel via the explicit `usageSnapshot` deploy option
// (test-called builder path), never ambient env: production never passes it.
// Under this file's redirected child the standin additionally mints a TEST
// capability for the ADMITTED fixture, which is what authorizes the
// fake-observed apply below (production capabilities remain unmintable here).
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
  const provisionerEnvs = [];
  let reads = 0;
  const options = { confirmLive: true, verifyCode: async () => {}, environment, usageSnapshot: defaultUsageSnapshot, now: () => now, log: () => {},
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
  return { calls, receipts, provisionerEnvs, options };
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
  assert.equal(test.calls.filter((call) => call === deployCommand).length, 1);
  assert.ok(test.calls.indexOf(generatedDryRun) < test.calls.indexOf(coreMigration));
  assert.ok(test.calls.indexOf(coreMigration) < test.calls.indexOf(searchMigration));
  assert.ok(test.calls.indexOf(searchMigration) < test.calls.indexOf(deployCommand));
  assert.equal(test.calls.filter((call) => call.endsWith("--check-only")).length, 4);
  assert.ok(!test.calls.some((call) => call.includes("--keep-vars")));
  assert.ok(test.calls.indexOf("archive") < test.calls.indexOf("node scripts/provision-cloudflare-core.mjs"));
  assert.equal(receipt.remote_http_smoke.state, "PASS");
  assert.ok(Object.values(receipt.live_conformance).every((state) => state === "NOT_EXECUTED"));
  assert.equal(test.receipts.length, 1);
  assert.ok(!JSON.stringify(receipt).includes("secret-"));
  const schema = JSON.parse(await readFile(new URL("../infra/cloudflare/deployment-receipt.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(receipt).sort(), schema.required.slice().sort());
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
  assert.equal(test.calls.filter((call) => call.startsWith("GET ")).length, 1);
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

console.log(`Deployment apply ordering: ${cases} groups passed; live Cloudflare NOT_EXECUTED`);
