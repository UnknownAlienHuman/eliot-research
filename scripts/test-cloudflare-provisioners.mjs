import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { digestAccountId, evaluateUsageSnapshot } from "./lib/cloudflare-usage-envelope.mjs";
import { dailyWindowFor, monthlyWindowFor } from "./lib/cloudflare-usage-collection.mjs";
import {
  nodeOptionsHasLoaderToken,
  scrubTokenEnv,
  stripNodeOptionsLoaderTokens,
} from "./lib/cloudflare-wrangler-oauth.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const accountId = "mock-account";
const accessHostname = "research.example.test";
const ownerEmail = "owner@example.test";
const generatedConfigPath = resolve(repositoryRoot, "apps/eliotr-core/wrangler.deploy.jsonc");
// Scratch isolation: spawned provisioners write receipts under
// ELIOTR_STATE_DIRECTORY (temp, per-run) instead of the shared gitignored
// .eliotr-state, so leftover receipts can never divert later children.
const isolatedStateDirectory = await mkdtemp(join(tmpdir(), "eliotr-provisioner-state-"));
const canonicalConfigPath = resolve(repositoryRoot, "apps/eliotr-core/wrangler.jsonc");
const canonicalConfigBefore = await readFile(canonicalConfigPath, "utf8");
const aiSearchDesired = JSON.parse(await readFile(
  resolve(repositoryRoot, "infra/ai-search/instances.json"),
  "utf8",
));
const backupRoot = resolve(repositoryRoot, `.eliotr-provisioner-test-backup-${process.pid}`);
const backupGeneratedConfigPath = resolve(backupRoot, "wrangler.deploy.jsonc");
let generatedConfigBackedUp = false;
async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}
if (await exists(generatedConfigPath)) {
  await mkdir(backupRoot, { recursive: true });
  await rename(generatedConfigPath, backupGeneratedConfigPath);
  generatedConfigBackedUp = true;
}

function emptyState() {
  return {
    d1: new Map(),
    r2: new Map(),
    queues: new Map(),
    aiNamespace: null,
    aiInstances: new Map(),
    gateways: new Map(),
    accessApps: new Map(),
    accessPolicies: new Map(),
    serviceTokens: new Map(),
    mutations: [],
    requests: [],
    sequence: 0,
  };
}
let state = emptyState();

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
function nextId(prefix) {
  state.sequence += 1;
  return `${prefix}-${state.sequence}`;
}
function pathParts(url) {
  return url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://mock");
    const method = req.method ?? "GET";
    const body = await bodyJson(req);
    state.requests.push({ method, pathname: url.pathname, search: url.search, body });
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) state.mutations.push({ method, pathname: url.pathname, body });
    const parts = pathParts(url);
    // /client/v4/accounts/:account/...
    const accountIndex = parts.indexOf("accounts");
    if (accountIndex < 0 || parts[accountIndex + 1] !== accountId) return json(res, notFound("unknown account"));
    const tail = parts.slice(accountIndex + 2);

    if (tail[0] === "d1" && tail[1] === "database") {
      if (method === "GET") {
        const name = url.searchParams.get("name");
        const values = [...state.d1.values()].filter((item) => name === null || item.name === name);
        return json(res, success(values));
      }
      if (method === "POST") {
        const item = { uuid: nextId("d1"), name: body.name, jurisdiction: body.jurisdiction };
        state.d1.set(item.name, item);
        return json(res, success(item, 200));
      }
    }

    if (tail[0] === "r2" && tail[1] === "buckets") {
      if (method === "GET" && tail.length === 3) {
        const item = state.r2.get(tail[2]);
        return json(res, item ? success(item) : notFound());
      }
      if (method === "POST" && tail.length === 2) {
        const item = {
          name: body.name,
          jurisdiction: req.headers["cf-r2-jurisdiction"] ?? "default",
          storage_class: body.storageClass ?? "Standard",
        };
        state.r2.set(item.name, item);
        return json(res, success(item));
      }
    }

    if (tail[0] === "queues") {
      if (method === "GET" && tail.length === 1) return json(res, success([...state.queues.values()]));
      if (method === "POST" && tail.length === 1) {
        const item = { queue_id: nextId("queue"), queue_name: body.queue_name };
        state.queues.set(item.queue_name, item);
        return json(res, success(item));
      }
    }

    if (tail[0] === "ai-search" && tail[1] === "namespaces") {
      if (tail.length === 3 && method === "GET") {
        return json(res, state.aiNamespace?.name === tail[2] ? success(state.aiNamespace) : notFound());
      }
      if (tail.length === 2 && method === "POST") {
        state.aiNamespace = { id: nextId("namespace"), name: body.name, description: body.description };
        return json(res, success(state.aiNamespace));
      }
      if (tail.length === 5 && tail[3] === "instances" && method === "GET") {
        const item = state.aiInstances.get(tail[4]);
        return json(res, item ? success(item) : notFound());
      }
      if (tail.length === 4 && tail[3] === "instances" && method === "POST") {
        state.aiInstances.set(body.id, structuredClone(body));
        return json(res, success(structuredClone(body)));
      }
    }

    if (tail[0] === "ai-gateway" && tail[1] === "gateways") {
      if (tail.length === 3 && method === "GET") {
        const item = state.gateways.get(tail[2]);
        return json(res, item ? success(item) : notFound());
      }
      if (tail.length === 2 && method === "POST") {
        state.gateways.set(body.id, structuredClone(body));
        return json(res, success(structuredClone(body)));
      }
    }

    if (tail[0] === "access" && tail[1] === "apps") {
      if (tail.length === 2 && method === "GET") return json(res, success([...state.accessApps.values()]));
      if (tail.length === 2 && method === "POST") {
        const id = nextId("access-app");
        const { policies = [], ...applicationBody } = body;
        const application = { id, aud: body.aud ?? (body.destinations?.[0]?.uri?.endsWith("/mcp") ? "mcp-generated-audience" : "owner-generated-audience"), ...structuredClone(applicationBody) };
        state.accessApps.set(id, application);
        state.accessPolicies.set(id, policies.map((policy) => ({ id: nextId("access-policy"), ...structuredClone(policy), exclude: [], require: [] })));
        return json(res, success(application));
      }
      if (tail.length === 4 && tail[3] === "policies" && method === "GET") {
        return json(res, success(state.accessPolicies.get(tail[2]) ?? []));
      }
      if (tail.length === 4 && tail[3] === "policies" && method === "POST") {
        const policy = { id: nextId("access-policy"), ...structuredClone(body), exclude: [], require: [] };
        const list = state.accessPolicies.get(tail[2]) ?? [];
        list.push(policy);
        state.accessPolicies.set(tail[2], list);
        return json(res, success(policy));
      }
    }

    if (tail[0] === "access" && tail[1] === "service_tokens") {
      if (tail.length === 3 && method === "GET") {
        const item = state.serviceTokens.get(tail[2]);
        return json(res, item ? success(structuredClone(item)) : notFound("service token not found"));
      }
    }

    return json(res, notFound(`${method} ${url.pathname}`));
  } catch (error) {
    json(res, { status: 500, payload: { success: false, errors: [{ message: error instanceof Error ? error.stack : String(error) }] } });
  }
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
assert(address && typeof address === "object");
const apiBase = `http://127.0.0.1:${address.port}/client/v4`;
const commonEnv = {
  ...process.env,
  CLOUDFLARE_ACCOUNT_ID: accountId,
  CLOUDFLARE_API_TOKEN: "mock-token",
  CLOUDFLARE_API_BASE_URL: apiBase,
  ELIOTR_ACCESS_HOSTNAME: accessHostname,
  ELIOTR_OWNER_EMAILS: ownerEmail,
  ELIOTR_ENVIRONMENT: "staging",
  ELIOTR_DEPLOYMENT_GENERATION: "mock-generation",
  ELIOTR_CUSTOM_DOMAIN: "1",
  // Isolated scratch state: spawned children never touch the shared
  // gitignored .eliotr-state.
  ELIOTR_STATE_DIRECTORY: isolatedStateDirectory,
  // Mocked Access authority (Access-first order): core apply refuses
  // foundation mutations without a verified AUD/team origin, so the harness
  // establishes the fictional authority the same way
  // test-deployment-orchestration.mjs does — no live calls, no credentials.
  ELIOTR_ACCESS_TEAM_DOMAIN: "https://mock-team-example.cloudflareaccess.com",
  ELIOTR_ACCESS_AUDIENCE: "mock-access-audience",
  ELIOTR_ACCESS_SERVICE_PRINCIPALS: "eliotr-federation,eliotr-agent",
};

function run(script, args = [], env = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [resolve(repositoryRoot, script), ...args], {
      cwd: repositoryRoot,
      env: { ...commonEnv, ...env },
      stdio: ["ignore", "pipe", "pipe"],
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
      resolveRun({ status: null, signal: null, stdout, stderr: `${stderr}${error.stack ?? error}` });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      resolveRun({ status, signal, stdout, stderr });
    });
  });
}
function expectPass(result, label) {
  assert.equal(result.status, 0, `${label} failed (signal=${result.signal ?? "none"})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}
function expectFail(result, label) {
  assert.notEqual(result.status, 0, `${label} unexpectedly passed\nstdout:\n${result.stdout}`);
}
function mutationCount() { return state.mutations.length; }
function reset() { state = emptyState(); }

try {
  await rm(generatedConfigPath, { force: true });
  await rm(isolatedStateDirectory, { recursive: true, force: true });
  await mkdir(isolatedStateDirectory, { recursive: true });

  // Poisoned ambient env alone can never admit: a real-shaped static token
  // plus every legacy seam name and the shim-only variable (garbage value: if
  // production read it, it would throw MALFORMED instead of sealing) with no
  // explicit capability must be denied before the first Cloudflare call.
  reset();
  {
    const poisoned = await run("scripts/provision-cloudflare-core.mjs", [], {
      ELIOTR_TEST_USAGE_SNAPSHOT_JSON: JSON.stringify({ protocol: "eliotr.cloudflare-usage-snapshot.v1" }),
      ELIOTR_TEST_WRANGLER_WHOAMI_OUTPUT: `Account ${accountId} via browser OAuth`,
      ELIOTR_TEST_SPAWN_SNAPSHOT_JSON: "not-json-at-all",
    });
    expectFail(poisoned, "poisoned-env core apply");
    assert.match(poisoned.stderr, /SEALED/u, "poisoned env was not SEALED");
    assert.equal(mutationCount(), 0, "poisoned env mutated");
    assert.equal(state.requests.length, 0, "poisoned env contacted Cloudflare");
  }

  // FIX9WC NODE_OPTIONS-only loader injection denial: spawning the REAL
  // preflight CLI with NODE_OPTIONS=--import <shim> plus the snapshot variable
  // and NO --import on argv must stay SEALED with zero mutations. Node
  // auto-loads NODE_OPTIONS loader tokens at startup, so without the Layer 1
  // refusal this would admit through the test standin. The fixture below is
  // genuinely admittable (proven by the control), so SEALED proves refusal.
  function admittableSpawnSnapshot() {
    const at = Date.now();
    return JSON.stringify({
      protocol: "eliotr.cloudflare-usage-snapshot.v1",
      account_id_digest: digestAccountId(accountId),
      account_ref: "cloudflare-account:mock-a…ount",
      collected_at: new Date(at - 60_000).toISOString(),
      window: monthlyWindowFor(at),
      daily_window: dailyWindowFor(at),
      source: "test-fixture",
      readback: { whoami_verified: true },
      metrics: {
        workers_requests: 100, workers_cpu_ms: 100,
        d1_storage_bytes: 100, d1_rows_read: 100, d1_rows_written: 100,
        r2_storage_gb_month: 1, r2_class_a_ops: 100, r2_class_b_ops: 100,
        queue_ops: 100, do_requests: 100, do_gb_seconds: 100,
        do_sql_reads: 100, do_sql_writes: 100, do_storage_bytes: 100,
        workers_ai_neurons_per_day: 100, ai_search_instances: 5,
        ai_search_queries_month: 100,
        vectorize_queried_dims_month: 100, vectorize_stored_dims_month: 100,
      },
    });
  }
  reset();
  {
    const fixture = admittableSpawnSnapshot();
    assert.equal(evaluateUsageSnapshot(JSON.parse(fixture),
      { expectedAccountDigest: digestAccountId(accountId), now: Date.now() }).decision,
      "ADMITTED", "denial fixture must be admittable for the control to be load-bearing");
    const shimHref = pathToFileURL(resolve(repositoryRoot, "scripts/test-usage-gate-shim.mjs")).href;
    const attacked = await run("scripts/check-cloudflare-usage-preflight.mjs", ["--check-only"], {
      NODE_OPTIONS: `--import ${shimHref}`,
      ELIOTR_TEST_SPAWN_SNAPSHOT_JSON: fixture,
    });
    assert.equal(attacked.status, 0,
      `env-only loader injection must stay SEALED (exit 0)\nstdout:\n${attacked.stdout}\nstderr:\n${attacked.stderr}`);
    assert.equal(JSON.parse(attacked.stdout).decision, "SEALED", "env-only loader injection admitted");
    assert.match(attacked.stderr, /SEALED/u, "env-only loader injection hid its decision");
    assert.equal(mutationCount(), 0, "env-only loader injection mutated");
    assert.equal(state.requests.length, 0, "env-only loader injection contacted Cloudflare");
  }

  // FIX9WC Layer 2 unit tests (denial of loader injection): only
  // --import/--loader/--experimental-loader/--require plus their values are
  // stripped; benign flags pass through intact; missing stays missing.
  {
    assert.equal(nodeOptionsHasLoaderToken(undefined), false);
    assert.equal(nodeOptionsHasLoaderToken(""), false);
    assert.equal(nodeOptionsHasLoaderToken("--max-old-space-size=4096 --trace-warnings"), false);
    assert.equal(nodeOptionsHasLoaderToken("--import ./shim.mjs"), true);
    assert.equal(nodeOptionsHasLoaderToken("--import=./shim.mjs"), true);
    assert.equal(nodeOptionsHasLoaderToken("--loader ./a.mjs --trace-warnings"), true);
    assert.equal(nodeOptionsHasLoaderToken("--experimental-loader ./b.mjs"), true);
    assert.equal(nodeOptionsHasLoaderToken("--require some-module"), true);
    assert.equal(nodeOptionsHasLoaderToken("-r some-module"), true);
    // Windows-relevant and case-variant regressions: attached-short values,
    // case-variant heads, and fuzzy loader-like spellings are never benign
    // (Node itself rejects some of these pre-execution; the detector still
    // refuses to call them benign).
    assert.equal(nodeOptionsHasLoaderToken("-rC:\\path"), true);
    assert.equal(nodeOptionsHasLoaderToken("--IMPORT"), true);
    assert.equal(nodeOptionsHasLoaderToken("--Require"), true);
    assert.equal(nodeOptionsHasLoaderToken("--IMPORT x"), true);
    assert.equal(nodeOptionsHasLoaderToken("--Require x"), true);
    assert.equal(nodeOptionsHasLoaderToken("--importt ./shim.mjs"), true);
    assert.equal(nodeOptionsHasLoaderToken("--requier some-module"), true);
    assert.equal(nodeOptionsHasLoaderToken("--LOADR ./shim.mjs"), true);
    assert.equal(stripNodeOptionsLoaderTokens(undefined), undefined);
    assert.equal(stripNodeOptionsLoaderTokens("--max-old-space-size=4096 --trace-warnings"),
      "--max-old-space-size=4096 --trace-warnings");
    assert.equal(stripNodeOptionsLoaderTokens("--import ./shim.mjs --max-old-space-size=4096"),
      "--max-old-space-size=4096");
    assert.equal(stripNodeOptionsLoaderTokens("--import=./shim.mjs --max-old-space-size=4096"),
      "--max-old-space-size=4096");
    assert.equal(stripNodeOptionsLoaderTokens("--loader ./a.mjs --experimental-loader ./b.mjs --require c --trace-warnings"),
      "--trace-warnings");
    assert.equal(stripNodeOptionsLoaderTokens("--import ./shim.mjs"), "");
    // Attached-short, case-variant, and fuzzy forms strip to nothing (or to
    // the surviving benign flags), and genuinely benign flags — including
    // Windows paths — survive byte-wise.
    assert.equal(stripNodeOptionsLoaderTokens("-rC:\\path"), "");
    assert.equal(stripNodeOptionsLoaderTokens("--IMPORT ./shim.mjs --max-old-space-size=4096"), "--max-old-space-size=4096");
    assert.equal(stripNodeOptionsLoaderTokens("--Require some-module"), "");
    assert.equal(stripNodeOptionsLoaderTokens("--importt ./shim.mjs --trace-warnings"), "--trace-warnings");
    assert.equal(stripNodeOptionsLoaderTokens("--cpu-prof-dir C:\\prof --max-old-space-size=4096"), "--cpu-prof-dir C:\\prof --max-old-space-size=4096");
    const scrubbed = scrubTokenEnv({ CLOUDFLARE_API_TOKEN: "secret",
      NODE_OPTIONS: "--import ./shim.mjs --max-old-space-size=4096" });
    assert.equal(scrubbed.CLOUDFLARE_API_TOKEN, undefined);
    assert.equal(scrubbed.NODE_OPTIONS, "--max-old-space-size=4096");
    assert.equal("NODE_OPTIONS" in scrubTokenEnv({ NODE_OPTIONS: "--require some-module" }), false);
    const untouched = scrubTokenEnv({ A: "1" });
    assert.equal("NODE_OPTIONS" in untouched, false);
    assert.equal(untouched.A, "1");
  }

  // Check-only must be globally side-effect free when every resource is missing.
  // (Api-token mode seals here, so this also proves SEALED check-only stays
  // read-only metadata with zero mutations.)
  reset();
  for (const script of [
    "scripts/provision-cloudflare-core.mjs",
    "scripts/provision-ai-search.mjs",
    "scripts/provision-ai-gateways.mjs",
    "scripts/provision-cloudflare-access.mjs",
  ]) {
    expectPass(await run(script, ["--check-only"]), `${script} --check-only`);
  }
  assert.equal(mutationCount(), 0, "check-only sent a mutating request");

  // SEALED denies every direct apply path before the first Cloudflare call:
  // no POST/PUT/PATCH/DELETE, no Worker upload, no migration — not even a GET.
  reset();
  for (const script of [
    "scripts/provision-cloudflare-core.mjs",
    "scripts/provision-ai-search.mjs",
    "scripts/provision-cloudflare-access.mjs",
    "scripts/provision-ai-gateways.mjs",
  ]) {
    const sealed = await run(script);
    expectFail(sealed, `SEALED ${script} apply`);
    assert.match(sealed.stderr, /SEALED/u, `${script} SEALED apply hid its decision`);
  }
  assert.equal(mutationCount(), 0, "SEALED apply sent a mutating request");
  assert.equal(state.requests.length, 0, "SEALED apply contacted Cloudflare");

  // FIX11: ADMITTED without a capability denies every direct apply path too.
  // The child runs under the test-only --import gate with a genuinely
  // admittable fixture, so evaluation is ADMITTED — but with capability
  // minting suppressed (standin-only seam, unreachable from production) no
  // capability exists, and apply must deny before the first Cloudflare call
  // with an explicit capability message and zero mutations.
  reset();
  {
    const fixture = admittableSpawnSnapshot();
    assert.equal(evaluateUsageSnapshot(JSON.parse(fixture),
      { expectedAccountDigest: digestAccountId(accountId), now: Date.now() }).decision,
      "ADMITTED", "capability-denial fixture must be admittable for the control to be load-bearing");
    const shimHref = pathToFileURL(resolve(repositoryRoot, "scripts/test-usage-gate-shim.mjs")).href;
    const runGated = (script, extraEnv = {}) => new Promise((resolveRun) => {
      const child = spawn(process.execPath,
        ["--import", shimHref, resolve(repositoryRoot, script)],
        {
          cwd: repositoryRoot,
          env: {
            ...commonEnv,
            ...extraEnv,
            ELIOTR_TEST_SPAWN_SNAPSHOT_JSON: fixture,
            ELIOTR_TEST_SPAWN_SUPPRESS_CAPABILITY: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
      child.on("close", (status, signal) => {
        clearTimeout(timeout);
        resolveRun({ status, signal, stdout, stderr });
      });
    });
    for (const script of [
      "scripts/provision-cloudflare-core.mjs",
      "scripts/provision-ai-search.mjs",
      "scripts/provision-cloudflare-access.mjs",
      "scripts/provision-ai-gateways.mjs",
    ]) {
      const denied = await runGated(script);
      expectFail(denied, `capability-less ADMITTED ${script} apply`);
      assert.match(denied.stderr, /admission capability/u, `${script} capability denial hid its reason`);
      assert.equal(mutationCount(), 0, `capability-less ADMITTED ${script} apply mutated`);
      assert.equal(state.requests.length, 0, `capability-less ADMITTED ${script} apply contacted Cloudflare`);
    }
  }

  // Route/Access mismatch is rejected before the first Cloudflare read or mutation.
  reset();
  expectFail(
    await run("scripts/provision-cloudflare-core.mjs", ["--check-only"], { ELIOTR_CUSTOM_DOMAIN: "0" }),
    "workers.dev route mismatch rejection",
  );
  assert.equal(state.requests.length, 0, "invalid public-route mode contacted Cloudflare");
  assert.equal(mutationCount(), 0);

  // Foundation plan exposes exact CREATE dispositions with zero mutations.
  // Apply without usage admission stays SEALED before the first call:
  // fixture env can no longer admit (see the poisoned block above), and no
  // explicit provider capability crosses a process boundary.
  reset();
  {
    const plan = await run("scripts/provision-cloudflare-core.mjs", ["--check-only"]);
    expectPass(plan, "foundation check-only plan");
    const parsed = JSON.parse(plan.stdout);
    assert.equal(parsed.mode, "CHECK_ONLY_NO_MUTATION");
    assert.ok(parsed.d1_databases.every((item) => item.disposition === "CREATE"));
    assert.ok(parsed.r2_buckets.every((item) => item.disposition === "CREATE"));
    assert.equal(mutationCount(), 0, "foundation plan mutated");
    const denied = await run("scripts/provision-cloudflare-core.mjs", []);
    expectFail(denied, "foundation apply without admission");
    assert.match(denied.stderr, /SEALED/u);
    assert.equal(mutationCount(), 0, "foundation apply without admission mutated");
    assert.equal(await readFile(canonicalConfigPath, "utf8"), canonicalConfigBefore, "canonical wrangler config was mutated");
    assert.equal(await exists(generatedConfigPath), false, "apply without admission generated config");
  }

  // Missing stable IDs are unsafe even when names match.
  reset();
  state.d1.set("eliotr-core", { name: "eliotr-core" });
  expectFail(await run("scripts/provision-cloudflare-core.mjs", ["--check-only"]), "D1 missing uuid rejection");
  assert.equal(mutationCount(), 0);

  // Immutable AI Search drift fails the plan before mutation; apply without
  // admission stops at the usage gate first (SEALED), also with zero
  // mutations.
  reset();
  state.aiNamespace = { id: "namespace-1", name: aiSearchDesired.namespace };
  const driftSpec = aiSearchDesired.instances[0];
  assert(driftSpec, "AI Search desired state must contain an instance");
  state.aiInstances.set(driftSpec.id, {
    ...structuredClone(driftSpec.create),
    embedding_model: "@cf/incompatible/model",
  });
  expectFail(await run("scripts/provision-ai-search.mjs", ["--check-only"]), "AI Search drift check-only");
  const driftApply = await run("scripts/provision-ai-search.mjs", []);
  expectFail(driftApply, "AI Search drift apply");
  assert.match(driftApply.stderr, /SEALED/u, "AI Search apply without admission hid its decision");
  assert.equal(mutationCount(), 0, "AI Search drift path mutated resources");

  // An undeclared Access policy can broaden access and must block both modes before mutation.
  reset();
  const appId = "access-app-existing";
  const appName = `Eliot Research: ${accessHostname}`;
  state.accessApps.set(appId, {
    id: appId,
    type: "self_hosted",
    name: appName,
    domain: accessHostname,
    destinations: [{ type: "public", uri: accessHostname }],
    session_duration: "24h",
    app_launcher_visible: false,
  });
  state.accessPolicies.set(appId, [
    { id: "owner-policy", name: "Eliot Research owners", decision: "allow", include: [{ email: { email: ownerEmail } }], exclude: [], require: [] },
    { id: "unexpected-policy", name: "Everyone", decision: "allow", include: [{ everyone: {} }], exclude: [], require: [] },
  ]);
  expectFail(await run("scripts/provision-cloudflare-access.mjs", ["--check-only"]), "Access extra policy check-only");
  const extraPolicyApply = await run("scripts/provision-cloudflare-access.mjs", []);
  expectFail(extraPolicyApply, "Access extra policy apply");
  assert.match(extraPolicyApply.stderr, /SEALED/u, "Access apply without admission hid its decision");
  assert.equal(mutationCount(), 0, "Access drift path mutated resources");

  // A clean hostname-based Access contour plans one atomic CREATE with zero
  // mutations; apply without admission stays denied before any mutation.
  reset();
  {
    const plan = await run("scripts/provision-cloudflare-access.mjs", ["--check-only"]);
    expectPass(plan, "Access check-only plan");
    assert.equal(mutationCount(), 0, "Access plan mutated");
    const denied = await run("scripts/provision-cloudflare-access.mjs", []);
    expectFail(denied, "Access apply without admission");
    assert.match(denied.stderr, /SEALED/u);
    assert.equal(mutationCount(), 0, "Access apply without admission mutated");
  }

  // Selected Gemini MCP performs a complete GET-only preflight. A CREATE plan
  // keeps Cloudflare's future MCP AUD unknown, while the service-token UUID
  // policy selector and signed .access Client ID are checked independently.
  reset();
  const serviceTokenId = "123e4567-e89b-12d3-a456-426614174000";
  state.serviceTokens.set(serviceTokenId, { id: serviceTokenId, client_id: "mcp-client.access" });
  {
    const plan = await run("scripts/provision-cloudflare-access.mjs", ["--check-only"], {
      ELIOTR_GOOGLE_EXTERNAL_TRANSPORT: "gemini-mcp",
      ELIOTR_MCP_ACCESS_AUTH_PROFILE: "service-token",
      ELIOTR_MCP_ACCESS_SERVICE_TOKEN_ID: serviceTokenId,
      ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: "mcp-client.access",
    });
    expectPass(plan, "MCP service-token CREATE plan");
    const parsed = JSON.parse(plan.stdout);
    assert.equal(parsed.mcp.auth_profile, "service-token");
    assert.equal(parsed.mcp.application.disposition, "CREATE");
    assert.equal(parsed.mcp.aud, null, "CREATE plan invented a future MCP AUD");
    assert.equal(mutationCount(), 0, "MCP CREATE plan mutated");
    assert.ok(state.requests.some((item) => item.pathname.endsWith(`/access/service_tokens/${serviceTokenId}`)), "MCP preflight did not read the exact service-token record");
  }

  // A mismatched generated Client ID is rejected from the exact service-token
  // readback before any owner or MCP POST can occur.
  reset();
  state.serviceTokens.set(serviceTokenId, { id: serviceTokenId, client_id: "different-client.access" });
  const tokenMismatch = await run("scripts/provision-cloudflare-access.mjs", ["--check-only"], {
    ELIOTR_GOOGLE_EXTERNAL_TRANSPORT: "gemini-mcp",
    ELIOTR_MCP_ACCESS_AUTH_PROFILE: "service-token",
    ELIOTR_MCP_ACCESS_SERVICE_TOKEN_ID: serviceTokenId,
    ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: "mcp-client.access",
  });
  expectFail(tokenMismatch, "MCP service-token readback mismatch");
  assert.equal(mutationCount(), 0, "MCP token mismatch mutated");

  // Managed OAuth is a separate profile: it enables the managed OAuth app
  // contour and rejects service-token inputs without borrowing ordinary AUD.
  reset();
  {
    const plan = await run("scripts/provision-cloudflare-access.mjs", ["--check-only"], {
      ELIOTR_GOOGLE_EXTERNAL_TRANSPORT: "gemini-mcp",
      ELIOTR_MCP_ACCESS_AUTH_PROFILE: "managed-oauth",
    });
    expectPass(plan, "MCP managed-oauth CREATE plan");
    const parsed = JSON.parse(plan.stdout);
    assert.equal(parsed.mcp.auth_profile, "managed-oauth");
    assert.equal(parsed.mcp.oauth_configuration_enabled, true);
    assert.equal(parsed.mcp.aud, null, "managed CREATE plan invented a future MCP AUD");
    assert.equal(mutationCount(), 0, "managed MCP CREATE plan mutated");
  }

  console.log("Cloudflare provisioner mock conformance: PASS");
  console.log("- check-only mutations: 0");
  console.log("- poisoned ambient env: SEALED BEFORE FIRST CALL, zero mutations");
  console.log("- NODE_OPTIONS-only loader injection: SEALED BEFORE FIRST CALL, zero mutations");
  console.log("- NODE_OPTIONS stripping: loader tokens removed, benign flags intact, missing stays missing");
  console.log("- SEALED direct apply: DENIED BEFORE FIRST CALL (core, ai-search, access, gateways)");
  console.log("- public route / Access hostname alignment: PASS");
  console.log("- foundation plan/create dispositions: PASS (apply gated by usage admission)");
  console.log("- missing stable resource IDs: REJECTED");
  console.log("- immutable AI Search drift: REJECTED BEFORE MUTATION");
  console.log("- undeclared Access policy: REJECTED BEFORE MUTATION");
  console.log("- hostname Access plan: PASS (apply gated by usage admission)");
  console.log("- MCP service-token exact ID/Client ID readback: PASS");
  console.log("- MCP managed-oauth CREATE plan: PASS (AUD generated on create)");
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(generatedConfigPath, { force: true });
  await rm(isolatedStateDirectory, { recursive: true, force: true });
  if (generatedConfigBackedUp) {
    await mkdir(dirname(generatedConfigPath), { recursive: true });
    await rename(backupGeneratedConfigPath, generatedConfigPath);
  }
  await rm(backupRoot, { recursive: true, force: true });
}
