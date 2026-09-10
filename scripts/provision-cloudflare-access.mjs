import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOGIN_INSTRUCTION, loadWranglerOAuthCredential, resolveAuthMode,
  scrubTokenEnv, verifyWranglerOAuthAccount, WRANGLER_OAUTH_MODE } from "./lib/cloudflare-wrangler-oauth.mjs";
import { CLOUDFLARE_MCP_TRANSPORT, createCloudflareMcpTransport } from "./lib/cloudflare-mcp-oauth.mjs";
import { isUsageAdmissionCapability, runUsagePreflight } from "./lib/cloudflare-usage-admission.mjs";

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
const googleTransport = process.env.ELIOTR_GOOGLE_EXTERNAL_TRANSPORT ?? "disabled";
if (!["disabled", "gemini-mcp", "drive-exchange"].includes(googleTransport)) {
  throw new Error("ELIOTR_GOOGLE_EXTERNAL_TRANSPORT must be disabled, gemini-mcp, or drive-exchange");
}
const mcpEnabled = googleTransport === "gemini-mcp";
const mcpDesired = desired.mcp;
if (mcpEnabled && (!mcpDesired || mcpDesired.path !== "/mcp" || mcpDesired.path_cookie_attribute !== true)) {
  throw new Error("Access desired-state manifest lacks the exact MCP /mcp contour");
}
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

function resolveLiveAud(app) {
  const live = extractAud(app);
  if (live) return { aud: live, source: "CLOUDFLARE_READBACK" };
  const fallbackRaw = process.env.ELIOTR_ACCESS_AUDIENCE?.trim() ?? "";
  if (fallbackRaw !== "" && AUD_TAG_PATTERN.test(fallbackRaw)) {
    return { aud: fallbackRaw, source: "ENVIRONMENT_FALLBACK" };
  }
  return { aud: null, source: "UNKNOWN" };
}

function resolveLiveMcpAud(app) {
  const live = extractAud(app);
  if (live) return { aud: live, source: "CLOUDFLARE_READBACK" };
  const fallbackRaw = process.env.ELIOTR_MCP_ACCESS_AUDIENCE?.trim() ?? "";
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

const MCP_CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}\.access$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const mcpAppName = mcpEnabled ? `${mcpDesired.application.name_prefix}: ${hostname}/mcp` : null;
const mcpPolicyName = mcpEnabled ? `${mcpDesired.policy.name_prefix}: ${hostname}/mcp` : null;
const mcpProfile = mcpEnabled ? (process.env.ELIOTR_MCP_ACCESS_AUTH_PROFILE ?? "service-token") : null;
if (mcpEnabled && !["service-token", "managed-oauth"].includes(mcpProfile)) {
  throw new Error("ELIOTR_MCP_ACCESS_AUTH_PROFILE must be service-token or managed-oauth");
}
if (mcpEnabled && process.env.ELIOTR_MCP_HOSTNAME !== undefined && process.env.ELIOTR_MCP_HOSTNAME !== hostname) {
  throw new Error("ELIOTR_MCP_HOSTNAME must equal ELIOTR_ACCESS_HOSTNAME on the one-host /mcp contour");
}
const mcpClientId = mcpEnabled ? process.env.ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID : undefined;
const mcpServiceTokenId = mcpEnabled ? process.env.ELIOTR_MCP_ACCESS_SERVICE_TOKEN_ID : undefined;
if (mcpEnabled && mcpProfile === "service-token") {
  if (typeof mcpServiceTokenId !== "string" || !UUID_PATTERN.test(mcpServiceTokenId)) {
    throw new Error("ELIOTR_MCP_ACCESS_SERVICE_TOKEN_ID must be the exact service-token UUID");
  }
  if (typeof mcpClientId !== "string" || !MCP_CLIENT_ID_PATTERN.test(mcpClientId) || mcpClientId !== mcpClientId.trim()) {
    throw new Error("ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID must be the exact Cloudflare Access service-token Client ID");
  }
} else if (mcpEnabled && (mcpClientId !== undefined || mcpServiceTokenId !== undefined)) {
  throw new Error("Managed OAuth MCP profile must not configure service-token identifiers");
}
const explicitMcpAud = mcpEnabled ? process.env.ELIOTR_MCP_ACCESS_AUDIENCE : undefined;
if (mcpEnabled && explicitMcpAud !== undefined && (!explicitMcpAud || explicitMcpAud !== explicitMcpAud.trim() || !AUD_TAG_PATTERN.test(explicitMcpAud))) {
  throw new Error("ELIOTR_MCP_ACCESS_AUDIENCE must be one exact bounded Cloudflare Access AUD tag");
}
const explicitMcpTeam = mcpEnabled ? process.env.ELIOTR_MCP_ACCESS_TEAM_DOMAIN : undefined;
if (mcpEnabled && explicitMcpTeam !== undefined) normalizeTeamOriginStrict(explicitMcpTeam, "ELIOTR_MCP_ACCESS_TEAM_DOMAIN");

function mcpExpectedDestination() { return `${hostname}/mcp`; }
function normalizedServiceTokenId(policy) {
  const rules = [...(Array.isArray(policy?.include) ? policy.include : []), ...(Array.isArray(policy?.require) ? policy.require : [])];
  const match = rules.find((rule) => typeof rule?.service_token?.token_id === "string");
  return match?.service_token.token_id ?? null;
}
function normalizedMcpEmailIncludes(policy) {
  return normalizedEmailIncludes(policy);
}
function expectedMcpPolicy() {
  if (mcpProfile === "service-token") {
    return { name: mcpPolicyName, decision: mcpDesired.policy.decision, include: [{ service_token: { token_id: mcpServiceTokenId } }] };
  }
  return { name: mcpPolicyName, decision: mcpDesired.policy.decision, include: ownerEmails.map((email) => ({ email: { email } })) };
}
function assertMcpApplicationContour(candidate) {
  const drift = [];
  if (candidate.type !== mcpDesired.application.type) drift.push({ field: "type", expected: mcpDesired.application.type, actual: candidate.type });
  if ((candidate.session_duration ?? "24h") !== mcpDesired.application.session_duration) drift.push({ field: "session_duration", expected: mcpDesired.application.session_duration, actual: candidate.session_duration });
  if ((candidate.app_launcher_visible ?? false) !== mcpDesired.application.app_launcher_visible) drift.push({ field: "app_launcher_visible", expected: mcpDesired.application.app_launcher_visible, actual: candidate.app_launcher_visible });
  if (!equal(normalizedDestinations(candidate), [{ type: "public", uri: mcpExpectedDestination() }])) drift.push({ field: "destinations", expected: [{ type: "public", uri: mcpExpectedDestination() }], actual: normalizedDestinations(candidate) });
  if (candidate.path_cookie_attribute !== true) drift.push({ field: "path_cookie_attribute", expected: true, actual: candidate.path_cookie_attribute });
  if (Boolean(candidate.oauth_configuration?.enabled) !== (mcpProfile === "managed-oauth")) drift.push({ field: "oauth_configuration.enabled", expected: mcpProfile === "managed-oauth", actual: candidate.oauth_configuration?.enabled });
  if (drift.length > 0) throw new Error(`MCP Access application drift; refusing in-place mutation: ${JSON.stringify(drift, null, 2)}`);
}
function classifyMcpPolicies(items) {
  const owners = items.filter((item) => item.name === mcpPolicyName);
  if (owners.length > 1) throw new Error(`multiple Access MCP policies named ${mcpPolicyName}`);
  const additional = items.filter((item) => item.name !== mcpPolicyName);
  if (additional.length > 0) throw new Error(`undeclared additional MCP Access policies may broaden access: ${JSON.stringify(additional.map((item) => ({ id: item.id ?? null, name: item.name ?? null })))}`);
  return { owner: owners[0] ?? null, additional };
}
function assertMcpPolicy(policy) {
  if (!policy) throw new Error("MCP Access policy readback is missing");
  const expected = expectedMcpPolicy();
  const drift = [];
  if (policy.decision !== expected.decision) drift.push({ field: "decision", expected: expected.decision, actual: policy.decision });
  if (mcpProfile === "service-token") {
    const includeRules = Array.isArray(policy.include) ? policy.include : [];
    const requireRules = Array.isArray(policy.require) ? policy.require : [];
    if (includeRules.length + requireRules.length !== 1 || normalizedServiceTokenId(policy) !== mcpServiceTokenId) {
      drift.push({ field: "service_token.selector", expected: mcpServiceTokenId, actual: normalizedServiceTokenId(policy) });
    }
  } else if (!equal(normalizedMcpEmailIncludes(policy), ownerEmails) || (policy.include ?? []).length !== ownerEmails.length) {
    drift.push({ field: "include.email", expected: ownerEmails, actual: normalizedMcpEmailIncludes(policy) });
  }
  if ((policy.exclude ?? []).length > 0 || (mcpProfile === "managed-oauth" && (policy.require ?? []).length > 0)) drift.push({ field: "exclude/require", expected: [], actual: { exclude: policy.exclude, require: policy.require } });
  if (drift.length > 0) throw new Error(`MCP Access policy drift; refusing in-place mutation: ${JSON.stringify(drift, null, 2)}`);
}

// Hostname-based Access is deliberate. Worker-level Access currently rejects WebSocket upgrades, while
// ResearchSession uses Durable Object WebSockets.
//
// Preflight ordering: every local validation plus every GET (apps inventory,
// organization/team origin, and, when the exact app exists, its policies)
// finishes before the first POST. A missing exact app is a valid CREATE plan
// and never requires an invented AUD: the AUD is Cloudflare-generated on
// create and read back before the receipt is persisted.
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
let mcpApplication = null;
let mcpApplicationDisposition = "UNCHANGED";
let mcpPolicyDisposition = "UNCHANGED";
let mcpPolicies = [];
let mcpClassified = { owner: null, additional: [] };
let serviceTokenRecord = null;
let mcpLiveAud = null;

function assertApplicationContour(candidate) {
  const drift = [];
  if (candidate.type !== desired.application.type) drift.push({ field: "type", expected: desired.application.type, actual: candidate.type });
  if ((candidate.session_duration ?? "24h") !== desired.application.session_duration) drift.push({ field: "session_duration", expected: desired.application.session_duration, actual: candidate.session_duration });
  if ((candidate.app_launcher_visible ?? false) !== desired.application.app_launcher_visible) drift.push({ field: "app_launcher_visible", expected: desired.application.app_launcher_visible, actual: candidate.app_launcher_visible });
  if (!equal(normalizedDestinations(candidate), expectedDestination)) drift.push({ field: "destinations", expected: expectedDestination, actual: normalizedDestinations(candidate) });
  if (drift.length > 0) throw new Error(`Access application drift; refusing in-place mutation: ${JSON.stringify(drift, null, 2)}`);
}

if (application) assertApplicationContour(application);

if (mcpEnabled) {
  const mcpExactApps = applications.filter((app) => app.name === mcpAppName);
  if (mcpExactApps.length > 1) throw new Error(`multiple Access applications named ${mcpAppName}; refusing ambiguous MCP binding`);
  const mcpCollisions = applications.filter((app) => app.name !== appName && app.name !== mcpAppName &&
    normalizedDestinations(app).some((destination) => destination.uri === mcpExpectedDestination()));
  if (mcpCollisions.length > 0) {
    throw new Error(`wrong Access application already claims ${mcpExpectedDestination()}: ${JSON.stringify(mcpCollisions.map((app) => ({ id: app.id ?? null, name: app.name ?? null })))}`);
  }
  mcpApplication = mcpExactApps[0] ?? null;
  if (mcpApplication) {
    assertMcpApplicationContour(mcpApplication);
    const mcpPoliciesResult = await request("GET", `/accounts/${enc(accountId)}/access/apps/${enc(mcpApplication.id)}/policies?per_page=100`);
    mcpPolicies = Array.isArray(mcpPoliciesResult) ? mcpPoliciesResult : [];
    mcpClassified = classifyMcpPolicies(mcpPolicies);
    if (mcpClassified.owner) assertMcpPolicy(mcpClassified.owner);
  }
  if (mcpProfile === "service-token") {
    const serviceToken = await request("GET", `/accounts/${enc(accountId)}/access/service_tokens/${enc(mcpServiceTokenId)}`);
    if (!serviceToken || serviceToken.id !== mcpServiceTokenId || typeof serviceToken.client_id !== "string" || serviceToken.client_id !== mcpClientId) {
      throw new Error("Cloudflare service-token readback does not match the configured MCP token ID and Client ID");
    }
    if (!MCP_CLIENT_ID_PATTERN.test(serviceToken.client_id)) throw new Error("Cloudflare service-token readback has an invalid Client ID");
    serviceTokenRecord = serviceToken;
  }
}

// GET-only team-origin preflight (live organization readback wins; the
// environment fallback exists only for mocks/transition and must reconcile).
const teamPreflight = await fetchLiveTeamDomain();
if (mcpEnabled && explicitMcpTeam !== undefined && normalizeTeamOriginStrict(explicitMcpTeam, "ELIOTR_MCP_ACCESS_TEAM_DOMAIN") !== teamPreflight.teamDomain && teamPreflight.teamDomain !== null) {
  throw new Error("MCP team domain differs from the verified Access organization team domain");
}
if (mcpEnabled && mcpApplication) {
  const ownerAud = resolveLiveAud(application);
  const mcpAud = resolveLiveMcpAud(mcpApplication);
  if (mcpAud.aud && ownerAud.aud && mcpAud.aud === ownerAud.aud) throw new Error("MCP Access audience must differ from the ordinary Access audience");
  if (explicitMcpAud !== undefined && mcpAud.aud && explicitMcpAud !== mcpAud.aud) throw new Error("MCP Access audience differs from the existing Access application readback");
}

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

function mcpPlanSummary() {
  if (!mcpEnabled) return undefined;
  const liveAud = mcpApplication ? resolveLiveMcpAud(mcpApplication) : { aud: null };
  return {
    hostname,
    path: "/mcp",
    path_cookie_attribute: true,
    application: { id: mcpApplication?.id ?? null, name: mcpAppName, disposition: mcpApplication ? "VERIFY" : "CREATE" },
    policy: { id: mcpClassified.owner?.id ?? null, name: mcpPolicyName, disposition: mcpClassified.owner ? "VERIFY" : "CREATE", selector: mcpProfile === "service-token" ? "service_token" : "email" },
    auth_profile: mcpProfile,
    aud: liveAud.aud,
    aud_disposition: liveAud.aud ? "VERIFY" : "GENERATED_ON_CREATE",
    oauth_configuration_enabled: mcpProfile === "managed-oauth",
    service_token_id: mcpProfile === "service-token" ? mcpServiceTokenId : undefined,
  };
}

if (!application && checkOnly) {
  console.log(JSON.stringify(strictPlanBase({
    application: { name: appName, disposition: "CREATE" },
    policy: { name: policyName, disposition: "CREATE_INLINE", owner_email_count: ownerEmails.length },
    aud: null,
    aud_disposition: "GENERATED_ON_CREATE",
    team_disposition: teamPreflight.teamDomain ? "VERIFY" : "READBACK_ON_APPLY",
    ...(mcpEnabled ? { mcp: mcpPlanSummary() } : {}),
  }), null, 2));
  process.exitCode = 0;
}

if (application || !checkOnly) {
if (!application && !checkOnly) {
  applicationDisposition = "CREATED";
  policyDisposition = "CREATED_INLINE";
  const created = await request("POST", `/accounts/${enc(accountId)}/access/apps`, {
    type: desired.application.type,
    name: appName,
    domain: hostname,
    destinations: expectedDestination,
    session_duration: desired.application.session_duration,
    app_launcher_visible: desired.application.app_launcher_visible,
    policies: [expectedPolicy],
  });
  if (!created?.id) {
    // Lost-ACK reconciliation: the create may have succeeded without a usable
    // readback, so re-list by exact name before failing.
    const retryList = await request("GET", `/accounts/${enc(accountId)}/access/apps?per_page=100`);
    const retryExact = (Array.isArray(retryList) ? retryList : []).filter((app) => app.name === appName);
    if (retryExact.length !== 1 || !retryExact[0]?.id) throw new Error("Access application creation readback lacks id");
    application = retryExact[0];
  } else {
    application = created;
  }
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
    ...(mcpEnabled ? { mcp: mcpPlanSummary() } : {}),
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
    ...(mcpEnabled ? { mcp: mcpPlanSummary() } : {}),
  }), null, 2));
  process.exitCode = 0;
}

if (!checkOnly) {
if (mcpEnabled) {
  // Resolve the ordinary AUD before creating or accepting the narrower MCP
  // application. Cloudflare generates the MCP AUD on CREATE; no future AUD is
  // guessed or accepted from the ordinary application.
  const ordinaryAud = resolveLiveAud(application).aud;
  if (!ordinaryAud) throw new Error("ordinary Access application readback lacks AUD before MCP provisioning");
  const mcpExpected = expectedMcpPolicy();
  if (!mcpApplication) {
    const createBody = {
      type: mcpDesired.application.type,
      name: mcpAppName,
      domain: hostname,
      destinations: [{ type: "public", uri: mcpExpectedDestination() }],
      session_duration: mcpDesired.application.session_duration,
      app_launcher_visible: mcpDesired.application.app_launcher_visible,
      path_cookie_attribute: true,
      ...(mcpProfile === "managed-oauth" ? { oauth_configuration: { enabled: true } } : {}),
      policies: [mcpExpected],
    };
    const created = await request("POST", `/accounts/${enc(accountId)}/access/apps`, createBody);
    if (!created?.id) {
      const retryList = await request("GET", `/accounts/${enc(accountId)}/access/apps?per_page=100`);
      const retryExact = (Array.isArray(retryList) ? retryList : []).filter((app) => app.name === mcpAppName);
      if (retryExact.length !== 1 || !retryExact[0]?.id) throw new Error("MCP Access application creation readback lacks id");
      mcpApplication = retryExact[0];
    } else {
      mcpApplication = created;
    }
    mcpApplicationDisposition = "CREATED";
    assertMcpApplicationContour(mcpApplication);
  }
  const mcpPoliciesResult = await request("GET", `/accounts/${enc(accountId)}/access/apps/${enc(mcpApplication.id)}/policies?per_page=100`);
  mcpPolicies = Array.isArray(mcpPoliciesResult) ? mcpPoliciesResult : [];
  mcpClassified = classifyMcpPolicies(mcpPolicies);
  if (!mcpClassified.owner) {
    await request("POST", `/accounts/${enc(accountId)}/access/apps/${enc(mcpApplication.id)}/policies`, mcpExpected);
    mcpPolicyDisposition = "CREATED";
    const readback = await request("GET", `/accounts/${enc(accountId)}/access/apps/${enc(mcpApplication.id)}/policies?per_page=100`);
    mcpClassified = classifyMcpPolicies(Array.isArray(readback) ? readback : []);
  }
  assertMcpPolicy(mcpClassified.owner);
  mcpLiveAud = resolveLiveMcpAud(mcpApplication).aud;
  if (!mcpLiveAud) throw new Error("MCP Access application readback lacks a bounded dedicated AUD");
  if (mcpLiveAud === ordinaryAud) throw new Error("MCP Access audience must differ from the ordinary Access audience");
  if (explicitMcpAud !== undefined && explicitMcpAud !== mcpLiveAud) throw new Error("MCP Access audience differs from the created application readback");
}
// Apply readback: AUD plus exact team origin are Cloudflare authority and are
// persisted only in the ignored non-secret receipt for core config generation.
let liveAud = resolveLiveAud(application);
if (!liveAud.aud) {
  const refreshList = await request("GET", `/accounts/${enc(accountId)}/access/apps?per_page=100`);
  const refreshed = (Array.isArray(refreshList) ? refreshList : []).find((app) => app?.id === application.id) ?? null;
  if (refreshed) {
    assertApplicationContour(refreshed);
    application = refreshed;
    liveAud = resolveLiveAud(application);
  }
}
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
  if (mcpEnabled && priorReceipt.mcp) {
    if (priorReceipt.mcp.application?.id && priorReceipt.mcp.application.id !== mcpApplication.id) throw new Error("stale MCP receipt binds a different Access app id; review before overwrite");
    if (priorReceipt.mcp.aud && priorReceipt.mcp.aud !== mcpLiveAud) throw new Error("MCP Access AUD drift vs prior receipt; refusing silent substitution");
    if (priorReceipt.mcp.auth_profile && priorReceipt.mcp.auth_profile !== mcpProfile) throw new Error("MCP Access auth profile drift vs prior receipt");
    if (priorReceipt.mcp.service_token_id && priorReceipt.mcp.service_token_id !== mcpServiceTokenId) throw new Error("MCP service-token drift vs prior receipt");
  }
}

const mcpReceipt = mcpEnabled ? {
  hostname,
  path: "/mcp",
  path_cookie_attribute: true,
  team_domain: teamFinal,
  aud: mcpLiveAud,
  auth_profile: mcpProfile,
  oauth_configuration_enabled: mcpProfile === "managed-oauth",
  application: {
    id: mcpApplication.id,
    name: mcpAppName,
    destination: mcpExpectedDestination(),
    disposition: mcpApplicationDisposition,
  },
  policy: {
    id: mcpClassified.owner?.id ?? null,
    name: mcpPolicyName,
    decision: mcpDesired.policy.decision,
    selector: mcpProfile === "service-token" ? "service_token" : "email",
    ...(mcpProfile === "service-token" ? { service_token_id: mcpServiceTokenId } : {
      owner_email_count: ownerEmails.length,
      owner_email_set_sha256: ownerEmailSetSha256,
    }),
    disposition: mcpPolicyDisposition,
  },
  ...(mcpProfile === "service-token" ? {
    service_token_id: mcpServiceTokenId,
    service_token_client_id_sha256: sha256Hex(serviceTokenRecord.client_id),
  } : {}),
} : undefined;

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
