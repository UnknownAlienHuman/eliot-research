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
  runUsagePreflight,
} from "./lib/cloudflare-usage-collection.mjs";

const BEARER = "oauth-test-bearer-VALID-0042";
const ACCOUNT = "test-account";
const NOW = Date.parse("2026-09-06T00:00:00.000Z");
const FUTURE = "2030-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

const validToml = (expiration = FUTURE) =>
  `# wrangler browser profile\n\noauth_token = "${BEARER}"\nrefresh_token = "oauth-test-refresh-009"\nexpiration_time = "${expiration}"\n`;

const baseEnvironment = {
  ELIOTR_CLOUDFLARE_AUTH_MODE: "wrangler-oauth",
  ELIOTR_WRANGLER_CONFIG_FILE: "wrangler-test-default.toml",
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  ELIOTR_ENVIRONMENT: "staging",
  ELIOTR_DEPLOYMENT_GENERATION: "git-test",
  ELIOTR_CUSTOM_DOMAIN: "1",
  ELIOTR_ACCESS_HOSTNAME: "research.example.com",
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
  },
  d1_databases: [
    { binding: "CORE_DB", database_name: "eliotr-core", database_id: "11111111-1111-4111-8111-111111111111" },
    { binding: "SEARCH_DB", database_name: "eliotr-search", database_id: "22222222-2222-4222-8222-222222222222" },
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
    // Injected usage evidence for the preflight seam; SEALED-negative tests
    // override with [] to prove the fail-closed default is intact.
    usageProviders: admittedUsageProviders(),
    ...overrides,
  };
  return { calls, childTokens, logs, receipts, options };
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
  const windows = resolveWranglerConfigCandidates({ env: {}, platform: "win32", appData: "C:\\Users\\t\\AppData\\Roaming" });
  assert.equal(windows.length, 1);
  assert.ok(windows[0].startsWith("C:\\Users\\t\\AppData\\Roaming"));
  assert.ok(windows[0].includes("wrangler") && windows[0].endsWith("default.toml"));
  const named = resolveWranglerConfigCandidates({ env: { ELIOTR_WRANGLER_PROFILE: "work" }, platform: "win32", appData: "C:\\Users\\t\\AppData\\Roaming" });
  assert.ok(named[0].endsWith("work.toml"));
  const unix = resolveWranglerConfigCandidates({ env: {}, platform: "linux", home: "/home/t" });
  const posix = unix.map((path) => path.replace(/\\/gu, "/"));
  assert.ok(posix[0].includes("/home/t/.config/wrangler/config/default.toml"));
  assert.ok(posix.some((path) => path.includes("/home/t/.wrangler/config/default.toml")));
  const explicit = resolveWranglerConfigCandidates({ env: { ELIOTR_WRANGLER_CONFIG_FILE: "/tmp/custom.toml" }, platform: "linux", home: "/home/t" });
  assert.deepEqual(explicit, ["/tmp/custom.toml"]);
  assert.throws(() => resolveWranglerConfigCandidates({ env: { ELIOTR_WRANGLER_PROFILE: "../evil" }, platform: "linux", home: "/home/t" }));
});

await check("profile parser accepts quoted and integer expirations", () => {
  assert.equal(parseWranglerOAuthConfig(validToml()).oauthToken, BEARER);
  assert.equal(parseWranglerOAuthConfig(`oauth_token = '${BEARER}'\nexpiration_time = 4102444800\n`).oauthToken, BEARER);
  for (const bad of ["", "oauth_token = \n", "oauth_token = [x]\n", "[profile]\nnope"]) {
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

await check("env snapshot never precedes identity verification in oauth mode", async () => {
  // Manager repro: the fixture path consumed ELIOTR_TEST_USAGE_SNAPSHOT_JSON
  // before any credential read or whoami. The gate must verify identity
  // FIRST even when a snapshot is staged: zero reads/verifications is a
  // bypass. Here a valid staged ADMITTED snapshot is supplied in oauth mode
  // with failing seams — the run must fail closed on identity, never admit.
  const staged = await admittedSnapshotJson();
  let credReads = 0;
  let whoamiCalls = 0;
  const result = await runUsagePreflight({
    env: {
      ELIOTR_CLOUDFLARE_AUTH_MODE: "wrangler-oauth",
      ELIOTR_WRANGLER_CONFIG_FILE: "wrangler-test-default.toml",
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      ELIOTR_TEST_USAGE_SNAPSHOT_JSON: staged,
    },
    nowMs: NOW,
    readFile: async () => { credReads += 1; throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    getWhoamiOutput: async () => { whoamiCalls += 1; return `Account ${ACCOUNT} via browser OAuth`; },
    providers: admittedUsageProviders(),
  }).then(() => assert.fail("must throw on missing credential"), (error) => error);
  assert.ok(["OAUTH_UNAVAILABLE", "OAUTH_EXPIRED"].includes(result.code), `unexpected code ${result.code}`);
  assert.equal(credReads, 1);
  assert.equal(whoamiCalls, 0);
  // And with a readable credential but a wrong-account whoami, the staged
  // snapshot must still not admit: verification precedes evaluation.
  const wrong = await runUsagePreflight({
    env: {
      ELIOTR_CLOUDFLARE_AUTH_MODE: "wrangler-oauth",
      ELIOTR_WRANGLER_CONFIG_FILE: "wrangler-test-default.toml",
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      ELIOTR_TEST_USAGE_SNAPSHOT_JSON: staged,
    },
    nowMs: NOW,
    readFile: async () => validToml(),
    getWhoamiOutput: async () => "Account other-account via browser OAuth",
    providers: admittedUsageProviders(),
  }).then(() => assert.fail("must throw on wrong account"), (error) => error);
  assert.equal(wrong.code, "OAUTH_ACCOUNT_MISMATCH");
});

await check("bearer injection stays in child env memory, verification env stays scrubbed", () => {
  const injected = injectOAuthBearer({ A: "1" }, BEARER);
  assert.equal(injected.CLOUDFLARE_API_TOKEN, BEARER);
  const scrubbed = scrubTokenEnv({ ...injected, CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
  assert.equal(scrubbed.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(scrubbed.CLOUDFLARE_ACCOUNT_ID, ACCOUNT);
});

await check("oauth happy path keeps gate order and bearer out of argv/logs/receipts", async () => {
  const test = deployHarness();
  // Explicit decision proof through the real gate, not merely non-throw.
  // Fresh lambdas mirror the harness seams without recording calls, so the
  // gate-order assertions below observe only the deploy path.
  const gate = await runUsagePreflight({
    env: { ...test.options.environment },
    nowMs: NOW,
    readFile: async () => validToml(),
    getWhoamiOutput: async () => `Account ${ACCOUNT} via browser OAuth`,
    providers: admittedUsageProviders(),
  });
  assert.equal(gate.decision, "ADMITTED");
  assert.deepEqual(gate.evaluation.unknown, []);
  const receipt = await deployCloudflare(test.options);
  assert.ok(receipt.deployment_generation === "git-test");
  assert.ok(test.childTokens.length > 0 && test.childTokens.every((token) => token === BEARER));
  assert.ok(test.calls.indexOf("pnpm check") < test.calls.indexOf("whoami"));
  assert.ok(test.calls.indexOf("whoami") < test.calls.indexOf("node scripts/provision-cloudflare-core.mjs --check-only"));
  assert.ok(test.calls.indexOf("archive") < test.calls.indexOf("node scripts/provision-cloudflare-core.mjs"));
  assert.ok(test.calls.includes("save"));
  noBearer(test.calls, "argv");
  noBearer(test.logs, "logs");
  noBearer(test.receipts, "receipts");
  noBearer(process.argv, "process argv");
});

await check("sealed zero-provider preflight denies before archive and mutation", async () => {
  const test = deployHarness({ usageProviders: [] });
  const error = await deployCloudflare(test.options).then(() => assert.fail("must throw"), (error) => error);
  assert.match(error.message, /SEALED/);
  assert.match(error.message, /Zero billable bindings/);
  assert.ok(test.calls.includes("pnpm check") && test.calls.includes("whoami"));
  assert.ok(!test.calls.includes("archive"), "sealed path archived a receipt");
  assert.ok(!test.calls.includes("save"), "sealed path saved a receipt");
  assert.ok(!test.calls.some((call) => call.startsWith("node scripts/provision")), "sealed path ran a provisioner");
  assert.ok(!test.calls.some((call) => call.startsWith("GET ")), "sealed path made a remote call");
  assert.equal(test.receipts.length, 0);
  noBearer(error.message, "error");
});

await check("expired oauth blocks before any local gate or mutation", async () => {
  const test = deployHarness({ readWranglerFile: async () => validToml(PAST) });
  const error = await deployCloudflare(test.options).then(() => assert.fail("must throw"), (error) => error);
  assert.equal(error.code, "OAUTH_EXPIRED");
  assert.deepEqual(test.calls, []);
  assert.equal(test.receipts.length, 0);
  noBearer(error.message, "error");
});

await check("missing profile means no-auth-no-mutation", async () => {
  const test = deployHarness({ readWranglerFile: enoentRead });
  const error = await deployCloudflare(test.options).then(() => assert.fail("must throw"), (error) => error);
  assert.equal(error.code, "OAUTH_UNAVAILABLE");
  assert.deepEqual(test.calls, []);
  assert.equal(test.receipts.length, 0);
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
  assert.equal(test.receipts.length, 0);
  noBearer(test.calls, "argv");
  noBearer(error.message, "error");
});

await check("api-token mode stays compatible for CI without whoami", async () => {
  // Staged admission: the snapshot below was produced by the real collector
  // over the same FOCUS/inventory providers, so the gate evaluates a
  // genuinely admitted aggregate through the real envelope. usageProviders
  // are still supplied (forwarded, unused in api-token mode by design).
  const staged = await admittedSnapshotJson();
  noBearer(staged, "staged snapshot");
  const test = deployHarness({
    environment: {
      ...baseEnvironment,
      ELIOTR_CLOUDFLARE_AUTH_MODE: undefined,
      CLOUDFLARE_API_TOKEN: "secret-token",
      ELIOTR_TEST_USAGE_SNAPSHOT_JSON: staged,
    },
    runWranglerWhoami: async () => assert.fail("whoami must not run in api-token mode"),
  });
  const gate = await runUsagePreflight({ env: { ...test.options.environment }, nowMs: NOW, providers: test.options.usageProviders });
  assert.equal(gate.decision, "ADMITTED");
  assert.deepEqual(gate.evaluation.unknown, []);
  const receipt = await deployCloudflare(test.options);
  assert.ok(receipt.deployment_generation === "git-test");
  assert.ok(test.childTokens.every((token) => token === "secret-token"));
  assert.ok(!test.calls.includes("whoami"));
  assert.ok(test.calls.includes("save"));
  noBearer(test.receipts, "receipts");
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
