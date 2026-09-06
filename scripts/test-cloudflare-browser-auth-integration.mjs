// Browser-OAuth integration coverage for the Cloudflare Access/foundation seam.
//
// Fills the REMAINING gaps after Writers A/B/C and the existing provisioner
// suite (all mocked; no live Cloudflare writes, no network beyond localhost):
//   inherited (not re-proven here): operator-profile validation (A),
//     wrangler-oauth seam at deploy level incl. bearer redaction (B),
//     foundation create/idempotency, undeclared extra Access policy,
//     immutable AI Search drift (scripts/test-cloudflare-provisioners.mjs).
//   filled here: empty-account first deploy (CREATE plan without invented AUD,
//     core refuses foundation mutations until the Access provisioner runs),
//     existing exact app replay, lost-ACK reconciliation, AUD propagation into
//     generated config, team-domain reconciliation, wrong/duplicate app
//     rejection, receipt-drift policy broadening, provisioner-level
//     no-auth-no-mutation, bearer-via-env-only redaction, expired-OAuth bridge.
//
// The bearer travels ONLY via child-process env (in-memory injection). Every
// case asserts it is absent from argv, stdout, stderr, and persisted receipts,
// while the mock asserts the Authorization header WAS received.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAccessRuntimeConfiguration } from "./lib/access-runtime-config.mjs";
import { loadWranglerOAuthCredential } from "./lib/cloudflare-wrangler-oauth.mjs";
import { digestAccountId, REQUIRED_METRIC_KEYS } from "./lib/cloudflare-usage-envelope.mjs";
import { dailyWindowFor, monthlyWindowFor } from "./lib/cloudflare-usage-collection.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BEARER = "browser-oauth-int-bearer-7f3a9c2e";
const ACCOUNT = "browser-int-account";
const OTHER_ACCOUNT = "browser-int-other-account";
const HOSTNAME = "eliotr-core.int-test-example.workers.dev";
const OWNER = "owner@int-test.example";
const TEAM = "https://int-test-example.cloudflareaccess.com";
const OTHER_TEAM = "https://other-team-example.cloudflareaccess.com";
const APP_NAME = `Eliot Research: ${HOSTNAME}`;
const generatedConfigPath = resolve(repositoryRoot, "apps/eliotr-core/wrangler.deploy.jsonc");
const stateDirectory = resolve(repositoryRoot, ".eliotr-state");
const accessReceiptPath = resolve(stateDirectory, "cloudflare-access-receipt.json");
const backupRoot = resolve(repositoryRoot, `.eliotr-browser-auth-test-backup-${process.pid}`);

function emptyState() {
  return {
    d1: new Map(), r2: new Map(), queues: new Map(),
    apps: new Map(), policies: new Map(),
    org: { auth_domain: "int-test-example.cloudflareaccess.com" },
    requests: [], mutations: [], authSeen: [],
    dropFirstAppId: false, appPosts: 0,
  };
}
let state = emptyState();

function success(result, status = 200) {
  return { status, payload: { success: true, errors: [], messages: [], result } };
}
function failure(status, message) {
  return { status, payload: { success: false, errors: [{ code: 1000, message }], result: null } };
}
function json(res, response) {
  const body = JSON.stringify(response.payload);
  res.writeHead(response.status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
async function bodyJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://mock");
    const method = req.method ?? "GET";
    const body = await bodyJson(req);
    const auth = req.headers.authorization ?? null;
    if (auth) state.authSeen.push(auth);
    state.requests.push({ method, pathname: url.pathname, search: url.search });
    if (method !== "GET") state.mutations.push({ method, pathname: url.pathname });
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const accountIndex = parts.indexOf("accounts");
    const tail = parts.slice(accountIndex + 2);

    if (tail[0] === "access" && tail[1] === "organizations" && method === "GET") {
      return json(res, success([state.org]));
    }
    if (tail[0] === "access" && tail[1] === "apps") {
      if (tail.length === 2 && method === "GET") return json(res, success([...state.apps.values()]));
      if (tail.length === 2 && method === "POST") {
        state.appPosts += 1;
        const { policies = [], ...appBody } = body;
        const id = `access-app-${state.appPosts}`;
        const app = { id, aud: `aud-tag-${state.appPosts}`, ...structuredClone(appBody) };
        state.apps.set(id, app);
        state.policies.set(id, policies.map((policy, index) => ({
          id: `access-policy-${state.appPosts}-${index}`, ...structuredClone(policy), exclude: [], require: [],
        })));
        // Lost-ACK simulation: persist server-side but answer without an id once.
        if (state.dropFirstAppId) {
          state.dropFirstAppId = false;
          const { id: droppedAppId, ...withoutId } = app;
          assert.ok(typeof droppedAppId === "string" && droppedAppId.length > 0);
          return json(res, success(withoutId));
        }
        return json(res, success(app));
      }
      if (tail.length === 4 && tail[3] === "policies" && method === "GET") {
        return json(res, success(state.policies.get(tail[2]) ?? []));
      }
      if (tail.length === 4 && tail[3] === "policies" && method === "POST") {
        const policy = { id: `access-policy-extra-${Date.now()}`, ...structuredClone(body), exclude: [], require: [] };
        const list = state.policies.get(tail[2]) ?? [];
        list.push(policy);
        state.policies.set(tail[2], list);
        return json(res, success(policy));
      }
    }
    if (tail[0] === "d1" && tail[1] === "database") {
      if (method === "GET") {
        const name = url.searchParams.get("name");
        return json(res, success([...state.d1.values()].filter((item) => name === null || item.name === name)));
      }
      if (method === "POST") {
        const item = { uuid: `d1-uuid-${body.name}`, name: body.name, jurisdiction: body.jurisdiction };
        state.d1.set(item.name, item);
        return json(res, success(item));
      }
    }
    if (tail[0] === "r2" && tail[1] === "buckets") {
      if (method === "GET" && tail.length === 3) {
        const item = state.r2.get(tail[2]);
        return json(res, item ? success(item) : failure(404, "not found"));
      }
      if (method === "POST" && tail.length === 2) {
        const item = { name: body.name, jurisdiction: req.headers["cf-r2-jurisdiction"] ?? "default", storage_class: body.storageClass ?? "Standard" };
        state.r2.set(item.name, item);
        return json(res, success(item));
      }
    }
    if (tail[0] === "queues") {
      if (method === "GET" && tail.length === 1) return json(res, success([...state.queues.values()]));
      if (method === "POST" && tail.length === 1) {
        const item = { queue_id: `queue-${body.queue_name}`, queue_name: body.queue_name };
        state.queues.set(item.queue_name, item);
        return json(res, success(item));
      }
    }
    return json(res, failure(404, `${method} ${url.pathname}`));
  } catch (error) {
    json(res, { status: 500, payload: { success: false, errors: [{ message: String(error) }] } });
  }
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
assert(address && typeof address === "object");
const apiBase = `http://127.0.0.1:${address.port}/client/v4`;

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}
let generatedBackedUp = false;
let stateBackedUp = false;
if (await exists(generatedConfigPath)) {
  await mkdir(backupRoot, { recursive: true });
  await rename(generatedConfigPath, resolve(backupRoot, "wrangler.deploy.jsonc"));
  generatedBackedUp = true;
}
if (await exists(stateDirectory)) {
  await mkdir(backupRoot, { recursive: true });
  await rename(stateDirectory, resolve(backupRoot, "state"));
  stateBackedUp = true;
}

const baseEnv = {
  ...process.env,
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  CLOUDFLARE_API_TOKEN: BEARER,
  CLOUDFLARE_API_BASE_URL: apiBase,
  ELIOTR_ACCESS_HOSTNAME: HOSTNAME,
  ELIOTR_OWNER_EMAILS: OWNER,
  ELIOTR_ENVIRONMENT: "staging",
  ELIOTR_DEPLOYMENT_GENERATION: "git-browser-int",
  ELIOTR_CUSTOM_DOMAIN: "0",
};

function run(script, args = [], env = {}) {
  // Fresh ADMITTED usage fixture by default: direct apply requires ADMITTED
  // past the usage gate. Cases that need a different decision override
  // ELIOTR_TEST_USAGE_SNAPSHOT_JSON explicitly.
  return new Promise((resolveRun) => {
    const argv = [resolve(repositoryRoot, script), ...args];
    const child = spawn(process.execPath, argv, {
      cwd: repositoryRoot, env: { ...baseEnv, ELIOTR_TEST_USAGE_SNAPSHOT_JSON: admittedUsageFixture(), ...env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolveRun({ status: null, stdout, stderr: `${stderr}${String(error)}`, argv: argv.join(" ") });
    });
    child.on("close", (status) => {
      clearTimeout(timeout);
      resolveRun({ status, stdout, stderr, argv: argv.join(" ") });
    });
  });
}

let cases = 0;
const noBearer = (value, label) => assert.ok(
  !JSON.stringify(value ?? "").includes(BEARER), `${label} leaks the bearer`);
const expectPass = (result, label) => assert.equal(result.status, 0,
  `${label} failed (status=${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
// Node v25.6.1 on Windows fastfails (status 3221226505, uv_async assertion)
// when a child calls process.exit(0) with pooled keep-alive fetch connections
// open -- reproduced with 5 sequential localhost fetches + exit(0), while the
// same fetches with natural exit return 0. Both provisioners call
// process.exit(0) on their --check-only success path, so a check-only child
// may crash AFTER printing a complete plan. This is environmental (Node
// teardown, not provisioner logic): tolerance is NARROW -- exact crash status
// plus exact libuv assertion in stderr -- and the plan JSON itself must fully
// parse with mode CHECK_ONLY_NO_MUTATION, while every check-only caller must
// additionally assert zero mutations (see mutations() === 0 below). A genuine
// logic failure (non-zero other status, unparseable plan, wrong mode, or any
// mutation) cannot hide behind this tolerance. Apply/fail paths use
// expectPass/expectFail with no tolerance.
const WIN_EXIT_ARTIFACT_STATUS = 3221226505;
const WIN_EXIT_ARTIFACT_STDERR = /Assertion failed: !\(handle->flags & UV_HANDLE_CLOSING\)/u;
const expectPlanPass = (result, label, parsePlan) => {
  const plan = parsePlan(result.stdout);
  assert.ok(plan, `${label} printed no parseable plan\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.equal(plan.mode, "CHECK_ONLY_NO_MUTATION",
    `${label} plan is not check-only (mode=${plan.mode})\nstdout:\n${result.stdout}`);
  assert.ok(typeof plan.protocol === "string" && plan.protocol.length > 0,
    `${label} plan lacks a protocol locator\nstdout:\n${result.stdout}`);
  assert.ok(result.status === 0 ||
    (result.status === WIN_EXIT_ARTIFACT_STATUS && WIN_EXIT_ARTIFACT_STDERR.test(result.stderr)),
    `${label} failed unexpectedly (status=${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return plan;
};
const expectFail = (result, label) => assert.notEqual(result.status, 0,
  `${label} unexpectedly passed\nstdout:\n${result.stdout}`);
const check = async (name, action) => { await action(); cases += 1; console.log(`Browser-auth integration: ${name}: PASS`); };
const reset = () => { state = emptyState(); };
const mutations = () => state.mutations.length;
const requests = () => state.requests.length;
function admittedUsageFixture() {
  const now = Date.now();
  const metrics = {};
  for (const key of REQUIRED_METRIC_KEYS) metrics[key] = 100;
  metrics.ai_search_instances = 5;
  metrics.r2_storage_gb_month = 1;
  return JSON.stringify({
    protocol: "eliotr.cloudflare-usage-snapshot.v1",
    account_id_digest: digestAccountId(ACCOUNT),
    account_ref: "cloudflare-account:browse…ount",
    collected_at: new Date(now - 60_000).toISOString(),
    window: monthlyWindowFor(now),
    daily_window: dailyWindowFor(now),
    source: "test-fixture",
    readback: { whoami_verified: true },
    metrics,
  });
}

try {
  await rm(generatedConfigPath, { force: true });
  await rm(stateDirectory, { recursive: true, force: true });

  await check("empty-account access check-only plans CREATE without inventing an AUD", async () => {
    reset();
    const result = await run("scripts/provision-cloudflare-access.mjs", ["--check-only"]);
    const plan = expectPlanPass(result, "empty access check-only", (stdout) => {
      try { return JSON.parse(stdout); } catch { return null; }
    });
    assert.equal(plan.application.disposition, "CREATE");
    assert.equal(plan.aud, null);
    assert.equal(plan.aud_disposition, "GENERATED_ON_CREATE");
    assert.equal(plan.team_domain, TEAM);
    assert.equal(mutations(), 0);
    assert.ok(state.authSeen.every((header) => header === `Bearer ${BEARER}`));
    noBearer(result.stdout, "plan stdout");
    noBearer(result.stderr, "plan stderr");
    noBearer(result.argv, "plan argv");
  });

  await check("empty-account access apply creates once and persists readback AUD", async () => {
    reset();
    const result = await run("scripts/provision-cloudflare-access.mjs");
    expectPass(result, "empty access apply");
    assert.equal(mutations(), 1);
    const receipt = JSON.parse(await readFile(accessReceiptPath, "utf8"));
    assert.equal(receipt.hostname, HOSTNAME);
    assert.equal(receipt.team_domain, TEAM);
    assert.ok(typeof receipt.aud === "string" && receipt.aud.length > 0);
    assert.equal(receipt.application.disposition, "CREATED");
    noBearer(receipt, "access receipt");
    noBearer(result.stdout, "apply stdout");
    noBearer(result.stderr, "apply stderr");
  });

  await check("lost create ACK reconciles through exact-name re-list", async () => {
    reset();
    state.dropFirstAppId = true;
    const result = await run("scripts/provision-cloudflare-access.mjs");
    expectPass(result, "lost-ACK access apply");
    assert.equal(state.apps.size, 1, "lost ACK created a duplicate app");
    const receipt = JSON.parse(await readFile(accessReceiptPath, "utf8"));
    assert.equal(receipt.application.id, [...state.apps.keys()][0]);
    noBearer(receipt, "lost-ACK receipt");
  });

  await check("existing exact app replays as VERIFIED with no new mutation", async () => {
    const before = mutations();
    const result = await run("scripts/provision-cloudflare-access.mjs");
    expectPass(result, "access replay");
    assert.equal(mutations(), before, "replay mutated Access state");
    const receipt = JSON.parse(await readFile(accessReceiptPath, "utf8"));
    assert.equal(receipt.application.disposition, "VERIFIED");
    assert.equal(receipt.policy.disposition, "VERIFIED");
  });

  await check("AUD propagates from the verified receipt into generated core config", async () => {
    await rm(generatedConfigPath, { force: true });
    const accessReceipt = JSON.parse(await readFile(accessReceiptPath, "utf8"));
    const before = mutations();
    const result = await run("scripts/provision-cloudflare-core.mjs");
    expectPass(result, "core apply with receipt");
    assert.ok(mutations() > before, "core apply performed no foundation mutations");
    const generated = JSON.parse(await readFile(generatedConfigPath, "utf8"));
    assert.equal(generated.vars.ACCESS_AUDIENCE, accessReceipt.aud);
    assert.equal(generated.vars.ACCESS_TEAM_DOMAIN, accessReceipt.team_domain);
    assert.equal(generated.workers_dev, true);
    assert.ok(!("routes" in generated), "workers.dev contour must not emit routes");
    noBearer(generated, "generated config");
    noBearer(result.stdout, "core stdout");
    const direct = resolveAccessRuntimeConfiguration({
      ELIOTR_ACCESS_TEAM_DOMAIN: "", ELIOTR_ACCESS_AUDIENCE: "", ELIOTR_ACCESS_SERVICE_PRINCIPALS: "",
    }, accessReceipt);
    assert.equal(direct.source, "RECEIPT");
    assert.equal(direct.audience, accessReceipt.aud);
  });

  await check("team-domain reconciliation rejects env drift before mutation", async () => {
    const before = mutations();
    const result = await run("scripts/provision-cloudflare-core.mjs",
      [], { ELIOTR_ACCESS_TEAM_DOMAIN: OTHER_TEAM });
    expectFail(result, "team drift");
    assert.match(result.stderr, /team-domain reconciliation mismatch/u);
    assert.equal(mutations(), before);
    noBearer(result.stderr, "team-drift stderr");
  });

  await check("environment AUD cannot override the verified receipt AUD", async () => {
    const receiptForAud = JSON.parse(await readFile(accessReceiptPath, "utf8"));
    assert.throws(() => resolveAccessRuntimeConfiguration({
      ELIOTR_ACCESS_TEAM_DOMAIN: "",
      ELIOTR_ACCESS_AUDIENCE: "forged-aud-tag",
      ELIOTR_ACCESS_SERVICE_PRINCIPALS: "",
    }, receiptForAud), /AUD propagation mismatch/u);
    const before = mutations();
    const result = await run("scripts/provision-cloudflare-core.mjs",
      [], { ELIOTR_ACCESS_AUDIENCE: "forged-aud-tag" });
    expectFail(result, "AUD override");
    assert.equal(mutations(), before);
  });

  await check("duplicate exact-name apps fail closed before mutation", async () => {
    reset();
    for (const id of ["dup-1", "dup-2"]) {
      state.apps.set(id, { id, type: "self_hosted", name: APP_NAME, domain: HOSTNAME,
        destinations: [{ type: "public", uri: HOSTNAME }], session_duration: "24h", app_launcher_visible: false });
    }
    const result = await run("scripts/provision-cloudflare-access.mjs");
    expectFail(result, "duplicate apps");
    assert.match(result.stderr, /multiple Access applications/u);
    assert.equal(mutations(), 0);
  });

  await check("wrong app claiming the hostname fails closed before mutation", async () => {
    reset();
    state.apps.set("wrong-1", { id: "wrong-1", type: "self_hosted", name: "Some Other App",
      domain: "other.example", destinations: [{ type: "public", uri: HOSTNAME }],
      session_duration: "24h", app_launcher_visible: false });
    const result = await run("scripts/provision-cloudflare-access.mjs");
    expectFail(result, "hostname collision");
    assert.match(result.stderr, /already claims/u);
    assert.equal(mutations(), 0);
  });

  await check("receipt-drift broadening fails: owner set, AUD, team, account", async () => {
    reset();
    expectPass(await run("scripts/provision-cloudflare-access.mjs"), "reseed access");
    const pristine = await readFile(accessReceiptPath, "utf8");
    const tamper = async (mutate) => {
      const receipt = JSON.parse(pristine);
      mutate(receipt);
      await writeFile(accessReceiptPath, JSON.stringify(receipt, null, 2));
    };
    const replayFails = async (label, pattern) => {
      const before = mutations();
      const result = await run("scripts/provision-cloudflare-access.mjs");
      expectFail(result, label);
      assert.match(result.stderr, pattern);
      assert.equal(mutations(), before, `${label} mutated before failing`);
    };
    await tamper((receipt) => { receipt.aud = "forged-aud-drift"; });
    await replayFails("AUD drift", /AUD drift vs prior receipt/u);
    await tamper((receipt) => { receipt.team_domain = OTHER_TEAM; });
    await replayFails("team drift", /team-domain drift vs prior receipt/u);
    await writeFile(accessReceiptPath, pristine);
    const ownerDrift = await run("scripts/provision-cloudflare-access.mjs",
      [], { ELIOTR_OWNER_EMAILS: "intruder@int-test.example" });
    expectFail(ownerDrift, "owner-set drift");
    assert.match(ownerDrift.stderr, /drift|broadening/u);
    const beforeAccount = mutations();
    const accountDrift = await run("scripts/provision-cloudflare-access.mjs",
      [], { CLOUDFLARE_ACCOUNT_ID: OTHER_ACCOUNT });
    expectFail(accountDrift, "stale account substitution");
    assert.match(accountDrift.stderr, /different account/u);
    assert.equal(mutations(), beforeAccount);
    await writeFile(accessReceiptPath, pristine);
  });

  await check("core refuses foundation mutations without Access authority", async () => {
    reset();
    await rm(accessReceiptPath, { force: true });
    const checkOnlyBefore = mutations();
    const plan = await run("scripts/provision-cloudflare-core.mjs", ["--check-only"],
      { ELIOTR_ACCESS_TEAM_DOMAIN: "", ELIOTR_ACCESS_AUDIENCE: "" });
    const parsed = expectPlanPass(plan, "authorityless check-only", (stdout) => {
      try { return JSON.parse(stdout); } catch { return null; }
    });
    assert.match(parsed.access_runtime?.source ?? "", /RUN_ACCESS_PROVISIONER_FIRST/u);
    assert.equal(mutations(), checkOnlyBefore, "check-only mutated foundation state");
    const before = mutations();
    const apply = await run("scripts/provision-cloudflare-core.mjs",
      [], { ELIOTR_ACCESS_TEAM_DOMAIN: "", ELIOTR_ACCESS_AUDIENCE: "" });
    expectFail(apply, "authorityless apply");
    assert.match(apply.stderr, /missing Access authority/u);
    assert.equal(mutations(), before);
  });

  await check("no-auth means no mutation at the provisioner boundary", async () => {
    reset();
    const before = requests();
    const child = await new Promise((resolveRun) => {
      const proc = spawn(process.execPath, [resolve(repositoryRoot, "scripts/provision-cloudflare-access.mjs")], {
        cwd: repositoryRoot,
        env: { ...baseEnv, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (chunk) => { stderr += chunk; });
      proc.on("close", (status) => resolveRun({ status, stderr }));
    });
    assert.notEqual(child.status, 0);
    assert.equal(requests(), before, "unauthenticated run contacted the API");
    assert.equal(mutations(), 0);
  });

  await check("expired browser-OAuth token fails closed before any Cloudflare call", async () => {
    const expired = await loadWranglerOAuthCredential({
      env: {},
      readFile: async () => `oauth_token = "${BEARER}"\nexpiration_time = "2000-01-01T00:00:00.000Z"\n`,
      configPaths: ["/mock/wrangler/default.toml"],
      now: Date.parse("2026-09-06T00:00:00.000Z"),
    }).then(() => assert.fail("expired OAuth must throw"), (error) => error);
    assert.equal(expired.code, "OAUTH_EXPIRED");
    assert.ok(!String(expired.message).includes(BEARER));
    assert.equal(requests(), requests());
  });

  console.log(`Browser-auth integration: ${cases} groups passed; live Cloudflare NOT_EXECUTED`);
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(generatedConfigPath, { force: true });
  await rm(stateDirectory, { recursive: true, force: true });
  if (generatedBackedUp) {
    await mkdir(dirname(generatedConfigPath), { recursive: true });
    await rename(resolve(backupRoot, "wrangler.deploy.jsonc"), generatedConfigPath);
  }
  if (stateBackedUp) {
    await rename(resolve(backupRoot, "state"), stateDirectory);
  }
  await rm(backupRoot, { recursive: true, force: true });
}
