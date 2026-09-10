// Usage-preflight spawned-children conformance: deterministic, mocked, no
// live calls. Split from test-usage-envelope.mjs (FIX11 split-only except
// the noted capability assertions; no behavior change): the preflight CLI
// checks and provisioner-gating checks that spawn child processes live here,
// while pure envelope evaluation/collection units stay in
// test-usage-envelope.mjs. Fixture admission for spawned children travels
// ONLY via the explicit gate shim (--import test-usage-gate-shim.mjs +
// ELIOTR_TEST_SPAWN_SNAPSHOT_JSON, honored solely by the test standin);
// ambient variables alone never admit.
// Fictional data only (example.invalid, fake hex identifiers). Run with:
//   node scripts/test-usage-preflight-children.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  USAGE_ADMISSION_PROTOCOL,
  USAGE_SNAPSHOT_PROTOCOL,
  accountRef,
  digestAccountId,
  validateAdmissionReceipt,
} from "./lib/cloudflare-usage-envelope.mjs";
import {
  dailyWindowFor,
  monthlyWindowFor,
} from "./lib/cloudflare-usage-collection.mjs";
import {
  runUsagePreflight,
} from "./lib/cloudflare-usage-admission.mjs";
import { isChromiumSafePort } from "./lib/local-owner-bridge.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ACCOUNT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST = digestAccountId(ACCOUNT);
const BEARER = "fictional-oauth-bearer-for-tests-only";
const OWNER_EMAIL = "owner@example.invalid";
const HOSTNAME = "research.example.invalid";

let cases = 0;
async function check(name, action) {
  await action();
  cases += 1;
  console.log(`Usage preflight children: ${name}: PASS`);
}

function baseMetrics() {
  return {
    workers_requests: 100_000,
    workers_cpu_ms: 200_000,
    d1_storage_bytes: 100 * 1024 * 1024,
    d1_rows_read: 1_000_000,
    d1_rows_written: 100_000,
    r2_storage_gb_month: 1,
    r2_class_a_ops: 10_000,
    r2_class_b_ops: 100_000,
    queue_ops: 10_000,
    do_requests: 10_000,
    do_gb_seconds: 1_000,
    do_sql_reads: 1_000_000,
    do_sql_writes: 100_000,
    do_storage_bytes: 100 * 1024 * 1024,
    workers_ai_neurons_per_day: 100,
    ai_search_instances: 5,
    ai_search_queries_month: 1_000,
    vectorize_queried_dims_month: 1_000_000,
    vectorize_stored_dims_month: 100_000,
  };
}

// Wall-clock fixture for child-process preflight runs, which evaluate with
// the real clock instead of the fixed NOW used by the pure unit cases above.
function liveFixtureSnapshot(overrides = {}) {
  const at = Date.now();
  return {
    protocol: USAGE_SNAPSHOT_PROTOCOL,
    account_id_digest: DIGEST,
    account_ref: accountRef(ACCOUNT),
    collected_at: new Date(at - 5 * 60 * 1000).toISOString(),
    window: monthlyWindowFor(at),
    daily_window: dailyWindowFor(at),
    source: "test-fixture",
    readback: { whoami_verified: true },
    metrics: { ...baseMetrics(), ...overrides },
  };
}

// --- mock Cloudflare API ---------------------------------------------------

function emptyMockState() {
  return {
    d1: new Map(),
    r2: new Map(),
    queues: new Map(),
    accessApps: new Map(),
    accessPolicies: new Map(),
    requests: [],
    mutations: [],
    sequence: 0,
  };
}
let mock = emptyMockState();
function success(result, status = 200) {
  return { status, payload: { success: true, errors: [], messages: [], result } };
}
function notFound(message = "not found") {
  return { status: 404, payload: { success: false, errors: [{ code: 1000, message }], result: null } };
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
    mock.requests.push({ method, pathname: url.pathname, body });
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) mock.mutations.push({ method, pathname: url.pathname, body });
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const accountIndex = parts.indexOf("accounts");
    if (accountIndex < 0) return json(res, notFound("unknown account"));
    const tail = parts.slice(accountIndex + 2);
    if (tail[0] === "d1" && tail[1] === "database") {
      if (method === "GET") {
        const name = url.searchParams.get("name");
        return json(res, success([...mock.d1.values()].filter((item) => name === null || item.name === name)));
      }
      if (method === "POST") {
        mock.sequence += 1;
        const item = { uuid: `d1-${mock.sequence}`, name: body.name, jurisdiction: body.jurisdiction };
        mock.d1.set(item.name, item);
        return json(res, success(item));
      }
    }
    if (tail[0] === "r2" && tail[1] === "buckets") {
      if (method === "GET" && tail.length === 3) {
        const item = mock.r2.get(tail[2]);
        return json(res, item ? success(item) : notFound());
      }
      if (method === "POST" && tail.length === 2) {
        const item = { name: body.name, jurisdiction: req.headers["cf-r2-jurisdiction"] ?? "default", storage_class: body.storageClass ?? "Standard" };
        mock.r2.set(item.name, item);
        return json(res, success(item));
      }
    }
    if (tail[0] === "queues") {
      if (method === "GET" && tail.length === 1) return json(res, success([...mock.queues.values()]));
      if (method === "POST" && tail.length === 1) {
        mock.sequence += 1;
        const item = { queue_id: `queue-${mock.sequence}`, queue_name: body.queue_name };
        mock.queues.set(item.queue_name, item);
        return json(res, success(item));
      }
    }
    if (tail[0] === "access" && tail[1] === "apps") {
      if (method === "GET" && tail.length === 2) return json(res, success([...mock.accessApps.values()]));
      if (method === "POST" && tail.length === 2) {
        mock.sequence += 1;
        const id = `access-app-${mock.sequence}`;
        const { policies = [], ...rest } = body;
        const isMcp = body.domain === `${HOSTNAME}/mcp`;
        mock.accessApps.set(id, { id, aud: isMcp ? "mock-mcp-audience" : "mock-access-audience", ...structuredClone(rest) });
        mock.accessPolicies.set(id, policies.map((policy) => ({ id: `policy-${mock.sequence}`, ...structuredClone(policy) })));
        return json(res, success(mock.accessApps.get(id)));
      }
      if (tail.length === 4 && tail[3] === "policies" && method === "GET") {
        return json(res, success(mock.accessPolicies.get(tail[2]) ?? []));
      }
      if (tail.length === 4 && tail[3] === "policies" && method === "POST") {
        const list = mock.accessPolicies.get(tail[2]) ?? [];
        list.push({ id: `policy-${mock.sequence}`, ...structuredClone(body) });
        mock.accessPolicies.set(tail[2], list);
        return json(res, success(list[list.length - 1]));
      }
    }
    return json(res, notFound(`${method} ${url.pathname}`));
  } catch (error) {
    json(res, { status: 500, payload: { success: false, errors: [{ message: String(error) }] } });
  }
});
async function listenMockServerSafely() {
  for (let attempt = 1; attempt <= 25; attempt += 1) {
    await new Promise((resolveListen, rejectListen) => {
      const onError = (error) => { server.off("listening", onListening); rejectListen(error); };
      const onListening = () => { server.off("error", onError); resolveListen(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });
    const bound = server.address();
    if (bound && typeof bound === "object" && isChromiumSafePort(bound.port)) return bound;
    await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  }
  throw new Error("mock Cloudflare API could not obtain a Chromium-safe loopback port");
}
const address = await listenMockServerSafely();
assert(address && typeof address === "object");
const apiBase = `http://127.0.0.1:${address.port}/client/v4`;

function childEnv(overrides = {}) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function runScript(script, args = [], env = {}, gateFixture = null) {
  return new Promise((resolveRun) => {
    const argv = [resolve(repositoryRoot, script), ...args];
    const spawnEnv = childEnv(env);
    // gateFixture reaches the child ONLY via the explicit --import shim flag;
    // without it the same variable in env is ignored (poisoned case below).
    const finalArgv = gateFixture === null ? argv : ["--import", GATE_SHIM, ...argv];
    if (gateFixture !== null) spawnEnv.ELIOTR_TEST_SPAWN_SNAPSHOT_JSON = gateFixture;
    const child = spawn(process.execPath, finalArgv, {
      cwd: repositoryRoot,
      env: spawnEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolveRun({ status: null, stdout, stderr: `${stderr}${String(error)}` });
    });
    child.on("close", (status) => {
      clearTimeout(timeout);
      resolveRun({ status, stdout, stderr });
    });
  });
}

const scratch = await mkdtemp(join(tmpdir(), "eliotr-usage-test-"));
function receiptEnv(extra = {}) {
  return { ELIOTR_USAGE_RECEIPT_PATH: join(scratch, `receipt-${cases}.json`), ...extra };
}
// Explicit spawn gate + isolated scratch state for spawned provisioners.
const GATE_SHIM = pathToFileURL(resolve(repositoryRoot, "scripts/test-usage-gate-shim.mjs")).href;
const isolatedStateDirectory = await mkdtemp(join(tmpdir(), "eliotr-usage-state-"));
// Fake `pnpm` on PATH for the `wrangler whoami` spawn in oauth-mode children.
const fakeBinDir = await mkdtemp(join(tmpdir(), "eliotr-fake-pnpm-"));
const fakeWhoamiLine = `account ${ACCOUNT} active`.replace(/"/gu, "");
await writeFile(join(fakeBinDir, "pnpm.cmd"), `@echo off\r\nif "%1"=="exec" if "%2"=="wrangler" if "%3"=="whoami" (\r\n  echo ${fakeWhoamiLine}\r\n  exit /b 0\r\n)\r\nexit /b 1\r\n`);
await writeFile(join(fakeBinDir, "pnpm"), `#!/bin/sh\nif [ "$1" = "exec" ] && [ "$2" = "wrangler" ] && [ "$3" = "whoami" ]; then echo "${fakeWhoamiLine}"; exit 0; fi\nexit 1\n`);
// Linux CI resolves `pnpm` via PATH with shell:false, so the shim must be
// executable; without +x libuv skips it, the real `pnpm exec wrangler whoami`
// runs (exit 0 "not authenticated" when no profile), and verification fails
// with OAUTH_ACCOUNT_MISMATCH. Windows uses pnpm.cmd via shell:true.
await chmod(join(fakeBinDir, "pnpm"), 0o755);
const fakePath = `${fakeBinDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`;

const provisionEnv = {
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  CLOUDFLARE_API_TOKEN: "fictional-static-token-for-tests",
  CLOUDFLARE_API_BASE_URL: apiBase,
  ELIOTR_STATE_DIRECTORY: isolatedStateDirectory,
  ELIOTR_ACCESS_HOSTNAME: HOSTNAME,
  ELIOTR_OWNER_EMAILS: OWNER_EMAIL,
  ELIOTR_ENVIRONMENT: "staging",
  ELIOTR_DEPLOYMENT_GENERATION: "mock-generation",
  ELIOTR_CUSTOM_DOMAIN: "1",
  ELIOTR_ACCESS_TEAM_DOMAIN: "https://mock-team-example.cloudflareaccess.com",
  ELIOTR_ACCESS_AUDIENCE: "mock-access-audience",
};

// --- preflight CLI ---------------------------------------------------------

await check("explicit snapshot admits in-process through the real envelope", async () => {
  // Positive admission without ambient env: builder-generated fixture via
  // the explicit `snapshot` option (the shimmed spawn path uses the same
  // option internally, proven by the fixture tests below).
  const gate = await runUsagePreflight({
    env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "fictional-static-token-for-tests" },
    nowMs: Date.now(),
    snapshot: JSON.stringify(liveFixtureSnapshot()),
    providers: [],
  });
  assert.equal(gate.decision, "ADMITTED");
  // FIX11: an explicitly injected snapshot evaluates but never mints — the
  // structure was caller-supplied, not freshly collected over verified live
  // transport — so no capability may accompany the ADMITTED label.
  assert.equal(gate.capability, null);
});

await check("preflight admits fixture, writes redacted atomic receipt", async () => {
  const env = receiptEnv({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
  const result = await runScript("scripts/check-cloudflare-usage-preflight.mjs", [], env,
    JSON.stringify(liveFixtureSnapshot()));
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const receipt = JSON.parse(await readFile(env.ELIOTR_USAGE_RECEIPT_PATH, "utf8"));
  assert.equal(receipt.protocol, USAGE_ADMISSION_PROTOCOL);
  assert.equal(receipt.decision, "ADMITTED");
  const checkReceipt = validateAdmissionReceipt(receipt, { expectedAccountDigest: DIGEST, now: Date.now(), maxAgeMs: 24 * 60 * 60 * 1000 });
  // BLOCKER B: fixture receipts are snapshot-asserted, never authorizing (test-only path).
  assert.equal(checkReceipt.ok, false, JSON.stringify(checkReceipt.reasons));
  assert.match(checkReceipt.reasons.join(";"), /never authorizes heavy work/u);
  const text = await readFile(env.ELIOTR_USAGE_RECEIPT_PATH, "utf8");
  assert.ok(!text.includes(ACCOUNT), "exact account id leaked into receipt");
  assert.ok(!text.includes("fictional-static-token"), "token leaked into receipt");
  assert.ok(!text.includes(OWNER_EMAIL), "owner email leaked into receipt");
  const leftovers = (await readdir(scratch)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
  if (process.platform === "win32") {
    console.log("Usage envelope: receipt mode bits: SKIP on win32 (0600 best-effort)");
  } else {
    assert.equal((await stat(env.ELIOTR_USAGE_RECEIPT_PATH)).mode & 0o777, 0o600);
  }
});

await check("preflight blocks over-envelope with zero mutations", async () => {
  mock = emptyMockState();
  const env = receiptEnv({
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    CLOUDFLARE_API_TOKEN: "fictional-static-token-for-tests",
    CLOUDFLARE_API_BASE_URL: apiBase,
  });
  const result = await runScript("scripts/check-cloudflare-usage-preflight.mjs", [], env,
    JSON.stringify(liveFixtureSnapshot({ queue_ops: 900_000 })));
  assert.notEqual(result.status, 0);
  const receipt = JSON.parse(await readFile(env.ELIOTR_USAGE_RECEIPT_PATH, "utf8"));
  assert.equal(receipt.decision, "BLOCKED");
  assert.equal(mock.requests.length, 0);
  assert.equal(mock.mutations.length, 0);
});

await check("ignored exact account required for live", async () => {
  const result = await runScript("scripts/check-cloudflare-usage-preflight.mjs", [],
    receiptEnv({ CLOUDFLARE_ACCOUNT_ID: undefined }));
  assert.notEqual(result.status, 0);
});

await check("no api-token fallback and sealed without network", async () => {
  mock = emptyMockState();
  const env = receiptEnv({
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    CLOUDFLARE_API_TOKEN: "fictional-static-token-for-tests",
    CLOUDFLARE_API_BASE_URL: apiBase,
    // Poisoned ambient snapshot: production ignores it without the gate shim
    // and still seals with zero network calls.
    ELIOTR_TEST_SPAWN_SNAPSHOT_JSON: JSON.stringify(liveFixtureSnapshot()),
  });
  const result = await runScript("scripts/check-cloudflare-usage-preflight.mjs", [], env);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const receipt = JSON.parse(await readFile(env.ELIOTR_USAGE_RECEIPT_PATH, "utf8"));
  assert.equal(receipt.decision, "SEALED");
  assert.equal(mock.requests.length, 0);
});

await check("oauth bearer memory-only and redacted end to end", async () => {
  mock = emptyMockState();
  const profilePath = join(scratch, "oauth-profile.toml");
  await writeFile(profilePath, `oauth_token = "${BEARER}"\nexpiration_time = 4102444800\n`, "utf8");
  const env = receiptEnv({
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    CLOUDFLARE_API_BASE_URL: apiBase,
    ELIOTR_CLOUDFLARE_AUTH_MODE: "wrangler-oauth",
    ELIOTR_WRANGLER_CONFIG_FILE: profilePath,
    PATH: fakePath,
    ELIOTR_OWNER_EMAILS: OWNER_EMAIL,
  });
  const result = await runScript("scripts/check-cloudflare-usage-preflight.mjs", [], env);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const text = await readFile(env.ELIOTR_USAGE_RECEIPT_PATH, "utf8");
  assert.ok(!text.includes(BEARER), "bearer leaked into receipt");
  assert.ok(!text.includes(ACCOUNT), "exact account id leaked into receipt");
  assert.ok(!result.stdout.includes(BEARER) && !result.stderr.includes(BEARER), "bearer leaked into output");
  assert.equal(mock.requests.length, 0);
});

await check("expired and missing oauth credentials fail closed", async () => {
  const expiredPath = join(scratch, "oauth-expired.toml");
  await writeFile(expiredPath, `oauth_token = "${BEARER}"\nexpiration_time = 946684800\n`, "utf8");
  const base = {
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    ELIOTR_CLOUDFLARE_AUTH_MODE: "wrangler-oauth",
  };
  const expired = await runScript("scripts/check-cloudflare-usage-preflight.mjs", [],
    receiptEnv({ ...base, ELIOTR_WRANGLER_CONFIG_FILE: expiredPath }));
  assert.notEqual(expired.status, 0);
  const missing = await runScript("scripts/check-cloudflare-usage-preflight.mjs", [],
    receiptEnv({ ...base, ELIOTR_WRANGLER_CONFIG_FILE: join(scratch, "no-such-profile.toml") }));
  assert.notEqual(missing.status, 0);
  assert.equal(mock.requests.length, 0);
});

// --- provisioner gating ----------------------------------------------------

const generatedConfigPath = resolve(repositoryRoot, "apps/eliotr-core/wrangler.deploy.jsonc");
const backupRoot = resolve(repositoryRoot, `.eliotr-usage-test-backup-${process.pid}`);
async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}
let backedGenerated = false;
if (await exists(generatedConfigPath)) {
  await mkdir(backupRoot, { recursive: true });
  await rename(generatedConfigPath, join(backupRoot, "wrangler.deploy.jsonc"));
  backedGenerated = true;
}

try {
  await check("blocked usage aborts core and access before any mutation", async () => {
    mock = emptyMockState();
    const blocked = JSON.stringify(liveFixtureSnapshot({ r2_class_a_ops: 900_000 }));
    const coreEnv = { ...provisionEnv, ...receiptEnv() };
    const core = await runScript("scripts/provision-cloudflare-core.mjs", [], coreEnv, blocked);
    assert.notEqual(core.status, 0, `core unexpectedly passed: ${core.stdout}`);
    const accessEnv = { ...provisionEnv, ...receiptEnv() };
    const accessScript = await runScript("scripts/provision-cloudflare-access.mjs", [], accessEnv, blocked);
    assert.notEqual(accessScript.status, 0, `access unexpectedly passed: ${accessScript.stdout}`);
    assert.equal(mock.requests.length, 0);
    assert.equal(mock.mutations.length, 0);
  });

  await check("access-first: no authority means no worker exposure", async () => {
    mock = emptyMockState();
    const env = { ...provisionEnv, ...receiptEnv() };
    delete env.ELIOTR_ACCESS_TEAM_DOMAIN;
    delete env.ELIOTR_ACCESS_AUDIENCE;
    const core = await runScript("scripts/provision-cloudflare-core.mjs", [], env);
    assert.notEqual(core.status, 0);
    // Cross-product inspection is GET-only; the authority failure lands
    // before the first mutation, so no worker surface can be exposed.
    assert.equal(mock.mutations.length, 0);
    assert.equal(await exists(generatedConfigPath), false);
  });

  await check("allowlist protects gotham inventory", async () => {
    mock = emptyMockState();
    mock.d1.set("gotham-analytics", { uuid: "d1-gotham", name: "gotham-analytics" });
    mock.r2.set("gotham-bucket", { name: "gotham-bucket", jurisdiction: "default", storage_class: "Standard" });
    mock.queues.set("gotham-jobs", { queue_id: "queue-gotham", queue_name: "gotham-jobs" });
    const env = {
      ...provisionEnv,
      ...receiptEnv(),
      ELIOTR_GOOGLE_EXTERNAL_TRANSPORT: "gemini-mcp",
      ELIOTR_MCP_ACCESS_AUTH_PROFILE: "managed-oauth",
      ELIOTR_MCP_ACCESS_TEAM_DOMAIN: "https://mock-team-example.cloudflareaccess.com",
      ELIOTR_MCP_ACCESS_AUDIENCE: "mock-mcp-audience",
    };
    const access = await runScript("scripts/provision-cloudflare-access.mjs", [], env,
      JSON.stringify(liveFixtureSnapshot()));
    assert.equal(access.status, 0, `access fixture failed: ${access.stdout}\n${access.stderr}`);
    const accessReceipt = JSON.parse(await readFile(join(isolatedStateDirectory, "cloudflare-access-receipt.json"), "utf8"));
    assert.equal(accessReceipt.mcp?.auth_profile, "managed-oauth");
    assert.equal(accessReceipt.mcp?.aud, "mock-mcp-audience");
    assert.equal(accessReceipt.mcp?.oauth_configuration_enabled, true);
    assert.equal(Object.hasOwn(accessReceipt.mcp ?? {}, "service_token_id"), false);
    assert.equal(Object.hasOwn(accessReceipt.mcp ?? {}, "service_token_client_id_sha256"), false);
    const core = await runScript("scripts/provision-cloudflare-core.mjs", [], env,
      JSON.stringify(liveFixtureSnapshot()));
    assert.equal(core.status, 0, `core failed: ${core.stdout}\n${core.stderr}`);
    assert.ok(mock.d1.get("gotham-analytics")?.uuid === "d1-gotham");
    assert.ok(mock.r2.get("gotham-bucket")?.name === "gotham-bucket");
    assert.ok(mock.queues.get("gotham-jobs")?.queue_id === "queue-gotham");
    const touchedGotham = [...mock.mutations, ...mock.requests].filter((item) => JSON.stringify(item).includes("gotham"));
    assert.deepEqual(touchedGotham, []);
  });
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(generatedConfigPath, { force: true });
  if (backedGenerated) {
    await mkdir(dirname(generatedConfigPath), { recursive: true });
    await rename(join(backupRoot, "wrangler.deploy.jsonc"), generatedConfigPath);
  }
  await rm(backupRoot, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
  await rm(isolatedStateDirectory, { recursive: true, force: true });
  await rm(fakeBinDir, { recursive: true, force: true });
}

console.log(`Usage preflight children: ${cases} groups passed; live Cloudflare NOT_EXECUTED`);
