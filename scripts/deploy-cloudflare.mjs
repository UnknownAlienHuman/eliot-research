import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readDeploymentWorker, validateDeploymentInput, validateGeneratedDeployment,
  verifyDeploymentSmoke } from "./lib/deployment-verification.mjs";
import { injectOAuthBearer, loadWranglerOAuthCredential, resolveAuthMode, scrubTokenEnv,
  stripNodeOptionsLoaderTokens, verifyWranglerOAuthAccount, WRANGLER_OAUTH_MODE, WranglerOAuthError, LOGIN_INSTRUCTION } from "./lib/cloudflare-wrangler-oauth.mjs";
import { isUsageAdmissionCapability, runUsagePreflight } from "./lib/cloudflare-usage-admission.mjs";

import { assertLaunchCodeComplete, readConfiguredTransport } from "./check-launch-code.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = resolve(root, "apps/eliotr-core");
const deployConfig = "wrangler.deploy.jsonc";
const receiptPath = resolve(root, ".eliotr-state/cloudflare-deployment-receipt.json");
const provisioners = ["provision-cloudflare-access", "provision-cloudflare-core", "provision-ai-search",
  "provision-ai-gateways"];
const SEMANTIC_SERVER_CONFIGURATION_KEYS = Object.freeze([
  "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON",
  "ELIOTR_MODEL_PROFILE_DEFINITION_JSON",
  "ELIOTR_MODEL_PROFILE_PROVENANCE_REF",
  "ELIOTR_MODEL_SPEND_POLICY_JSON",
  "ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF",
  "ELIOTR_RESEARCH_REPORT_CONFIG_JSON",
  "ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF",
]);

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit", shell: process.platform === "win32" });
  if (result.error || result.status !== 0) throw new Error(`Deployment command failed: ${command} (exit ${result.status ?? "unknown"})`);
}

function capture(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", shell: process.platform === "win32" });
  return !result.error && result.status === 0 ? result.stdout.trim() || null : null;
}

function verifyGeneratedSemanticConfiguration(config, environment) {
  for (const key of SEMANTIC_SERVER_CONFIGURATION_KEYS) {
    const expected = Object.hasOwn(environment, key) && typeof environment[key] === "string"
      ? environment[key] : undefined;
    const actual = config?.vars && Object.hasOwn(config.vars, key) ? config.vars[key] : undefined;
    if (actual !== expected) throw new Error(`Generated deployment semantic configuration drift (${key})`);
  }
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
  verifyCode = assertLaunchCodeComplete, readWranglerFile, runWranglerWhoami,
  usageProviders = null, usageSnapshot = null } = {}) {
  const env = { ...environment };
  // FIX9WC Layer 2 (defense in depth, child exec env only): strip ambient
  // module-loader tokens (--import/--loader/--experimental-loader/--require
  // plus values) from NODE_OPTIONS so a poisoned env can never auto-load test
  // hooks into provisioner/wrangler children. Benign flags pass through
  // intact; a missing NODE_OPTIONS stays missing. Bearer/token handling above
  // and below is untouched.
  if (env.NODE_OPTIONS !== undefined && env.NODE_OPTIONS !== null) {
    const stripped = stripNodeOptionsLoaderTokens(env.NODE_OPTIONS);
    if (String(stripped).trim() === "") delete env.NODE_OPTIONS;
    else env.NODE_OPTIONS = stripped;
  }
  let input;
  let oauth = null;
  if (confirmLive) {
    await verifyCode();
    env.ELIOTR_ENVIRONMENT ??= "production";
    // Local-only credential load (profile file + clock). No remote effect yet,
    // so launch:code and the local gates below still precede every remote call.
    if (resolveAuthMode(env) === WRANGLER_OAUTH_MODE) {
      // OS credential locations come from the host; profile knobs come from the deployment env.
      oauth = await loadWranglerOAuthCredential({ env: { ...process.env, ...env }, readFile: readWranglerFile ?? read, now: now() });
      env.CLOUDFLARE_API_TOKEN = injectOAuthBearer(env, oauth.bearer).CLOUDFLARE_API_TOKEN;
    }
    if (!env.ELIOTR_DEPLOYMENT_GENERATION) {
      const revision = captureCommand("git", ["rev-parse", "--short=12", "HEAD"], root, env);
      if (!revision) throw new Error("Set ELIOTR_DEPLOYMENT_GENERATION when Git revision is unavailable");
      env.ELIOTR_DEPLOYMENT_GENERATION = `git-${revision}`;
    }
    const canonicalConfig = JSON.parse(await readFile(resolve(core, "wrangler.jsonc"), "utf8"));
    env.ELIOTR_GOOGLE_EXTERNAL_TRANSPORT = readConfiguredTransport(canonicalConfig);
    input = validateDeploymentInput(env);
  }
  const exec = (command, args, cwd = root) => execute(command, args, cwd, env);
  const provisionerEnv = (name) => name === "provision-cloudflare-access" && env.ELIOTR_ACCESS_TRANSPORT === "cloudflare-mcp"
    ? scrubTokenEnv(env)
    : env;
  exec("pnpm", ["check"]);
  exec("pnpm", ["build:pwa"]);
  exec("pnpm", ["--filter", "@eliotr/core", "cf:types"]);
  exec("pnpm", ["--filter", "@eliotr/core", "deploy:dry-run"]);
  if (!confirmLive) {
    log("Dry-run gates passed. No remote provisioning or deployment was executed.");
    return null;
  }

  // Official-profile verification after local gates, before the first remote
  // mutation. whoami runs with a token-scrubbed env so the browser-OAuth
  // profile itself (not the injected bearer) is verified.
  if (oauth) {
    const getWhoamiOutput = runWranglerWhoami ?? (async () => {
      const result = spawnSync("pnpm", ["exec", "wrangler", "whoami"],
        { cwd: root, env: scrubTokenEnv(env), encoding: "utf8", shell: process.platform === "win32" });
      if (result.error || result.status !== 0) {
        throw new WranglerOAuthError("OAUTH_UNAVAILABLE",
          `Wrangler verification (wrangler whoami exit ${result.status ?? "unknown"}) failed. ${LOGIN_INSTRUCTION}`);
      }
      return result.stdout ?? "";
    });
    await verifyWranglerOAuthAccount({ expectedAccountId: env.CLOUDFLARE_ACCOUNT_ID, getWhoamiOutput });
  }

  // FIX1-B usage-envelope gate (strict deny-by-default): usage preflight
  // before the first remote mutation. Local gates above (pnpm check, PWA
  // build, cf:types, deploy:dry-run, provisioner --check-only) are the
  // enumerated proven metadata-only/zero-billable SEALED allowlist. BLOCKED
  // denies everything; SEALED authorizes only that allowlist after fresh
  // account binding/inventory receipt. Worker upload/exposure, route/domain,
  // D1 migrations/queries, R2 writes, Queue create/config/produce/consume,
  // Workflow/DO exec, Workers AI, AI Search index/query and Vectorize
  // writes/queries must not occur while any required metric is
  // unknown/stale/untrusted — so ADMITTED alone never suffices: the gate
  // additionally requires the same-process admission capability minted by the
  // fresh live collection lifecycle above. Injected providers, staged
  // snapshots, and persisted receipts can yield the ADMITTED label but never
  // the capability, so they deny here before the first remote mutation.
  // Access runs first in both check-only and apply loops and is read back
  // before any Worker surface exists; any partial failure aborts before the
  // single Worker deploy, leaving no public workers.dev path
  // (preview_urls=false is enforced by validateGeneratedDeployment).
  // An explicit usageProviders value is forwarded verbatim as a test seam.
  // The omitted/null default lets the OAuth lifecycle build its branded live
  // registry; usageSnapshot remains an explicit test-called builder path.
  {
    const usageGate = await runUsagePreflight({
      env: { ...process.env, ...env },
      nowMs: now(),
      readFile: readWranglerFile ?? read,
      getWhoamiOutput: runWranglerWhoami,
      providers: usageProviders,
      snapshot: usageSnapshot,
      writeReceipt: false,
      cwd: root,
    });
    if (usageGate.decision === "BLOCKED") {
      throw new Error(`Cloudflare usage preflight BLOCKED deployment before any mutation. ${usageGate.evaluation.reasons.join("; ")}`);
    }
    if (usageGate.decision !== "ADMITTED" || !isUsageAdmissionCapability(usageGate.capability)) {
      throw new Error(`Cloudflare usage preflight ${usageGate.decision} denies remote deployment: only a fresh ADMITTED aggregate with a same-process admission capability authorizes Worker upload, D1 migrations, and provisioner apply. ${usageGate.evaluation.reasons.join("; ")} Zero billable bindings were invoked.`);
    }
  }

  // All predictable cross-product drift must fail before the first remote mutation.
  for (const name of provisioners) execute("node", [`scripts/${name}.mjs`, "--check-only"], root, provisionerEnv(name));
  // Preserve prior evidence but never leave an old PASS at the current receipt path after a failure.
  await archive();
  for (const name of provisioners) execute("node", [`scripts/${name}.mjs`], root, provisionerEnv(name));
  const configPath = resolve(core, deployConfig);
  const bytes = await read(configPath);
  const config = validateGeneratedDeployment(bytes, env, input);
  verifyGeneratedSemanticConfiguration(config, env);
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
