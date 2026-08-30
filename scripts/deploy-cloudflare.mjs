import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = resolve(root, "apps/eliotr-core");
const deployConfig = "wrangler.deploy.jsonc";
const confirmLive = process.argv.includes("--confirm-live") || process.env.ELIOTR_CONFIRM_LIVE_DEPLOY === "1";

function run(command, args, cwd = root, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function requiredEnvironment(names) {
  const missing = names.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    console.error(`Live deploy requires: ${missing.join(", ")}`);
    process.exit(2);
  }
}

async function cloudflareRequest(path) {
  const apiBase = process.env.CLOUDFLARE_API_BASE_URL ?? "https://api.cloudflare.com/client/v4";
  const response = await fetch(`${apiBase}${path}`, {
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    throw new Error(`Cloudflare readback ${path} failed (${response.status}): ${JSON.stringify(payload.errors ?? payload)}`);
  }
  return payload.result ?? payload;
}

async function readWorkerDeployment() {
  const accountId = encodeURIComponent(process.env.CLOUDFLARE_ACCOUNT_ID);
  const result = await cloudflareRequest(`/accounts/${accountId}/workers/scripts`);
  const workers = Array.isArray(result) ? result : [];
  const exact = workers.filter((worker) => worker.id === "eliotr-core");
  if (exact.length !== 1) throw new Error(`expected one deployed Worker eliotr-core, found ${exact.length}`);
  const worker = exact[0];
  return {
    id: worker.id,
    compatibility_date: worker.compatibility_date ?? null,
    modified_on: worker.modified_on ?? null,
    last_deployed_from: worker.last_deployed_from ?? null,
    has_assets: worker.has_assets ?? null,
    durable_object_export: worker.exports?.ResearchSession?.type ?? null,
  };
}

async function remoteHttpSmoke() {
  const base = process.env.ELIOTR_SMOKE_BASE_URL?.replace(/\/$/, "") ?? `https://${process.env.ELIOTR_ACCESS_HOSTNAME}`;
  const accessCookie = process.env.ELIOTR_ACCESS_SMOKE_COOKIE;
  if (!accessCookie) {
    return { state: "NOT_EXECUTED", reason: "ELIOTR_ACCESS_SMOKE_COOKIE is not set; no unauthenticated request is treated as a passing Access smoke." };
  }
  const results = [];
  for (const path of ["/healthz", "/api/v1/system/capabilities"]) {
    const response = await fetch(`${base}${path}`, {
      headers: { Cookie: `CF_Authorization=${accessCookie}` },
      redirect: "manual",
    });
    if (!response.ok) throw new Error(`Authenticated smoke ${path} failed: ${response.status}`);
    results.push({ path, status: response.status });
  }
  return { state: "PASS", results };
}

run("pnpm", ["check"]);
run("pnpm", ["build:pwa"]);
run("pnpm", ["--filter", "@eliotr/core", "cf:types"]);
run("pnpm", ["--filter", "@eliotr/core", "deploy:dry-run"]);

if (!confirmLive) {
  console.log("Dry-run gates passed. Re-run with --confirm-live (or ELIOTR_CONFIRM_LIVE_DEPLOY=1) for remote mutation.");
  process.exit(0);
}

requiredEnvironment([
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "ELIOTR_ACCESS_HOSTNAME",
  "ELIOTR_ACCESS_TEAM_DOMAIN",
  "ELIOTR_ACCESS_AUDIENCE",
  "ELIOTR_OWNER_EMAILS",
  "ELIOTR_CUSTOM_DOMAIN",
]);

if (!process.env.ELIOTR_DEPLOYMENT_GENERATION) {
  const gitRevision = capture("git", ["rev-parse", "--short=12", "HEAD"]);
  if (!gitRevision) {
    console.error("Set ELIOTR_DEPLOYMENT_GENERATION when the repository revision cannot be read from Git.");
    process.exit(2);
  }
  process.env.ELIOTR_DEPLOYMENT_GENERATION = `git-${gitRevision}`;
}
process.env.ELIOTR_ENVIRONMENT ??= "production";

// Cross-product preflight: detect all known immutable-profile/configuration drift before the first
// remote create. This cannot make Cloudflare APIs transactional, but it prevents predictable partial
// environments caused by discovering a later drift after earlier resources were created.
for (const script of [
  "scripts/provision-cloudflare-core.mjs",
  "scripts/provision-ai-search.mjs",
  "scripts/provision-ai-gateways.mjs",
  "scripts/provision-cloudflare-access.mjs",
]) {
  run("node", [script, "--check-only"]);
}

run("node", ["scripts/provision-cloudflare-core.mjs"]);
run("node", ["scripts/provision-ai-search.mjs"]);
run("node", ["scripts/provision-ai-gateways.mjs"]);
run("node", ["scripts/provision-cloudflare-access.mjs"]);

// D1 is explicitly provisioned and the generated config contains exact database IDs. Apply additive
// migrations before exposing the new Worker generation; a bootstrap deployment with an empty schema is
// neither needed nor allowed.
run("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "CORE_DB", "--remote", "--config", deployConfig], core);
run("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "SEARCH_DB", "--remote", "--config", deployConfig], core);
run("pnpm", ["exec", "wrangler", "deploy", "--config", deployConfig, "--keep-vars"], core);

const workerReadback = await readWorkerDeployment();
if (workerReadback.durable_object_export !== "durable-object") {
  throw new Error(`ResearchSession declarative Durable Object export missing after deploy: ${JSON.stringify(workerReadback)}`);
}
const generatedConfigBytes = await readFile(resolve(core, deployConfig));
const httpSmoke = await remoteHttpSmoke();

const receipt = {
  protocol: "eliotr.cloudflare-deployment-receipt.v1",
  deployment_generation: process.env.ELIOTR_DEPLOYMENT_GENERATION,
  environment: process.env.ELIOTR_ENVIRONMENT,
  worker: workerReadback,
  generated_config_sha256: createHash("sha256").update(generatedConfigBytes).digest("hex"),
  remote_http_smoke: httpSmoke,
  live_conformance: {
    d1_write_readback: "NOT_EXECUTED",
    r2_immutable_put_readback: "NOT_EXECUTED",
    queue_duplicate_delivery: "NOT_EXECUTED",
    durable_object_hibernation: "NOT_EXECUTED",
    workflow_retry_resume: "NOT_EXECUTED",
    ai_search_exact_resolution: "NOT_EXECUTED",
    google_drive_exchange: "NOT_EXECUTED",
  },
  note: "Deployment success is not T4/T6 conformance. Unexecuted live gates remain explicit.",
  created_at: new Date().toISOString(),
};
const receiptPath = resolve(root, ".eliotr-state/cloudflare-deployment-receipt.json");
await mkdir(dirname(receiptPath), { recursive: true });
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(receipt, null, 2));