import { createHash } from "node:crypto";
import {
  hasMcpAccessServiceConfiguration,
  mcpAccessRuntimeClientSha256,
  readMcpAccessRuntimeClients,
} from "./mcp-access-service-bindings.mjs";

const AUD_TAG_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
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
  try { teamUrl = new URL(raw); }
  catch { throw new Error(`${label} must be an absolute HTTPS URL`); }
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
  if (!AUD_TAG_PATTERN.test(raw)) throw new Error(`${label} must be a bounded Cloudflare Access AUD tag`);
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
      value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f,]/u.test(value)
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
  const teamDomain = normalizeTeamOrigin(environment.ELIOTR_ACCESS_TEAM_DOMAIN, "ELIOTR_ACCESS_TEAM_DOMAIN");
  const audience = validateAudTag(environment.ELIOTR_ACCESS_AUDIENCE, "ELIOTR_ACCESS_AUDIENCE");
  const servicePrincipals = parseServicePrincipals(environment);
  return Object.freeze({
    teamDomain,
    audience,
    servicePrincipals,
    servicePrincipalCount: servicePrincipals.length,
  });
}

/** Resolve the verified ordinary Access authority for generated Core configuration. */
export function resolveAccessRuntimeConfiguration(environment, accessReceipt) {
  const servicePrincipals = parseServicePrincipals(environment);
  if (accessReceipt === null || accessReceipt === undefined) {
    const fromEnv = validateAccessRuntimeConfiguration({
      ...environment,
      ELIOTR_ACCESS_SERVICE_PRINCIPALS: environment.ELIOTR_ACCESS_SERVICE_PRINCIPALS ?? "",
    });
    return Object.freeze({ ...fromEnv, source: "ENVIRONMENT", mcpAccessRuntime: null });
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
  const mcpAccessRuntime = accessReceipt.mcp === undefined
    ? null
    : resolveMcpAccessRuntimeConfiguration(environment, accessReceipt, {
        ordinaryAudience: accessReceipt.aud,
        publicHostname: accessReceipt.hostname,
        profileDefault: accessReceipt.mcp?.auth_profile,
      });
  return Object.freeze({
    teamDomain: receiptTeam,
    audience: accessReceipt.aud,
    servicePrincipals,
    servicePrincipalCount: servicePrincipals.length,
    source: "RECEIPT",
    mcpAccessRuntime,
  });
}

export function applyAccessRuntimeVars(vars, accessRuntime) {
  const ordinary = {
    ...vars,
    ACCESS_TEAM_DOMAIN: accessRuntime.teamDomain,
    ACCESS_AUDIENCE: accessRuntime.audience,
    ACCESS_SERVICE_PRINCIPALS: accessRuntime.servicePrincipals.join(","),
  };
  return accessRuntime.mcpAccessRuntime === null || accessRuntime.mcpAccessRuntime === undefined
    ? ordinary
    : applyMcpRuntimeVars(ordinary, accessRuntime.mcpAccessRuntime);
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

function sha256Hex(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }

function mcpReceiptAuthority(accessReceipt, publicHostname) {
  if (accessReceipt === null || accessReceipt === undefined) return null;
  const raw = accessReceipt.mcp;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("MCP Access receipt is missing its dedicated mcp authority");
  }
  const hostname = strictMcpHostname(raw.hostname, "MCP receipt hostname");
  if (hostname !== publicHostname) {
    throw new Error("MCP Access receipt hostname differs from the public deployment hostname");
  }
  if (raw.path !== MCP_PATH || raw.path_cookie_attribute !== true) {
    throw new Error,"MCP Access receipt must bind the exact /mcp path and scoped cookie attribute");
  }
  const teamDomain = strictMcpTeamOrigin(raw.team_domain, "MCP receipt team_domain");
  const audience = strictMcpAudience(raw.aud, "MCP receipt aud");
  const profile = strictMcpProfile(raw.auth_profile, "MCP receipt auth_profile");
  if (raw.oauth_configuration_enabled !== (profile === "managed-oauth")) {
    throw new Error,"MCP Access receipt OAuth configuration does not match its auth profile");
  }
  const application = raw.application;
  if (application === null || typeof application !== "object" || Array.isArray(application) ||
      typeof application.id !== "string" || application.id.trim() === "" ||
      typeof application.name !== "string" || application.name.trim() === "" ||
      application.destination !== `${publicHostname}${MCP_PATH}` ||
      !["CREATED", "UNCHANGED"].includes(application.disposition)) {
    throw new Error("MCP Access receipt application binding is invalid");
  }

  const oldClientDigest = raw.service_token_client_id_sha256;
  const runtimeDigest = raw.service_token_runtime_clients_sha256;
  const bindingDigest = raw.service_token_bindings_sha256;
  const clientCount = raw.service_token_count;
  if (profile === "service-token") {
    const oldShape = runtimeDigest === undefined && SHA256.test(oldClientDigest ?? "");
    const newShape = SHA256.test(runtimeDigest ?? "") && SHA256.test(bindingDigest ?? "") &&
      Number.isSafeInteger(clientCount) && clientCount >= 1 && clientCount <= 64;
    if (!oldShape && !newShape) {
      throw new Error("MCP service-token receipt must bind the complete verified client set");
    }
  } else if (oldClientDigest !== undefined || runtimeDigest !== undefined || bindingDigest !== undefined ||
             clientCount !== undefined || raw.service_token_id !== undefined) {
    throw new Error("Managed OAuth MCP receipt must not contain service-token bindings");
  }
  return Object.freeze({
    source: "RECEIPT",
    hostname,
    path: MCP_PATH,
    teamDomain,
    audience,
    authProfile: profile,
    applicationId: application.id,
    serviceTokenClientIdSha256: oldClientDigest,
    serviceTokenRuntimeClientsSha256: runtimeDigest,
    serviceTokenBindingsSha256: bindingDigest,
    serviceTokenCount: clientCount,
  });
}

/** Resolve dedicated MCP Access authority independently of any Google transport. */
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

  const clients = readMcpAccessRuntimeClients(environment);
  if (authProfile === "managed-oauth" && (clients.count !== 0 || hasMcpAccessServiceConfiguration(environment))) {
    throw new Error("Managed OAuth MCP profile must not configure service-token identifiers");
  }
  if (authProfile === "service-token" && receipt && clients.count === 0) {
    throw new Error("MCP service-token Client IDs are required to materialize generated Worker vars");
  }
  if (receipt && authProfile === "service-token") {
    if (receipt.serviceTokenRuntimeClientsSha256 !== undefined) {
      if (clients.count !== receipt.serviceTokenCount ||
          mcpAccessRuntimeClientSha256(clients) !== receipt.serviceTokenRuntimeClientsSha256) {
        throw new Error,"MCP service-token Client IDs differ from the verified receipt client set");
      }
    } else {
      if (clients.count !== 1 || clients.legacyClientId === null || clients.additionalClientIds.length !== 0 ||
          sha256Hex(clients.legacyClientId) !== receipt.serviceTokenClientIdSha256) {
        throw new Error("MCP service-token Client ID differs from the legacy verified receipt digest");
      }
    }
  }

  const source = receipt ? "RECEIPT" : audience !== null || teamDomain !== null ? "EXPLICIT_ENVIRONMENT" : "CREATE";
  if (!receipt && !checkOnly) {
    throw new Error,"MCP Access receipt is required for apply");
  }
  return Object.freeze({
    source,
    hostname,
    path: MCP_PATH,
    teamDomain,
    audience,
    authProfile,
    legacyClientId: clients.legacyClientId,
    additionalClientIds: clients.additionalClientIds,
    serviceTokenClientCount: clients.count,
    serviceTokenClientIdConfigured: clients.count > 0,
    serviceTokenRuntimeClientsSha256: clients.count > 0 ? mcpAccessRuntimeClientSha256(clients) : null,
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
    if (runtime.legacyClientId === null) delete result.MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID;
    else result.MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID = runtime.legacyClientId;
    if (runtime.additionalClientIds.length === 0) delete result.MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS;
    else result.MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS = JSON.stringify(runtime.additionalClientIds);
  } else {
    delete result.MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID;
    delete result.MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS;
  }
  return result;
}
