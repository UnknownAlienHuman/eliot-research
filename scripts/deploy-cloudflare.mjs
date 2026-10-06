import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { APPROVED_RUNTIME_CONFIGURATION_VARIABLES, assertGeneratedOwnerTemplatesCurrent,
  readDeploymentWorker, validateDeploymentInput, validateGeneratedDeployment,
  verifyDeploymentSmoke } from "./lib/deployment-verification.mjs";
import { injectOAuthBearer, loadWranglerOAuthCredential, resolveAuthMode, scrubTokenEnv,
  stripNodeOptionsLoaderTokens, verifyWranglerOAuthAccount, WRANGLER_OAUTH_MODE, WranglerOAuthError, LOGIN_INSTRUCTION } from "./lib/cloudflare-wrangler-oauth.mjs";
import { assertLaunchCodeComplete, readConfiguredTransport, readCompositionCapabilityProfile } from "./check-launch-code.mjs";
import { assertMaintenanceCapabilityProfile, readActiveDeploymentIdentity, readAuthenticatedCapabilities,
  readFullReleaseBlockers, requireSameMaintenanceCapabilityReadback,
  selectDeploymentGoogleTransport, selectDeploymentAiSearchNamespaces,
  verifyDeploymentSchemaGenerations } from "./lib/deployment-maintenance.mjs";
import { loadMaintenanceRouteUpdate, requireUnchangedMaintenanceRouteUpdate } from "./lib/deployment-route-update.mjs";
import { captureMaintenanceAiGateways, requireSameMaintenanceAiGateways } from "./lib/deployment-ai-gateways.mjs";
import { loadMaintenanceAiSearchBootstrap, requireUnchangedMaintenanceAiSearchBootstrap } from
  "./lib/deployment-ai-search-bootstrap.mjs";
import { assertMaintenancePrimaryBindingBootstrapProfile, loadMaintenancePrimaryBindingBootstrap,
  requireUnchangedMaintenancePrimaryBindingBootstrap, withoutPrimaryBindingAdditions } from
  "./lib/deployment-primary-binding-bootstrap.mjs";
import { loadMaintenanceMcpAccessTransition, maintenanceMcpAccessReceiptSummary,
  requireUnchangedMaintenanceMcpAccessTransition } from "./lib/deployment-mcp-access-transition.mjs";
import { loadResearchRuntimeEnvironment, RESEARCH_RUNTIME_CONFIGURATION_KEYS,
  RESEARCH_RUNTIME_SEMANTIC_TRANSPORT_KEYS, semanticConfigurationTransport } from "./lib/research-runtime-config.mjs";
import { readResearchDeploymentAuthority, synchronizeResearchDeploymentAuthority } from "./lib/research-deployment-authority.mjs";
import { computeResearchBackendFingerprint } from "./lib/research-backend-fingerprint.mjs";
import { readDeploymentMigrationPlan, requireUnchangedMigrationPlan, validateDeploymentMigrationDirectories, verifyDeploymentMigrationLedgers } from "./lib/deployment-migrations.mjs";
import { readDeploymentAssetManifest, verifyDeploymentAssets } from "./lib/deployment-assets.mjs";
import { captureDeploymentBuildInputs, requireUnchangedDeploymentBuildInputs,
  pinGeneratedDeploymentConfig, attestDeploymentBundle,
  requireUnchangedDeploymentBundle } from "./lib/deployment-build-inputs.mjs";
import { validateStagingTarget } from "./lib/staging-isolation.mjs";
import { createCloudflaredOwnerFetch } from "./lib/cloudflare-owner-http.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = resolve(root, "apps/eliotr-core");
const deployConfig = "wrangler.deploy.jsonc";
const receiptPath = resolve(root, ".eliotr-state/cloudflare-deployment-receipt.json");
const provisioners = ["provision-cloudflare-access", "provision-cloudflare-core", "provision-ai-search",
  "provision-ai-gateways"];
const SEMANTIC_SERVER_CONFIGURATION_KEYS = RESEARCH_RUNTIME_CONFIGURATION_KEYS;
const FULL_RELEASE_PURPOSE = "FULL_RELEASE";
const MAINTENANCE_PURPOSE = "MAINTENANCE";
const DEPLOYMENT_SECRET_BINDING = "ELIOTR_MODEL_PROVIDER_CONTROL_TOKEN";
const MAX_DEPLOYMENT_SECRETS_FILE_BYTES = 16 * 1024;
const MAX_DEPLOYMENT_SECRET_VALUE_BYTES = 8 * 1024;
const DEPLOYMENT_SECRETS_PATH_PATTERN = /^[A-Za-z0-9._/\\: -]+$/u;

function resolveDeploymentSecretsPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || !isAbsolute(value)) {
    throw new Error("Deployment secrets file path must be an absolute path");
  }
  const resolved = resolve(value);
  if (!DEPLOYMENT_SECRETS_PATH_PATTERN.test(resolved)) {
    throw new Error("Deployment secrets file path contains unsupported shell characters");
  }
  return resolved;
}

function secretFileIdentity(stats) {
  return Object.freeze({ dev: stats.dev, ino: stats.ino, mode: stats.mode, size: stats.size,
    mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, birthtimeMs: stats.birthtimeMs });
}

function sameSecretFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs &&
    left.birthtimeMs === right.birthtimeMs;
}

async function readBoundedSecretFile(path) {
  let handle;
  try {
    const pathBefore = await lstat(path);
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.size > MAX_DEPLOYMENT_SECRETS_FILE_BYTES) {
      throw new Error("invalid deployment secrets file");
    }
    handle = await open(path, fsConstants.O_RDONLY);
    const opened = await handle.stat();
    const identity = secretFileIdentity(pathBefore);
    if (!opened.isFile() || !sameSecretFileIdentity(identity, secretFileIdentity(opened))) {
      throw new Error("deployment secrets file identity changed");
    }
    const buffer = Buffer.alloc(MAX_DEPLOYMENT_SECRETS_FILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_DEPLOYMENT_SECRETS_FILE_BYTES) throw new Error("deployment secrets file is oversized");
    const afterRead = await handle.stat();
    const pathAfter = await lstat(path);
    if (!pathAfter.isFile() || pathAfter.isSymbolicLink() ||
        !sameSecretFileIdentity(identity, secretFileIdentity(afterRead)) ||
        !sameSecretFileIdentity(identity, secretFileIdentity(pathAfter)) || afterRead.size !== offset) {
      throw new Error("deployment secrets file changed while reading");
    }
    return { identity, bytes: buffer.subarray(0, offset) };
  } catch {
    throw new Error("Deployment secrets file could not be verified");
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {});
  }
}

function validateDeploymentSecretsBytes(bytes) {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_DEPLOYMENT_SECRETS_FILE_BYTES) {
    throw new Error("Deployment secrets file is invalid");
  }
  let parsed;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Deployment secrets file must contain valid UTF-8 JSON");
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object" ||
      Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, DEPLOYMENT_SECRET_BINDING) ||
      typeof parsed[DEPLOYMENT_SECRET_BINDING] !== "string" ||
      Buffer.byteLength(parsed[DEPLOYMENT_SECRET_BINDING], "utf8") === 0 ||
      Buffer.byteLength(parsed[DEPLOYMENT_SECRET_BINDING], "utf8") > MAX_DEPLOYMENT_SECRET_VALUE_BYTES) {
    throw new Error("Deployment secrets file must contain only the provider control-token secret");
  }
}

async function pinDeploymentSecretsFile(path) {
  const resolved = resolveDeploymentSecretsPath(path);
  const snapshot = await readBoundedSecretFile(resolved);
  validateDeploymentSecretsBytes(snapshot.bytes);
  return Object.freeze({ path: resolved, identity: snapshot.identity, bytes: Buffer.from(snapshot.bytes) });
}

async function requireUnchangedDeploymentSecretsFile(pin) {
  const snapshot = await readBoundedSecretFile(pin.path);
  if (!sameSecretFileIdentity(pin.identity, snapshot.identity) || !pin.bytes.equals(snapshot.bytes)) {
    throw new Error("Deployment secrets file changed after validation");
  }
}

export function parseDeploymentArguments(args) {
  const flags = new Set();
  let secretsFilePath;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--secrets-file") {
      if (secretsFilePath !== undefined || index + 1 >= args.length || args[index + 1].startsWith("--")) {
        throw new Error("Deployment arguments are invalid");
      }
      secretsFilePath = resolveDeploymentSecretsPath(args[index + 1]);
      index += 1;
      continue;
    }
    if (!["--confirm-live", "--maintenance"].includes(argument) || flags.has(argument)) {
      throw new Error("Deployment arguments are invalid");
    }
    flags.add(argument);
  }
  return { confirmLive: flags.has("--confirm-live"), purpose: flags.has("--maintenance") ? MAINTENANCE_PURPOSE : FULL_RELEASE_PURPOSE,
    ...(secretsFilePath === undefined ? {} : { secretsFilePath }) };
}

function run(command, args, cwd, env) {
  const spawnArgs = process.platform === "win32" ? args.map((argument, index) =>
    args[index - 1] === "--secrets-file" ? `"${argument}"` : argument) : args;
  const result = spawnSync(command, spawnArgs, { cwd, env, stdio: "inherit", shell: process.platform === "win32" });
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
export async function deployCloudflare({ confirmLive = false, secretsFilePath, environment = process.env,
  execute = run, captureCommand = capture, read = readFile, archive = archiveReceipt,
  save = saveReceipt, fetchImpl = fetch, now = Date.now, log = console.log,
  verifyCode = assertLaunchCodeComplete, readWranglerFile, runWranglerWhoami,
  purpose = FULL_RELEASE_PURPOSE, captureBudget = captureSourceBudget,
  readCapabilityProfile = readCompositionCapabilityProfile,
  readActiveWorker = readActiveDeploymentIdentity, readCapabilities = readAuthenticatedCapabilities,
  readReleaseBlockers = readFullReleaseBlockers, readSchemaGenerations = verifyDeploymentSchemaGenerations,
  readWorker = readDeploymentWorker,
  readBackendFingerprint = computeResearchBackendFingerprint,
  captureAiGateways = captureMaintenanceAiGateways,
  checkAiGateways = requireSameMaintenanceAiGateways,
  captureBuildInputs = captureDeploymentBuildInputs,
  checkBuildInputs = requireUnchangedDeploymentBuildInputs,
  pinGeneratedConfig = pinGeneratedDeploymentConfig,
  attestBundle = attestDeploymentBundle, checkBundle = requireUnchangedDeploymentBundle,
  readAssetManifest = readDeploymentAssetManifest } = {}) {
  if (![FULL_RELEASE_PURPOSE, MAINTENANCE_PURPOSE].includes(purpose)) throw new Error("Deployment purpose is invalid");
  if (secretsFilePath !== undefined && !confirmLive) {
    throw new Error("A deployment secrets file requires a confirmed live deployment");
  }
  const deploymentSecretsFile = secretsFilePath === undefined ? null : await pinDeploymentSecretsFile(secretsFilePath);
  const env = await loadResearchRuntimeEnvironment(environment, root);
  const maintenanceRouteUpdatePath = env.ELIOTR_MAINTENANCE_ROUTE_UPDATE_FILE;
  if (maintenanceRouteUpdatePath !== undefined &&
      (purpose !== MAINTENANCE_PURPOSE || !confirmLive || typeof maintenanceRouteUpdatePath !== "string" ||
       maintenanceRouteUpdatePath.length === 0)) {
    throw new Error("Pinned route updates require a confirmed live maintenance deployment and an intent file");
  }
  const maintenanceAiSearchBootstrapPath = env.ELIOTR_MAINTENANCE_AI_SEARCH_BOOTSTRAP_FILE;
  if (maintenanceAiSearchBootstrapPath !== undefined &&
      (purpose !== MAINTENANCE_PURPOSE || !confirmLive || typeof maintenanceAiSearchBootstrapPath !== "string" ||
       maintenanceAiSearchBootstrapPath.length === 0)) {
    throw new Error("AI Search binding bootstrap requires a confirmed live maintenance deployment and an intent file");
  }
  const maintenancePrimaryBindingBootstrapPath = env.ELIOTR_MAINTENANCE_PRIMARY_BINDING_BOOTSTRAP_FILE;
  if (maintenancePrimaryBindingBootstrapPath !== undefined &&
      (purpose !== MAINTENANCE_PURPOSE || !confirmLive || typeof maintenancePrimaryBindingBootstrapPath !== "string" ||
       maintenancePrimaryBindingBootstrapPath.length === 0)) {
    throw new Error("Primary binding bootstrap requires a confirmed live maintenance deployment and an intent file");
  }
  const maintenanceMcpAccessTransitionPath = env.ELIOTR_MAINTENANCE_MCP_ACCESS_TRANSITION_FILE;
  if (maintenanceMcpAccessTransitionPath !== undefined &&
      (purpose !== MAINTENANCE_PURPOSE || !confirmLive || typeof maintenanceMcpAccessTransitionPath !== "string" ||
       maintenanceMcpAccessTransitionPath.length === 0)) {
    throw new Error("Managed-OAuth MCP Access transition requires a confirmed live maintenance deployment and an intent file");
  }
  const preserveGoogleTransport = env.ELIOTR_MAINTENANCE_PRESERVE_GOOGLE_TRANSPORT;
  if (preserveGoogleTransport !== undefined &&
      (purpose !== MAINTENANCE_PURPOSE || preserveGoogleTransport !== "disabled")) {
    throw new Error("Google transport preservation is maintenance-only and accepts disabled only");
  }
  const preserveAiGateways = env.ELIOTR_MAINTENANCE_PRESERVE_AI_GATEWAYS;
  if (preserveAiGateways !== undefined &&
      (purpose !== MAINTENANCE_PURPOSE || !confirmLive || preserveAiGateways !== "existing" ||
       env.ELIOTR_CLOUDFLARE_AUTH_MODE !== "wrangler-oauth" ||
       typeof env.ELIOTR_CLOUDFLARE_MCP_CWD !== "string" ||
       !isAbsolute(env.ELIOTR_CLOUDFLARE_MCP_CWD.trim()))) {
    throw new Error("AI Gateway preservation requires confirmed live maintenance, managed Wrangler OAuth, and MCP CWD");
  }
  if (env.ELIOTR_MAINTENANCE_PRESERVE_AI_SEARCH !== undefined &&
      (purpose !== MAINTENANCE_PURPOSE || env.ELIOTR_MAINTENANCE_PRESERVE_AI_SEARCH !== "absent")) {
    throw new Error("AI Search preservation is maintenance-only and accepts absent only");
  }
  if (maintenanceAiSearchBootstrapPath !== undefined && env.ELIOTR_MAINTENANCE_PRESERVE_AI_SEARCH !== undefined) {
    throw new Error("AI Search binding bootstrap cannot be combined with absent-binding preservation");
  }
  if (maintenancePrimaryBindingBootstrapPath !== undefined && maintenanceAiSearchBootstrapPath !== undefined) {
    throw new Error("Primary binding bootstrap cannot be combined with AI Search binding bootstrap");
  }
  if (maintenancePrimaryBindingBootstrapPath !== undefined && env.ELIOTR_MAINTENANCE_PRESERVE_AI_SEARCH !== undefined) {
    throw new Error("Primary binding bootstrap cannot be combined with AI Search preservation");
  }
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
  // Capture bytes and path membership before profile inspection or any local gate.
  const testedInputs = await captureBuildInputs({ root });
  let input;
  let ownerFetch = fetchImpl;
  let oauth = null;
  let stagingTarget = null;
  let fullReleaseBlockers = null;
  let candidateCapabilityProfile = null;
  let routeUpdate = null;
  let maintenanceAiGateways = null;
  let maintenanceAiSearchBootstrap = null;
  let maintenanceAiSearchBaselineConfig = null;
  let maintenanceAiSearchBaselineReadback = null;
  let maintenanceAiSearchCandidateConfig = null;
  let maintenanceAiSearchCandidateBytes = null;
  let maintenanceAiSearchCandidateDigest = null;
  let maintenanceAiSearchApprovedCandidate = null;
  let maintenancePrimaryBindingBootstrap = null;
  let maintenancePrimaryBaselineConfig = null;
  let maintenancePrimaryBaselineReadback = null;
  let maintenanceMcpAccessTransition = null;
  const maintenanceAiGatewayReadbacks = {};
  let sourceBudgetState = null;
  let sourceBudgetFindings = null;
  let deploymentUploadCompleted = false;
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
    // Defer loading the local bearer until after the late scrubbed whoami
    // check, which may refresh Wrangler's cached profile.
    oauth = resolveAuthMode(env) === WRANGLER_OAUTH_MODE;
    if (!env.ELIOTR_DEPLOYMENT_GENERATION) {
      const revision = captureCommand("git", ["rev-parse", "--short=12", "HEAD"], root, env);
      if (!revision) throw new Error("Set ELIOTR_DEPLOYMENT_GENERATION when Git revision is unavailable");
      env.ELIOTR_DEPLOYMENT_GENERATION = `git-${revision}`;
    }
    const canonicalConfig = JSON.parse(await read(resolve(core, "wrangler.jsonc"), "utf8"));
    validateDeploymentMigrationDirectories(canonicalConfig, { root });
    env.ELIOTR_GOOGLE_EXTERNAL_TRANSPORT = preserveGoogleTransport ?? readConfiguredTransport(canonicalConfig);
    input = validateDeploymentInput(env, { authMode: resolveAuthMode(env) });
    if (input.ownerHttpTransport === "cloudflared") {
      ownerFetch = createCloudflaredOwnerFetch({ origin: input.origin, environment: env,
        binary: env.ELIOTR_CLOUDFLARED_BINARY ?? "cloudflared" });
    }
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
      "scripts/lib/deployment-ai-search-bootstrap.mjs", "scripts/test-deployment-ai-search-bootstrap.mjs",
      "scripts/lib/deployment-route-update.mjs", "scripts/test-deployment-route-update.mjs",
      "scripts/lib/deployment-ai-gateways.mjs", "scripts/test-deployment-ai-gateways.mjs",
      "scripts/test-deployment-maintenance.mjs", "scripts/test-deployment-apply-ordering.mjs",
      "scripts/test-deployment-orchestration.mjs",
      "scripts/lib/deployment-build-inputs.mjs",
      "scripts/check-launch-code.mjs"]);
    exec("pnpm", ["boundaries:check"]);
    exec("pnpm", ["boundaries:negative"]);
    exec("pnpm", ["build:pwa"]);
    exec("pnpm", ["--filter", "@eliotr/core", "cf:types"]);
    exec("pnpm", ["--filter", "@eliotr/core", "deploy:dry-run"]);
  }
  await checkBuildInputs({ root, manifest: testedInputs });
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
    // whoami is allowed to refresh the official cached profile. Only now read
    // and inject its bearer, then validate the actual authenticated input.
    const credential = await loadWranglerOAuthCredential({
      env: { ...process.env, ...env }, readFile: readWranglerFile ?? read, now: now(),
    });
    env.CLOUDFLARE_API_TOKEN = injectOAuthBearer(env, credential.bearer).CLOUDFLARE_API_TOKEN;
    input = validateDeploymentInput(env);
  }

  const activeWorkerBaseline = await readActiveWorker({ env, input, fetchImpl });
  let maintenanceBaseline = null;
  if (purpose === MAINTENANCE_PURPOSE) {
    if (input.cookie === null && input.ownerHttpTransport !== "cloudflared") {
      throw new Error("Maintenance requires cookie or cloudflared owner HTTP authentication for capability comparison");
    }
    const current = await readCapabilities({ input, fetchImpl: ownerFetch });
    if (current.generation !== activeWorkerBaseline.generation) {
      throw new Error("Maintenance capability generation is not pinned to the active Worker version");
    }
    if (maintenanceRouteUpdatePath !== undefined) {
      routeUpdate = await loadMaintenanceRouteUpdate({ path: maintenanceRouteUpdatePath, root,
        sourceHead: testedInputs.git_head, candidateGeneration: env.ELIOTR_DEPLOYMENT_GENERATION,
        accountId: env.CLOUDFLARE_ACCOUNT_ID, hostname: env.ELIOTR_ACCESS_HOSTNAME,
        activeWorkerIdentity: activeWorkerBaseline, candidateRoutes: candidateCapabilityProfile.routes,
        observedRoutes: current.capabilities.routes, read });
    }
    const canonicalConfig = JSON.parse(await read(resolve(core, "wrangler.jsonc"), "utf8"));
    let maintenanceProfileConfig = canonicalConfig;
    if (maintenanceAiSearchBootstrapPath !== undefined || maintenancePrimaryBindingBootstrapPath !== undefined ||
        maintenanceMcpAccessTransitionPath !== undefined) {
      const configPath = resolve(core, deployConfig);
      maintenanceAiSearchCandidateBytes = Buffer.from(await read(configPath));
      maintenanceAiSearchCandidateConfig = validateGeneratedDeployment(maintenanceAiSearchCandidateBytes, env, input);
      verifyGeneratedSemanticConfiguration(maintenanceAiSearchCandidateConfig, env);
      maintenanceAiSearchCandidateDigest = createHash("sha256").update(maintenanceAiSearchCandidateBytes).digest("hex");
      maintenanceAiSearchApprovedCandidate = Object.freeze({
        protocol: "eliotr.approved-runtime-candidate.v1",
        deployment_generation: env.ELIOTR_DEPLOYMENT_GENERATION,
        configuration_sha256: maintenanceAiSearchCandidateDigest,
      });
      if (maintenanceMcpAccessTransitionPath !== undefined) {
        if (env.ELIOTR_MCP_ACCESS_ENABLED !== "1" || env.ELIOTR_MCP_ACCESS_AUTH_PROFILE !== "managed-oauth" ||
            env.ELIOTR_MCP_HOSTNAME !== maintenanceAiSearchCandidateConfig.vars.MCP_HOSTNAME ||
            env.ELIOTR_MCP_ACCESS_TEAM_DOMAIN !== maintenanceAiSearchCandidateConfig.vars.MCP_ACCESS_TEAM_DOMAIN ||
            env.ELIOTR_MCP_ACCESS_AUDIENCE !== maintenanceAiSearchCandidateConfig.vars.MCP_ACCESS_AUDIENCE ||
            env.ELIOTR_MCP_ACCESS_AUTH_PROFILE !== maintenanceAiSearchCandidateConfig.vars.MCP_ACCESS_AUTH_PROFILE ||
            Object.keys(env).some((name) => name.startsWith("ELIOTR_MCP_ACCESS_SERVICE_TOKEN_"))) {
          throw new Error("Managed-OAuth MCP Access provisioner environment does not match the exact candidate or contains service-token inputs");
        }
        maintenanceMcpAccessTransition = await loadMaintenanceMcpAccessTransition({
          path: maintenanceMcpAccessTransitionPath, root, accountId: env.CLOUDFLARE_ACCOUNT_ID,
          sourceHead: testedInputs.git_head, candidateGeneration: env.ELIOTR_DEPLOYMENT_GENERATION,
          candidateConfigurationSha256: maintenanceAiSearchCandidateDigest,
          candidateConfig: maintenanceAiSearchCandidateConfig, activeWorkerIdentity: activeWorkerBaseline, read,
        });
      }
    }
    if (maintenanceAiSearchBootstrapPath !== undefined) {
      maintenanceAiSearchBaselineConfig = { ...maintenanceAiSearchCandidateConfig,
        ai_search_namespaces: [], ai_search: [] };
      const priorWorkerEnv = { ...env, ELIOTR_DEPLOYMENT_GENERATION: activeWorkerBaseline.generation };
      maintenanceAiSearchBaselineReadback = await readWorker(priorWorkerEnv, input,
        maintenanceAiSearchBaselineConfig, {
          fetchImpl, observedDeploymentGeneration: activeWorkerBaseline.generation,
          approvedRuntimeCandidate: maintenanceAiSearchApprovedCandidate,
          approvedMcpAccessTransition: maintenanceMcpAccessTransition,
        });
      maintenanceAiSearchBootstrap = await loadMaintenanceAiSearchBootstrap({
        path: maintenanceAiSearchBootstrapPath, root,
        accountId: env.CLOUDFLARE_ACCOUNT_ID, sourceHead: testedInputs.git_head,
        candidateGeneration: env.ELIOTR_DEPLOYMENT_GENERATION,
        candidateConfigurationSha256: maintenanceAiSearchCandidateDigest,
        candidateConfig: maintenanceAiSearchCandidateConfig,
        candidateCapabilities: candidateCapabilityProfile,
        activeWorkerIdentity: activeWorkerBaseline,
        baselineConfigurationBaseline: maintenanceAiSearchBaselineReadback.configuration_baseline,
        baselineConfig: maintenanceAiSearchBaselineConfig, read,
      });
      await requireUnchangedMaintenanceAiSearchBootstrap({ bootstrap: maintenanceAiSearchBootstrap });
      maintenanceProfileConfig = maintenanceAiSearchCandidateConfig;
    }
    if (maintenancePrimaryBindingBootstrapPath !== undefined) {
      maintenancePrimaryBaselineConfig = withoutPrimaryBindingAdditions(maintenanceAiSearchCandidateConfig);
      const priorWorkerEnv = { ...env, ELIOTR_DEPLOYMENT_GENERATION: activeWorkerBaseline.generation };
      maintenancePrimaryBaselineReadback = await readWorker(priorWorkerEnv, input,
        maintenancePrimaryBaselineConfig, {
          fetchImpl, observedDeploymentGeneration: activeWorkerBaseline.generation,
          approvedRuntimeCandidate: maintenanceAiSearchApprovedCandidate,
          approvedMcpAccessTransition: maintenanceMcpAccessTransition,
        });
      maintenancePrimaryBindingBootstrap = await loadMaintenancePrimaryBindingBootstrap({
        path: maintenancePrimaryBindingBootstrapPath, root,
        accountId: env.CLOUDFLARE_ACCOUNT_ID, sourceHead: testedInputs.git_head,
        candidateGeneration: env.ELIOTR_DEPLOYMENT_GENERATION,
        candidateConfigurationSha256: maintenanceAiSearchCandidateDigest,
        candidateConfig: maintenanceAiSearchCandidateConfig,
        candidateCapabilities: candidateCapabilityProfile,
        activeWorkerIdentity: activeWorkerBaseline,
        baselineConfigurationBaseline: maintenancePrimaryBaselineReadback.configuration_baseline,
        baselineConfig: maintenancePrimaryBaselineConfig, read,
      });
      assertMaintenancePrimaryBindingBootstrapProfile({ bootstrap: maintenancePrimaryBindingBootstrap,
        phase: "before", generatedConfig: maintenanceAiSearchCandidateConfig,
        activeWorkerIdentity: activeWorkerBaseline, workerReadback: maintenancePrimaryBaselineReadback });
      await requireUnchangedMaintenancePrimaryBindingBootstrap({ bootstrap: maintenancePrimaryBindingBootstrap });
      maintenanceProfileConfig = maintenanceAiSearchCandidateConfig;
    }
    if (maintenanceMcpAccessTransition !== null && maintenanceAiSearchBootstrap === null &&
        maintenancePrimaryBindingBootstrap === null) {
      maintenanceAiSearchBaselineConfig = maintenanceAiSearchCandidateConfig;
    }
    const transport = selectDeploymentGoogleTransport({ purpose, preserve: preserveGoogleTransport,
      canonicalTransport: readConfiguredTransport(canonicalConfig),
      observedTransport: activeWorkerBaseline.google_external_transport });
    const preserveAiSearch = env.ELIOTR_MAINTENANCE_PRESERVE_AI_SEARCH ??
      (maintenanceAiSearchBootstrap === null && activeWorkerBaseline.ai_search_bound === false ? "absent" : undefined);
    const namespaces = selectDeploymentAiSearchNamespaces({ purpose, canonicalConfig: maintenanceProfileConfig,
      preserve: preserveAiSearch, activeWorkerIdentity: activeWorkerBaseline,
      candidate: candidateCapabilityProfile, aiSearchBootstrap: maintenanceAiSearchBootstrap });
    const maintenanceConfig = { ...maintenanceProfileConfig, ai_search_namespaces: namespaces,
      vars: { ...maintenanceProfileConfig.vars, GOOGLE_EXTERNAL_TRANSPORT: transport } };
    if (routeUpdate !== null) await requireUnchangedMaintenanceRouteUpdate({ routeUpdate });
    assertMaintenanceCapabilityProfile({ candidate: candidateCapabilityProfile,
      observed: current.capabilities, generatedConfig: maintenanceConfig, activeWorkerIdentity: activeWorkerBaseline,
      routeUpdate, routeUpdatePhase: "before", aiSearchBootstrap: maintenanceAiSearchBootstrap,
      aiSearchBootstrapPhase: "before" });
    if (preserveAiGateways === "existing") {
      maintenanceAiGateways = await captureAiGateways({ env, input,
        activeWorkerIdentity: activeWorkerBaseline, candidate: candidateCapabilityProfile,
        observed: current.capabilities });
      if (maintenanceAiGateways?.state !== "PINNED" ||
          maintenanceAiGateways?.protocol !== "eliotr.maintenance-ai-gateway-profile.v1") {
        throw new Error("Maintenance AI Gateway baseline could not be pinned");
      }
    }
    if (preserveAiSearch !== undefined) env.ELIOTR_MAINTENANCE_PRESERVE_AI_SEARCH = preserveAiSearch;
    maintenanceBaseline = { active: activeWorkerBaseline, capabilities: current };
  }

  // All predictable cross-product drift must fail before the first remote mutation.
  const activeProvisioners = provisioners.filter((name) =>
    (name !== "provision-ai-search" || env.ELIOTR_MAINTENANCE_PRESERVE_AI_SEARCH !== "absent" ||
      maintenanceAiSearchBootstrap !== null) &&
    (name !== "provision-ai-gateways" || maintenanceAiGateways === null));
  for (const name of activeProvisioners) execute("node", [`scripts/${name}.mjs`, "--check-only"], root, provisionerEnv(name));
  // Preserve prior evidence but never leave an old PASS at the current receipt path after a failure.
  await archive();
  for (const name of activeProvisioners) execute("node", [`scripts/${name}.mjs`, "--verify-existing"], root, provisionerEnv(name));
  const configPath = resolve(core, deployConfig);
  const bytes = Buffer.from(await read(configPath));
  if (maintenanceAiSearchCandidateBytes !== null && !bytes.equals(maintenanceAiSearchCandidateBytes)) {
    throw new Error("Generated maintenance bootstrap candidate config changed during deployment preparation");
  }
  const config = maintenanceAiSearchCandidateConfig ?? validateGeneratedDeployment(bytes, env, input);
  if (maintenanceAiGateways !== null) assertMaintenanceAiGatewayTargets(maintenanceAiGateways, config);
  verifyGeneratedSemanticConfiguration(config, env);
  assertGeneratedOwnerTemplatesCurrent(config);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (maintenanceAiSearchCandidateDigest !== null && digest !== maintenanceAiSearchCandidateDigest) {
    throw new Error("Generated maintenance bootstrap candidate config digest changed during deployment preparation");
  }
  const generatedConfigPin = await pinGeneratedConfig({ root, path: configPath });
  if (generatedConfigPin.sha256 !== digest) throw new Error("Generated deployment config changed before artifact preparation");
  const migrationPlan = await readDeploymentMigrationPlan(config, { root });
  const assetManifest = await readAssetManifest(config, { root });
  const backendFingerprint = readBackendFingerprint({ root, generated_config: config });
  const coreDatabase = config.d1_databases.find((database) => database.binding === "CORE_DB");
  if (coreDatabase === undefined || typeof coreDatabase.database_id !== "string") {
    throw new Error("Generated deployment is missing CORE_DB identity");
  }
  const authorityInput = {
    account_id: env.CLOUDFLARE_ACCOUNT_ID,
    database_id: coreDatabase.database_id,
    api_token: env.CLOUDFLARE_API_TOKEN,
    api_base_url: input.apiBase,
    deployment_generation: env.ELIOTR_DEPLOYMENT_GENERATION,
    backend_fingerprint: backendFingerprint,
    fetch_impl: fetchImpl,
    now,
  };
  const deploymentAuthorityBaseline = await readResearchDeploymentAuthority(authorityInput);
  const priorWorkerEnv = { ...env, ELIOTR_DEPLOYMENT_GENERATION: activeWorkerBaseline.generation };
  const approvedRuntimeCandidate = Object.freeze({
    protocol: "eliotr.approved-runtime-candidate.v1",
    deployment_generation: env.ELIOTR_DEPLOYMENT_GENERATION,
    configuration_sha256: digest,
  });
  const maintenanceBindingBootstrap = maintenanceAiSearchBootstrap ?? maintenancePrimaryBindingBootstrap;
  const maintenanceBindingBaselineConfig = maintenanceAiSearchBootstrap !== null
    ? maintenanceAiSearchBaselineConfig : maintenancePrimaryBindingBootstrap !== null
      ? maintenancePrimaryBaselineConfig : null;
  const maintenanceBindingBaselineReadback = maintenanceAiSearchBootstrap !== null
    ? maintenanceAiSearchBaselineReadback : maintenancePrimaryBindingBootstrap !== null
      ? maintenancePrimaryBaselineReadback : null;
  const priorWorkerReadback = maintenanceBindingBootstrap === null
    ? await readWorker(priorWorkerEnv, input, config, {
    fetchImpl, observedDeploymentGeneration: activeWorkerBaseline.generation,
    approvedRuntimeCandidate,
    approvedMcpAccessTransition: maintenanceMcpAccessTransition,
  }) : await readWorker(priorWorkerEnv, input, maintenanceBindingBaselineConfig, {
    fetchImpl, observedDeploymentGeneration: activeWorkerBaseline.generation,
    expectedConfigurationBaseline: maintenanceBindingBaselineReadback.configuration_baseline,
    approvedRuntimeCandidate: maintenanceAiSearchApprovedCandidate,
    approvedMcpAccessTransition: maintenanceMcpAccessTransition,
  });
  const priorWorkerConfigurationBaseline = priorWorkerReadback.configuration_baseline;
  if (priorWorkerReadback.deployment_id !== activeWorkerBaseline.deployment_id ||
      priorWorkerReadback.version_id !== activeWorkerBaseline.version_id ||
      priorWorkerConfigurationBaseline?.deployment_id !== activeWorkerBaseline.deployment_id ||
      priorWorkerConfigurationBaseline?.version_id !== activeWorkerBaseline.version_id ||
      priorWorkerConfigurationBaseline?.deployment_generation !== activeWorkerBaseline.generation ||
      !/^[0-9a-f]{64}$/u.test(priorWorkerConfigurationBaseline?.configuration_sha256 ?? "")) {
    throw new Error("Worker bindings do not match the active configured resource identities");
  }
  const approvedRuntimeTransition = Object.freeze({
    protocol: "eliotr.approved-runtime-transition.v1",
    baseline: Object.freeze({
      deployment_id: priorWorkerConfigurationBaseline.deployment_id,
      version_id: priorWorkerConfigurationBaseline.version_id,
      deployment_generation: priorWorkerConfigurationBaseline.deployment_generation,
      configuration_sha256: priorWorkerConfigurationBaseline.configuration_sha256,
    }),
    candidate: Object.freeze({
      deployment_generation: approvedRuntimeCandidate.deployment_generation,
      configuration_sha256: approvedRuntimeCandidate.configuration_sha256,
    }),
    owner_runtime_variables: APPROVED_RUNTIME_CONFIGURATION_VARIABLES,
  });
  const requireUnchangedConfig = async () => {
    if (createHash("sha256").update(await read(configPath)).digest("hex") !== digest) {
      throw new Error("Generated deployment config changed during release");
    }
  };
  let workerBundle = null;
  const requireUnchangedInputs = async () => {
    if (deploymentSecretsFile !== null && !deploymentUploadCompleted) {
      await requireUnchangedDeploymentSecretsFile(deploymentSecretsFile);
    }
    if (routeUpdate !== null) await requireUnchangedMaintenanceRouteUpdate({ routeUpdate });
    if (maintenanceAiSearchBootstrap !== null) {
      await requireUnchangedMaintenanceAiSearchBootstrap({ bootstrap: maintenanceAiSearchBootstrap });
    }
    if (maintenancePrimaryBindingBootstrap !== null) {
      await requireUnchangedMaintenancePrimaryBindingBootstrap({ bootstrap: maintenancePrimaryBindingBootstrap });
    }
    if (maintenanceMcpAccessTransition !== null) {
      await requireUnchangedMaintenanceMcpAccessTransition({ transition: maintenanceMcpAccessTransition, read });
    }
    await requireUnchangedConfig();
    await checkBuildInputs({ root, manifest: testedInputs, generatedConfigPin });
    if (workerBundle !== null) await checkBundle({ root, manifest: testedInputs, attestation: workerBundle });
    if (readBackendFingerprint({ root, generated_config: config }) !== backendFingerprint) {
      throw new Error("Backend execution inputs changed during deployment");
    }
    await requireUnchangedMigrationPlan(config, migrationPlan, { root });
    if (JSON.stringify(await readAssetManifest(config, { root })) !== JSON.stringify(assetManifest)) {
      throw new Error("Deployment assets changed during release");
    }
  };
  // The account-neutral build does not validate generated IDs, routes and runtime variables.
  await requireUnchangedInputs();
  const bundleDirectory = resolve(root, ".eliotr-state", `deployment-worker-${randomUUID()}`);
  const metafilePath = resolve(bundleDirectory, "bundle-meta.json");
  exec("pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--minify", "--config", deployConfig,
    "--outdir", bundleDirectory, "--metafile", metafilePath], core);
  workerBundle = await attestBundle({ root, manifest: testedInputs, outdir: bundleDirectory,
    metafilePath, generatedConfigPin });
  await requireUnchangedInputs();
  const migrationReadback = await verifyDeploymentMigrationLedgers(env, input, migrationPlan, { fetchImpl });
  await requireUnchangedInputs();
  const schemaGenerationReadback = await readSchemaGenerations({ env, input, plan: migrationPlan,
    root, fetchImpl, read });
  await requireUnchangedInputs();
  {
    const currentCapabilities = purpose === MAINTENANCE_PURPOSE
      ? await readCapabilities({ input, fetchImpl: ownerFetch }) : null;
    const currentIdentity = await readActiveWorker({ env, input, fetchImpl });
    const currentWorker = await readWorker(priorWorkerEnv, input,
      maintenanceBindingBootstrap === null ? config : maintenanceBindingBaselineConfig, {
      fetchImpl,
      observedDeploymentGeneration: activeWorkerBaseline.generation,
      expectedConfigurationBaseline: priorWorkerConfigurationBaseline,
      approvedRuntimeCandidate,
      approvedRuntimeTransition,
      approvedMcpAccessTransition: maintenanceMcpAccessTransition,
    });
    if (canonicalJson(currentIdentity) !== canonicalJson(activeWorkerBaseline) ||
        currentWorker.deployment_id !== priorWorkerReadback.deployment_id ||
        currentWorker.version_id !== priorWorkerReadback.version_id ||
        canonicalJson(currentWorker.configuration_baseline) !== canonicalJson(priorWorkerConfigurationBaseline)) {
      throw new Error("Active Worker version or bindings changed during deployment preflight");
    }
    if (maintenancePrimaryBindingBootstrap !== null) {
      assertMaintenancePrimaryBindingBootstrapProfile({ bootstrap: maintenancePrimaryBindingBootstrap,
        phase: "before", generatedConfig: config, activeWorkerIdentity: currentIdentity,
        workerReadback: currentWorker });
    }
    if (purpose === MAINTENANCE_PURPOSE) {
      if (currentCapabilities.generation !== maintenanceBaseline.capabilities.generation ||
          canonicalJson(currentCapabilities.capabilities) !== canonicalJson(maintenanceBaseline.capabilities.capabilities)) {
        throw new Error("Active Worker capabilities changed during maintenance preflight");
      }
      if (routeUpdate !== null) await requireUnchangedMaintenanceRouteUpdate({ routeUpdate });
      assertMaintenanceCapabilityProfile({ candidate: candidateCapabilityProfile,
        observed: currentCapabilities.capabilities, generatedConfig: config, activeWorkerIdentity: currentIdentity,
        routeUpdate, routeUpdatePhase: "before", aiSearchBootstrap: maintenanceAiSearchBootstrap,
        aiSearchBootstrapPhase: "before" });
      if (maintenanceAiGateways !== null) await recordMaintenanceAiGatewayReadback({
        profile: maintenanceAiGateways, readbacks: maintenanceAiGatewayReadbacks, stage: "before_upload",
        result: await checkAiGateways({ profile: maintenanceAiGateways, env, input,
          activeWorkerIdentity: currentIdentity }),
      });
    }
    if (maintenanceAiSearchBootstrap !== null) {
      await requireUnchangedInputs();
      execute("node", ["scripts/provision-ai-search.mjs", "--verify-existing"], root, provisionerEnv("provision-ai-search"));
      await requireUnchangedInputs();
    }
    await requireUnchangedInputs();
    const currentAuthority = await readResearchDeploymentAuthority(authorityInput);
    if (canonicalJson(currentAuthority) !== canonicalJson(deploymentAuthorityBaseline)) {
      throw new Error("Research deployment authority changed during deployment preflight");
    }
  }
  // Canonical generated vars win; Wrangler preserves secrets without --keep-vars.
  const deployArgs = ["exec", "wrangler", "deploy", workerBundle.entrypoint,
    "--no-bundle", "--config", deployConfig];
  if (deploymentSecretsFile !== null) {
    await requireUnchangedDeploymentSecretsFile(deploymentSecretsFile);
    deployArgs.push("--secrets-file", deploymentSecretsFile.path);
  }
  exec("pnpm", deployArgs, core);
  deploymentUploadCompleted = true;
  await requireUnchangedInputs();
  const worker = await readWorker(env, input, config, { fetchImpl });
  let assetReadback = await verifyDeploymentAssets(assetManifest, input, { fetchImpl: ownerFetch });
  if (assetReadback.state === "PASS") {
    const afterAssets = await readWorker(env, input, config, { fetchImpl });
    if (afterAssets.deployment_id !== worker.deployment_id || afterAssets.version_id !== worker.version_id) {
      throw new Error("Active Worker deployment changed during asset readback");
    }
    assetReadback = { ...assetReadback, deployment_id: worker.deployment_id,
      version_id: worker.version_id, active_version_unchanged: "PASS" };
  }
  await requireUnchangedInputs();
  const remoteHttpSmoke = await verifyDeploymentSmoke(env, input, { fetchImpl: ownerFetch, now });
  const uploadedIdentity = await readActiveWorker({ env, input, fetchImpl });
  if (uploadedIdentity.generation !== env.ELIOTR_DEPLOYMENT_GENERATION ||
      uploadedIdentity.deployment_id !== worker.deployment_id || uploadedIdentity.version_id !== worker.version_id) {
    throw new Error("Uploaded Worker identity does not match the candidate deployment before authority synchronization");
  }
  if (maintenancePrimaryBindingBootstrap !== null) {
    assertMaintenancePrimaryBindingBootstrapProfile({ bootstrap: maintenancePrimaryBindingBootstrap,
      phase: "after", generatedConfig: config, activeWorkerIdentity: uploadedIdentity,
      workerReadback: worker });
  }
  if (purpose === MAINTENANCE_PURPOSE) {
    const candidateCapabilities = await readCapabilities({ input, fetchImpl: ownerFetch });
    if (routeUpdate !== null) await requireUnchangedMaintenanceRouteUpdate({ routeUpdate });
    assertMaintenanceCapabilityProfile({ candidate: candidateCapabilityProfile,
      observed: candidateCapabilities.capabilities, generatedConfig: config, activeWorkerIdentity: uploadedIdentity,
      routeUpdate, routeUpdatePhase: "after", aiSearchBootstrap: maintenanceAiSearchBootstrap,
      aiSearchBootstrapPhase: "after" });
    requireSameMaintenanceCapabilityReadback({ baseline: maintenanceBaseline.capabilities,
      current: candidateCapabilities, routeUpdate });
    if (candidateCapabilities.generation !== env.ELIOTR_DEPLOYMENT_GENERATION) {
      throw new Error("Maintenance capability readback does not match candidate generation before authority synchronization");
    }
    if (maintenanceAiGateways !== null) await recordMaintenanceAiGatewayReadback({
      profile: maintenanceAiGateways, readbacks: maintenanceAiGatewayReadbacks,
      stage: "after_upload_before_authority_sync",
      result: await checkAiGateways({ profile: maintenanceAiGateways, env, input,
        activeWorkerIdentity: uploadedIdentity }),
    });
  }
  await requireUnchangedInputs();
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
  if (maintenancePrimaryBindingBootstrap !== null) {
    assertMaintenancePrimaryBindingBootstrapProfile({ bootstrap: maintenancePrimaryBindingBootstrap,
      phase: "after", generatedConfig: config, activeWorkerIdentity: postSyncIdentity,
      workerReadback: postSyncWorker });
  }
  if (maintenanceAiGateways !== null) await recordMaintenanceAiGatewayReadback({
    profile: maintenanceAiGateways, readbacks: maintenanceAiGatewayReadbacks,
    stage: "after_authority_sync",
    result: await checkAiGateways({ profile: maintenanceAiGateways, env, input,
      activeWorkerIdentity: postSyncIdentity }),
  });
  if (purpose === MAINTENANCE_PURPOSE) {
    const finalCapabilities = await readCapabilities({ input, fetchImpl: ownerFetch });
    if (routeUpdate !== null) await requireUnchangedMaintenanceRouteUpdate({ routeUpdate });
    assertMaintenanceCapabilityProfile({ candidate: candidateCapabilityProfile,
      observed: finalCapabilities.capabilities, generatedConfig: config, activeWorkerIdentity: postSyncIdentity,
      routeUpdate, routeUpdatePhase: "after", aiSearchBootstrap: maintenanceAiSearchBootstrap,
      aiSearchBootstrapPhase: "after" });
    requireSameMaintenanceCapabilityReadback({ baseline: maintenanceBaseline.capabilities,
      current: finalCapabilities, routeUpdate });
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
    ...(routeUpdate === null ? {} : { maintenance_route_update: {
      protocol: routeUpdate.protocol,
      intent_sha256: routeUpdate.intent_sha256,
      source_head: testedInputs.git_head,
      baseline_generation: maintenanceBaseline.active.generation,
      candidate_generation: env.ELIOTR_DEPLOYMENT_GENERATION,
      baseline_route_count: routeUpdate.baseline_routes.length,
      candidate_route_count: routeUpdate.candidate_routes.length,
      added_route_count: routeUpdate.added_routes.length,
      changed_route_count: routeUpdate.changed_routes.length,
      removed_route_count: 0,
      service_principal_allowlist: "EMPTY_PRESERVED",
    } }),
    ...(maintenanceAiSearchBootstrap === null ? {} : { maintenance_ai_search_binding_bootstrap: {
      protocol: maintenanceAiSearchBootstrap.protocol,
      intent_sha256: maintenanceAiSearchBootstrap.intent_sha256,
      manifest_sha256: maintenanceAiSearchBootstrap.manifest_sha256,
      binding: "AI_SEARCH:eliotr",
      baseline_deployment_id: maintenanceAiSearchBootstrap.baseline.deployment_id,
      baseline_version_id: maintenanceAiSearchBootstrap.baseline.version_id,
      baseline_generation: maintenanceAiSearchBootstrap.baseline.generation,
      baseline_configuration_sha256: maintenanceAiSearchBootstrap.baseline.configuration_sha256,
      candidate_generation: maintenanceAiSearchBootstrap.candidate.generation,
      candidate_configuration_sha256: maintenanceAiSearchBootstrap.candidate.configuration_sha256,
      readback: "PASS",
    } }),
    ...(maintenancePrimaryBindingBootstrap === null ? {} : { maintenance_primary_binding_bootstrap: {
      protocol: maintenancePrimaryBindingBootstrap.protocol,
      intent_sha256: maintenancePrimaryBindingBootstrap.intent_sha256,
      bucket_receipt_sha256: maintenancePrimaryBindingBootstrap.bucket_receipt.sha256,
      binding: "BACKUP_PARTS_BUCKET",
      version_metadata: "VERSION_METADATA",
      preexisting_bucket: false,
      bucket_creation_readback: "PASS",
      baseline_deployment_id: maintenancePrimaryBindingBootstrap.baseline.deployment_id,
      baseline_version_id: maintenancePrimaryBindingBootstrap.baseline.version_id,
      baseline_generation: maintenancePrimaryBindingBootstrap.baseline.generation,
      baseline_configuration_sha256: maintenancePrimaryBindingBootstrap.baseline.configuration_sha256,
      candidate_generation: maintenancePrimaryBindingBootstrap.candidate.generation,
      candidate_configuration_sha256: maintenancePrimaryBindingBootstrap.candidate.configuration_sha256,
      readback: "PASS",
    } }),
    ...(maintenanceMcpAccessTransition === null ? {} : { maintenance_mcp_access_transition:
      maintenanceMcpAccessReceiptSummary(maintenanceMcpAccessTransition) }),
    ...(maintenanceAiGateways === null ? {} : { maintenance_ai_gateways: {
      protocol: maintenanceAiGateways.protocol,
      profile_sha256: maintenanceAiGateways.profile_sha256,
      gateways: {
        reasoning: { id: "eliotr-reasoning", presence: "PRESENT", settings: maintenanceAiGateways.gateways.reasoning },
        retrieval: maintenanceAiGateways.gateways.retrieval === null
          ? { id: "eliotr-retrieval", presence: "ABSENT" }
          : { id: "eliotr-retrieval", presence: "PRESENT", settings: maintenanceAiGateways.gateways.retrieval },
      },
      readbacks: maintenanceAiGatewayReadbacks,
    } }),
    live_conformance: {
      d1_write_readback: "NOT_EXECUTED", r2_immutable_put_readback: "NOT_EXECUTED",
      queue_duplicate_delivery: "NOT_EXECUTED", durable_object_hibernation: "NOT_EXECUTED",
      workflow_retry_resume: "NOT_EXECUTED", ai_search_exact_resolution: "NOT_EXECUTED",
      google_drive_exchange: "NOT_EXECUTED",
    },
    note: (purpose === MAINTENANCE_PURPOSE
      ? buildMaintenanceNote(fullReleaseBlockers, sourceBudgetState, sourceBudgetFindings, migrationReadback,
        schemaGenerationReadback, routeUpdate, maintenanceAiGateways, maintenanceAiSearchBootstrap,
        maintenancePrimaryBindingBootstrap)
      : "Active version, configured resource bindings and migration names are verified. ETag and local migration hashes are not remote content proof; asset body hashes are observed only with authenticated readback and stable active-version observations. Product/T4/T6 gates remain separate. HTTP generation is verified only when authenticated smoke passes.") +
      ` Build input manifest captured before gates: ${testedInputs.sha256}; prepared Worker artifact: ${workerBundle.sha256}. ` +
      "Source membership/bytes, generated config, metafile inputs and emitted files were rechecked immediately before upload; the prepared entrypoint was deployed with --no-bundle. " +
      "Metafile paths and byte counts do not attest the exact bytes read by the compiler; a same-size edit restored between checks may evade this observation. " +
      "These are bounded local integrity checks, not an immutable source-to-artifact seal, a cryptographic attestation of compiler/tool internals or an atomic remote source/build seal.",
    created_at: new Date(now()).toISOString(),
  };
  await save(receipt);
  log(JSON.stringify(receipt, null, 2));
  return receipt;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let parsed;
  try {
    parsed = parseDeploymentArguments(process.argv.slice(2));
  } catch {
    console.error("Deployment arguments are invalid");
    process.exitCode = 2;
  }
  if (parsed !== undefined) {
    parsed.confirmLive ||= process.env.ELIOTR_CONFIRM_LIVE_DEPLOY === "1";
    await deployCloudflare(parsed).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}

function buildMaintenanceNote(blockers, sourceBudgetState, sourceBudgetFindings, migrationReadback,
  schemaGenerationReadback, routeUpdate, maintenanceAiGateways, maintenanceAiSearchBootstrap,
  maintenancePrimaryBindingBootstrap) {
  const items = Array.isArray(blockers) ? blockers : [];
  const blockerText = items.length === 0 ? "No known full-release blockers were reported" :
    `Full-release blockers (${items.length}): ${items.join("; ")}`;
  const ledgerState = migrationReadback?.state === "PASS" ? "PASS" : "NOT_VERIFIED";
  const schemaState = schemaGenerationReadback?.state === "PASS" ? "PASS" : "NOT_VERIFIED";
  const routeState = routeUpdate === null
    ? "Authenticated candidate capability profile matched the active Worker before upload and after synchronization. "
    : "Authenticated readback matched the pinned baseline routes before upload and the exact candidate routes after upload; all non-route capability fields remained unchanged. ";
  const aiGatewayState = maintenanceAiGateways === null ? "" :
    `Existing AI Gateway inventory and settings were pinned by managed OAuth GET-only readback and rechecked before upload, after upload, and after authority synchronization; reasoning remained present and retrieval remained ${maintenanceAiGateways.gateways.retrieval === null ? "absent" : "present"}. No AI Gateway resource was created or edited. `;
  const aiSearchState = maintenanceAiSearchBootstrap === null ? "" :
    "The exact existing AI Search namespace was verified with GET-only provisioner readback before upload; only the pinned AI_SEARCH:eliotr Worker binding was added, with RETRIEVAL and ERASURE disabled. ";
  const primaryBindingState = maintenancePrimaryBindingBootstrap === null ? "" :
    "The fresh primary backup bucket creation receipt and exact VERSION_METADATA/BACKUP_PARTS_BUCKET Worker readback were pinned before upload and after synchronization; existing bindings remained preserved and RETRIEVAL/ERASURE stayed disabled. ";
  return `Worker/assets maintenance deployment only; this receipt does not qualify a full release. ${blockerText}. ` +
    `Source-maintainability budget gate: ${sourceBudgetState ?? "NOT_EXECUTED"}. ` +
    `${sourceBudgetFindings === null ? "No source-budget failure output was observed. " : `Source-budget findings: ${sourceBudgetFindings}. `}` +
    `D1 migrations were not applied; exact existing migration ledger readback: ${ledgerState}; ` +
    `required Core/Search schema generation readback: ${schemaState}. ` +
    routeState + aiGatewayState + aiSearchState + primaryBindingState +
    "ETag and local migration hashes are not remote content proof; product and workload gates remain separate.";
}

function assertMaintenanceAiGatewayTargets(profile, config) {
  if (profile?.protocol !== "eliotr.maintenance-ai-gateway-profile.v1" ||
      typeof profile.targets?.reasoning_url !== "string" || typeof profile.targets?.retrieval_url !== "string" ||
      config?.vars?.AI_GATEWAY_REASONING_URL !== profile.targets.reasoning_url ||
      config?.vars?.AI_GATEWAY_RETRIEVAL_URL !== profile.targets.retrieval_url) {
    throw new Error("Generated deployment AI Gateway URLs do not match the pinned maintenance profile");
  }
}

async function recordMaintenanceAiGatewayReadback({ profile, readbacks, stage, result } = {}) {
  const expectedRetrieval = profile?.gateways?.retrieval === null ? "ABSENT" : "PRESENT";
  const presence = result?.gateway_presence;
  if (result?.state !== "PASS" || result.protocol !== profile?.protocol ||
      result.profile_sha256 !== profile?.profile_sha256 || presence === null || typeof presence !== "object" ||
      Array.isArray(presence) || Object.keys(presence).length !== 2 ||
      presence.reasoning !== "PRESENT" || presence.retrieval !== expectedRetrieval ||
      !["before_upload", "after_upload_before_authority_sync", "after_authority_sync"].includes(stage)) {
    throw new Error("Maintenance AI Gateway readback does not match the pinned profile");
  }
  readbacks[stage] = Object.freeze({ state: "PASS", profile_sha256: profile.profile_sha256,
    gateway_presence: Object.freeze({ reasoning: presence.reasoning, retrieval: presence.retrieval }) });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
