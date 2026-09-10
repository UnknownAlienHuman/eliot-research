import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readDeploymentWorker, validateDeploymentInput, validateGeneratedDeployment,
  verifyDeploymentSmoke } from "./lib/deployment-verification.mjs";

import { assertLaunchCodeComplete } from "./check-launch-code.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = resolve(root, "apps/eliotr-core");
const deployConfig = "wrangler.deploy.jsonc";
const receiptPath = resolve(root, ".eliotr-state/cloudflare-deployment-receipt.json");
const provisioners = ["provision-cloudflare-core", "provision-ai-search",
  "provision-ai-gateways", "provision-cloudflare-access"];

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit", shell: process.platform === "win32" });
  if (result.error || result.status !== 0) throw new Error(`Deployment command failed: ${command} (exit ${result.status ?? "unknown"})`);
}

function capture(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", shell: process.platform === "win32" });
  return !result.error && result.status === 0 ? result.stdout.trim() || null : null;
}

async function archiveReceipt() {
  try { await rename(receiptPath, `${receiptPath}.previous`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function saveReceipt(receipt) {
  await mkdir(dirname(receiptPath), { recursive: true });
  const temporary = `${receiptPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, receiptPath);
}

/** Effects are explicit so failure ordering can be tested without Cloudflare credentials. */
export async function deployCloudflare({ confirmLive = false, environment = process.env,
  execute = run, captureCommand = capture, read = readFile, archive = archiveReceipt,
  save = saveReceipt, fetchImpl = fetch, now = Date.now, log = console.log,
  verifyCode = assertLaunchCodeComplete } = {}) {
  const env = { ...environment };
  let input;
  if (confirmLive) {
    await verifyCode();
    env.ELIOTR_ENVIRONMENT ??= "production";
    if (!env.ELIOTR_DEPLOYMENT_GENERATION) {
      const revision = captureCommand("git", ["rev-parse", "--short=12", "HEAD"], root, env);
      if (!revision) throw new Error("Set ELIOTR_DEPLOYMENT_GENERATION when Git revision is unavailable");
      env.ELIOTR_DEPLOYMENT_GENERATION = `git-${revision}`;
    }
    input = validateDeploymentInput(env);
  }
  const exec = (command, args, cwd = root) => execute(command, args, cwd, env);
  exec("pnpm", ["check"]);
  exec("pnpm", ["build:pwa"]);
  exec("pnpm", ["--filter", "@eliotr/core", "cf:types"]);
  exec("pnpm", ["--filter", "@eliotr/core", "deploy:dry-run"]);
  if (!confirmLive) {
    log("Dry-run gates passed. No remote provisioning or deployment was executed.");
    return null;
  }

  // All predictable cross-product drift must fail before the first remote mutation.
  for (const name of provisioners) exec("node", [`scripts/${name}.mjs`, "--check-only"]);
  // Preserve prior evidence but never leave an old PASS at the current receipt path after a failure.
  await archive();
  for (const name of provisioners) exec("node", [`scripts/${name}.mjs`]);
  const configPath = resolve(core, deployConfig);
  const bytes = await read(configPath);
  const config = validateGeneratedDeployment(bytes, env, input);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const requireUnchangedConfig = async () => {
    if (createHash("sha256").update(await read(configPath)).digest("hex") !== digest) {
      throw new Error("Generated deployment config changed during release");
    }
  };
  // The account-neutral build does not validate generated IDs, routes and runtime variables.
  exec("pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--minify", "--config", deployConfig], core);
  await requireUnchangedConfig();
  for (const binding of ["CORE_DB", "SEARCH_DB"]) {
    exec("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", binding, "--remote", "--config", deployConfig], core);
    await requireUnchangedConfig();
  }
  // Canonical generated vars win; Wrangler preserves secrets without --keep-vars.
  exec("pnpm", ["exec", "wrangler", "deploy", "--config", deployConfig], core);
  await requireUnchangedConfig();
  const worker = await readDeploymentWorker(env, input, config, { fetchImpl });
  const remoteHttpSmoke = await verifyDeploymentSmoke(env, input, { fetchImpl, now });
  const receipt = {
    protocol: "eliotr.cloudflare-deployment-receipt.v1",
    deployment_generation: env.ELIOTR_DEPLOYMENT_GENERATION,
    environment: env.ELIOTR_ENVIRONMENT,
    worker,
    generated_config_sha256: digest,
    remote_http_smoke: remoteHttpSmoke,
    live_conformance: {
      d1_write_readback: "NOT_EXECUTED", r2_immutable_put_readback: "NOT_EXECUTED",
      queue_duplicate_delivery: "NOT_EXECUTED", durable_object_hibernation: "NOT_EXECUTED",
      workflow_retry_resume: "NOT_EXECUTED", ai_search_exact_resolution: "NOT_EXECUTED",
      google_drive_exchange: "NOT_EXECUTED",
    },
    note: "Inventory/export readback is not full binding or version attestation. HTTP generation is verified only when authenticated smoke passes. Product and T4/T6 gates remain separate.",
    created_at: new Date(now()).toISOString(),
  };
  await save(receipt);
  log(JSON.stringify(receipt, null, 2));
  return receipt;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await deployCloudflare({ confirmLive: process.argv.includes("--confirm-live") ||
    process.env.ELIOTR_CONFIRM_LIVE_DEPLOY === "1" }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
