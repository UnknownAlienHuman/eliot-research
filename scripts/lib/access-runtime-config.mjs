import { createHash } from "node:crypto";

const AUD_TAG_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u;
const ACCESS_RECEIPT_PROTOCOL = "eliotr.cloudflare-access-receipt.v1";
const MCP_ACCESS_AUTH_PROFILES = new Set(["service-token", "managed-oauth"]);
const MCP_PATH = "/mcp";

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function normalizeTeamOrigin(value, label = "ELIOTR_ACCESS_TEAM_DOMAIN") {
  const raw = required(value, label);
  let teamUrl;
  try {
    teamUrl = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
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

export function validateAudTag(value, label = "ELIOTR_ACCESS_AUDIENCE") {
  const raw = required(value, label);
  if (!AUD_TAG_PATTERN.test(raw)) {
    throw new Error(`${label} must be a bounded Cloudflare Access AUD tag`);
  }
  return raw;
}

function parseServicePrincipals(environment) {
  const rawPrincipals = environment.ELIOTR_ACCESS_SERVICE_PRINCIPALS ?? "";
  const servicePrincipals = rawPrincipals.trim() === ""
    ? []
    : rawPrincipals.split(",").map((value) => value.trim());
  if (
    servicePrincipals.length > 64 ||
    servicePrincipals.some((value) =>
      value.length === 0 ||
      value.length > 256 ||
      /[\u0000-\u001f\u007f,]/.test(value)
    ) ||
    new Set(servicePrincipals).size !== servicePrincipals.length
  ) {
    throw new Error(
      "ELIOTR_ACCESS_SERVICE_PRINCIPALS must contain at most 64 unique bounded common_name values",
    );
  }
  return Object.freeze([...servicePrincipals]);
}

export function validateAccessRuntimeConfiguration(environment) {
  const teamDomain = normalizeTeamOrigin(
    environment.ELIOTR_ACCESS_TEAM_DOMAIN,
    "ELIOTR_ACCESS_TEAM_DOMAIN",
  );
  const audience = validateAudTag(
    environment.ELIOTR_ACCESS_AUDIENCE,
    "ELIOTR_ACCESS_AUDIENCE",
  );
  const servicePrincipals = parseServicePrincipals(environment);

  return Object.freeze({
    teamDomain,
    audience,
    servicePrincipals,
    servicePrincipalCount: servicePrincipals.length,
  });
}

/**
 * Resolve the verified Access authority for core config generation.
 *
 * Pure (no network, filesystem, or clock): the caller loads the ignored
 * non-secret Access receipt and passes it here. When a receipt is present its
 * Cloudflare-readback AUD and team origin win; non-empty environment values
 * must reconcile exactly instead of silently overriding the receipt. When no
 * receipt is present the caller falls back to environment validation (used by
 * check-only CREATE plans and historical mocks). Service principals always
 * come from the environment: receipts carry only digests, never principals.
 */
export function resolveAccessRuntimeConfiguration(environment, accessReceipt) {
  const servicePrincipals = parseServicePrincipals(environment);
  if (accessReceipt === null || accessReceipt === undefined) {
    const fromEnv = validateAccessRuntimeConfiguration({
      ...environment,
      ELIOTR_ACCESS_SERVICE_PRINCIPALS: environment.ELIOTR_ACCESS_SERVICE_PRINCIPALS ?? "",
    });
    return Object.freeze({ ...fromEnv, source: "ENVIRONMENT" });
  }
  if (typeof accessReceipt !== "object" || Array.isArray(accessReceipt)) {
    throw new Error("Access receipt must be an object for AUD propagation");
  }
  if (accessReceipt.protocol !== ACCESS_RECEIPT_PROTOCOL) {
    throw new Error(`Access receipt protocol must be ${ACCESS_RECEIPT_PROTOCOL}`);
  }
  if (typeof accessReceipt.aud !== "string" || !AUD_TAG_PATTERN.test(accessReceipt.aud)) {
    throw new Error("stale Access receipt lacks a bounded Cloudflare AUD binding; re-run the Access provisioner");
  }
  const receiptTeam = normalizeTeamOrigin(accessReceipt.team_domain, "Access receipt team_domain");
  if (typeof accessReceipt.account_id !== "string" || accessReceipt.account_id.trim() === "") {
    throw new Error("stale Access receipt lacks an account_id binding; re-run the Access provisioner");
  }
  if (typeof accessReceipt.hostname !== "string" || accessReceipt.hostname.trim() === "") {
    throw new Error("stale Access receipt lacks a hostname binding; re-run the Access provisioner");
  }
  const rawTeamEnv = typeof environment.ELIOTR_ACCESS_TEAM_DOMAIN === "string"
    ? environment.ELIOTR_ACCESS_TEAM_DOMAIN.trim()
    : "";
  if (rawTeamEnv !== "") {
    const envTeam = normalizeTeamOrigin(rawTeamEnv, "ELIOTR_ACCESS_TEAM_DOMAIN");
    if (envTeam !== receiptTeam) {
      throw new Error(`Access team-domain reconciliation mismatch: receipt ${receiptTeam} vs environment ${envTeam}`);
    }
  }
  const rawAudEnv = typeof environment.ELIOTR_ACCESS_AUDIENCE === "string"
    ? environment.ELIOTR_ACCESS_AUDIENCE.trim()
    : "";
  if (rawAudEnv !== "") {
    if (!AUD_TAG_PATTERN.test(rawAudEnv)) {
      throw new Error("ELIOTR_ACCESS_AUDIENCE must be a bounded Cloudflare Access AUD tag");
    }
    if (rawAudEnv !== accessReceipt.aud) {
      throw new Error("Access AUD propagation mismatch: environment AUD differs from the verified Access receipt AUD");
    }
  }
  return Object.freeze({
    teamDomain: receiptTeam,
    audience: accessReceipt.aud,
    servicePrincipals,
    servicePrincipalCount: servicePrincipals.length,
    source: "RECEIPT",
  });
}

export function applyAccessRuntimeVars(vars, accessRuntime) {
  return {
    ...vars,
    ACCESS_TEAM_DOMAIN: accessRuntime.teamDomain,
    ACCESS_AUDIENCE: accessRuntime.audience,
    ACCESS_SERVICE_PRINCIPALS: accessRuntime.servicePrincipals.join(","),
  };
}

function strictMcpTeamOrigin(value, label = "ELIOTR_MCP_ACCESS_TEAM_DOMAIN") {
  if (typeof value !== "string" || value === "" || value !== value.trim()) {
    throw new Error(`${label} must be an exact non-empty string`);
  }
  return normalizeTeamOrigin(value, label);
}

function strictMcpHostname(value, label = "ELIOTR_MCP_HOSTNAME") {
  if (typeof value !== "string" || value === "" || value !== value.trim() ||
      value !== value.toLowerCase() || value.includes("://") || value.includes("/") ||
      value.includes(":") || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(value)) {
    throw new Error(`${label} must be one exact lowercase hostname without scheme, path, or port`);
  }
  return value;
}

function strictMcpAudience(value, label = "ELIOTR_MCP_ACCESS_AUDIENCE") {
  if (typeof value !== "string" || value === "" || value !== value.trim()) {
    throw new Error(`${label} must be an exact non-empty string`);
  }
  return validateAudTag(value, label);
}

function strictMcpProfile(value, label = "ELIOTR_MCP_ACCESS_AUTH_PROFILE") {
  if (typeof value !== "string" || !MCP_ACCESS_AUTH_PROFILES.has(value)) {
    throw new Error(`${label} must be service-token or managed-oauth`);
  }
  return value;
}

function strictMcpClientId(value, label = "ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID") {
  if (typeof value !== "string" || value === "" || value !== value.trim() ||
      value.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}\.access$/u.test(value)) {
    throw new Error(`${label} must be the exact Cloudflare Access service-token Client ID`);
  }
  return value;
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function mcpReceiptAuthority(accessReceipt, publicHostname) {
  if (accessReceipt === null || accessReceipt === undefined) return null;
  if (typeof accessReceipt !== "object" || Array.isArray(accessReceipt) ||
      accessReceipt.protocol !== ACCESS_RECEIPT_PROTOCOL) {
    throw new Error("MCP Access receipt must use the ordinary Access receipt protocol");
  }
  const raw = accessReceipt.mcp;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("MCP Access receipt is missing its dedicated mcp authority");
  }
  const hostname = strictMcpHostname(raw.hostname, "MCP receipt hostname");
  if (hostname !== publicHostname) {
    throw new Error("MCP Access receipt hostname differs from the public deployment hostname");
  }
  if (raw.path !== MCP_PATH || raw.path_cookie_attribute !== true) {
    throw new Error("MCP Access receipt must bind the exact /mcp path and scoped cookie attribute");
  }
  const teamDomain = strictMcpTeamOrigin(raw.team_domain, "MCP receipt team_domain");
  const audience = strictMcpAudience(raw.aud, "MCP receipt aud");
  const profile = strictMcpProfile(raw.auth_profile, "MCP receipt auth_profile");
  if (raw.oauth_configuration_enabled !== (profile === "managed-oauth")) {
    throw new Error("MCP Access receipt OAuth configuration does not match its auth profile");
  }
  const application = raw.application;
  if (application === null || typeof application !== "object" || Array.isArray(application) ||
      typeof application.id !== "string" || application.id.trim() === "" ||
      typeof application.name !== "string" || application.name.trim() === "" ||
      application.destination !== `${publicHostname}${MCP_PATH}` ||
      !["CREATED", "UNCHANGED"].includes(application.disposition)) {
    throw new Error("MCP Access receipt application binding is invalid");
  }
  const digest = raw.service_token_client_id_sha256;
  if (profile === "service-token" &&
      (typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest))) {
    throw new Error("MCP service-token receipt must bind a Client ID digest");
  }
  if (profile === "managed-oauth" && digest !== undefined) {
    throw new Error("Managed OAuth MCP receipt must not contain a service-token Client ID digest");
  }
  return Object.freeze({
    source: "RECEIPT",
    hostname,
    path: MCP_PATH,
    teamDomain,
    audience,
    authProfile: profile,
    applicationId: application.id,
    serviceTokenClientIdSha256: digest,
  });
}

/**
 * Resolve the dedicated MCP Access authority without contacting Cloudflare.
 * A receipt is required for apply; explicit MCP values are accepted only for
 * check-only CREATE plans and never borrow the ordinary Access AUD.
 */
export function resolveMcpAccessRuntimeConfiguration(environment, accessReceipt, {
  ordinaryAudience,
  publicHostname,
  checkOnly = false,
  profileDefault = "service-token",
} = {}) {
  const hostname = strictMcpHostname(publicHostname, "public deployment hostname");
  const configuredHostname = environment.ELIOTR_MCP_HOSTNAME;
  if (configuredHostname !== undefined && strictMcpHostname(configuredHostname) !== hostname) {
    throw new Error("ELIOTR_MCP_HOSTNAME must equal ELIOTR_ACCESS_HOSTNAME on the one-host /mcp contour");
  }
  const receipt = mcpReceiptAuthority(accessReceipt, hostname);
  const configuredProfile = environment.ELIOTR_MCP_ACCESS_AUTH_PROFILE;
  const authProfile = strictMcpProfile(configuredProfile ?? receipt?.authProfile ?? profileDefault);
  if (receipt && receipt.authProfile !== authProfile) {
    throw new Error("MCP auth profile differs from the verified MCP Access receipt");
  }

  const rawTeam = environment.ELIOTR_MCP_ACCESS_TEAM_DOMAIN;
  const explicitTeam = rawTeam === undefined ? undefined : strictMcpTeamOrigin(rawTeam);
  const teamDomain = receipt?.teamDomain ?? explicitTeam ?? null;
  if (receipt && explicitTeam !== undefined && explicitTeam !== receipt.teamDomain) {
    throw new Error("MCP team domain differs from the verified MCP Access receipt");
  }
  const rawAudience = environment.ELIOTR_MCP_ACCESS_AUDIENCE;
  const explicitAudience = rawAudience === undefined ? undefined : strictMcpAudience(rawAudience);
  const audience = receipt?.audience ?? explicitAudience ?? null;
  if (receipt && explicitAudience !== undefined && explicitAudience !== receipt.audience) {
    throw new Error("MCP Access audience differs from the verified MCP Access receipt");
  }
  if (audience !== null && ordinaryAudience === undefined) {
    throw new Error("ordinary Access audience must be resolved before MCP audience reconciliation");
  }
  if (audience !== null && audience === ordinaryAudience) {
    throw new Error("MCP Access audience must differ from the resolved ordinary Access audience");
  }

  const rawClientId = environment.ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID;
  const clientId = rawClientId === undefined ? undefined : strictMcpClientId(rawClientId);
  if (authProfile === "managed-oauth" && clientId !== undefined) {
    throw new Error("Managed OAuth MCP profile must not configure a service-token Client ID");
  }
  if (authProfile === "service-token" && receipt && clientId === undefined) {
    throw new Error("MCP service-token Client ID is required to materialize generated Worker vars");
  }
  if (receipt && clientId !== undefined && sha256Hex(clientId) !== receipt.serviceTokenClientIdSha256) {
    throw new Error("MCP service-token Client ID differs from the verified receipt digest");
  }

  const source = receipt ? "RECEIPT" : audience !== null || teamDomain !== null ? "EXPLICIT_ENVIRONMENT" : "CREATE";
  if (!receipt && !checkOnly) {
    throw new Error("MCP Access receipt is required for apply on the gemini-mcp profile");
  }
  return Object.freeze({
    source,
    hostname,
    path: MCP_PATH,
    teamDomain,
    audience,
    authProfile,
    serviceTokenClientId: clientId,
    serviceTokenClientIdConfigured: clientId !== undefined,
    applicationId: receipt?.applicationId ?? null,
  });
}

export function applyMcpRuntimeVars(vars, runtime) {
  const result = {
    ...vars,
    MCP_HOSTNAME: runtime.hostname,
    MCP_ACCESS_TEAM_DOMAIN: runtime.teamDomain,
    MCP_ACCESS_AUDIENCE: runtime.audience,
    MCP_ACCESS_AUTH_PROFILE: runtime.authProfile,
  };
  if (runtime.authProfile === "service-token") {
    result.MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID = runtime.serviceTokenClientId;
  } else {
    delete result.MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID;
  }
  return result;
}
