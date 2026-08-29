import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const accountId = "mock-account";
const accessHostname = "research.example.test";
const ownerEmail = "owner@example.test";
const generatedConfigPath = resolve(repositoryRoot, "apps/eliotr-core/wrangler.deploy.jsonc");
const stateDirectory = resolve(repositoryRoot, ".eliotr-state");
const canonicalConfigPath = resolve(repositoryRoot, "apps/eliotr-core/wrangler.jsonc");
const canonicalConfigBefore = await readFile(canonicalConfigPath, "utf8");
const backupRoot = resolve(repositoryRoot, `.eliotr-provisioner-test-backup-${process.pid}`);
const backupGeneratedConfigPath = resolve(backupRoot, "wrangler.deploy.jsonc");
const backupStateDirectory = resolve(backupRoot, "state");
let generatedConfigBackedUp = false;
let stateDirectoryBackedUp = false;
async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}
if (await exists(generatedConfigPath)) {
  await mkdir(backupRoot, { recursive: true });
  await rename(generatedConfigPath, backupGeneratedConfigPath);
  generatedConfigBackedUp = true;
}
if (await exists(stateDirectory)) {
  await mkdir(backupRoot, { recursive: true });
  await rename(stateDirectory, backupStateDirectory);
  stateDirectoryBackedUp = true;
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
        const application = { id, ...structuredClone(applicationBody) };
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
  await rm(stateDirectory, { recursive: true, force: true });

  // Check-only must be globally side-effect free when every resource is missing.
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

  // Route/Access mismatch is rejected before the first Cloudflare read or mutation.
  reset();
  expectFail(
    await run("scripts/provision-cloudflare-core.mjs", ["--check-only"], { ELIOTR_CUSTOM_DOMAIN: "0" }),
    "workers.dev route mismatch rejection",
  );
  assert.equal(state.requests.length, 0, "invalid public-route mode contacted Cloudflare");
  assert.equal(mutationCount(), 0);

  // Foundation provisioning creates exact resources once and generates only the ignored deploy config.
  reset();
  expectPass(await run("scripts/provision-cloudflare-core.mjs"), "foundation apply");
  assert.equal(mutationCount(), 6, "foundation must create exactly two D1, two R2 and two Queues");
  const generated = JSON.parse(await readFile(generatedConfigPath, "utf8"));
  assert.deepEqual(generated.d1_databases.map((item) => item.database_id), ["d1-1", "d1-2"]);
  assert.equal(await readFile(canonicalConfigPath, "utf8"), canonicalConfigBefore, "canonical wrangler config was mutated");
  const afterFirstFoundation = mutationCount();
  expectPass(await run("scripts/provision-cloudflare-core.mjs"), "foundation idempotent apply");
  assert.equal(mutationCount(), afterFirstFoundation, "second foundation apply created duplicate resources");

  // Missing stable IDs are unsafe even when names match.
  reset();
  state.d1.set("eliotr-core", { name: "eliotr-core" });
  expectFail(await run("scripts/provision-cloudflare-core.mjs", ["--check-only"]), "D1 missing uuid rejection");
  assert.equal(mutationCount(), 0);

  // Immutable AI Search drift fails in both plan and apply modes before mutation.
  reset();
  state.aiNamespace = { id: "namespace-1", name: "eliotr" };
  state.aiInstances.set("private-prose-g1", {
    id: "private-prose-g1",
    embedding_model: "@cf/incompatible/model",
    index_method: { vector: true, keyword: true },
    fusion_method: "rrf",
    indexing_options: { keyword_tokenizer: "porter" },
    retrieval_options: { keyword_match_mode: "and" },
    max_num_results: 50,
    reranking: true,
    reranking_model: "@cf/baai/bge-reranker-base",
  });
  expectFail(await run("scripts/provision-ai-search.mjs", ["--check-only"]), "AI Search drift check-only");
  expectFail(await run("scripts/provision-ai-search.mjs"), "AI Search drift apply");
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
  expectFail(await run("scripts/provision-cloudflare-access.mjs"), "Access extra policy apply");
  assert.equal(mutationCount(), 0, "Access drift path mutated resources");

  // A clean hostname-based Access contour creates once and verifies on repeat.
  reset();
  expectPass(await run("scripts/provision-cloudflare-access.mjs"), "Access apply");
  assert.equal(mutationCount(), 1, "Access app and inline owner policy should be one atomic create");
  const accessApp = [...state.accessApps.values()][0];
  assert(accessApp);
  assert.deepEqual(accessApp.destinations, [{ type: "public", uri: accessHostname }]);
  assert.equal((state.accessPolicies.get(accessApp.id) ?? []).length, 1);
  const afterFirstAccess = mutationCount();
  expectPass(await run("scripts/provision-cloudflare-access.mjs"), "Access idempotent apply");
  assert.equal(mutationCount(), afterFirstAccess, "second Access apply created duplicate state");

  console.log("Cloudflare provisioner mock conformance: PASS");
  console.log("- check-only mutations: 0");
  console.log("- public route / Access hostname alignment: PASS");
  console.log("- foundation create/idempotency: PASS");
  console.log("- missing stable resource IDs: REJECTED");
  console.log("- immutable AI Search drift: REJECTED BEFORE MUTATION");
  console.log("- undeclared Access policy: REJECTED BEFORE MUTATION");
  console.log("- hostname Access create/idempotency: PASS");
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(generatedConfigPath, { force: true });
  await rm(stateDirectory, { recursive: true, force: true });
  if (generatedConfigBackedUp) {
    await mkdir(dirname(generatedConfigPath), { recursive: true });
    await rename(backupGeneratedConfigPath, generatedConfigPath);
  }
  if (stateDirectoryBackedUp) {
    await rename(backupStateDirectory, stateDirectory);
  }
  await rm(backupRoot, { recursive: true, force: true });
}
