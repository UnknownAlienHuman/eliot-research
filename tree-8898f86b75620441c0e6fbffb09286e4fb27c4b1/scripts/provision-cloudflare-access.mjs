import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOGIN_INSTRUCTION, loadWranglerOAuthCredential, resolveAuthMode,
  scrubTokenEnv, verifyWranglerOAuthAccount, WRANGLER_OAUTH_MODE } from "./lib/cloudflare-wrangler-oauth.mjs";
import { CLOUDFLARE_MCP_TRANSPORT, createCloudflareMcpTransport } from "./lib/cloudflare-mcp-oauth.mjs";
import { isUsageAdmissionCapability, runUsagePreflight } from "./lib/cloudflare-usage-admission.mjs";
import { readConfiguredTransport } from "./check-launch-code.mjs";
import {
  applyMcp,
  buildMcpReceipt,
  createMcpAccessConfig,
  mcpPlanSummary,
  preflightMcp,
} from "./lib/cloudflare-access-mcp.mjs";

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
  console.log("Usage: scripts/provision-cloudflare-access.mjs [--check-only] [--help]\nProvisions the hostname-based Cloudflare Access application and owner policy. --check-only prints the plan with zero mutations.");
  process.exitCode = 0;
}
if (!showHelp) {
const hostname = process.env.ELIOTR_ACCESS_HOSTNAME?.trim().toLowerCase();
const ownerEmails = parseOwnerEmails(process.env.ELIOTR_OWNER_EMAILS);
const allowedAdditionalPolicyIds = new Set((process.env.ELIOTR_ALLOWED_ADDITIONAL_ACCESS_POLICY_IDS ?? "").split(",").map((item) => item.trim()).filter(Boolean));
const accessTransport = (process.env.ELIOTR_ACCESS_TRANSPORT ?? "wrangler").trim() || "wrangler";
if (accessTransport !== "wrangler" && accessTransport !== CLOUDFLARE_MCP_TRANSPORT) {
  console.error("ELIOTR_ACCESS_TRANSPORT must be wrangler or cloudflare-mcp");
  process.exit(2);
}
let mcpTransport = null;
function exitWithMcpCleanup(code) { mcpTransport?.close(); process.exit(code); }
function parseOwnerEmails(value) {
  if (!value) return [];
  const emails = value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const unique = [...new Set(emails)];
  for (const email of unique) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`invalid owner email ${email}`);
  }
  return unique.sort();
}

let authMode = "api-token";
try {
  authMode = resolveAuthMode(process.env);
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exit(2);
}
try {
if (accessTransport === CLOUDFLARE_MCP_TRANSPORT) {
  if (authMode !== WRANGLER_OAUTH_MODE) {
    console.error(`ELIOTR_ACCESS_TRANSPORT=${CLOUDFLARE_MCP_TRANSPORT} requires ELIOTR_CLOUDFLARE_AUTH_MODE=${WRANGLER_OAUTH_MODE}; static-token mode is prohibited`);
    process.exit(2);
  }
  if (!accountId) {
    console.error(`CLOUDFLARE_ACCOUNT_ID is required. ${LOGIN_INSTRUCTION}`);
    process.exit(2);
  }
} else if (authMode === WRANGLER_OAUTH_MODE) {
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
    // spawns the official `wrangler whoami` with a token-scrubbed env. No
    // ambient test seam is honored here.
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
// (SEALED) exits in apply mode — SEALED never POSTs app or policy creates.
// ADMITTED alone never suffices in apply mode: the same-process admission
// capability minted by fresh live collection is additionally required.
// Check-only inspection stays read-only metadata.
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
    console.error(`Cloudflare usage preflight ${usageGate.decision} denies Access provisioning before any mutation. ${usageGate.evaluation.reasons.join("; ")}${usageGate.decision === "ADMITTED" ? " Missing same-process admission capability: ADMITTED alone never authorizes mutations." : ""}`);
    process.exit(2);
  }
}
if (accessTransport === CLOUDFLARE_MCP_TRANSPORT) {
  try {
    mcpTransport = createCloudflareMcpTransport({
      cwd: process.env.ELIOTR_CLOUDFLARE_MCP_CWD,
      accountId,
    });
    await mcpTransport.verifyAccount();
  } catch (error) {
    console.error(error?.message ?? "Cloudflare MCP account verification failed");
    exitWithMcpCleanup(2);
  }
}
if (!hostname) {
  console.error("ELIOTR_ACCESS_HOSTNAME is required for a live deployment");
  exitWithMcpCleanup(2);
}
validateHostname(hostname);
if (ownerEmails.length === 0) {
  console.error("ELIOTR_OWNER_EMAILS must contain at least one exact owner email");
  exitWithMcpCleanup(2);
}

const desired = JSON.parse(await readFile(resolve(repositoryRoot, "infra/cloudflare/access.json"), "utf8"));
if (desired.protocol !== "eliotr.cloudflare-access.v1" || desired.requirements?.hostname_based !== true) {
  throw new Error("unsupported or unsafe Access desired-state manifest");
}
const appName = `${desired.application.name_prefix}: ${hostname}`;
const policyName = desired.policy.name;
const configuredGoogleTransport = process.env.ELIOTR_GOOGLE_EXTERNAL_TRANSPORT;
const canonicalConfig = JSON.parse(await readFile(resolve(repositoryRoot, "apps/eliotr-core/wrangler.jsonc"), "utf8"));
const canonicalGoogleTransport = readConfiguredTransport(canonicalConfig);
const googleTransport = configuredGoogleTransport ?? "disabled";
if (!["disabled", "gemini-mcp", "drive-exchange"].includes(googleTransport)) {
  throw new Error("ELIOTR_GOOGLE_EXTERNAL_TRANSPORT must be disabled, gemini-mcp, or drive-exchange");
}
if (configuredGoogleTransport !== undefined && googleTransport !== canonicalGoogleTransport) {
  throw new Error("ELIOTR_GOOGLE_EXTERNAL_TRANSPORT differs from the canonical Core deployment config");
}
if (!checkOnly && configuredGoogleTransport === undefined && canonicalGoogleTransport !== "disabled") {
  throw new Error("ELIOTR_GOOGLE_EXTERNAL_TRANSPORT must be explicit before issuing an owner-only Access receipt");
}
const mcpEnabled = googleTransport === "gemini-mcp";
const mcpDesired = desired.mcp;
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const enc = encodeURIComponent;

function validateHostname(value) {
  if (value.includes("://") || value.includes("/") || value.startsWith("*") || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value)) {
    throw new Error("ELIOTR_ACCESS_HOSTNAME must be one exact lowercase hostname without scheme, path, port, or wildcard");
  }
}

async function request(method, path, body) {
  if (mcpTransport !== null) return mcpTransport.request(method, path, body);
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (!response.ok || payload.success === false) {
    throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(payload.errors ?? payload, null, 2)}`);
  }
  return payload.result ?? payload;
}

async function createApplicationWithReconciliation(name, body) {
  let created;
  try {
    created = await request("POST", `/accounts/${enc(accountId)}/access/apps`, body);
  } catch (error) {
    const inventory = await request("GET", `/accounts/${enc(accountId)}/access/apps?per_page=100`);
    const matches = (Array.isArray(inventory) ? inventory : []).filter((app) => app.name === name);
    if (matches.length === 1 && matches[0]?.id) return matches[0];
    throw error;
  }
  if (created?.id) return created;
  const inventory = await request("GET", `/accounts/${enc(accountId)}/access/apps?per_page=100`);
  const matches = (Array.isArray(inventory) ? inventory : []).filter((app) => app.name === name);
  if (matches.length !== 1 || !matches[0]?.id) throw new Error(`Access application ${name} creation readback lacks id`);
  return matches[0];
}

async function freshApplication(id) {
  const inventory = await request("GET", `/accounts/${enc(accountId)}/access/apps?per_page=100`);
  const application = (Array.isArray(inventory) ? inventory : []).find((item) => item?.id === id) ?? null;
  if (!application) throw new Error(`Access application ${id} disappeared during readback`);
  return application;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]));
  }
  return value;
}
function equal(left, right) { return JSON.stringify(stable(left)) === JSON.stringify(stable(right)); }
function sha256Hex(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }

const AUD_TAG_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u;
const ACCESS_RECEIPT_PROTOCOL = "eliotr.cloudflare-access-receipt.v1";
const ACCESS_PLAN_PROTOCOL = "eliotr.cloudflare-access-plan.v1";
const receiptPath = resolve(stateDirectory, "cloudflare-access-receipt.json");
const ownerEmailSetSha256 = sha256Hex(ownerEmails.join("\n"));
const allowedAdditionalPolicyIdsSha256 = sha256Hex([...allowedAdditionalPolicyIds].sort().join("\n"));

async function loadPriorReceipt() {
  try {
    const raw = await readFile(receiptPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function extractAud(app) {
  const candidates = [app?.aud, app?.aud_tag, app?.audience];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && AUD_TAG_PATTERN.test(candidate)) return candidate;
  }
  return null;
}

function normalizeTeamOriginStrict(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  let teamUrl;
  try { teamUrl = new URL(value.trim()); } catch { throw new Error(`${label} must be an absolute HTTPS URL`); }
  if (
    teamUrl.protocol !== "https:" ||
    teamUrl.username !== "" ||
    teamUrl.password !== "" ||
    teamUrl.port !== "" ||
    teamUrl.pathname !== "/" ||
    teamUrl.search !== "" ||
    teamUrl.hash !== "" ||
    !teamUrl.hostname.toLowerCase().endsWith(".cloudflareaccess.com")
  ) {
    throw new Error(`${label} must be one https://<team>.cloudflareaccess.com origin`);
  }
  return teamUrl.origin;
}

function teamOriginFromOrganization(payload) {
  const items = Array.isArray(payload) ? payload : [payload];
  const objects = items.filter((item) => item && typeof item === "object" && !Array.isArray(item));
  if (objects.length !== 1) return null;
  const org = objects[0];
  const authDomain = typeof org.auth_domain === "string" ? org.auth_domain.trim() : "";
  if (authDomain !== "") {
    const normalized = authDomain.startsWith("https://") ? authDomain : `https://${authDomain}`;
    try { return normalizeTeamOriginStrict(normalized, "Access organization auth_domain"); } catch { return null; }
  }
  const name = typeof org.name === "string" ? org.name.trim().toLowerCase() : "";
  if (name !== "" && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) {
    try { return normalizeTeamOriginStrict(`https://${name}.cloudflareaccess.com`, "Access organization name"); } catch { return null; }
  }
  return null;
}

async function fetchLiveTeamDomain() {
  try {
    const payload = await request("GET", `/accounts/${enc(accountId)}/access/organizations`);
    const live = teamOriginFromOrganization(payload);
    if (live) return { teamDomain: live, source: "CLOUDFLARE_READBACK" };
  } catch (error) {
    if (!/failed \((404|400)\)/.test(error?.message ?? "")) throw error;
  }
  const fallbackRaw = process.env.ELIOTR_ACCESS_TEAM_DOMAIN?.trim() ?? "";
  if (fallbackRaw !== "") {
    return { teamDomain: normalizeTeamOriginStrict(fallbackRaw, "ELIOTR_ACCESS_TEAM_DOMAIN"), source: "ENVIRONMENT_FALLBACK" };
  }
  return { teamDomain: null, source: "UNKNOWN" };
}

function resolveLiveAud(app, { allowEnvironmentFallback = true } = {}) {
  const live = extractAud(app);
  if (live) return { aud: live, source: "CLOUDFLARE_READBACK" };
  if (!allowEnvironmentFallback) return { aud: null, source: "UNKNOWN" };
  const fallbackRaw = process.env.ELIOTR_ACCESS_AUDIENCE?.trim() ?? "";
  if (fallbackRaw !== "" && AUD_TAG_PATTERN.test(fallbackRaw)) {
    return { aud: fallbackRaw, source: "ENVIRONMENT_FALLBACK" };
  }
  return { aud: null, source: "UNKNOWN" };
}

function normalizedDestinations(app) {
  const destinations = Array.isArray(app.destinations) ? app.destinations : [];
  return destinations
    .filter((item) => item?.type === "public")
    .map((item) => ({ type: "public", uri: String(item.uri ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase() }))
    .sort((left, right) => left.uri.localeCompare(right.uri));
}

function normalizedEmailIncludes(policy) {
  return (Array.isArray(policy.include) ? policy.include : [])
    .flatMap((rule) => typeof rule?.email?.email === "string" ? [rule.email.email.toLowerCase()] : [])
    .sort();
}

const expectedDestination = [{ type: desired.application.destination_type, uri: hostname }];
const expectedPolicy = {
  name: policyName,
  decision: desired.policy.decision,
  include: ownerEmails.map((email) => ({ email: { email } })),
};
const mcpConfig = createMcpAccessConfig({ enabled: mcpEnabled, environment: process.env, desired: mcpDesired, hostname, ownerEmails });

// Hostname-based Access is deliberate because ResearchSession uses WebSockets.
// All local validation and GET preflight completes before the first POST.
const priorReceipt = await loadPriorReceipt();
const applicationsResult = await request("GET", `/accounts/${enc(accountId)}/access/apps?per_page=100`);
const applications = Array.isArray(applicationsResult) ? applicationsResult : [];
const exactApps = applications.filter((app) => app.name === appName);
if (exactApps.length > 1) throw new Error(`multiple Access applications named ${appName}; refusing ambiguous binding`);
const hostnameCollisions = applications.filter((app) => app.name !== appName &&
  normalizedDestinations(app).some((destination) => destination.uri === hostname));
if (hostnameCollisions.length > 0) {
  throw new Error(`wrong Access application already claims ${hostname}: ${JSON.stringify(hostnameCollisions.map((app) => ({ id: app.id ?? null, name: app.name ?? null })))}`);
}
let application = exactApps[0] ?? null;
let applicationDisposition = "VERIFIED";
let policyDisposition = "VERIFIED";

function assertApplicationContour(candidate) {
  const drift = [];
  if (candidate.type !== desired.application.type) drift.push({ field: "type", expected: desired.application.type, actual: candidate.type });
  if ((candidate.session_duration ?? "24h") !== desired.application.session_duration) drift.push({ field: "session_duration", expected: desired.application.session_duration, actual: candidate.session_duration });
  if ((candidate.app_launcher_visible ?? false) !== desired.application.app_launcher_visible) drift.push({ field: "app_launcher_visible", expected: desired.application.app_launcher_visible, actual: candidate.app_launcher_visible });
  if (!equal(normalizedDestinations(candidate), expectedDestination)) drift.push({ field: "destinations", expected: expectedDestination, actual: normalizedDestinations(candidate) });
  if (drift.length > 0) throw new Error(`Access application drift; refusing in-place mutation: ${JSON.stringify(drift, null, 2)}`);
}

if (application) assertApplicationContour(application);
if (application && (!checkOnly || mcpConfig)) {
  application = await freshApplication(application.id);
  assertApplicationContour(application);
  const freshOwnerAud = resolveLiveAud(application, { allowEnvironmentFallback: false }).aud;
  if (!freshOwnerAud) throw new Error("existing Access application readback lacks a bounded AUD");
  const configuredOwnerAud = process.env.ELIOTR_ACCESS_AUDIENCE?.trim() ?? "";
  if (configuredOwnerAud !== "" && configuredOwnerAud !== freshOwnerAud) throw new Error("Access AUD differs from the existing application readback");
}
// GET-only team-origin preflight (live organization readback wins; the
// environment fallback exists only for mocks/transition and must reconcile).
const teamPreflight = await fetchLiveTeamDomain();
let mcpState = null;
if (mcpConfig) mcpState = await preflightMcp({ config: mcpConfig, applications, request, accountId, enc, teamDomain: teamPreflight.teamDomain, ordinaryApplication: application, resolveOrdinaryAud: resolveLiveAud, equal, freshApplication });

function strictPlanBase(extra) {
  return {
    protocol: ACCESS_PLAN_PROTOCOL,
    mode: "CHECK_ONLY_NO_MUTATION",
    account_id: accountId,
    hostname,
    owner_email_set_sha256: ownerEmailSetSha256,
    team_domain: teamPreflight.teamDomain,
    websocket_compatible_contour: "HOSTNAME_BASED_ACCESS",
    worker_level_access: "PROHIBITED_FOR_RESEARCH_SESSION_WEBSOCKETS",
    ...extra,
  };
}

if (!application && checkOnly) {
  console.log(JSON.stringify(strictPlanBase({
    application: { name: appName, disposition: "CREATE" },
    policy: { name: policyName, disposition: "CREATE_INLINE", owner_email_count: ownerEmails.length },
    aud: null,
    aud_disposition: "GENERATED_ON_CREATE",
    team_disposition: teamPreflight.teamDomain ? "VERIFY" : "READBACK_ON_APPLY",
    ...(mcpConfig ? { mcp: mcpPlanSummary(mcpConfig, mcpState) } : {}),
  }), null, 2));
  process.exitCode = 0;
}

if (application || !checkOnly) {
if (!application && !checkOnly) {
  applicationDisposition = "CREATED";
  policyDisposition = "CREATED_INLINE";
  application = await createApplicationWithReconciliation(appName, {
    type: desired.application.type,
    name: appName,
    domain: hostname,
    destinations: expectedDestination,
    session_duration: desired.application.session_duration,
    app_launcher_visible: desired.application.app_launcher_visible,
    policies: [expectedPolicy],
  });
  assertApplicationContour(application);
}

const policiesResult = await request("GET", `/accounts/${enc(accountId)}/access/apps/${enc(application.id)}/policies?per_page=100`);
let policies = Array.isArray(policiesResult) ? policiesResult : [];

function classifyPolicies(items) {
  const owners = items.filter((item) => item.name === policyName);
  if (owners.length > 1) throw new Error(`multiple Access owner policies named ${policyName}`);
  const additional = items.filter((item) => item.name !== policyName);
  const unapproved = additional.filter((item) => !item.id || !allowedAdditionalPolicyIds.has(item.id));
  if (unapproved.length > 0) {
    throw new Error(`undeclared additional Access policies may broaden access: ${JSON.stringify(unapproved.map((item) => ({ id: item.id ?? null, name: item.name ?? null })))}`);
  }
  return { owner: owners[0] ?? null, additional };
}

let classified = classifyPolicies(policies);
if (!classified.owner && checkOnly) {
  const liveAud = resolveLiveAud(application);
  console.log(JSON.stringify(strictPlanBase({
    application: { id: application.id, name: appName, disposition: "VERIFY" },
    policy: { name: policyName, disposition: "CREATE", owner_email_count: ownerEmails.length },
    aud: liveAud.aud,
    aud_disposition: liveAud.aud ? "VERIFY" : "GENERATED_ON_CREATE",
    approved_additional_policy_count: classified.additional.length,
    ...(mcpConfig ? { mcp: mcpPlanSummary(mcpConfig, mcpState) } : {}),
  }), null, 2));
  process.exitCode = 0;
}
if (classified.owner || !checkOnly) {
if (!classified.owner) {
  await request("POST", `/accounts/${enc(accountId)}/access/apps/${enc(application.id)}/policies`, expectedPolicy);
  policyDisposition = policyDisposition === "CREATED_INLINE" ? "CREATED_INLINE" : "CREATED";
  const readback = await request("GET", `/accounts/${enc(accountId)}/access/apps/${enc(application.id)}/policies?per_page=100`);
  policies = Array.isArray(readback) ? readback : [];
  classified = classifyPolicies(policies);
}
const policy = classified.owner;
if (!policy) throw new Error("Access owner policy creation readback is missing");
const policyDrift = [];
if (policy.decision !== expectedPolicy.decision) policyDrift.push({ field: "decision", expected: expectedPolicy.decision, actual: policy.decision });
if (!equal(normalizedEmailIncludes(policy), ownerEmails)) policyDrift.push({ field: "include.email", expected: ownerEmails, actual: normalizedEmailIncludes(policy) });
if (Array.isArray(policy.exclude) && policy.exclude.length > 0) policyDrift.push({ field: "exclude", expected: [], actual: policy.exclude });
if (Array.isArray(policy.require) && policy.require.length > 0) policyDrift.push({ field: "require", expected: [], actual: policy.require });
if (policyDrift.length > 0) throw new Error(`Access owner policy drift; refusing in-place mutation: ${JSON.stringify(policyDrift, null, 2)}`);

if (checkOnly) {
  const liveAud = resolveLiveAud(application);
  console.log(JSON.stringify(strictPlanBase({
    application: { id: application.id, name: appName, disposition: "VERIFY" },
    policy: { id: policy.id ?? null, name: policyName, disposition: "VERIFY", owner_email_count: ownerEmails.length },
    aud: liveAud.aud,
    aud_disposition: "VERIFY",
    approved_additional_policy_count: classified.additional.length,
    ...(mcpConfig ? { mcp: mcpPlanSummary(mcpConfig, mcpState) } : {}),
  }), null, 2));
  process.exitCode = 0;
}

if (!checkOnly) {
if (mcpConfig) mcpState = await applyMcp({ config: mcpConfig, state: mcpState, ordinaryApplication: application, request, accountId, enc, freshApplication, createApplicationWithReconciliation, equal, resolveOrdinaryAud: resolveLiveAud });
// Apply readback: AUD plus exact team origin are Cloudflare authority and are
// persisted only in the ignored non-secret receipt for core config generation.
application = await freshApplication(application.id);
assertApplicationContour(application);
const liveAud = resolveLiveAud(application, { allowEnvironmentFallback: false });
if (!liveAud.aud) throw new Error("Access application readback lacks a bounded AUD tag; refusing to persist unverified authority");
const teamFinal = teamPreflight.teamDomain ?? (await fetchLiveTeamDomain()).teamDomain;
if (!teamFinal) throw new Error("Access team origin is undiscoverable; refusing to persist unverified authority");

if (priorReceipt && priorReceipt.protocol === ACCESS_RECEIPT_PROTOCOL) {
  if (priorReceipt.account_id && priorReceipt.account_id !== accountId) {
    throw new Error("stale Access receipt binds a different account; refusing substitution");
  }
  if (priorReceipt.hostname && priorReceipt.hostname !== hostname) {
    throw new Error("stale Access receipt binds a different hostname; refusing substitution");
  }
  if (priorReceipt.application?.id && priorReceipt.application.id !== application.id) {
    throw new Error("stale Access receipt binds a different Access app id; review before overwrite");
  }
  if (priorReceipt.aud && priorReceipt.aud !== liveAud.aud) {
    throw new Error("Access AUD drift vs prior receipt; refusing silent substitution");
  }
  if (priorReceipt.team_domain && priorReceipt.team_domain !== teamFinal) {
    throw new Error("Access team-domain drift vs prior receipt; refusing silent substitution");
  }
  if (priorReceipt.owner_email_set_sha256 && priorReceipt.owner_email_set_sha256 !== ownerEmailSetSha256) {
    throw new Error("Access owner-set drift vs prior receipt; refusing silent broadening");
  }
  if (mcpConfig && priorReceipt.mcp) {
    if (priorReceipt.mcp.application?.id && priorReceipt.mcp.application.id !== mcpState.application.id) throw new Error("stale MCP receipt binds a different Access app id; review before overwrite");
    if (priorReceipt.mcp.aud && priorReceipt.mcp.aud !== mcpState.liveAud.aud) throw new Error("MCP Access AUD drift vs prior receipt; refusing silent substitution");
    if (priorReceipt.mcp.auth_profile && priorReceipt.mcp.auth_profile !== mcpConfig.profile) throw new Error("MCP Access auth profile drift vs prior receipt");
    if (priorReceipt.mcp.service_token_id && priorReceipt.mcp.service_token_id !== mcpConfig.serviceTokenId) throw new Error("MCP service-token drift vs prior receipt");
  }
}

const mcpReceipt = mcpConfig ? buildMcpReceipt({ config: mcpConfig, state: mcpState, teamFinal, sha256Hex }) : undefined;

const receipt = {
  protocol: ACCESS_RECEIPT_PROTOCOL,
  account_id: accountId,
  hostname,
  aud: liveAud.aud,
  team_domain: teamFinal,
  application: {
    id: application.id,
    name: appName,
    destination: hostname,
    disposition: applicationDisposition,
  },
  policy: {
    id: policy.id ?? null,
    name: policyName,
    owner_email_count: ownerEmails.length,
    owner_email_set_sha256: ownerEmailSetSha256,
    disposition: policyDisposition,
  },
  websocket_compatible_contour: "HOSTNAME_BASED_ACCESS",
  approved_additional_policy_count: classified.additional.length,
  approved_additional_policy_ids_sha256: allowedAdditionalPolicyIdsSha256,
  worker_level_access: "PROHIBITED_FOR_RESEARCH_SESSION_WEBSOCKETS",
  created_at: new Date().toISOString(),
  ...(mcpReceipt ? { mcp: mcpReceipt } : {}),
};
await mkdir(dirname(receiptPath), { recursive: true });
const receiptTemporary = `${receiptPath}.${process.pid}.tmp`;
await writeFile(receiptTemporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
await rename(receiptTemporary, receiptPath);
console.log(JSON.stringify(receipt, null, 2));
}
}
}
} finally {
  mcpTransport?.close();
}
}
