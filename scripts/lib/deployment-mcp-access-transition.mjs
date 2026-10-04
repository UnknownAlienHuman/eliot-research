import { createHash } from "node:crypto";
import { lstat, realpath, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { readMcpReceiptAuthority, strictMcpAudience, strictMcpHostname, strictMcpProfile,
  strictMcpTeamOrigin } from "./access-runtime-mcp-receipt.mjs";
import { readMcpAccessRuntimeClients } from "./mcp-access-service-bindings.mjs";

export const MCP_ACCESS_TRANSITION_PROTOCOL = "eliotr.maintenance-managed-oauth-mcp-transition.v1";
export const MCP_ACCESS_VERIFICATION_SUMMARY_PROTOCOL = "eliotr.cloudflare-access-verify-existing-summary.v1";
export const MCP_ACCESS_TRANSITION_VARIABLES = Object.freeze([
  "MCP_HOSTNAME", "MCP_ACCESS_TEAM_DOMAIN", "MCP_ACCESS_AUDIENCE", "MCP_ACCESS_AUTH_PROFILE",
  "MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID", "MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS",
]);
export const MCP_ACCESS_CANDIDATE_VARIABLES = Object.freeze(MCP_ACCESS_TRANSITION_VARIABLES.slice(0, 4));
export const MCP_ACCESS_SERVICE_TOKEN_VARIABLES = Object.freeze(MCP_ACCESS_TRANSITION_VARIABLES.slice(4));

const ACCESS_RECEIPT_PROTOCOL = "eliotr.cloudflare-access-receipt.v1";
const SUMMARY_KEYS = Object.freeze([
  "protocol", "disposition", "method", "receipt_protocol", "receipt_sha256", "api_readback_summary_sha256",
  "account_id", "managed_oauth_profile", "team_domain", "hostname", "mcp", "preserved_pwa",
  "generated_worker_config_sha256_before", "generated_worker_config_sha256_after",
  "static_token_environment_scrubbed", "child_exit_code", "verified_at",
]);
const SUMMARY_MCP_KEYS = Object.freeze([
  "application_id", "application_name", "destination", "aud", "path", "policy_id", "policy_decision",
  "selector", "owner_email_count", "owner_email_set_sha256", "session_duration",
]);
const SUMMARY_PWA_KEYS = Object.freeze(["application_id", "aud", "session_duration"]);
const API_READBACK_KEYS = Object.freeze([
  "kind", "protocol", "source", "observed_on", "account_id", "application", "policy", "organization",
  "preserved_application", "limitation", "runtime_receipt_generated",
]);
const API_APPLICATION_KEYS = Object.freeze([
  "id", "name", "type", "domain", "destination", "session_duration", "app_launcher_visible",
  "path_cookie_attribute", "oauth_configuration_enabled", "aud", "create_status", "readback_status", "readback_exact",
]);
const API_POLICY_KEYS = Object.freeze(["count", "decision", "approved_email", "excludes", "requires", "readback_exact"]);
const API_ORGANIZATION_KEYS = Object.freeze(["team_domain", "readback_exact"]);
const API_PRESERVED_KEYS = Object.freeze(["id", "name", "session_duration", "aud", "policy_count", "unchanged"]);
const INTENT_KEYS = Object.freeze(["protocol", "account_id", "worker_id", "baseline", "candidate", "verified_access"]);
const BASELINE_KEYS = Object.freeze([
  "deployment_id", "version_id", "generation", "configuration_sha256", "mcp_variables_sha256",
]);
const CANDIDATE_KEYS = Object.freeze(["source_head", "generation", "configuration_sha256"]);
const VERIFIED_ACCESS_KEYS = Object.freeze([
  "receipt_protocol", "receipt_sha256", "summary_sha256", "api_readback_summary_sha256", "authority_sha256",
]);
const SHA256 = /^[0-9a-f]{64}$/u;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const SOURCE_HEAD = /^[0-9a-f]{40}$/u;
const DEPLOYMENT_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const VERIFIED = new WeakSet();
const OBSERVATIONS = new WeakSet();
const TRANSITIONS = new WeakSet();
const PRIVATE = new WeakMap();
const fail = (message) => { throw new Error(message); };
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exactKeys = (value, keys, message) => {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) fail(message);
};
const nonEmpty = (value) => typeof value === "string" && value.length > 0 && value === value.trim();
const deepFreeze = (value) => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail("MCP Access authority contains a non-JSON value");
  return encoded;
}

function validPathInput(value) {
  return typeof value === "string" && value.trim() !== "" && !/[\u0000-\u001f\u007f]/u.test(value);
}

async function readStateFile(pathArgument, root, label, maximumBytes, read = readFile) {
  if (!validPathInput(root) || !validPathInput(pathArgument) || typeof read !== "function") {
    fail(`${label} path is invalid`);
  }
  const rootPath = resolve(root);
  const statePath = resolve(rootPath, ".eliotr-state");
  const path = resolve(isAbsolute(pathArgument) ? pathArgument : resolve(rootPath, pathArgument));
  const rel = relative(statePath, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail(`${label} is outside ignored state`);
  let stateReal;
  let pathReal;
  let before;
  let bytes;
  let after;
  try {
    stateReal = await realpath(statePath);
    before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maximumBytes) {
      fail(`${label} is not a bounded regular file`);
    }
    pathReal = await realpath(path);
    const canonicalRelative = relative(stateReal, pathReal);
    if (canonicalRelative === ".." || canonicalRelative.startsWith(`..${sep}`) || isAbsolute(canonicalRelative)) {
      fail(`${label} resolves outside ignored state`);
    }
    bytes = await read(path);
    after = await lstat(path);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    fail(`${label} is missing or unreadable`);
  }
  if (!after.isFile() || after.isSymbolicLink() || bytes.length !== before.size || bytes.length !== after.size ||
      before.dev !== after.dev || before.ino !== after.ino) fail(`${label} changed while being read`);
  return { path, bytes };
}

async function readStateJson(pathArgument, root, label, maximumBytes, read) {
  const file = await readStateFile(pathArgument, root, label, maximumBytes, read);
  let value;
  try { value = JSON.parse(file.bytes.toString("utf8")); }
  catch { fail(`${label} is not valid JSON`); }
  if (!isRecord(value)) fail(`${label} must be a JSON object`);
  return { ...file, value };
}

function validateSummary(summary, receipt, apiReadbackSummary, { accountId, publicHostname, expectedConfigurationSha256 } = {}) {
  exactKeys(summary, SUMMARY_KEYS, "MCP Access verification summary has unsupported fields");
  exactKeys(summary.mcp, SUMMARY_MCP_KEYS, "MCP Access verification MCP tuple is malformed");
  exactKeys(summary.preserved_pwa, SUMMARY_PWA_KEYS, "MCP Access verification PWA tuple is malformed");
  exactKeys(apiReadbackSummary, API_READBACK_KEYS, "Pinned MCP API readback summary has unsupported fields");
  exactKeys(apiReadbackSummary.application, API_APPLICATION_KEYS, "Pinned MCP application readback is malformed");
  exactKeys(apiReadbackSummary.policy, API_POLICY_KEYS, "Pinned MCP owner-policy readback is malformed");
  exactKeys(apiReadbackSummary.organization, API_ORGANIZATION_KEYS, "Pinned Access team readback is malformed");
  exactKeys(apiReadbackSummary.preserved_application, API_PRESERVED_KEYS,
    "Pinned ordinary PWA readback is malformed");
  if (apiReadbackSummary.kind !== "cloudflare-access-api-readback-summary" ||
      apiReadbackSummary.protocol !== "eliotr.cloudflare-access-api-readback-summary.v1" ||
      apiReadbackSummary.source !== "Authenticated Cloudflare connector create response plus exact follow-up GET readback" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(apiReadbackSummary.observed_on ?? "") ||
      apiReadbackSummary.account_id !== accountId || apiReadbackSummary.runtime_receipt_generated !== false ||
      typeof apiReadbackSummary.limitation !== "string" || apiReadbackSummary.limitation.length > 512 ||
      apiReadbackSummary.application.readback_exact !== true || apiReadbackSummary.application.create_status !== 201 ||
      apiReadbackSummary.application.readback_status !== 200 || apiReadbackSummary.application.type !== "self_hosted" ||
      apiReadbackSummary.application.app_launcher_visible !== false ||
      apiReadbackSummary.application.path_cookie_attribute !== true ||
      apiReadbackSummary.application.oauth_configuration_enabled !== true ||
      apiReadbackSummary.application.session_duration !== "24h" ||
      apiReadbackSummary.policy.readback_exact !== true || apiReadbackSummary.policy.count !== 1 ||
      apiReadbackSummary.policy.decision !== "allow" || apiReadbackSummary.policy.excludes !== 0 ||
      apiReadbackSummary.policy.requires !== 0 || !nonEmpty(apiReadbackSummary.policy.approved_email) ||
      apiReadbackSummary.policy.approved_email !== apiReadbackSummary.policy.approved_email.toLowerCase() ||
      apiReadbackSummary.organization.readback_exact !== true ||
      apiReadbackSummary.preserved_application.unchanged !== true ||
      apiReadbackSummary.preserved_application.session_duration !== "168h" ||
      apiReadbackSummary.preserved_application.policy_count !== 1) {
    fail("Pinned MCP API readback summary is not an exact successful native Access observation");
  }
  if (summary.protocol !== MCP_ACCESS_VERIFICATION_SUMMARY_PROTOCOL || summary.disposition !== "VERIFIED" ||
      summary.method !== "supported-provisioner --verify-existing" || summary.receipt_protocol !== ACCESS_RECEIPT_PROTOCOL ||
      summary.account_id !== accountId || summary.managed_oauth_profile !== "managed-oauth" ||
      summary.hostname !== publicHostname || !Number.isSafeInteger(summary.child_exit_code) || summary.child_exit_code !== 0 ||
      summary.static_token_environment_scrubbed !== true || typeof summary.verified_at !== "string" ||
      !Number.isFinite(Date.parse(summary.verified_at)) ||
      !SHA256.test(summary.receipt_sha256 ?? "") || !SHA256.test(summary.api_readback_summary_sha256 ?? "") ||
      !SHA256.test(summary.generated_worker_config_sha256_before ?? "") ||
      summary.generated_worker_config_sha256_before !== summary.generated_worker_config_sha256_after ||
      (expectedConfigurationSha256 !== undefined && summary.generated_worker_config_sha256_before !== expectedConfigurationSha256)) {
    fail("MCP Access verification summary is not an exact successful GET-only readback for this candidate");
  }
  if (receipt?.protocol !== ACCESS_RECEIPT_PROTOCOL || receipt.account_id !== accountId ||
      receipt.hostname !== publicHostname || receipt.team_domain !== summary.team_domain ||
      receipt.team_domain !== receipt.mcp?.team_domain || receipt.mcp?.hostname !== publicHostname ||
      receipt.mcp?.auth_profile !== "managed-oauth" || receipt.mcp?.oauth_configuration_enabled !== true ||
      receipt.mcp?.path !== "/mcp" || receipt.mcp?.application?.destination !== `${publicHostname}/mcp` ||
      receipt.mcp?.application?.disposition !== "UNCHANGED" || receipt.mcp?.policy?.disposition !== "UNCHANGED") {
    fail("MCP Access receipt is not the exact existing managed-OAuth contour");
  }
  let authority;
  try { authority = projectVerifiedAccessAuthority(receipt, publicHostname); }
  catch (error) {
    const reason = error instanceof Error ? error.message : "invalid authority shape";
    fail(`MCP Access receipt authority is malformed or unverified: ${reason}`);
  }
  const mcp = summary.mcp;
  const pwa = summary.preserved_pwa;
  const apiApp = apiReadbackSummary.application;
  const apiPwa = apiReadbackSummary.preserved_application;
  if (summary.team_domain !== authority.team_domain || mcp.application_id !== authority.mcp.application_id ||
      mcp.application_name !== authority.mcp.application_name || mcp.destination !== authority.mcp.destination ||
      mcp.aud !== authority.mcp.audience || mcp.path !== "/mcp" || mcp.policy_id !== authority.mcp.policy_id ||
      mcp.policy_decision !== "allow" || mcp.selector !== "email" ||
      mcp.owner_email_count !== authority.mcp.owner_email_count ||
      mcp.owner_email_set_sha256 !== authority.mcp.owner_email_set_sha256 ||
      mcp.session_duration !== "24h" ||
      pwa.application_id !== authority.pwa.application_id || pwa.aud !== authority.pwa.audience ||
      pwa.session_duration !== "168h" || apiReadbackSummary.organization.team_domain !== authority.team_domain ||
      apiApp.id !== authority.mcp.application_id || apiApp.name !== authority.mcp.application_name ||
      apiApp.domain !== authority.mcp.destination || apiApp.destination !== authority.mcp.destination ||
      apiApp.aud !== authority.mcp.audience || apiApp.session_duration !== authority.mcp.session_duration ||
      apiReadbackSummary.policy.count !== mcp.owner_email_count ||
      sha256(Buffer.from(apiReadbackSummary.policy.approved_email, "utf8")) !== mcp.owner_email_set_sha256 ||
      apiPwa.id !== authority.pwa.application_id || apiPwa.aud !== authority.pwa.audience ||
      apiPwa.name !== receipt.application.name || apiPwa.session_duration !== "168h") {
    fail("MCP verification summary does not match the dedicated app and preserved PWA readbacks");
  }
  if (authority.mcp.audience === authority.pwa.audience) fail("MCP Access audience must differ from ordinary PWA Access");
  return authority;
}

function projectVerifiedAccessAuthority(receipt, publicHostname) {
  if (!isRecord(receipt) || receipt.protocol !== ACCESS_RECEIPT_PROTOCOL ||
      receipt.hostname !== publicHostname || !nonEmpty(receipt.account_id) ||
      !nonEmpty(receipt.team_domain) || !nonEmpty(receipt.aud) || !isRecord(receipt.application) ||
      !nonEmpty(receipt.application.id) || !nonEmpty(receipt.application.name) ||
      receipt.application.destination !== publicHostname || receipt.application.disposition !== "VERIFIED" ||
      !isRecord(receipt.policy) || ![null, undefined].includes(receipt.policy.id) && !nonEmpty(receipt.policy.id) ||
      !nonEmpty(receipt.policy.name) || receipt.policy.disposition !== "VERIFIED" ||
      !Number.isSafeInteger(receipt.policy.owner_email_count) || receipt.policy.owner_email_count < 1 ||
      !SHA256.test(receipt.policy.owner_email_set_sha256 ?? "")) {
    fail("Ordinary Access receipt is not the verified preserved PWA authority");
  }
  const mcp = receipt.mcp;
  if (!isRecord(mcp)) fail("Dedicated MCP Access receipt is missing");
  const mcpAuthority = readMcpReceiptAuthority(receipt, publicHostname);
  const mcpApplication = mcp.application;
  const mcpPolicy = mcp.policy;
  if (mcpAuthority.authProfile !== "managed-oauth" || mcpAuthority.path !== "/mcp" ||
      mcp.team_domain !== receipt.team_domain || mcp.aud === receipt.aud ||
      Object.keys(mcp).sort().join(",") !== ["application", "auth_profile", "aud", "hostname", "oauth_configuration_enabled",
        "path", "path_cookie_attribute", "policy", "team_domain"].sort().join(",") ||
      !isRecord(mcpApplication) || Object.keys(mcpApplication).sort().join(",") !== "destination,disposition,id,name" ||
      !nonEmpty(mcpApplication.id) || !nonEmpty(mcpApplication.name) ||
      mcpApplication.destination !== `${publicHostname}/mcp` || mcpApplication.disposition !== "UNCHANGED" ||
      !isRecord(mcpPolicy) || Object.keys(mcpPolicy).sort().join(",") !==
        "decision,disposition,id,name,owner_email_count,owner_email_set_sha256,selector" ||
      !nonEmpty(mcpPolicy.id) || !nonEmpty(mcpPolicy.name) || mcpPolicy.decision !== "allow" ||
      mcpPolicy.selector !== "email" || mcpPolicy.disposition !== "UNCHANGED" ||
      mcpPolicy.owner_email_count !== receipt.policy.owner_email_count ||
      mcpPolicy.owner_email_set_sha256 !== receipt.policy.owner_email_set_sha256) {
    fail("Dedicated MCP Access app or exact owner policy readback is invalid");
  }
  return deepFreeze({
    account_id: receipt.account_id,
    team_domain: receipt.team_domain,
    hostname: publicHostname,
    pwa: { application_id: receipt.application.id, audience: receipt.aud,
      owner_policy_id: receipt.policy.id ?? null, owner_email_count: receipt.policy.owner_email_count,
      owner_email_set_sha256: receipt.policy.owner_email_set_sha256, session_duration: "168h" },
    mcp: { hostname: mcp.hostname, path: mcp.path, team_domain: mcp.team_domain, audience: mcp.aud,
      auth_profile: mcp.auth_profile, application_id: mcpApplication.id, application_name: mcpApplication.name,
      destination: mcpApplication.destination, policy_id: mcpPolicy.id, policy_name: mcpPolicy.name,
      policy_decision: mcpPolicy.decision, selector: mcpPolicy.selector,
      owner_email_count: mcpPolicy.owner_email_count, owner_email_set_sha256: mcpPolicy.owner_email_set_sha256,
      session_duration: "24h" },
  });
}

function validateCandidateConfig(candidateConfig, authority, expectedConfigurationSha256) {
  if (!isRecord(candidateConfig) || candidateConfig.name !== "eliotr-core" || !isRecord(candidateConfig.vars)) {
    fail("MCP transition candidate Worker config is invalid");
  }
  const vars = candidateConfig.vars;
  const expected = {
    MCP_HOSTNAME: authority.mcp.hostname,
    MCP_ACCESS_TEAM_DOMAIN: authority.mcp.team_domain,
    MCP_ACCESS_AUDIENCE: authority.mcp.audience,
    MCP_ACCESS_AUTH_PROFILE: "managed-oauth",
  };
  for (const [name, value] of Object.entries(expected)) if (vars[name] !== value) {
    fail("Generated MCP Worker variables do not match the verified managed-OAuth app");
  }
  if (MCP_ACCESS_SERVICE_TOKEN_VARIABLES.some((name) => Object.hasOwn(vars, name)) ||
      Object.keys(vars).filter((name) => name.startsWith("MCP_")).sort().join(",") !==
        [...MCP_ACCESS_CANDIDATE_VARIABLES].sort().join(",") ||
      vars.ACCESS_TEAM_DOMAIN !== authority.team_domain || vars.ACCESS_AUDIENCE !== authority.pwa.audience) {
    fail("MCP transition candidate must remove only the old MCP service-token vars and preserve PWA Access");
  }
  if (expectedConfigurationSha256 !== undefined && !SHA256.test(expectedConfigurationSha256)) {
    fail("MCP transition candidate config digest is invalid");
  }
  return Object.freeze({ ...expected });
}

export async function readVerifiedMcpAccessEvidence({ root, receiptPath, summaryPath, apiReadbackSummaryPath,
  accountId, publicHostname, expectedConfigurationSha256, candidateConfig, read = readFile } = {}) {
  if (!ACCOUNT_ID.test(accountId ?? "") || !validPathInput(publicHostname)) {
    fail("MCP Access verification evidence inputs are invalid");
  }
  const stateDirectory = resolve(root, ".eliotr-state", "completion-20261003");
  const receiptFile = await readStateJson(receiptPath ?? resolve(root, ".eliotr-state", "cloudflare-access-receipt.json"),
    root, "Supported Access receipt", 64 * 1024, read);
  const summaryFile = await readStateJson(summaryPath ?? resolve(stateDirectory, "mcp-access-verify-existing-summary.json"),
    root, "MCP Access verify-existing summary", 32 * 1024, read);
  const apiSummaryFile = await readStateFile(apiReadbackSummaryPath ?? resolve(stateDirectory, "mcp-access-api-readback-summary.json"),
    root, "Pinned MCP API readback summary", 64 * 1024, read);
  const receipt = receiptFile.value;
  const summary = summaryFile.value;
  if (sha256(receiptFile.bytes) !== summary.receipt_sha256 ||
      sha256(apiSummaryFile.bytes) !== summary.api_readback_summary_sha256) {
    fail("MCP verification summary does not hash-bind the supported receipt and selected API readback");
  }
  let apiReadbackSummary;
  try { apiReadbackSummary = JSON.parse(apiSummaryFile.bytes.toString("utf8")); }
  catch { fail("Pinned MCP API readback summary is not valid JSON"); }
  const authority = validateSummary(summary, receipt, apiReadbackSummary,
    { accountId, publicHostname, expectedConfigurationSha256 });
  const authoritySha256 = sha256(Buffer.from(canonical(authority), "utf8"));
  if (candidateConfig !== undefined) validateCandidateConfig(candidateConfig, authority, expectedConfigurationSha256);
  const evidence = deepFreeze({
    protocol: MCP_ACCESS_VERIFICATION_SUMMARY_PROTOCOL,
    account_id: accountId,
    public_hostname: publicHostname,
    receipt_sha256: sha256(receiptFile.bytes),
    summary_sha256: sha256(summaryFile.bytes),
    api_readback_summary_sha256: sha256(apiSummaryFile.bytes),
    authority_sha256: authoritySha256,
    authority,
    expected_configuration_sha256: summary.generated_worker_config_sha256_before,
  });
  VERIFIED.add(evidence);
  PRIVATE.set(evidence, { receiptPath: receiptFile.path, summaryPath: summaryFile.path,
    apiReadbackSummaryPath: apiSummaryFile.path, root: resolve(root), read, receiptBytesSha256: evidence.receipt_sha256 });
  return evidence;
}

function requireEvidence(evidence) {
  if (!isRecord(evidence) || !VERIFIED.has(evidence)) fail("MCP Access transition requires supported GET-only verification evidence");
  return evidence;
}

function workerIdentityMatches(identity, accountId) {
  return isRecord(identity) && identity.worker_id === "eliotr-core" &&
    DEPLOYMENT_ID.test(identity.deployment_id ?? "") && DEPLOYMENT_ID.test(identity.version_id ?? "") &&
    nonEmpty(identity.generation) && (!Object.hasOwn(identity, "account_id") || identity.account_id === accountId);
}

function candidateIdentity(sourceHead, generation, configSha) {
  if (!SOURCE_HEAD.test(sourceHead ?? "") || generation !== `git-${sourceHead.slice(0, 12)}` || !SHA256.test(configSha ?? "")) {
    fail("MCP transition candidate source identity is invalid");
  }
}

function extractMcpBaselinePins(configurationBaseline) {
  const variables = configurationBaseline?.configuration?.variables;
  if (!isRecord(variables)) fail("MCP baseline configuration omitted observed variables");
  if (Object.keys(variables).some((name) => name.startsWith("MCP_") && !MCP_ACCESS_TRANSITION_VARIABLES.includes(name))) {
    fail("MCP baseline contains an unsupported authority variable");
  }
  const pins = {};
  for (const name of MCP_ACCESS_TRANSITION_VARIABLES) {
    const observed = Object.hasOwn(variables, name) ? variables[name] : null;
    if (observed !== null && (!isRecord(observed) || observed.type !== "plain_text" || typeof observed.value !== "string")) {
      fail("MCP baseline contains a non-text or malformed authority variable");
    }
    pins[name] = observed === null ? null : { type: observed.type, value: observed.value };
  }
  if (MCP_ACCESS_TRANSITION_VARIABLES.every((name) => pins[name] === null)) return deepFreeze(pins);
  if (MCP_ACCESS_CANDIDATE_VARIABLES.some((name) => pins[name] === null)) {
    fail("MCP baseline must be fully absent or have a complete configured profile");
  }
  const hostname = pins.MCP_HOSTNAME?.value;
  const teamDomain = pins.MCP_ACCESS_TEAM_DOMAIN?.value;
  const audience = pins.MCP_ACCESS_AUDIENCE?.value;
  const authProfile = pins.MCP_ACCESS_AUTH_PROFILE?.value;
  strictMcpHostname(hostname, "Observed MCP hostname");
  strictMcpTeamOrigin(teamDomain, "Observed MCP team domain");
  strictMcpAudience(audience, "Observed MCP audience");
  strictMcpProfile(authProfile, "Observed MCP auth profile");
  const clientsEnvironment = {
    ...(pins.MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID === null ? {} :
      { ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: pins.MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID.value }),
    ...(pins.MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS === null ? {} :
      { ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS: pins.MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS.value }),
  };
  const clients = readMcpAccessRuntimeClients(clientsEnvironment);
  if ((authProfile === "managed-oauth" && clients.count !== 0) ||
      (authProfile === "service-token" && clients.count === 0)) {
    fail("Observed MCP baseline profile and service-token variables disagree");
  }
  return deepFreeze(pins);
}

function mcpVariablesSha256(configurationBaseline) {
  return sha256(Buffer.from(canonical(extractMcpBaselinePins(configurationBaseline)), "utf8"));
}

function assertMcpBaselineAuthorityContour(authority, configurationBaseline) {
  const pins = extractMcpBaselinePins(configurationBaseline);
  if (MCP_ACCESS_TRANSITION_VARIABLES.every((name) => pins[name] === null)) return;
  if (pins.MCP_HOSTNAME.value !== authority.hostname || pins.MCP_ACCESS_TEAM_DOMAIN.value !== authority.team_domain ||
      pins.MCP_ACCESS_AUDIENCE.value === authority.pwa.audience) {
    fail("Pinned active Worker MCP profile does not match the approved hostname, team or audience contour");
  }
}

export function createMaintenanceMcpAccessBaselineObservation({ evidence, accountId, sourceHead,
  candidateGeneration, candidateConfigurationSha256, candidateConfig, activeWorkerIdentity } = {}) {
  const verified = requireEvidence(evidence);
  candidateIdentity(sourceHead, candidateGeneration, candidateConfigurationSha256);
  validateCandidateConfig(candidateConfig, verified.authority, candidateConfigurationSha256);
  if (!workerIdentityMatches(activeWorkerIdentity, accountId) || verified.account_id !== accountId) {
    fail("MCP baseline observation is not bound to the active Worker and account");
  }
  const observation = deepFreeze({ protocol: "eliotr.mcp-access-baseline-observation.v1",
    account_id: accountId, active_worker: { deployment_id: activeWorkerIdentity.deployment_id,
      version_id: activeWorkerIdentity.version_id, generation: activeWorkerIdentity.generation },
    candidate: { source_head: sourceHead, generation: candidateGeneration,
      configuration_sha256: candidateConfigurationSha256 }, authority_sha256: verified.authority_sha256 });
  OBSERVATIONS.add(observation);
  PRIVATE.set(observation, { evidence: verified, authority: verified.authority });
  return observation;
}

export function createMaintenanceMcpAccessTransitionIntent({ evidence, accountId, sourceHead,
  candidateGeneration, candidateConfigurationSha256, candidateConfig, activeWorkerIdentity,
  baselineConfigurationBaseline } = {}) {
  const verified = requireEvidence(evidence);
  candidateIdentity(sourceHead, candidateGeneration, candidateConfigurationSha256);
  validateCandidateConfig(candidateConfig, verified.authority, candidateConfigurationSha256);
  if (!workerIdentityMatches(activeWorkerIdentity, accountId) || verified.account_id !== accountId ||
      baselineConfigurationBaseline?.deployment_id !== activeWorkerIdentity.deployment_id ||
      baselineConfigurationBaseline?.version_id !== activeWorkerIdentity.version_id ||
      baselineConfigurationBaseline?.deployment_generation !== activeWorkerIdentity.generation ||
      !SHA256.test(baselineConfigurationBaseline?.configuration_sha256 ?? "")) {
    fail("MCP transition requires the exact active Worker baseline");
  }
  const baseline = {
    deployment_id: activeWorkerIdentity.deployment_id,
    version_id: activeWorkerIdentity.version_id,
    generation: activeWorkerIdentity.generation,
    configuration_sha256: baselineConfigurationBaseline.configuration_sha256,
    mcp_variables_sha256: mcpVariablesSha256(baselineConfigurationBaseline),
  };
  return deepFreeze({
    protocol: MCP_ACCESS_TRANSITION_PROTOCOL,
    account_id: accountId,
    worker_id: "eliotr-core",
    baseline,
    candidate: { source_head: sourceHead, generation: candidateGeneration,
      configuration_sha256: candidateConfigurationSha256 },
    verified_access: { receipt_protocol: ACCESS_RECEIPT_PROTOCOL, receipt_sha256: verified.receipt_sha256,
      summary_sha256: verified.summary_sha256, api_readback_summary_sha256: verified.api_readback_summary_sha256,
      authority_sha256: verified.authority_sha256 },
  });
}

function parseTransition(intent, evidence, { accountId, sourceHead, candidateGeneration,
  candidateConfigurationSha256, candidateConfig, activeWorkerIdentity } = {}) {
  exactKeys(intent, INTENT_KEYS, "MCP transition intent has unsupported fields");
  exactKeys(intent.baseline, BASELINE_KEYS, "MCP transition baseline pin is malformed");
  exactKeys(intent.candidate, CANDIDATE_KEYS, "MCP transition candidate pin is malformed");
  exactKeys(intent.verified_access, VERIFIED_ACCESS_KEYS, "MCP transition Access proof pin is malformed");
  candidateIdentity(sourceHead, candidateGeneration, candidateConfigurationSha256);
  const verified = requireEvidence(evidence);
  validateCandidateConfig(candidateConfig, verified.authority, candidateConfigurationSha256);
  if (intent.protocol !== MCP_ACCESS_TRANSITION_PROTOCOL || intent.account_id !== accountId ||
      intent.worker_id !== "eliotr-core" || !workerIdentityMatches(activeWorkerIdentity, accountId) ||
      intent.baseline.deployment_id !== activeWorkerIdentity.deployment_id ||
      intent.baseline.version_id !== activeWorkerIdentity.version_id ||
      intent.baseline.generation !== activeWorkerIdentity.generation ||
      !SHA256.test(intent.baseline.configuration_sha256 ?? "") ||
      !SHA256.test(intent.baseline.mcp_variables_sha256 ?? "") ||
      intent.candidate.source_head !== sourceHead || intent.candidate.generation !== candidateGeneration ||
      intent.candidate.configuration_sha256 !== candidateConfigurationSha256 ||
      intent.verified_access.receipt_protocol !== ACCESS_RECEIPT_PROTOCOL ||
      intent.verified_access.receipt_sha256 !== verified.receipt_sha256 ||
      intent.verified_access.summary_sha256 !== verified.summary_sha256 ||
      intent.verified_access.api_readback_summary_sha256 !== verified.api_readback_summary_sha256 ||
      intent.verified_access.authority_sha256 !== verified.authority_sha256) {
    fail("MCP transition intent does not pin the exact verified Access, Worker baseline and candidate");
  }
  return deepFreeze({ protocol: intent.protocol, account_id: intent.account_id, worker_id: intent.worker_id,
    baseline: { ...intent.baseline }, candidate: { ...intent.candidate }, verified_access: { ...intent.verified_access },
    intent_sha256: null });
}

export async function loadMaintenanceMcpAccessTransition({ path, root, receiptPath, summaryPath,
  apiReadbackSummaryPath, accountId, sourceHead, candidateGeneration, candidateConfigurationSha256,
  candidateConfig, activeWorkerIdentity, read = readFile } = {}) {
  const evidence = await readVerifiedMcpAccessEvidence({ root, receiptPath, summaryPath, apiReadbackSummaryPath,
    accountId, publicHostname: candidateConfig?.vars?.MCP_HOSTNAME, expectedConfigurationSha256: candidateConfigurationSha256,
    candidateConfig, read });
  const file = await readStateJson(path, root, "MCP transition intent", 32 * 1024, read);
  const parsed = parseTransition(file.value, evidence, { accountId, sourceHead, candidateGeneration,
    candidateConfigurationSha256, candidateConfig, activeWorkerIdentity });
  const transition = deepFreeze({ ...parsed, intent_sha256: sha256(file.bytes) });
  TRANSITIONS.add(transition);
  PRIVATE.set(transition, { path: file.path, root: resolve(root), read, intentSha256: transition.intent_sha256,
    receiptPath: evidence && PRIVATE.get(evidence).receiptPath, authority: evidence.authority,
    authoritySha256: evidence.authority_sha256, candidateConfigSha256: candidateConfigurationSha256, evidence });
  return transition;
}

export function isMaintenanceMcpAccessBaselineObservation(value, { config, expectedGeneration,
  deploymentId, versionId, observedGeneration } = {}) {
  if (!isRecord(value) || !OBSERVATIONS.has(value)) return false;
  const state = PRIVATE.get(value);
  return value.candidate.generation === expectedGeneration && value.active_worker.deployment_id === deploymentId &&
    value.active_worker.version_id === versionId && value.active_worker.generation === observedGeneration &&
    value.authority_sha256 === state?.evidence.authority_sha256 &&
    candidateConfigMatchesAuthority(config, state?.authority);
}

export function isMaintenanceMcpAccessTransition(value, { config, expectedGeneration,
  deploymentId, versionId, observedGeneration } = {}) {
  if (!isRecord(value) || !TRANSITIONS.has(value)) return false;
  const state = PRIVATE.get(value);
  return value.candidate.generation === expectedGeneration && value.baseline.deployment_id === deploymentId &&
    value.baseline.version_id === versionId && value.baseline.generation === observedGeneration &&
    value.verified_access.authority_sha256 === state?.authoritySha256 &&
    candidateConfigMatchesAuthority(config, state?.authority);
}

function candidateConfigMatchesAuthority(config, authority) {
  if (!isRecord(config) || !isRecord(config.vars) || !isRecord(authority)) return false;
  try { validateCandidateConfig(config, authority); return true; }
  catch { return false; }
}

export function isMcpAccessTransitionVariable(name) {
  return MCP_ACCESS_TRANSITION_VARIABLES.includes(name);
}

export function assertMcpAccessBaselineObservation(observation, configurationBaseline) {
  if (!isRecord(observation) || !OBSERVATIONS.has(observation)) fail("MCP baseline observation is not authorized");
  const state = PRIVATE.get(observation);
  const baseline = configurationBaseline;
  const expected = observation.active_worker;
  if (!isRecord(baseline) || baseline.deployment_id !== expected.deployment_id ||
      baseline.version_id !== expected.version_id || baseline.deployment_generation !== expected.generation) {
    fail("Observed MCP baseline does not match the pinned active Worker identity");
  }
  assertMcpBaselineAuthorityContour(state.authority, baseline);
}

export function assertMcpAccessTransitionBaseline(transition, configurationBaseline) {
  if (!isRecord(transition) || !TRANSITIONS.has(transition)) fail("MCP baseline transition is not authorized");
  const expected = transition.baseline;
  if (!isRecord(configurationBaseline) || configurationBaseline.deployment_id !== expected.deployment_id ||
      configurationBaseline.version_id !== expected.version_id ||
      configurationBaseline.deployment_generation !== expected.generation ||
      configurationBaseline.configuration_sha256 !== expected.configuration_sha256 ||
      mcpVariablesSha256(configurationBaseline) !== expected.mcp_variables_sha256) {
    fail("Active Worker MCP configuration differs from the exact pinned baseline");
  }
  assertMcpAccessBaselineObservationFromAuthority(PRIVATE.get(transition).authority, configurationBaseline);
}

function assertMcpAccessBaselineObservationFromAuthority(authority, configurationBaseline) {
  assertMcpBaselineAuthorityContour(authority, configurationBaseline);
}

/** Recheck immutable local intent and the current GET-only receipt authority before upload. */
export async function requireUnchangedMaintenanceMcpAccessTransition({ transition, read = readFile } = {}) {
  if (!isRecord(transition) || !TRANSITIONS.has(transition) || typeof read !== "function") {
    fail("MCP transition revalidation requires a validated intent");
  }
  const state = PRIVATE.get(transition);
  const bytes = await readStateFile(state.path, state.root, "MCP transition intent", 32 * 1024, read);
  if (sha256(bytes.bytes) !== state.intentSha256) fail("MCP transition intent changed during deployment");
  const evidenceState = PRIVATE.get(state.evidence);
  if (!evidenceState) fail("MCP Access verification evidence is no longer available");
  const summaryFile = await readStateFile(evidenceState.summaryPath, evidenceState.root,
    "MCP Access verify-existing summary", 32 * 1024, read);
  const apiReadbackSummaryFile = await readStateFile(evidenceState.apiReadbackSummaryPath, evidenceState.root,
    "Pinned MCP API readback summary", 64 * 1024, read);
  if (sha256(summaryFile.bytes) !== transition.verified_access.summary_sha256 ||
      sha256(apiReadbackSummaryFile.bytes) !== transition.verified_access.api_readback_summary_sha256) {
    fail("MCP Access verification or API readback summary changed during deployment");
  }
  const current = await readStateJson(state.receiptPath, state.root, "Supported Access receipt", 64 * 1024, read);
  let authority;
  try { authority = projectVerifiedAccessAuthority(current.value, state.authority.hostname); }
  catch { fail("Current MCP Access readback no longer matches the prepared managed-OAuth authority"); }
  if (sha256(Buffer.from(canonical(authority), "utf8")) !== transition.verified_access.authority_sha256) {
    fail("Current MCP or preserved PWA Access readback differs from the pinned intent");
  }
  return Object.freeze({ state: "PASS", authority_sha256: transition.verified_access.authority_sha256 });
}

export function maintenanceMcpAccessReceiptSummary(transition) {
  if (!isRecord(transition) || !TRANSITIONS.has(transition)) fail("MCP transition summary requires a validated intent");
  return Object.freeze({ protocol: transition.protocol, intent_sha256: transition.intent_sha256,
    baseline_deployment_id: transition.baseline.deployment_id, baseline_version_id: transition.baseline.version_id,
    baseline_generation: transition.baseline.generation,
    baseline_configuration_sha256: transition.baseline.configuration_sha256,
    baseline_mcp_variables_sha256: transition.baseline.mcp_variables_sha256,
    candidate_source_head: transition.candidate.source_head, candidate_generation: transition.candidate.generation,
    candidate_configuration_sha256: transition.candidate.configuration_sha256,
    verified_access_authority_sha256: transition.verified_access.authority_sha256, readback: "PASS" });
}
