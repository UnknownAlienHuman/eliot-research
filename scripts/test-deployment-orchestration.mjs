import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deployCloudflare } from "./deploy-cloudflare.mjs";

const now = Date.parse("2026-09-04T23:00:00.000Z");
const environment = { CLOUDFLARE_ACCOUNT_ID: "test-account", CLOUDFLARE_API_TOKEN: "secret-token",
  ELIOTR_ENVIRONMENT: "staging", ELIOTR_DEPLOYMENT_GENERATION: "git-test", ELIOTR_CUSTOM_DOMAIN: "1",
  ELIOTR_ACCESS_HOSTNAME: "research.example.com", ELIOTR_OWNER_EMAILS: "owner@example.com",
  ELIOTR_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com", ELIOTR_ACCESS_AUDIENCE: "test-aud",
  ELIOTR_ACCESS_SERVICE_PRINCIPALS: "", ELIOTR_ACCESS_SMOKE_COOKIE: "secret-cookie" };
const config = { name: "eliotr-core", minify: true, preview_urls: false, compatibility_date: "2026-08-28",
  vars: { DEPLOYMENT_GENERATION: "git-test", ENVIRONMENT: "staging", ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
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
  const options = { confirmLive: true, verifyCode: async () => {}, environment, now: () => now, log: () => {},
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
await check("missing cookie retains NOT_EXECUTED", async () => {
  const test = harness({ options: { environment: { ...environment, ELIOTR_ACCESS_SMOKE_COOKIE: undefined } } });
  const receipt = await deployCloudflare(test.options);
  assert.equal(receipt.remote_http_smoke.state, "NOT_EXECUTED");
  assert.equal(test.calls.filter((call) => call.startsWith("GET ")).length, 1);
});
console.log(`Deployment orchestration: ${cases} groups passed; live Cloudflare NOT_EXECUTED`);
