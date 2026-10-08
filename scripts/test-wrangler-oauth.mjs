// Wrangler browser-OAuth seam: credential resolution, fail-closed negatives,
// deploy wiring order, and bearer-redaction proof. No network, no Cloudflare
// writes; every credential source and whoami runner is injected.
import assert from "node:assert/strict";
import { deployCloudflare } from "./deploy-cloudflare.mjs";
import {
  API_TOKEN_MODE,
  injectOAuthBearer,
  loadWranglerOAuthCredential,
  LOGIN_INSTRUCTION,
  parseWranglerOAuthConfig,
  resolveAuthMode,
  resolveWranglerConfigCandidates,
  scrubTokenEnv,
  verifyWranglerOAuthAccount,
  WRANGLER_OAUTH_MODE,
} from "./lib/cloudflare-wrangler-oauth.mjs";
import {
  BILLABLE_LIVE_COVERS,
  collectAccountUsage,
  createAiSearchInventoryProvider,
  createBillableUsageProvider,
} from "./lib/cloudflare-usage-collection.mjs";
import {
  runUsagePreflight,
} from "./lib/cloudflare-usage-admission.mjs";

const BEARER = "oauth-test-bearer-VALID-0042";
const ACCOUNT = "test-account";
const NOW = Date.parse("2026-09-06T00:00:00.000Z");
const FUTURE = "2030-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

const validToml = (expiration = FUTURE) =>
  `# wrangler browser profile\n\noauth_token = "${BEARER}"\nrefresh_token = "oauth-test-refresh-009"\nexpiration_time = "${expiration}"\nscopes = ["account:read", "user:read"]\n`;

const baseEnvironment = {
  ELIOTR_CLOUDFLARE_AUTH_MODE: "wrangler-oauth",
  ELIOTR_WRANGLER_CONFIG_FILE: "wrangler-test-default.toml",
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  ELIOTR_ENVIRONMENT: "staging",
  ELIOTR_DEPLOYMENT_GENERATION: "git-test",
  ELIOTR_CUSTOM_DOMAIN: "1",
  ELIOTR_ACCESS_HOSTNAME: "research.example.com",
  ELIOTR_STAGING_TARGET_JSON: JSON.stringify({ protocol: "eliotr.staging-target.v1", isolation: "dedicated-account",
    account_id: ACCOUNT, protected_account_ids: ["production-test-account"], access_hostname: "research.example.com" }),
  ELIOTR_OWNER_EMAILS: "owner@example.com",
  ELIOTR_ACCESS_TEAM_DOMAIN: "https://team-example.cloudflareaccess.com",
  ELIOTR_ACCESS_AUDIENCE: "test-aud",
  ELIOTR_ACCESS_SERVICE_PRINCIPALS: "",
  ELIOTR_ACCESS_SMOKE_COOKIE: "secret-cookie",
};

const config = {
  name: "eliotr-core", minify: true, preview_urls: false, compatibility_date: "2026-08-28",
  vars: {
    DEPLOYMENT_GENERATION: "git-test", ENVIRONMENT: "staging",
    ACCESS_TEAM_DOMAIN: "https://team-example.cloudflareaccess.com", ACCESS_AUDIENCE: "test-aud",
    ACCESS_SERVICE_PRINCIPALS: "",
    GOOGLE_EXTERNAL_TRANSPORT: "disabled",
  },
  d1_databases: [
    { binding: "CORE_DB", database_name: "eliotr-core", database_id: "11111111-1111-4111-8111-111111111111", migrations_dir: "../../infra/d1/core/migrations" },
    { binding: "SEARCH_DB", database_name: "eliotr-search", database_id: "22222222-2222-4222-8222-222222222222", migrations_dir: "../../infra/d1/search/migrations" },
  ],
};
const configBytes = Buffer.from(JSON.stringify(config));

// Genuinely admitted usage evidence through the real collector/envelope: the
// real billing provider over fictional FOCUS v1.3 rows (complete
// month-start→today cover for every billing metric, triple-mapped, mirroring
// test-cloudflare-usage-billing.mjs) plus the real AI Search inventory
// provider for the exact instance count. Fictional account/bearer only; the
// bearer crosses provider calls in memory and is never persisted.
function admittedMetricMap() {
  const map = {};
  for (const key of BILLABLE_LIVE_COVERS) {
    map[`fictional_${key}:Fictional ${key}:FictionalUnits`] = key;
  }
  return map;
}

function admittedBillingRows() {
  const rows = [];
  for (const key of BILLABLE_LIVE_COVERS) {
    for (let day = 1; day <= 5; day += 1) {
      const pad = String(day).padStart(2, "0");
      const next = String(day + 1).padStart(2, "0");
      rows.push({
        BillingAccountId: ACCOUNT,
        BillingAccountName: "Fictional Account",
        ChargeCategory: "Usage",
        ChargeDescription: `Fictional ${key} daily usage`,
        ChargeFrequency: "Usage-Based",
        ChargePeriodStart: `2026-09-${pad}T00:00:00.000Z`,
        ChargePeriodEnd: `2026-09-${next}T00:00:00.000Z`,
        ConsumedQuantity: 1,
        ConsumedUnit: "FictionalUnits",
        x_BillableMetricId: `fictional_${key}`,
        x_BillableMetricName: `Fictional ${key}`,
      });
    }
  }
  return rows;
}

function admittedUsageProviders() {
  const billing = createBillableUsageProvider({
    group: "billable-usage",
    covers: [...BILLABLE_LIVE_COVERS],
    endpoint: (id, from, to) => `https://api.cloudflare.com/client/v4/accounts/${id}/billable/usage?from=${from}&to=${to}`,
    fetchImpl: async () => ({ status: 200, json: async () => ({ success: true, result: admittedBillingRows() }) }),
    metricMap: admittedMetricMap(),
  });
  const inventory = createAiSearchInventoryProvider({
    group: "ai-search-inventory-list",
    covers: ["ai_search_instances"],
    endpoint: (id, page, perPage) => `https://api.cloudflare.com/client/v4/accounts/${id}/ai-search/instances?page=${page}&per_page=${perPage}`,
    fetchImpl: async () => ({
      status: 200,
      json: async () => ({
        success: true,
        result: [1, 2, 3, 4, 5].map((n) => ({ id: `fictional-instance-${n}`, name: `fictional-${n}` })),
        result_info: { page: 1, per_page: 100, count: 5, total_count: 5, total_pages: 1 },
      }),
    }),
  });
  return [billing, inventory];
}

// API-token mode exposes no live aggregate by design, so its harness stages a
// snapshot produced by the real collector over the same providers above and
// evaluated by the real envelope at the gate (the established provisioner
// pattern, but collector-generated instead of hand-written).
async function admittedSnapshotJson() {
  const snapshot = await collectAccountUsage({
    bearer: BEARER,
    expectedAccountId: ACCOUNT,
    now: NOW,
    whoamiOutput: `Account ${ACCOUNT} via browser OAuth`,
    providers: admittedUsageProviders(),
    source: "test-fixture",
  });
  assert.ok(!JSON.stringify(snapshot).includes(BEARER), "staged snapshot leaks the bearer");
  return JSON.stringify(snapshot);
}

let cases = 0;
const check = async (name, action) => { await action(); cases += 1; console.log(`Wrangler OAuth: ${name}: PASS`); };
const noBearer = (value, label) => assert.ok(
  !JSON.stringify(value ?? "").includes(BEARER), `${label} leaks the bearer`);

// Deploys with fully injected seams; records argv, child-env tokens (memory
// only), logs, and receipts for redaction proof.
function deployHarness(overrides = {}) {
  const calls = [];
  const childTokens = [];
  const authenticatedTokens = [];
  const logs = [];
  const receipts = [];
  const options = {
    confirmLive: true,
    verifyCode: async () => {},
    environment: { ...baseEnvironment },
    now: () => NOW,
    log: (line) => { logs.push(String(line)); },
    execute(command, args, _cwd, env) { calls.push(`${command} ${args.join(" ")}`); childTokens.push(env?.CLOUDFLARE_API_TOKEN ?? null); },
    readWranglerFile: async () => validToml(),
    runWranglerWhoami: async () => { calls.push("whoami"); return `Account ${ACCOUNT} via browser OAuth`; },
    archive: async () => { calls.push("archive"); },
    read: async () => configBytes,
    save: async (receipt) => { calls.push("save"); receipts.push(receipt); },
    fetchImpl: async (url) => {
      calls.push(`GET ${url}`);
      if (url.endsWith("/workers/scripts")) {
        return globalThis.Response.json({ success: true, result: [{ id: "eliotr-core", compatibility_date: "2026-08-28", has_assets: true, exports: { ResearchSession: { type: "durable-object" } } }] });
      }
      if (url.endsWith("/healthz")) {
        return globalThis.Response.json({ ready: true, deployment_generation: "git-test", checked_at: new Date(NOW).toISOString() });
      }
      return globalThis.Response.json({ trace_id: "trace-test", deployment_generation: "git-test", data: { protocol: "eliotr.capabilities.v1", deployment_generation: "git-test", enabled_slices: ["HEALTH", "ACCESS"], disabled_slices: ["RESEARCH"], exact_evidence_resolution_required: true, transport_completion_is_research_completion: false, ingest_live_qualified: false } });
    },
    // Stop at the first authenticated deployment read. This isolates OAuth
    // refresh/bearer ordering from later Worker, D1, and deployment gates.
    readActiveWorker: async ({ env }) => {
      calls.push("authenticated-worker-read");
      authenticatedTokens.push(env?.CLOUDFLARE_API_TOKEN ?? null);
      throw new Error("fixture stopped at authenticated Worker read boundary");
    },
    ...overrides,
  };
  return { calls, childTokens, authenticatedTokens, logs, receipts, options };
}

const enoentRead = async () => { const error = new Error("missing"); error.code = "ENOENT"; throw error; };

await check("auth mode resolution fails closed on unknown values", () => {
  assert.equal(resolveAuthMode({}), API_TOKEN_MODE);
  assert.equal(resolveAuthMode({ ELIOTR_CLOUDFLARE_AUTH_MODE: "" }), API_TOKEN_MODE);
  assert.equal(resolveAuthMode({ ELIOTR_CLOUDFLARE_AUTH_MODE: "wrangler-oauth" }), WRANGLER_OAUTH_MODE);
  assert.equal(resolveAuthMode({ ELIOTR_CLOUDFLARE_AUTH_MODE: "api-token" }), API_TOKEN_MODE);
  assert.throws(() => resolveAuthMode({ ELIOTR_CLOUDFLARE_AUTH_MODE: "raw-wrangler" }), /Unknown ELIOTR_CLOUDFLARE_AUTH_MODE/);
});

await check("config location supports verified Windows default and profiles", () => {
  const windows = resolveWranglerConfigCandidates({ env: {}, platform: "win32", home: "C:\\Users\\t", appData: "C:\\Users\\t\\AppData\\Roaming" });
  const windowsPosix = windows.map((path) => path.replace(/\\/gu, "/"));
  assert.ok(windowsPosix[0].endsWith("xdg.config/.wrangler/config/default.toml"));
  assert.ok(windowsPosix[1].endsWith(".wrangler/config/default.toml"));
  const named = resolveWranglerConfigCandidates({ env: { ELIOTR_WRANGLER_PROFILE: "work" }, platform: "win32", home: "C:\\Users\\t", appData: "C:\\Users\\t\\AppData\\Roaming" });
  assert.ok(named[0].replace(/\\/gu, "/").endsWith("xdg.config/.wrangler/config/work.toml"));
  const unix = resolveWranglerConfigCandidates({ env: {}, platform: "linux", home: "/home/t" });
  const posix = unix.map((path) => path.replace(/\\/gu, "/"));
  assert.equal(posix[0], "/home/t/.config/.wrangler/config/default.toml");
  assert.equal(posix[1], "/home/t/.wrangler/config/default.toml");
  const windowsXdg = resolveWranglerConfigCandidates({ env: { XDG_CONFIG_HOME: "D:\\xdg" }, platform: "win32", appData: "C:\\ignored" });
  assert.equal(windowsXdg[0].replace(/\\/gu, "/"), "D:/xdg/.wrangler/config/default.toml");
  const explicit = resolveWranglerConfigCandidates({ env: { ELIOTR_WRANGLER_CONFIG_FILE: "/tmp/custom.toml" }, platform: "linux", home: "/home/t" });
  assert.deepEqual(explicit, ["/tmp/custom.toml"]);
  assert.throws(() => resolveWranglerConfigCandidates({ env: { ELIOTR_WRANGLER_PROFILE: "../evil" }, platform: "linux", home: "/home/t" }));
});

await check("profile parser accepts quoted and integer expirations", () => {
  assert.equal(parseWranglerOAuthConfig(validToml()).oauthToken, BEARER);
  assert.equal(parseWranglerOAuthConfig(`oauth_token = '${BEARER}'\nexpiration_time = 4102444800\n`).oauthToken, BEARER);
  assert.doesNotThrow(() => parseWranglerOAuthConfig(`oauth_token = "${BEARER}"\nexpiration_time = "${FUTURE}"\nscopes = ["account:read", 'user:read',]\n`));
  for (const bad of ["", "oauth_token = \n", "oauth_token = [x]\n", "[profile]\nnope"]) {
    assert.throws(() => parseWranglerOAuthConfig(bad), (error) => !String(error.message).includes(BEARER));
  }
  for (const bad of [
    `oauth_token = "${BEARER}"\nexpiration_time = "${FUTURE}"\nscopes = [x]\n`,
    `oauth_token = "${BEARER}"\nexpiration_time = "${FUTURE}"\nscopes = ["account:read"  "user:read"]\n`,
    `oauth_token = "${BEARER}"\nexpiration_time = "${FUTURE}"\nscopes = ["account:read", 7]\n`,
    `oauth_token = "${BEARER}"\nexpiration_time = "${FUTURE}"\nother = ["untrusted"]\n`,
  ]) {
    assert.throws(() => parseWranglerOAuthConfig(bad), (error) => !String(error.message).includes(BEARER));
  }
});

await check("loader fails closed on missing, expired, and undated profiles", async () => {
  const missing = await loadWranglerOAuthCredential({ env: {}, readFile: enoentRead, configPaths: ["/nope/default.toml"], now: NOW }).then(() => assert.fail("must throw"), (error) => error);
  assert.equal(missing.code, "OAUTH_UNAVAILABLE");
  assert.ok(missing.message.includes("wrangler login") && !missing.message.includes(BEARER));
  const expired = await loadWranglerOAuthCredential({ env: {}, readFile: async () => validToml(PAST), configPaths: ["/p"], now: NOW }).then(() => assert.fail("must throw"), (error) => error);
  assert.equal(expired.code, "OAUTH_EXPIRED");
  assert.ok(expired.message.includes("wrangler login") && !expired.message.includes(BEARER));
  const undated = await loadWranglerOAuthCredential({ env: {}, readFile: async () => `oauth_token = "${BEARER}"\n`, configPaths: ["/p"], now: NOW }).then(() => assert.fail("must throw"), (error) => error);
  assert.equal(undated.code, "OAUTH_EXPIRED");
  const ok = await loadWranglerOAuthCredential({ env: {}, readFile: async () => validToml(), configPaths: ["/p"], now: NOW });
  assert.equal(ok.bearer, BEARER);
});

await check("account verification pins the official profile to the deployment account", async () => {
  assert.deepEqual(await verifyWranglerOAuthAccount({ expectedAccountId: ACCOUNT, getWhoamiOutput: async () => `id ${ACCOUNT} ok` }), { accountId: ACCOUNT });
  for (const output of ["another account only", "", null]) {
    const error = await verifyWranglerOAuthAccount({ expectedAccountId: ACCOUNT, getWhoamiOutput: async () => output }).then(() => assert.fail("must throw"), (error) => error);
    assert.equal(error.code, "OAUTH_ACCOUNT_MISMATCH");
    assert.ok(error.message.includes("wrangler login") && !String(error.message).includes(BEARER));
  }
  const failed = await verifyWranglerOAuthAccount({ expectedAccountId: ACCOUNT, getWhoamiOutput: async () => { throw new Error("boom"); } }).then(() => assert.fail("must throw"), (error) => error);
  assert.equal(failed.code, "OAUTH_UNAVAILABLE");
});

await check("account verification rejects unrelated-text and ambiguity structurally", async () => {
  // Wrong-account output that mentions the expected ID in unrelated text is
  // not THE active account: exact active-identifier equality is required.
  for (const output of [
    `Account other-account via browser OAuth (note ${ACCOUNT} seen elsewhere)`,
    `account other-account active; ${ACCOUNT} in unrelated text`,
    `Account ${ACCOUNT}-suffix via browser OAuth`,
    `Account prefix-${ACCOUNT} via browser OAuth`,
    `Account ${ACCOUNT} via browser OAuth\nAccount other-account via browser OAuth`,
  ]) {
    const error = await verifyWranglerOAuthAccount({ expectedAccountId: ACCOUNT, getWhoamiOutput: async () => output }).then(() => assert.fail("must throw"), (error) => error);
    assert.equal(error.code, "OAUTH_ACCOUNT_MISMATCH");
  }
  // The strict contract still accepts every documented active shape.
  for (const output of [
    `Account ${ACCOUNT} via browser OAuth`,
    `account ${ACCOUNT} active`,
    `id ${ACCOUNT} ok`,
  ]) {
    assert.deepEqual(await verifyWranglerOAuthAccount({ expectedAccountId: ACCOUNT, getWhoamiOutput: async () => output }), { accountId: ACCOUNT });
  }
});

await check("OAuth preflight verifies the profile before loading credentials or evaluating a snapshot", async () => {
  // A staged ADMITTED snapshot cannot bypass identity checks. The official
  // whoami runs first so it can refresh the profile; only then is the cached
  // bearer read and the explicit test snapshot evaluated. Ambient
  // ELIOTR_TEST_USAGE_SNAPSHOT_JSON remains ignored.
  const staged = await admittedSnapshotJson();
  const missingOrder = [];
  const result = await runUsagePreflight({
    env: {
      ELIOTR_CLOUDFLARE_AUTH_MODE: "wrangler-oauth",
      ELIOTR_WRANGLER_CONFIG_FILE: "wrangler-test-default.toml",
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    },
    nowMs: NOW,
    readFile: async () => { missingOrder.push("credential"); throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    getWhoamiOutput: async () => { missingOrder.push("whoami"); return `Account ${ACCOUNT} via browser OAuth`; },
    providers: admittedUsageProviders(),
    snapshot: staged,
  }).then(() => assert.fail("must throw on missing credential"), (error) => error);
  assert.ok(["OAUTH_UNAVAILABLE", "OAUTH_EXPIRED"].includes(result.code), `unexpected code ${result.code}`);
  assert.deepEqual(missingOrder, ["whoami", "credential"], "whoami must have a chance to refresh before the profile read");
  // A wrong account is rejected before the credential is loaded or the staged
  // snapshot is evaluated.
  let wrongCredentialReads = 0;
  const wrong = await runUsagePreflight({
    env: {
      ELIOTR_CLOUDFLARE_AUTH_MODE: "wrangler-oauth",
      ELIOTR_WRANGLER_CONFIG_FILE: "wrangler-test-default.toml",
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    },
    nowMs: NOW,
    readFile: async () => { wrongCredentialReads += 1; return validToml(); },
    getWhoamiOutput: async () => "Account other-account via browser OAuth",
    providers: admittedUsageProviders(),
    snapshot: staged,
  }).then(() => assert.fail("must throw on wrong account"), (error) => error);
  assert.equal(wrong.code, "OAUTH_ACCOUNT_MISMATCH");
  assert.equal(wrongCredentialReads, 0);

  let refreshedProfile = validToml(PAST);
  const refreshOrder = [];
  const refreshed = await runUsagePreflight({
    env: {
      ELIOTR_CLOUDFLARE_AUTH_MODE: "wrangler-oauth",
      ELIOTR_WRANGLER_CONFIG_FILE: "wrangler-test-default.toml",
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    },
    nowMs: NOW,
    readFile: async () => { refreshOrder.push("credential"); return refreshedProfile; },
    getWhoamiOutput: async () => {
      refreshOrder.push("whoami");
      refreshedProfile = validToml();
      return `Account ${ACCOUNT} via browser OAuth`;
    },
    providers: admittedUsageProviders(),
    snapshot: staged,
  });
  assert.deepEqual(refreshOrder, ["whoami", "credential"]);
  assert.equal(refreshed.decision, "ADMITTED");
  assert.equal(refreshed.capability, null, "an injected snapshot never mints live authority");
});

await check("OAuth omission selects inventory and diagnostic sources without restricted billing", async () => {
  const previousFetch = globalThis.fetch;
  const seen = [];
  const liveAccountId = "cccccccccccccccccccccccccccccccc";
  const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
  globalThis.fetch = async (url, init = {}) => {
    seen.push(url);
    if (url.includes("/d1/database/")) {
      return jsonResponse({ success: true, errors: [], messages: [], result: { uuid: "d1-one", file_size: 8192 } });
    }
    if (url.includes("/d1/database")) {
      return jsonResponse({ success: true, errors: [], messages: [], result: [{ uuid: "d1-one" }], result_info: { page: 1, per_page: 100, count: 1, total_count: 1 } });
    }
    if (url.includes("/r2/buckets")) {
      return jsonResponse({ success: true, errors: [], messages: [], result: { buckets: [{ name: "r2-one" }] } });
    }
    if (url.includes("/queues")) {
      return jsonResponse({ success: true, errors: [], messages: [], result: [{ queue_id: "queue-one", queue_name: "eliotr-jobs" }], result_info: { page: 1, per_page: 100, count: 1, total_count: 1, total_pages: 1 } });
    }
    if (url.includes("/ai-search/instances")) {
      return jsonResponse({ success: true, errors: [], messages: [], result: [], result_info: { page: 1, per_page: 100, count: 0, total_count: 0, total_pages: 1 } });
    }
    if (url.includes("/graphql")) {
      const query = JSON.parse(init.body).query;
      const datasets = [
        "workersInvocationsAdaptive",
        "d1AnalyticsAdaptiveGroups",
        "queueMessageOperationsAdaptiveGroups",
        "durableObjectsInvocationsAdaptiveGroups",
      ];
      const dataset = datasets.find((name) => query.includes(name));
      assert.ok(dataset, "unexpected GraphQL dataset");
      return jsonResponse({ data: { viewer: { accounts: [{ accountTag: liveAccountId, [dataset]: [] }] } } });
    }
    if (url.includes("/billable/usage")) {
      return jsonResponse({}, 403);
    }
    throw new Error("unexpected preflight URL");
  };
  try {
    const gate = await runUsagePreflight({
      env: { ...baseEnvironment, CLOUDFLARE_ACCOUNT_ID: liveAccountId },
      nowMs: NOW,
      readFile: async () => validToml(),
      getWhoamiOutput: async () => `Account ${liveAccountId} via browser OAuth`,
    });
    assert.equal(gate.decision, "SEALED");
    assert.equal(gate.capability, null);
    assert.equal(gate.evaluation.unknown.length, 18);
    assert.deepEqual(gate.snapshot.readback.provider_results.map((entry) => entry.group), [
      "d1-inventory-list",
      "d1-storage-diagnostic",
      "workers-requests-diagnostic",
      "d1-rows-diagnostic",
      "queue-ops-diagnostic",
      "do-requests-diagnostic",
      "r2-inventory-list",
      "queue-inventory-list",
      "ai-search-inventory-list",
    ]);
    assert.equal(gate.snapshot.metrics.ai_search_instances, 0);
    assert.ok(gate.snapshot.readback.provider_results.find((entry) => entry.group === "queue-inventory-list")?.inventory_count === 1);
    assert.deepEqual(gate.snapshot.readback.provider_results.find((entry) => entry.group === "d1-storage-diagnostic")?.diagnostic_values, { d1_storage_bytes: 8192 });
    assert.deepEqual(gate.snapshot.readback.provider_errors, [
      "d1-storage-diagnostic analytics samples are diagnostic-only, never billing authority",
    ]);
    for (const key of ["d1_storage_bytes", "workers_requests", "d1_rows_read", "d1_rows_written", "queue_ops", "do_requests"]) {
      assert.equal(gate.snapshot.metrics[key], "unknown", `${key} diagnostics must not become billing counters`);
    }
    assert.ok(!gate.snapshot.readback.provider_errors.some((line) => line.includes("authority brand without provenance")));
    assert.ok(seen.some((url) => url.includes("/queues?page=1&per_page=100")));
    assert.equal(seen.filter((url) => url.includes("/graphql")).length, 4);
    assert.ok(!seen.some((url) => url.includes("/billable/usage")), "restricted billable usage endpoint must remain unused");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

await check("poisoned env alone never admits (no explicit snapshot)", async () => {
  // Static token plus poisoned ELIOTR_TEST_* with throwing seams must seal,
  // never admit: ambient env cannot select fixture evaluation.
  const staged = await admittedSnapshotJson();
  const gate = await runUsagePreflight({
    env: {
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      CLOUDFLARE_API_TOKEN: "static-token",
      ELIOTR_TEST_USAGE_SNAPSHOT_JSON: staged,
      ELIOTR_TEST_WRANGLER_WHOAMI_OUTPUT: `Account ${ACCOUNT} via browser OAuth`,
    },
    nowMs: NOW,
    readFile: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    getWhoamiOutput: async () => assert.fail("whoami must not run in api-token mode"),
    providers: [],
  });
  assert.equal(gate.decision, "SEALED");
});

await check("bearer injection stays in child env memory, verification env stays scrubbed", () => {
  const injected = injectOAuthBearer({ A: "1" }, BEARER);
  assert.equal(injected.CLOUDFLARE_API_TOKEN, BEARER);
  const scrubbed = scrubTokenEnv({ ...injected, CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
  assert.equal(scrubbed.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(scrubbed.CLOUDFLARE_ACCOUNT_ID, ACCOUNT);
});

await check("test-only providers admit evaluation without minting live capability", async () => {
  const gate = await runUsagePreflight({
    env: { ...baseEnvironment },
    nowMs: NOW,
    readFile: async () => validToml(),
    getWhoamiOutput: async () => `Account ${ACCOUNT} via browser OAuth`,
    providers: admittedUsageProviders(),
  });
  assert.equal(gate.decision, "ADMITTED");
  assert.deepEqual(gate.evaluation.unknown, []);
  assert.equal(gate.capability, null);
  noBearer(gate.receipt, "test-only receipt");
});

await check("empty provider preflight seals with unknown counters and no capability", async () => {
  const gate = await runUsagePreflight({
    env: { ...baseEnvironment },
    nowMs: NOW,
    readFile: async () => validToml(),
    getWhoamiOutput: async () => `Account ${ACCOUNT} via browser OAuth`,
    providers: [],
  });
  assert.equal(gate.decision, "SEALED");
  assert.equal(gate.capability, null);
  assert.ok(gate.evaluation.unknown.length > 0);
  assert.ok(gate.evaluation.reasons.some((reason) => reason.includes("no authoritative aggregate for:")));
  assert.deepEqual(gate.snapshot.readback.provider_results, []);
  noBearer(gate.receipt, "empty-provider receipt");
});

await check("expired oauth remains fail-closed after the late whoami refresh opportunity", async () => {
  const test = deployHarness({ readWranglerFile: async () => validToml(PAST) });
  const error = await deployCloudflare(test.options).then(() => assert.fail("must throw"), (error) => error);
  assert.equal(error.code, "OAUTH_EXPIRED");
  assert.ok(test.calls.includes("pnpm check") && test.calls.includes("whoami"), "local gates and profile verification must precede bearer load");
  assert.ok(!test.calls.some((call) => call.startsWith("GET ")), "expired profile reached an authenticated API read");
  assert.ok(!test.calls.includes("archive") && !test.calls.includes("save"));
  assert.equal(test.calls.includes("authenticated-worker-read"), false);
  assert.ok(test.childTokens.length > 0 && test.childTokens.every((token) => token === null), "local children received a bearer before OAuth verification");
  assert.deepEqual(test.authenticatedTokens, []);
  assert.equal(test.receipts.length, 0);
  noBearer(error.message, "error");
});

await check("missing profile fails after scrubbed account verification without an API request", async () => {
  const test = deployHarness({ readWranglerFile: enoentRead });
  const error = await deployCloudflare(test.options).then(() => assert.fail("must throw"), (error) => error);
  assert.equal(error.code, "OAUTH_UNAVAILABLE");
  assert.ok(test.calls.includes("pnpm check") && test.calls.includes("whoami"));
  assert.ok(!test.calls.some((call) => call.startsWith("GET ")));
  assert.ok(!test.calls.includes("archive") && !test.calls.includes("save"));
  assert.equal(test.calls.includes("authenticated-worker-read"), false);
  assert.ok(test.childTokens.length > 0 && test.childTokens.every((token) => token === null), "local children received a bearer before OAuth verification");
  assert.deepEqual(test.authenticatedTokens, []);
  assert.equal(test.receipts.length, 0);
  noBearer(error.message, "error");
});

await check("late official whoami refreshes an expired cached profile before deploy loads its bearer", async () => {
  let profile = validToml(PAST);
  const authOrder = [];
  let test;
  test = deployHarness({
    readWranglerFile: async () => { authOrder.push("credential"); return profile; },
    runWranglerWhoami: async () => {
      authOrder.push("whoami");
      test.calls.push("whoami");
      profile = validToml();
      return `Account ${ACCOUNT} via browser OAuth`;
    },
  });
  const error = await deployCloudflare(test.options).then(() => assert.fail("authenticated read boundary should stop the fixture"), (error) => error);
  assert.deepEqual(authOrder.slice(0, 2), ["whoami", "credential"]);
  assert.equal(profile, validToml());
  assert.equal(error.message, "fixture stopped at authenticated Worker read boundary");
  assert.deepEqual(test.authenticatedTokens, [BEARER], "the first authenticated read must receive the refreshed bearer");
  assert.ok(test.calls.indexOf("whoami") > test.calls.indexOf("pnpm check"), "all local gates must precede the late whoami call");
  assert.ok(test.childTokens.length > 0 && test.childTokens.every((token) => token === null), "local children received a bearer before OAuth verification");
  assert.ok(!test.calls.includes("archive") && !test.calls.includes("save"));
  assert.ok(!test.calls.some((call) => call.startsWith("node scripts/provision")));
  assert.ok(!test.calls.some((call) => call.includes("d1 migrations apply")));
  assert.ok(!test.calls.some((call) => call.startsWith("pnpm exec wrangler deploy")));
  assert.equal(test.receipts.length, 0);
  noBearer(test.calls, "argv");
  noBearer(error.message, "error");
});

await check("wrong profile account fails after gates but before archive and mutation", async () => {
  const test = deployHarness({ runWranglerWhoami: async () => { test.calls.push("whoami"); return "Account other-account"; } });
  const error = await deployCloudflare(test.options).then(() => assert.fail("must throw"), (error) => error);
  assert.equal(error.code, "OAUTH_ACCOUNT_MISMATCH");
  assert.ok(test.calls.includes("pnpm check") && test.calls.includes("whoami"));
  assert.ok(!test.calls.includes("archive"));
  assert.ok(!test.calls.some((call) => call.startsWith("node scripts/provision")));
  assert.ok(!test.calls.some((call) => call.startsWith("GET ")));
  assert.equal(test.calls.includes("authenticated-worker-read"), false);
  assert.ok(test.childTokens.length > 0 && test.childTokens.every((token) => token === null), "local children received a bearer before OAuth verification");
  assert.deepEqual(test.authenticatedTokens, []);
  assert.equal(test.receipts.length, 0);
  noBearer(test.calls, "argv");
  noBearer(error.message, "error");
});

await check("staged snapshot admits evaluation without a production capability", async () => {
  // The snapshot is produced by the real collector over test-only providers,
  // then evaluated through the explicit snapshot seam. It never mints a
  // same-process live collection capability.
  const staged = await admittedSnapshotJson();
  noBearer(staged, "staged snapshot");
  const environment = { ...baseEnvironment, ELIOTR_CLOUDFLARE_AUTH_MODE: undefined, CLOUDFLARE_API_TOKEN: "secret-token" };
  const gate = await runUsagePreflight({ env: environment, nowMs: NOW, providers: admittedUsageProviders(),
    getWhoamiOutput: async () => assert.fail("whoami must not run in API-token mode"), snapshot: staged });
  assert.equal(gate.decision, "ADMITTED");
  assert.deepEqual(gate.evaluation.unknown, []);
  assert.equal(gate.capability, null);
  noBearer(gate.receipt, "staged-snapshot receipt");
});

await check("dry run never touches credentials or the network", async () => {
  const test = deployHarness();
  test.options.confirmLive = false;
  test.options.environment = { ELIOTR_CLOUDFLARE_AUTH_MODE: "wrangler-oauth" };
  test.options.readWranglerFile = async () => assert.fail("credential read must not run on dry run");
  test.options.runWranglerWhoami = async () => assert.fail("whoami must not run on dry run");
  assert.equal(await deployCloudflare(test.options), null);
  assert.ok(test.calls.includes("pnpm check") && !test.calls.includes("whoami"));
  assert.equal(test.receipts.length, 0);
});

assert.ok(LOGIN_INSTRUCTION.includes("wrangler login"));
console.log(`Wrangler OAuth seam: ${cases} groups passed; live Cloudflare NOT_EXECUTED`);
