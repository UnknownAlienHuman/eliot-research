import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyAccessRuntimeVars, applyMcpRuntimeVars, resolveAccessRuntimeConfiguration,
  resolveMcpAccessRuntimeConfiguration } from "./lib/access-runtime-config.mjs";
import { LOGIN_INSTRUCTION, loadWranglerOAuthCredential, resolveAuthMode,
  scrubTokenEnv, verifyWranglerOAuthAccount, WRANGLER_OAUTH_MODE } from "./lib/cloudflare-wrangler-oauth.mjs";
import { isUsageAdmissionCapability, runUsagePreflight } from "./lib/cloudflare-usage-admission.mjs";
import { loadResearchRuntimeEnvironment, RESEARCH_RUNTIME_CONFIGURATION_KEYS } from "./lib/research-runtime-config.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Isolated state root for tests: ELIOTR_STATE_DIRECTORY overrides the shared
// gitignored .eliotr-state so parallel/serial runs never communicate through
// leftover receipts. Production default is unchanged.
const stateDirectory = process.env.ELIOTR_STATE_DIRECTORY ? resolve(process.env.ELIOTR_STATE_DIRECTORY) : resolve(repositoryRoot, ".eliotr-state");
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
let token = process.env.CLOUDFLARE_API_TOKEN;
const apiBase = process.env.CLOUDFLARE_API_BASE_URL ?? "https://api.cloudflare.com/client/v4";
const checkOnly = process.argv.includes("--check-only");
const showHelp = process.argv.includes("--help") || process.argv.includes("-h");
if (showHelp) {
  console.log("Usage: scripts/provision-cloudflare-core.mjs [--check-only] [--help]\nProvisions the Cloudflare foundation (D1/R2/Queues) from infra/cloudflare/resources.json. --check-only prints the plan with zero mutations.");
  process.exitCode = 0;
}
if (!showHelp) {
const researchRuntimeEnvironment = await loadResearchRuntimeEnvironment(process.env, repositoryRoot);
let authMode = "api-token";
try {
  authMode = resolveAuthMode(process.env);
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exit(2);
}
if (authMode === WRANGLER_OAUTH_MODE) {
  // Direct-invocation OAuth path (cf:preflight:remote bypasses the deployer
  // injection). Bearer stays in process memory only: never argv/logs/files.
  if (!accountId) {
    console.error(`CLOUDFLARE_ACCOUNT_ID is required. ${LOGIN_INSTRUCTION}`);
    process.exit(2);
  }
  try {
    const credential = await loadWranglerOAuthCredential({ env: process.env, now: Date.now() });
    token = credential.bearer;
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exit(2);
  }
  try {
    // Official-profile account pin before the first Cloudflare GET. Always
    // spawns the official `wrangler whoami` with a token-scrubbed env so the
    // browser-OAuth profile itself (not an injected bearer) is verified. No
    // ambient test seam is honored here; tests must fake the binary or call
    // the library with explicit injection.
    const scrubbed = scrubTokenEnv(process.env);
    const result = spawnSync("pnpm", ["exec", "wrangler", "whoami"],
      { cwd: repositoryRoot, env: scrubbed, encoding: "utf8", shell: process.platform === "win32" });
    if (result.error || result.status !== 0) {
      console.error(`Wrangler verification (wrangler whoami exit ${result.status ?? "unknown"}) failed. ${LOGIN_INSTRUCTION}`);
      process.exit(2);
    }
    await verifyWranglerOAuthAccount({ expectedAccountId: accountId, getWhoamiOutput: async () => result.stdout ?? "" });
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exit(2);
  }
} else if (!accountId || !token) {
  console.error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
  process.exit(2);
}

// FIX1-B usage-envelope gate (narrow): usage preflight before the first
// remote mutation. In-process shared runner writes the redacted admission
// receipt. BLOCKED exits in every mode; any other non-ADMITTED decision
// (SEALED) exits in apply mode — SEALED never POSTs/PUTs/PATCHes/DELETEs,
// uploads a Worker, or applies a migration. ADMITTED alone never suffices:
// apply additionally requires the same-process admission capability minted by
// the fresh live collection lifecycle (staged snapshots and persisted
// receipts carry none). Check-only inspection stays read-only metadata
// (GET inventory lists, local config generation).
{
  let usageGate;
  try {
    usageGate = await runUsagePreflight({ env: process.env, nowMs: Date.now(), writeReceipt: true,
      receiptPath: resolve(stateDirectory, "cloudflare-usage-admission-receipt.json"), cwd: repositoryRoot });
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exit(2);
  }
  const admittedWithCapability = usageGate.decision === "ADMITTED" && isUsageAdmissionCapability(usageGate.capability);
  if (usageGate.decision === "BLOCKED" || (!checkOnly && !admittedWithCapability)) {
    console.error(`Cloudflare usage preflight ${usageGate.decision} denies foundation provisioning before any mutation. ${usageGate.evaluation.reasons.join("; ")}${usageGate.decision === "ADMITTED" ? " Missing same-process admission capability: ADMITTED alone never authorizes mutations." : ""}`);
    process.exit(2);
  }
}

const desiredPath = resolve(repositoryRoot, "infra/cloudflare/resources.json");
const desired = JSON.parse(await readFile(desiredPath, "utf8"));
const canonicalPath = resolve(repositoryRoot, desired.worker.canonical_config);
const generatedPath = resolve(repositoryRoot, desired.worker.generated_config);
const receiptPath = resolve(repositoryRoot, desired.worker.receipt);
const canonicalConfig = parseStrictJsonCompatibleJsonc(await readFile(canonicalPath, "utf8"), desired.worker.canonical_config);
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const enc = encodeURIComponent;
const SEMANTIC_SERVER_CONFIGURATION_KEYS = RESEARCH_RUNTIME_CONFIGURATION_KEYS;

function parseStrictJsonCompatibleJsonc(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} must remain strict-JSON-compatible JSONC so the audited deploy generator can parse it without executing code: ${error.message}`, { cause: error });
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value;
}

function assertUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

async function request(method, path, { body, extraHeaders, allow404 = false } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: { ...headers, ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (allow404 && response.status === 404) return null;
  if (!response.ok || payload.success === false) {
    throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(payload.errors ?? payload, null, 2)}`);
  }
  return payload.result ?? payload;
}

function assertManifest() {
  if (desired.protocol !== "eliotr.cloudflare-foundation.v1") throw new Error(`unsupported foundation protocol ${desired.protocol}`);
  assertNonEmptyString(desired.generation, "generation");
  assertNonEmptyString(desired.worker?.name, "worker.name");
  assertUnique(desired.d1_databases.map((item) => assertNonEmptyString(item.name, "D1 name")), "D1 name");
  assertUnique(desired.d1_databases.map((item) => assertNonEmptyString(item.binding, "D1 binding")), "D1 binding");
  assertUnique(desired.r2_buckets.map((item) => assertNonEmptyString(item.name, "R2 name")), "R2 name");
  assertUnique(desired.r2_buckets.map((item) => assertNonEmptyString(item.binding, "R2 binding")), "R2 binding");
  assertUnique(desired.queues.map((item) => assertNonEmptyString(item.name, "Queue name")), "Queue name");
  const primary = desired.queues.filter((item) => item.role === "primary");
  const deadLetters = desired.queues.filter((item) => item.role === "dead_letter");
  if (primary.length !== 1 || deadLetters.length !== 1) throw new Error("exactly one primary Queue and one dead-letter Queue are required");
  if (!primary[0].binding) throw new Error("primary Queue requires a Worker binding");
}

function assertCanonicalBindingAlignment() {
  const canonicalD1 = new Map((canonicalConfig.d1_databases ?? []).map((item) => [item.binding, item]));
  const canonicalR2 = new Map((canonicalConfig.r2_buckets ?? []).map((item) => [item.binding, item]));
  const canonicalQueues = new Map((canonicalConfig.queues?.producers ?? []).map((item) => [item.binding, item]));

  for (const spec of desired.d1_databases) {
    const item = canonicalD1.get(spec.binding);
    if (!item || item.database_name !== spec.name) throw new Error(`canonical D1 binding ${spec.binding} must name ${spec.name}`);
  }
  for (const spec of desired.r2_buckets) {
    const item = canonicalR2.get(spec.binding);
    if (!item || item.bucket_name !== spec.name) throw new Error(`canonical R2 binding ${spec.binding} must name ${spec.name}`);
  }
  for (const spec of desired.queues.filter((item) => item.binding)) {
    const item = canonicalQueues.get(spec.binding);
    if (!item || item.queue !== spec.name) throw new Error(`canonical Queue binding ${spec.binding} must name ${spec.name}`);
  }
  const expectedDlq = desired.queues.find((item) => item.role === "dead_letter")?.name;
  const consumers = canonicalConfig.queues?.consumers ?? [];
  if (consumers.length !== 1 || consumers[0].queue !== desired.queues.find((item) => item.role === "primary")?.name || consumers[0].dead_letter_queue !== expectedDlq) {
    throw new Error("canonical Queue consumer must bind the desired primary Queue and DLQ exactly");
  }
}

async function inspectD1(spec) {
  const result = await request("GET", `/accounts/${enc(accountId)}/d1/database?name=${enc(spec.name)}&per_page=100`);
  const exact = (Array.isArray(result) ? result : []).filter((item) => item.name === spec.name);
  if (exact.length > 1) throw new Error(`multiple D1 databases named ${spec.name}; refusing ambiguous binding`);
  const existing = exact[0] ?? null;
  if (existing && (typeof existing.uuid !== "string" || existing.uuid.trim() === "")) {
    throw new Error(`D1 ${spec.name} readback lacks a stable uuid`);
  }
  if (existing && spec.jurisdiction !== undefined && (existing.jurisdiction ?? null) !== spec.jurisdiction) {
    throw new Error(`D1 ${spec.name} jurisdiction drift: expected ${spec.jurisdiction}, got ${existing.jurisdiction ?? "default"}`);
  }
  return { spec, existing };
}

async function inspectR2(spec) {
  const jurisdiction = spec.jurisdiction ?? "default";
  const existing = await request("GET", `/accounts/${enc(accountId)}/r2/buckets/${enc(spec.name)}`, {
    allow404: true,
    extraHeaders: { "cf-r2-jurisdiction": jurisdiction },
  });
  if (existing) {
    const actualJurisdiction = existing.jurisdiction ?? "default";
    const actualStorageClass = existing.storage_class ?? "Standard";
    if (actualJurisdiction !== jurisdiction || actualStorageClass !== spec.storage_class) {
      throw new Error(`R2 ${spec.name} immutable profile drift: expected ${jurisdiction}/${spec.storage_class}, got ${actualJurisdiction}/${actualStorageClass}`);
    }
  }
  return { spec, existing };
}

async function inspectQueues() {
  const result = await request("GET", `/accounts/${enc(accountId)}/queues`);
  const existingQueues = Array.isArray(result) ? result : [];
  return desired.queues.map((spec) => {
    const exact = existingQueues.filter((item) => item.queue_name === spec.name);
    if (exact.length > 1) throw new Error(`multiple Queues named ${spec.name}; refusing ambiguous binding`);
    const existing = exact[0] ?? null;
    if (existing && (typeof existing.queue_id !== "string" || existing.queue_id.trim() === "")) {
      throw new Error(`Queue ${spec.name} readback lacks a stable queue_id`);
    }
    return { spec, existing };
  });
}

async function createD1(plan) {
  if (plan.existing) return { ...plan, disposition: "VERIFIED" };
  const body = { name: plan.spec.name };
  if (plan.spec.jurisdiction !== undefined) body.jurisdiction = plan.spec.jurisdiction;
  const existing = await request("POST", `/accounts/${enc(accountId)}/d1/database`, { body });
  if (!existing?.uuid) throw new Error(`D1 ${plan.spec.name} creation readback lacks uuid`);
  return { ...plan, existing, disposition: "CREATED" };
}

async function createR2(plan) {
  if (plan.existing) return { ...plan, disposition: "VERIFIED" };
  const jurisdiction = plan.spec.jurisdiction ?? "default";
  const body = { name: plan.spec.name, storageClass: plan.spec.storage_class };
  if (plan.spec.location_hint) body.locationHint = plan.spec.location_hint;
  const existing = await request("POST", `/accounts/${enc(accountId)}/r2/buckets`, {
    body,
    extraHeaders: { "cf-r2-jurisdiction": jurisdiction },
  });
  if (existing?.name !== plan.spec.name) throw new Error(`R2 ${plan.spec.name} creation readback mismatch`);
  return { ...plan, existing, disposition: "CREATED" };
}

async function createQueue(plan) {
  if (plan.existing) return { ...plan, disposition: "VERIFIED" };
  const existing = await request("POST", `/accounts/${enc(accountId)}/queues`, { body: { queue_name: plan.spec.name } });
  if (existing?.queue_name !== plan.spec.name || !existing?.queue_id) throw new Error(`Queue ${plan.spec.name} creation readback mismatch`);
  return { ...plan, existing, disposition: "CREATED" };
}

function validatePublicRouteConfiguration() {
  const accessHostname = assertNonEmptyString(process.env.ELIOTR_ACCESS_HOSTNAME, "ELIOTR_ACCESS_HOSTNAME").trim().toLowerCase();
  validateHostname(accessHostname, "ELIOTR_ACCESS_HOSTNAME");
  const customDomainMode = process.env.ELIOTR_CUSTOM_DOMAIN;
  if (customDomainMode !== "0" && customDomainMode !== "1") {
    throw new Error("ELIOTR_CUSTOM_DOMAIN must be explicitly set to 0 (one protected workers.dev hostname) or 1 (one protected Custom Domain)");
  }
  if (customDomainMode === "1") {
    if (accessHostname.endsWith(".workers.dev")) throw new Error("ELIOTR_CUSTOM_DOMAIN=1 requires a non-workers.dev hostname");
  } else {
    const expectedPrefix = `${desired.worker.name}.`;
    if (!accessHostname.startsWith(expectedPrefix) || !accessHostname.endsWith(".workers.dev")) {
      throw new Error(`ELIOTR_CUSTOM_DOMAIN=0 requires the exact ${desired.worker.name}.<account-subdomain>.workers.dev hostname`);
    }
  }
  return { accessHostname, customDomainMode };
}

function buildGeneratedConfig(d1Results, publicRoute, accessRuntime, mcpAccessRuntime) {
  const generated = structuredClone(canonicalConfig);
  const ids = new Map(d1Results.map((item) => [item.spec.binding, item.existing.uuid]));
  generated.d1_databases = generated.d1_databases.map((item) => {
    const databaseId = ids.get(item.binding);
    if (!databaseId) throw new Error(`no provisioned D1 id for binding ${item.binding}`);
    return { ...item, database_id: databaseId };
  });

  const environment = process.env.ELIOTR_ENVIRONMENT ?? "production";
  if (!["development", "staging", "production"].includes(environment)) throw new Error(`invalid ELIOTR_ENVIRONMENT ${environment}`);
  const deploymentGeneration = assertNonEmptyString(process.env.ELIOTR_DEPLOYMENT_GENERATION, "ELIOTR_DEPLOYMENT_GENERATION");
  generated.vars = applyAccessRuntimeVars({
    ...generated.vars,
    ENVIRONMENT: environment,
    DEPLOYMENT_GENERATION: deploymentGeneration,
    AI_GATEWAY_REASONING_URL: `https://gateway.ai.cloudflare.com/v1/${accountId}/eliotr-reasoning`,
    AI_GATEWAY_RETRIEVAL_URL: `https://gateway.ai.cloudflare.com/v1/${accountId}/eliotr-retrieval`,
  }, accessRuntime);
  for (const key of SEMANTIC_SERVER_CONFIGURATION_KEYS) {
    if (Object.hasOwn(researchRuntimeEnvironment, key) && typeof researchRuntimeEnvironment[key] === "string") {
      generated.vars[key] = researchRuntimeEnvironment[key];
    } else delete generated.vars[key];
  }
  if (mcpAccessRuntime !== null) {
    generated.vars = applyMcpRuntimeVars(generated.vars, mcpAccessRuntime);
  }

  if (publicRoute.customDomainMode === "1") {
    generated.routes = [{ pattern: publicRoute.accessHostname, custom_domain: true }];
    generated.workers_dev = false;
  } else {
    delete generated.routes;
    generated.workers_dev = true;
  }
  generated.preview_urls = false;
  return generated;
}

function validateHostname(hostname, label) {
  if (hostname.includes("://") || hostname.includes("/") || hostname.startsWith("*") || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname)) {
    throw new Error(`${label} must be one exact lowercase hostname without scheme, path, port, or wildcard`);
  }
}

assertManifest();
assertCanonicalBindingAlignment();
const publicRoute = validatePublicRouteConfiguration();

// AUD bootstrap ordering: the Access provisioner creates/verifies the exact
// hostname app FIRST and persists the Cloudflare-generated AUD plus exact team
// origin in the ignored non-secret Access receipt. Core feeds that verified
// authority into generated config before any D1/R2/Queue exposure. A missing
// receipt with no invented env AUD is a valid CREATE plan, never a demand for
// an invented AUD. Apply without any authority fails before the first mutation.
const accessReceiptPath = resolve(stateDirectory, "cloudflare-access-receipt.json");
async function loadAccessReceipt() {
  try {
    const raw = await readFile(accessReceiptPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}
const accessReceipt = await loadAccessReceipt();
const envHasAudAuthority = (process.env.ELIOTR_ACCESS_TEAM_DOMAIN?.trim() ?? "") !== "" &&
  (process.env.ELIOTR_ACCESS_AUDIENCE?.trim() ?? "") !== "";
let accessRuntime = null;
let mcpAccessRuntime = null;
let accessDisposition = "VERIFY";
if (accessReceipt) {
  if (typeof accessReceipt.account_id === "string" && accessReceipt.account_id !== accountId) {
    throw new Error("Access receipt binds a different account; refusing substituted receipt before any Cloudflare read");
  }
  if (typeof accessReceipt.hostname === "string" && accessReceipt.hostname !== publicRoute.accessHostname) {
    throw new Error("Access receipt binds a different hostname; refusing substituted receipt before any Cloudflare read");
  }
  accessRuntime = resolveAccessRuntimeConfiguration(process.env, accessReceipt);
} else if (envHasAudAuthority) {
  accessRuntime = resolveAccessRuntimeConfiguration(process.env, null);
} else {
  accessDisposition = "CREATE";
}

if (canonicalConfig.vars.GOOGLE_EXTERNAL_TRANSPORT === "gemini-mcp") {
  mcpAccessRuntime = resolveMcpAccessRuntimeConfiguration(process.env, accessReceipt, {
    ordinaryAudience: accessRuntime?.audience,
    publicHostname: publicRoute.accessHostname,
    checkOnly,
    profileDefault: canonicalConfig.vars.MCP_ACCESS_AUTH_PROFILE,
  });
}

// Inspect every existing resource before creating any missing resource. An immutable-profile drift in
// a later resource therefore cannot leave a partially-created environment.
const d1Plans = await Promise.all(desired.d1_databases.map(inspectD1));
const r2Plans = await Promise.all(desired.r2_buckets.map(inspectR2));
const queuePlans = await inspectQueues();

// Cross-product GET-only Access recheck (no mutation): when a receipt binds an
// app id, confirm the live inventory still holds that exact app before the
// first foundation mutation. A tolerant pass keeps historical mocks (no AUD on
// the wire) working while live drift still fails closed below.
let liveAccessBinding = null;
if (accessReceipt?.application?.id) {
  const liveApps = await request("GET", `/accounts/${enc(accountId)}/access/apps?per_page=100`);
  const candidates = (Array.isArray(liveApps) ? liveApps : []).filter((app) => app?.id === accessReceipt.application.id);
  if (candidates.length > 1) throw new Error("ambiguous live Access application binding; refusing to proceed");
  const live = candidates[0] ?? null;
  if (!live) throw new Error("Access receipt app id is absent from live inventory; re-run the Access provisioner before foundation mutations");
  if (live.name !== accessReceipt.application.name) throw new Error("live Access app name drift vs receipt; refusing stale receipt");
  const liveUris = Array.isArray(live.destinations) ? live.destinations.map((item) => String(item?.uri ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase()) : [];
  if (!liveUris.includes(publicRoute.accessHostname)) throw new Error("live Access app destination drift vs receipt hostname; refusing stale receipt");
  if (typeof live.aud === "string" && live.aud !== "" && accessReceipt.aud && live.aud !== accessReceipt.aud) {
    throw new Error("live Access AUD drift vs receipt; refusing stale receipt");
  }
  liveAccessBinding = { id: live.id, aud: accessReceipt.aud ?? live.aud ?? null };
}

if (checkOnly) {
  console.log(JSON.stringify({
    protocol: "eliotr.cloudflare-foundation-plan.v1",
    desired_generation: desired.generation,
    mode: "CHECK_ONLY_NO_MUTATION",
    access_runtime: accessRuntime ? {
      disposition: accessDisposition,
      team_domain: accessRuntime.teamDomain,
      audience_configured: true,
      service_principal_count: accessRuntime.servicePrincipalCount,
      source: accessRuntime.source ?? "ENVIRONMENT",
    } : {
      disposition: "CREATE",
      team_domain: null,
      audience_configured: false,
      service_principal_count: 0,
      source: "NONE_RUN_ACCESS_PROVISIONER_FIRST",
    },
    access_app_binding: accessReceipt ? {
      app_id: accessReceipt.application?.id ?? null,
      aud: accessReceipt.aud ?? null,
      team_domain: accessReceipt.team_domain ?? null,
      hostname: accessReceipt.hostname ?? null,
    } : null,
    mcp_access_runtime: mcpAccessRuntime ? {
      source: mcpAccessRuntime.source,
      hostname: mcpAccessRuntime.hostname,
      path: mcpAccessRuntime.path,
      team_domain: mcpAccessRuntime.teamDomain,
      audience_configured: mcpAccessRuntime.audience !== null,
      auth_profile: mcpAccessRuntime.authProfile,
      service_token_client_id_configured: mcpAccessRuntime.serviceTokenClientIdConfigured,
      application_id: mcpAccessRuntime.applicationId,
    } : null,
    d1_databases: d1Plans.map((item) => ({ binding: item.spec.binding, name: item.spec.name, disposition: item.existing ? "VERIFY" : "CREATE" })),
    r2_buckets: r2Plans.map((item) => ({ binding: item.spec.binding, name: item.spec.name, disposition: item.existing ? "VERIFY" : "CREATE" })),
    queues: queuePlans.map((item) => ({ binding: item.spec.binding ?? null, name: item.spec.name, disposition: item.existing ? "VERIFY" : "CREATE" })),
  }, null, 2));
  process.exitCode = 0;
}

if (!checkOnly) {
if (!accessRuntime) {
  throw new Error("missing Access authority: run scripts/provision-cloudflare-access.mjs first so the verified AUD and team origin feed core config generation; refusing foundation mutations");
}

const d1Results = [];
for (const plan of d1Plans) d1Results.push(await createD1(plan));
const r2Results = [];
for (const plan of r2Plans) r2Results.push(await createR2(plan));
const queueResults = [];
for (const plan of queuePlans) queueResults.push(await createQueue(plan));

const generatedConfig = buildGeneratedConfig(d1Results, publicRoute, accessRuntime, mcpAccessRuntime);
const generatedConfigText = `${JSON.stringify(generatedConfig, null, 2)}\n`;
const generatedConfigSha256 = createHash("sha256").update(generatedConfigText, "utf8").digest("hex");
await mkdir(dirname(generatedPath), { recursive: true });
const generatedTemporary = `${generatedPath}.${process.pid}.tmp`;
await writeFile(generatedTemporary, generatedConfigText, { mode: 0o600 });
await rename(generatedTemporary, generatedPath);

const receipt = {
  protocol: "eliotr.cloudflare-foundation-receipt.v1",
  desired_generation: desired.generation,
  deployment_generation: generatedConfig.vars.DEPLOYMENT_GENERATION,
  environment: generatedConfig.vars.ENVIRONMENT,
  generated_config: desired.worker.generated_config,
  generated_config_sha256: generatedConfigSha256,
  account_id: accountId,
  account_ref: `cloudflare-account:${accountId.slice(0, 6)}…${accountId.slice(-4)}`,
  d1_databases: d1Results.map((item) => ({ binding: item.spec.binding, name: item.spec.name, database_id: item.existing.uuid, disposition: item.disposition })),
  r2_buckets: r2Results.map((item) => ({ binding: item.spec.binding, name: item.spec.name, jurisdiction: item.spec.jurisdiction ?? "default", storage_class: item.spec.storage_class, disposition: item.disposition })),
  queues: queueResults.map((item) => ({ binding: item.spec.binding ?? null, name: item.spec.name, queue_id: item.existing.queue_id, role: item.spec.role, disposition: item.disposition })),
  access_hostname: publicRoute.accessHostname,
  access_team_domain: generatedConfig.vars.ACCESS_TEAM_DOMAIN,
  access_audience_configured: generatedConfig.vars.ACCESS_AUDIENCE.length > 0,
  access_aud: accessRuntime.audience,
  access_app_id: accessReceipt?.application?.id ?? liveAccessBinding?.id ?? null,
  access_owner_email_set_sha256: accessReceipt?.policy?.owner_email_set_sha256 ?? null,
  access_service_principal_count: accessRuntime.servicePrincipalCount,
  public_route_mode: publicRoute.customDomainMode === "1" ? "CUSTOM_DOMAIN_ONLY" : "WORKERS_DEV_ONLY",
  alternative_public_routes: "PROHIBITED",
  access_provisioning: "SEPARATE_REQUIRED_GATE",
  created_at: new Date().toISOString(),
};
await mkdir(dirname(receiptPath), { recursive: true });
const receiptTemporary = `${receiptPath}.${process.pid}.tmp`;
await writeFile(receiptTemporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
await rename(receiptTemporary, receiptPath);
console.log(JSON.stringify(receipt, null, 2));
}
}
