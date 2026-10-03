import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readDeploymentWorker, validateDeploymentInput, validateGeneratedDeployment,
  verifyDeploymentSmoke } from "./lib/deployment-verification.mjs";
import { injectOAuthBearer, loadWranglerOAuthCredential, resolveAuthMode, scrubTokenEnv,
  stripNodeOptionsLoaderTokens, verifyWranglerOAuthAccount, WRANGLER_OAUTH_MODE, WranglerOAuthError, LOGIN_INSTRUCTION } from "./lib/cloudflare-wrangler-oauth.mjs";
import { assertLaunchCodeComplete, readConfiguredTransport, readCompositionCapabilityProfile } from "./check-launch-code.mjs";
import { assertMaintenanceCapabilityProfile, readActiveDeploymentIdentity, readAuthenticatedCapabilities,
  readFullReleaseBlockers, requireSameMaintenanceCapabilityReadback,
  verifyDeploymentSchemaGenerations } from "./lib/deployment-maintenance.mjs";
import { loadResearchRuntimeEnvironment, RESEARCH_RUNTIME_CONFIGURATION_KEYS,
  RESEARCH_RUNTIME_SEMANTIC_TRANSPORT_KEYS, semanticConfigurationTransport } from "./lib/research-runtime-config.mjs";
import { synchronizeResearchDeploymentAuthority } from "./lib/research-deployment-authority.mjs";
import { computeResearchBackendFingerprint } from "./lib/research-backend-fingerprint.mjs";
import { readDeploymentMigrationPlan, requireUnchangedMigrationPlan, validateDeploymentMigrationDirectories, verifyDeploymentMigrationLedgers } from "./lib/deployment-migrations.mjs";
import { readDeploymentAssetManifest, verifyDeploymentAssets } from "./lib/deployment-assets.mjs";
import { validateStagingTarget } from "./lib/staging-isolation.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = resolve(root, "apps/eliotr-core");
const deployConfig = "wrangler.deploy.jsonc";
const receiptPath = resolve(root, ".eliotr-state/cloudflare-deployment-receipt.json");
const provisioners = ["provision-cloudflare-access", "provision-cloudflare-core", "provision-ai-search",
  "provision-ai-gateways"];
const SEMANTIC_SERVER_CONFIGURATION_KEYS = RESEARCH_RUNTIME_CONFIGURATION_KEYS;
const FULL_RELEASE_PURPOSE = "FULL_RELEASE";
const MAINTENANCE_PURPOSE = "MAINTENANCE";

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit", shell: process.platform === "win32" });
  if (result.error || result.status !== 0) throw new Error(`Deployment command failed: ${command} (exit ${result.status ?? "unknown"})`);
}

function capture(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", shell: process.platform === "win32" });
  return !result.error && result.status === 0 ? result.stdout.trim() || null : null;
}

function captureSourceBudget(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", shell: process.platform === "win32" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "",
    error: result.error?.code ?? null };
}

function verifyGeneratedSemanticConfiguration(config, environment) {
  const transport = semanticConfigurationTransport(environment);
  for (const key of RESEARCH_RUNTIME_SEMANTIC_TRANSPORT_KEYS) {
    const expected = transport.vars[key];
    const actual = config?.vars && Object.hasOwn(config.vars, key) ? config.vars[key] : undefined;
    if (actual !== expected) throw new Error(`Generated deployment semantic configuration drift (${key})`);
  }
  for (const key of SEMANTIC_SERVER_CONFIGURATION_KEYS.filter((item) => !RESEARCH_RUNTIME_SEMANTIC_TRANSPORT_KEYS.includes(item))) {
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
  purpose = FULL_RELEASE_PURPOSE, captureBudget = captureSourceBudget,
  readCapabilityProfile = readCompositionCapabilityProfile,
  readActiveWorker = readActiveDeploymentIdentity, readCapabilities = readAuthenticatedCapabilities,
  readReleaseBlockers = readFullReleaseBlockers, readSchemaGenerations = verifyDeploymentSchemaGenerations,
  readWorker = readDeploymentWorker,
  readAssetManifest = readDeploymentAssetManifest } = {}) {
  if (![FULL_RELEASE_PURPOSE, MAINTENANCE_PURPOSE].includes(purpose)) throw new Error("Deployment purpose is invalid");
  const env = await loadResearchRuntimeEnvironment(environment, root);
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
  let stagingTarget = null;
  let fullReleaseBlockers = null;
  let candidateCapabilityProfile = null;
  let sourceBudgetState = null;
  let sourceBudgetFindings = null;
  if (confirmLive) {
    if (purpose === FULL_RELEASE_PURPOSE) await verifyCode();
    else {
      fullReleaseBlockers = await readReleaseBlockers({ root, read });
      candidateCapabilityProfile = await readCapabilityProfile({ root, read });
    }
    env.ELIOTR_ENVIRONMENT ??= "production";
    // A staging label does not isolate fixed-name resources. Reject a missing,
    // mismatched or protected target before credential load or any command.
    stagingTarget = validateStagingTarget(env);
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
    const canonicalConfig = JSON.parse(await read(resolve(core, "wrangler.jsonc"), "utf8"));
    validateDeploymentMigrationDirectories(canonicalConfig, { root });
    env.ELIOTR_GOOGLE_EXTERNAL_TRANSPORT = readConfiguredTransport(canonicalConfig);
    input = validateDeploymentInput(env);
  }
  const exec = (command, args, cwd = root) => execute(command, args, cwd, env);
  const provisionerEnv = (name) => name === "provision-cloudflare-access" && env.ELIOTR_ACCESS_TRANSPORT === "cloudflare-mcp"
    ? scrubTokenEnv(env)
    : env;
  if (purpose === FULL_RELEASE_PURPOSE) {
    exec("pnpm", ["check"]);
    exec("pnpm", ["build:pwa"]);
    exec("pnpm", ["--filter", "@eliotr/core", "cf:types"]);
    exec("pnpm", ["--filter", "@eliotr/core", "deploy:dry-run"]);
  } else {
    fullReleaseBlockers ??= await readReleaseBlockers({ root, read });
    candidateCapabilityProfile ??= await readCapabilityProfile({ root, read });
    const budget = captureBudget("pnpm", ["budgets:check"], root, env);
    if (budget.error !== null || budget.stdout.length + budget.stderr.length > 64 * 1024) {
      throw new Error(`Maintenance source-budget command failed (${budget.error ?? "output limit"})`);
    }
    if (budget.status === 0 && /(?:^|\r?\n)Source budgets: PASS(?:\r?\n|$)/u.test(budget.stdout)) {
      sourceBudgetState = "PASS";
    } else {
      const failure = /(?:^|\r?\n)Source budgets: FAIL \((\d+) violations\)(?:\r?\n|$)/u.exec(budget.stdout);
      if (budget.status !== 1 || failure === null) throw new Error("Maintenance source-budget result could not be classified");
      sourceBudgetState = `FAIL (${failure[1]} violations)`;
      sourceBudgetFindings = `${budget.stdout}${budget.stderr}`.trim().slice(0, 4096);
      if (`${budget.stdout}${budget.stderr}`.trim().length > 4096) sourceBudgetFindings += " [truncated after 4096 characters]";
      log(`${budget.stdout}${budget.stderr}`.trim());
    }
    exec("pnpm", ["--filter", "@eliotr/core", "typecheck"]);
    exec("pnpm", ["exec", "eslint", "scripts/deploy-cloudflare.mjs", "scripts/lib/deployment-maintenance.mjs",
      "scripts/check-launch-code.mjs"]);
    exec("pnpm", ["boundaries:negative"]);
    exec("pnpm", ["build:pwa"]);
    exec("pnpm", ["--filter", "@eliotr/core", "cf:types"]);
    exec("pnpm", ["--filter", "@eliotr/core", "deploy:dry-run"]);
  }
  if (!confirmLive) {
    if (purpose === MAINTENANCE_PURPOSE) {
      log(JSON.stringify({ purpose, full_release_blockers: fullReleaseBlockers,
        source_budget_gate: sourceBudgetState, deployment: "NOT_EXECUTED" }));
    } else log("Dry-run gates passed. No remote provisioning or deployment was executed.");
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

  const activeWorkerBaseline = await readActiveWorker({ env, input, fetchImpl });
  let maintenanceBaseline = null;
  if (purpose === MAINTENANCE_PURPOSE) {
    if (input.cookie === null) throw new Error("Maintenance requires ELIOTR_ACCESS_SMOKE_COOKIE for authenticated capability comparison");
    const current = await readCapabilities({ input, fetchImpl });
    if (current.generation !== activeWorkerBaseline.generation) {
      throw new Error("Maintenance capability generation is not pinned to the active Worker version");
    }
    const canonicalConfig = JSON.parse(await read(resolve(core, "wrangler.jsonc"), "utf8"));
    assertMaintenanceCapabilityProfile({ candidate: candidateCapabilityProfile,
      observed: current.capabilities, generatedConfig: canonicalConfig, activeWorkerIdentity: activeWorkerBaseline });
    maintenanceBaseline = { active: activeWorkerBaseline, capabilities: current };
  }

  // All predictable cross-product drift must fail before the first remote mutation.
  for (const name of provisioners) execute("node", [`scripts/${name}.mjs`, "--check-only"], root, provisionerEnv(name));
  // Preserve prior evidence but never leave an old PASS at the current receipt path after a failure.
  await archive();
  for (const name of provisioners) execute("node", [`scripts/${name}.mjs`, "--verify-existing"], root, provisionerEnv(name));
  const configPath = resolve(core, deployConfig);
  const bytes = await read(configPath);
  const config = validateGeneratedDeployment(bytes, env, input);
  verifyGeneratedSemanticConfiguration(config, env);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const migrationPlan = await readDeploymentMigrationPlan(config, { root });
  const assetManifest = await readAssetManifest(config, { root });
  const backendFingerprint = computeResearchBackendFingerprint({ root, generated_config: config });
  const priorWorkerConfig = { ...config, vars: { ...config.vars,
    DEPLOYMENT_GENERATION: activeWorkerBaseline.generation } };
  const priorWorkerEnv = { ...env, ELIOTR_DEPLOYMENT_GENERATION: activeWorkerBaseline.generation };
  const priorWorkerReadback = await readWorker(priorWorkerEnv, input, priorWorkerConfig, { fetchImpl });
  if (priorWorkerReadback.deployment_id !== activeWorkerBaseline.deployment_id ||
      priorWorkerReadback.version_id !== activeWorkerBaseline.version_id) {
    throw new Error("Worker bindings do not match the active configured resource identities");
  }
  const requireUnchangedConfig = async () => {
    if (createHash("sha256").update(await read(configPath)).digest("hex") !== digest) {
      throw new Error("Generated deployment config changed during release");
    }
  };
  const requireUnchangedInputs = async () => {
    await requireUnchangedConfig();
    await requireUnchangedMigrationPlan(config, migrationPlan, { root });
    if (JSON.stringify(await readAssetManifest(config, { root })) !== JSON.stringify(assetManifest)) {
      throw new Error("Deployment assets changed during release");
    }
  };
  // The account-neutral build does not validate generated IDs, routes and runtime variables.
  exec("pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--minify", "--config", deployConfig], core);
  await requireUnchangedInputs();
  const migrationReadback = await verifyDeploymentMigrationLedgers(env, input, migrationPlan, { fetchImpl });
  await requireUnchangedInputs();
  const schemaGenerationReadback = await readSchemaGenerations({ env, input, plan: migrationPlan,
    root, fetchImpl, read });
  await requireUnchangedInputs();
  {
    const currentCapabilities = purpose === MAINTENANCE_PURPOSE
      ? await readCapabilities({ input, fetchImpl }) : null;
    const currentIdentity = await readActiveWorker({ env, input, fetchImpl });
    const currentWorker = await readWorker(priorWorkerEnv, input, priorWorkerConfig, { fetchImpl });
    if (canonicalJson(currentIdentity) !== canonicalJson(activeWorkerBaseline) ||
        currentWorker.deployment_id !== priorWorkerReadback.deployment_id ||
        currentWorker.version_id !== priorWorkerReadback.version_id) {
      throw new Error("Active Worker version or bindings changed during deployment preflight");
    }
    if (purpose === MAINTENANCE_PURPOSE) {
      if (currentCapabilities.generation !== maintenanceBaseline.capabilities.generation ||
          canonicalJson(currentCapabilities.capabilities) !== canonicalJson(maintenanceBaseline.capabilities.capabilities)) {
        throw new Error("Active Worker capabilities changed during maintenance preflight");
      }
      assertMaintenanceCapabilityProfile({ candidate: candidateCapabilityProfile,
        observed: currentCapabilities.capabilities, generatedConfig: config, activeWorkerIdentity: currentIdentity });
    }
    await requireUnchangedInputs();
  }
  // Canonical generated vars win; Wrangler preserves secrets without --keep-vars.
  exec("pnpm", ["exec", "wrangler", "deploy", "--config", deployConfig], core);
  await requireUnchangedInputs();
  const worker = await readWorker(env, input, config, { fetchImpl });
  let assetReadback = await verifyDeploymentAssets(assetManifest, input, { fetchImpl });
  if (assetReadback.state === "PASS") {
    const afterAssets = await readWorker(env, input, config, { fetchImpl });
    if (afterAssets.deployment_id !== worker.deployment_id || afterAssets.version_id !== worker.version_id) {
      throw new Error("Active Worker deployment changed during asset readback");
    }
    assetReadback = { ...assetReadback, deployment_id: worker.deployment_id,
      version_id: worker.version_id, active_version_unchanged: "PASS" };
  }
  await requireUnchangedInputs();
  const remoteHttpSmoke = await verifyDeploymentSmoke(env, input, { fetchImpl, now });
  const uploadedIdentity = await readActiveWorker({ env, input, fetchImpl });
  if (uploadedIdentity.generation !== env.ELIOTR_DEPLOYMENT_GENERATION ||
      uploadedIdentity.deployment_id !== worker.deployment_id || uploadedIdentity.version_id !== worker.version_id) {
    throw new Error("Uploaded Worker identity does not match the candidate deployment before authority synchronization");
  }
  if (purpose === MAINTENANCE_PURPOSE) {
    const candidateCapabilities = await readCapabilities({ input, fetchImpl });
    assertMaintenanceCapabilityProfile({ candidate: candidateCapabilityProfile,
      observed: candidateCapabilities.capabilities, generatedConfig: config, activeWorkerIdentity: uploadedIdentity });
    requireSameMaintenanceCapabilityReadback({ baseline: maintenanceBaseline.capabilities, current: candidateCapabilities });
    if (candidateCapabilities.generation !== env.ELIOTR_DEPLOYMENT_GENERATION) {
      throw new Error("Maintenance capability readback does not match candidate generation before authority synchronization");
    }
  }
  await requireUnchangedInputs();
  const coreDatabase = config.d1_databases.find((database) => database.binding === "CORE_DB");
  if (coreDatabase === undefined || typeof coreDatabase.database_id !== "string") {
    throw new Error("Generated deployment is missing CORE_DB identity");
  }
  const deploymentAuthority = await synchronizeResearchDeploymentAuthority({
    account_id: env.CLOUDFLARE_ACCOUNT_ID,
    database_id: coreDatabase.database_id,
    api_token: env.CLOUDFLARE_API_TOKEN,
    api_base_url: input.apiBase,
    deployment_generation: env.ELIOTR_DEPLOYMENT_GENERATION,
    backend_fingerprint: backendFingerprint,
    fetch_impl: fetchImpl,
    now,
  });
  const postSyncIdentity = await readActiveWorker({ env, input, fetchImpl });
  const postSyncWorker = await readWorker(env, input, config, { fetchImpl });
  if (postSyncIdentity.generation !== env.ELIOTR_DEPLOYMENT_GENERATION ||
      postSyncIdentity.deployment_id !== worker.deployment_id || postSyncIdentity.version_id !== worker.version_id ||
      postSyncWorker.deployment_id !== worker.deployment_id || postSyncWorker.version_id !== worker.version_id) {
    throw new Error("Active Worker deployment changed after authority synchronization");
  }
  if (purpose === MAINTENANCE_PURPOSE) {
    const finalCapabilities = await readCapabilities({ input, fetchImpl });
    assertMaintenanceCapabilityProfile({ candidate: candidateCapabilityProfile,
      observed: finalCapabilities.capabilities, generatedConfig: config, activeWorkerIdentity: postSyncIdentity });
    requireSameMaintenanceCapabilityReadback({ baseline: maintenanceBaseline.capabilities, current: finalCapabilities });
    if (finalCapabilities.generation !== env.ELIOTR_DEPLOYMENT_GENERATION) {
      throw new Error("Maintenance capability readback does not match candidate deployment generation");
    }
  }
  await requireUnchangedInputs();
  const receipt = {
    protocol: "eliotr.cloudflare-deployment-receipt.v1",
    deployment_generation: env.ELIOTR_DEPLOYMENT_GENERATION,
    environment: env.ELIOTR_ENVIRONMENT,
    ...(stagingTarget === null ? {} : { staging_target: stagingTarget }),
    worker,
    d1_migrations: migrationReadback,
    assets: { manifest: assetManifest, readback: assetReadback },
    generated_config_sha256: digest,
    backend_fingerprint: backendFingerprint,
    remote_http_smoke: remoteHttpSmoke,
    deployment_authority_sync: deploymentAuthority,
    live_conformance: {
      d1_write_readback: "NOT_EXECUTED", r2_immutable_put_readback: "NOT_EXECUTED",
      queue_duplicate_delivery: "NOT_EXECUTED", durable_object_hibernation: "NOT_EXECUTED",
      workflow_retry_resume: "NOT_EXECUTED", ai_search_exact_resolution: "NOT_EXECUTED",
      google_drive_exchange: "NOT_EXECUTED",
    },
    note: purpose === MAINTENANCE_PURPOSE
      ? buildMaintenanceNote(fullReleaseBlockers, sourceBudgetState, sourceBudgetFindings, migrationReadback, schemaGenerationReadback)
      : "Active version, configured resource bindings and migration names are verified. ETag and local migration hashes are not remote content proof; asset body hashes are observed only with authenticated readback and stable active-version observations. This is not an atomic source/build seal; product/T4/T6 gates remain separate. HTTP generation is verified only when authenticated smoke passes.",
    created_at: new Date(now()).toISOString(),
  };
  await save(receipt);
  log(JSON.stringify(receipt, null, 2));
  return receipt;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const allowed = new Set(["--confirm-live", "--maintenance"]);
  if (args.some((argument) => !allowed.has(argument)) || new Set(args).size !== args.length) {
    console.error("Deployment arguments are invalid");
    process.exitCode = 2;
  } else {
    await deployCloudflare({ confirmLive: args.includes("--confirm-live") ||
      process.env.ELIOTR_CONFIRM_LIVE_DEPLOY === "1",
    purpose: args.includes("--maintenance") ? MAINTENANCE_PURPOSE : FULL_RELEASE_PURPOSE }).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}

function buildMaintenanceNote(blockers, sourceBudgetState, sourceBudgetFindings, migrationReadback, schemaGenerationReadback) {
  const items = Array.isArray(blockers) ? blockers : [];
  const blockerText = items.length === 0 ? "No known full-release blockers were reported" :
    `Full-release blockers (${items.length}): ${items.join("; ")}`;
  const ledgerState = migrationReadback?.state === "PASS" ? "PASS" : "NOT_VERIFIED";
  const schemaState = schemaGenerationReadback?.state === "PASS" ? "PASS" : "NOT_VERIFIED";
  return `Worker/assets maintenance deployment only; this receipt does not qualify a full release. ${blockerText}. ` +
    `Source-maintainability budget gate: ${sourceBudgetState ?? "NOT_EXECUTED"}. ` +
    `${sourceBudgetFindings === null ? "No source-budget failure output was observed. " : `Source-budget findings: ${sourceBudgetFindings}. `}` +
    `D1 migrations were not applied; exact existing migration ledger readback: ${ledgerState}; ` +
    `required Core/Search schema generation readback: ${schemaState}. ` +
    "Authenticated candidate capability profile matched the active Worker before upload and after synchronization. " +
    "ETag and local migration hashes are not remote content proof; product and workload gates remain separate.";
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
