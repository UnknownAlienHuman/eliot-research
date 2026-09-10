// OAuth direct-preflight proof: ELIOTR_CLOUDFLARE_AUTH_MODE=wrangler-oauth with
// empty CLOUDFLARE_API_TOKEN plus a mock Wrangler credential succeeds on the
// --check-only (GET-only, zero-mutation) path for all four provisioners, while
// missing/expired/wrong-account fail closed with a `wrangler login`
// instruction. Fully mocked localhost; no live Cloudflare writes.
//
// Bearer travels ONLY via process memory (OAuth file -> env injection). Every
// happy path asserts the mock saw `Authorization: Bearer <mock>` while stdout,
// stderr, argv and any receipts never contain the bearer.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BEARER = "oauth-preflight-proof-bearer-9d4e2a1f";
const ACCOUNT = "oauth-preflight-account";
const HOSTNAME = "eliotr-core.oauth-preflight-example.workers.dev";
const OWNER = "owner@oauth-preflight.example";
const TEAM_HOST = "oauth-preflight.cloudflareaccess.com";
const FUTURE = "2030-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

const state = { requests: [], mutations: [], authSeen: [] };
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
    await bodyJson(req);
    const auth = req.headers.authorization ?? null;
    if (auth) state.authSeen.push(auth);
    state.requests.push({ method: req.method ?? "GET", pathname: url.pathname });
    if ((req.method ?? "GET") !== "GET") state.mutations.push({ method: req.method, pathname: url.pathname });
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const accountIndex = parts.indexOf("accounts");
    const tail = parts.slice(accountIndex + 2);
    if (tail[0] === "access" && tail[1] === "organizations") return json(res, success([{ auth_domain: TEAM_HOST }]));
    if (tail[0] === "access" && tail[1] === "apps" && tail.length === 2) return json(res, success([]));
    if (tail[0] === "d1") return json(res, success([]));
    if (tail[0] === "queues") return json(res, success([]));
    // R2 bucket GET, AI Search namespace/instance GET, AI Gateway GET: absent.
    return json(res, failure(404, "not found"));
  } catch (error) {
    json(res, { status: 500, payload: { success: false, errors: [{ message: String(error) }] } });
  }
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
assert(address && typeof address === "object");
const apiBase = `http://127.0.0.1:${address.port}/client/v4`;

// Backup the generated config so the proof never pollutes the worktree.
// Receipt state is isolated via ELIOTR_STATE_DIRECTORY (temp, per-run):
// spawned children never touch the shared gitignored .eliotr-state.
const generatedConfigPath = resolve(repositoryRoot, "apps/eliotr-core/wrangler.deploy.jsonc");
const isolatedStateDirectory = await mkdtemp(join(tmpdir(), "oauth-preflight-state-"));
const backupRoot = resolve(repositoryRoot, `.eliotr-oauth-preflight-backup-${process.pid}`);
async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}
let generatedBackedUp = false;
if (await exists(generatedConfigPath)) {
  await mkdir(backupRoot, { recursive: true });
  await rename(generatedConfigPath, resolve(backupRoot, "wrangler.deploy.jsonc"));
  generatedBackedUp = true;
}

const credentialDir = await mkdtemp(join(tmpdir(), "wrangler-oauth-proof-"));
const validCredentialPath = join(credentialDir, "default.toml");
const expiredCredentialPath = join(credentialDir, "expired.toml");
await writeFile(validCredentialPath, `oauth_token = "${BEARER}"\nrefresh_token = "proof-refresh"\nexpiration_time = "${FUTURE}"\n`);
await writeFile(expiredCredentialPath, `oauth_token = "${BEARER}"\nexpiration_time = "${PAST}"\n`);

// Fake `pnpm` earlier on PATH so the official `pnpm exec wrangler whoami`
// verification spawn resolves to this shim (no ambient whoami seam in
// production code). Only `exec wrangler whoami` is implemented; anything
// else exits 1. Output is rewritten per case (serial runs only).
const fakeBinDir = await mkdtemp(join(tmpdir(), "fake-pnpm-"));
async function setFakeWhoami(output) {
  const line = String(output).replace(/"/gu, "");
  await writeFile(join(fakeBinDir, "pnpm.cmd"), `@echo off\r\nif "%1"=="exec" if "%2"=="wrangler" if "%3"=="whoami" (\r\n  echo ${line}\r\n  exit /b 0\r\n)\r\necho unexpected pnpm invocation: %* 1>&2\r\nexit /b 1\r\n`);
  await writeFile(join(fakeBinDir, "pnpm"), `#!/bin/sh\nif [ "$1" = "exec" ] && [ "$2" = "wrangler" ] && [ "$3" = "whoami" ]; then\n  echo "${line}"\n  exit 0\nfi\necho "unexpected pnpm invocation: $*" >&2\nexit 1\n`);
  // Same Linux determinism as test-usage-preflight-children: +x required,
  // otherwise the real wrangler runs and the test becomes env-dependent.
  await chmod(join(fakeBinDir, "pnpm"), 0o755);
}
await setFakeWhoami(`Account ${ACCOUNT} via browser OAuth`);
const fakePath = `${fakeBinDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`;

function baseEnv(overrides = {}) {
  return {
    ...process.env,
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    CLOUDFLARE_API_TOKEN: "",
    CLOUDFLARE_API_BASE_URL: apiBase,
    ELIOTR_CLOUDFLARE_AUTH_MODE: "wrangler-oauth",
    ELIOTR_WRANGLER_CONFIG_FILE: validCredentialPath,
    ELIOTR_STATE_DIRECTORY: isolatedStateDirectory,
    PATH: fakePath,
    ELIOTR_ACCESS_HOSTNAME: HOSTNAME,
    ELIOTR_OWNER_EMAILS: OWNER,
    ELIOTR_ACCESS_TEAM_DOMAIN: "",
    ELIOTR_ACCESS_AUDIENCE: "",
    ELIOTR_ENVIRONMENT: "staging",
    ELIOTR_DEPLOYMENT_GENERATION: "git-oauth-proof",
    ELIOTR_CUSTOM_DOMAIN: "0",
    ...overrides,
  };
}

function run(script, args = [], env = {}) {
  return new Promise((resolveRun) => {
    const argv = [resolve(repositoryRoot, script), ...args];
    const child = spawn(process.execPath, argv, {
      cwd: repositoryRoot, env: { ...baseEnv(), ...env }, stdio: ["ignore", "pipe", "pipe"],
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
// Same narrow Windows Node-teardown tolerance as the integration suite: exact
// crash status + exact libuv assertion, plus a fully parsed CHECK_ONLY plan
// and zero mutations asserted by every caller below.
const WIN_STATUS = 3221226505;
const WIN_STDERR = /Assertion failed: !\(handle->flags & UV_HANDLE_CLOSING\)/u;
const expectPlanPass = (result, label) => {
  let plan;
  try { plan = JSON.parse(result.stdout); } catch { plan = null; }
  assert.ok(plan, `${label} printed no parseable plan\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.equal(plan.mode, "CHECK_ONLY_NO_MUTATION", `${label} is not check-only`);
  assert.ok(result.status === 0 || (result.status === WIN_STATUS && WIN_STDERR.test(result.stderr)),
    `${label} failed unexpectedly (status=${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return plan;
};
const check = async (name, action) => { await action(); cases += 1; console.log(`OAuth preflight proof: ${name}: PASS`); };

try {
  const scripts = [
    "scripts/provision-cloudflare-access.mjs",
    "scripts/provision-cloudflare-core.mjs",
    "scripts/provision-ai-search.mjs",
    "scripts/provision-ai-gateways.mjs",
  ];
  for (const script of scripts) {
    await check(`${script} oauth check-only succeeds with zero mutations`, async () => {
      state.requests.length = 0;
      state.mutations.length = 0;
      state.authSeen.length = 0;
      const result = await run(script, ["--check-only"]);
      const plan = expectPlanPass(result, script);
      assert.ok(typeof plan.protocol === "string");
      assert.equal(state.mutations.length, 0, `${script} mutated during check-only`);
      assert.ok(state.authSeen.length > 0, `${script} sent no authenticated GET`);
      assert.ok(state.authSeen.every((header) => header === `Bearer ${BEARER}`), `${script} used wrong bearer`);
      noBearer(result.stdout, `${script} stdout`);
      noBearer(result.stderr, `${script} stderr`);
      noBearer(result.argv, `${script} argv`);
      assert.ok(await exists(isolatedStateDirectory), "isolated state dir missing");
    });
  }

  await check("missing OAuth credential fails closed with login instruction", async () => {
    const beforeRequests = state.requests.length;
    const beforeMutations = state.mutations.length;
    const result = await run("scripts/provision-cloudflare-access.mjs", ["--check-only"],
      { ELIOTR_WRANGLER_CONFIG_FILE: join(credentialDir, "does-not-exist.toml") });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /wrangler login/u);
    assert.equal(state.mutations.length, beforeMutations);
    assert.equal(state.requests.length, beforeRequests, "missing credential contacted the API");
    noBearer(result.stderr, "missing-credential stderr");
  });

  await check("expired OAuth credential fails closed with login instruction", async () => {
    const beforeRequests = state.requests.length;
    const beforeMutations = state.mutations.length;
    const result = await run("scripts/provision-cloudflare-core.mjs", ["--check-only"],
      { ELIOTR_WRANGLER_CONFIG_FILE: expiredCredentialPath });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /wrangler login/u);
    assert.equal(state.mutations.length, beforeMutations);
    assert.equal(state.requests.length, beforeRequests, "expired credential contacted the API");
    noBearer(result.stderr, "expired-credential stderr");
  });

  await check("wrong-account OAuth profile fails closed with login instruction", async () => {
    const beforeMutations = state.mutations.length;
    await setFakeWhoami("Account other-account via browser OAuth");
    let result;
    try {
      result = await run("scripts/provision-ai-gateways.mjs", ["--check-only"]);
    } finally {
      await setFakeWhoami(`Account ${ACCOUNT} via browser OAuth`);
    }
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /mismatch|wrangler login/u);
    assert.equal(state.mutations.length, beforeMutations);
    noBearer(result.stderr, "wrong-account stderr");
  });

  // Check-only purity: no receipt or generated config may appear.
  assert.ok(!(await exists(join(isolatedStateDirectory, "cloudflare-access-receipt.json"))), "access receipt written during check-only");
  assert.ok(!(await exists(join(isolatedStateDirectory, "cloudflare-foundation-receipt.json"))), "foundation receipt written during check-only");
  console.log(`OAuth preflight proof: ${cases} groups passed; live Cloudflare NOT_EXECUTED`);
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(generatedConfigPath, { force: true });
  await rm(isolatedStateDirectory, { recursive: true, force: true });
  await rm(credentialDir, { recursive: true, force: true });
  await rm(fakeBinDir, { recursive: true, force: true });
  if (generatedBackedUp) {
    await mkdir(dirname(generatedConfigPath), { recursive: true });
    await rename(resolve(backupRoot, "wrangler.deploy.jsonc"), generatedConfigPath);
  }
  await rm(backupRoot, { recursive: true, force: true });
}
