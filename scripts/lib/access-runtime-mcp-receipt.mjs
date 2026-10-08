import { createHash } from "node:crypto";
import { normalizeTeamOrigin, validateAudTag } from "./access-runtime-base.mjs";

const SHA256 = /^[0-9a-f]{64}$/u;
const ACCESS_RECEIPT_PROTOCOL = "eliotr.cloudflare-access-receipt.v1";
const MCP_ACCESS_AUTH_PROFILES = new Set(["service-token", "managed-oauth"]);
const MCP_PATH = "/mcp";

export function strictMcpTeamOrigin(value, label = "ELIOTR_MCP_ACCESS_TEAM_DOMAIN") {
  if (typeof value !== "string" || value === "" || value !== value.trim()) {
    throw new Error(`${label} must be an exact non-empty string`);
  }
  return normalizeTeamOrigin(value, label);
}

export function strictMcpHostname(value, label = "ELIOTR_MCP_HOSTNAME") {
  if (typeof value !== "string" || value === "" || value !== value.trim() ||
      value !== value.toLowerCase() || value.includes("://") || value.includes("/") ||
      value.includes(":") || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(value)) {
    throw new Error(`${label} must be one exact lowercase hostname without scheme, path, or port`);
  }
  return value;
}

export function strictMcpAudience(value, label = "ELIOTR_MCP_ACCESS_AUDIENCE") {
  if (typeof value !== "string" || value === "" || value !== value.trim()) {
    throw new Error(`${label} must be an exact non-empty string`);
  }
  return validateAudTag(value, label);
}

export function strictMcpProfile(value, label = "ELIOTR_MCP_ACCESS_AUTH_PROFILE") {
  if (typeof value !== "string" || !MCP_ACCESS_AUTH_PROFILES.has(value)) {
    throw new Error(`${label} must be service-token or managed-oauth`);
  }
  return value;
}

export function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function readMcpReceiptAuthority(accessReceipt, publicHostname) {
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
