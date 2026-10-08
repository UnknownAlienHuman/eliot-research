import { normalizeTeamOrigin } from "./access-runtime-config.mjs";
import {
  hasMcpAccessServiceConfiguration,
  mcpAccessServiceBindingSha256,
  readMcpAccessServiceBindings,
} from "./mcp-access-service-bindings.mjs";

const AUD_TAG_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u;

export function strictMcpTeam(value, label) {
  if (typeof value !== "string" || value === "" || value !== value.trim()) {
    throw new Error(`${label} must be an exact non-empty string`);
  }
  return normalizeTeamOrigin(value, label);
}

function strictAudience(value, label) {
  if (typeof value !== "string" || value === "" || value !== value.trim() || !AUD_TAG_PATTERN.test(value)) {
    throw new Error(`${label} must be one exact bounded Cloudflare Access AUD tag`);
  }
  return value;
}

function resolveEnabled(environment, selectedByLegacyProfile) {
  const flag = environment.ELIOTR_MCP_ACCESS_ENABLED;
  if (flag !== undefined && flag !== "1") {
    throw new Error("ELIOTR_MCP_ACCESS_ENABLED, when set, must be 1; safe removal is a separate operation");
  }
  const hasServiceConfiguration = hasMcpAccessServiceConfiguration(environment);
  const hasProfile = environment.ELIOTR_MCP_ACCESS_AUTH_PROFILE !== undefined;
  return flag === "1" || selectedByLegacyProfile || hasServiceConfiguration || hasProfile;
}

export function createMcpAccessConfig({ enabled, environment, desired, hostname, ownerEmails }) {
  if (!resolveEnabled(environment, enabled)) return null;
  if (!desired || desired.path !== "/mcp" || desired.path_cookie_attribute !== true ||
      desired.policy?.decision !== "allow" || desired.policy?.service_token_decision !== "non_identity") {
    throw new Error("Access desired-state manifest lacks the exact profile-specific MCP contour");
  }
  const profile = environment.ELIOTR_MCP_ACCESS_AUTH_PROFILE ?? "service-token";
  if (profile !== "service-token" && profile !== "managed-oauth") {
    throw new Error("ELIOTR_MCP_ACCESS_AUTH_PROFILE must be service-token or managed-oauth");
  }
  if (environment.ELIOTR_MCP_HOSTNAME !== undefined && environment.ELIOTR_MCP_HOSTNAME !== hostname) {
    throw new Error("ELIOTR_MCP_HOSTNAME must equal ELIOTR_ACCESS_HOSTNAME on the one-host /mcp contour");
  }
  let serviceBindings = Object.freeze([]);
  if (profile === "service-token") {
    serviceBindings = readMcpAccessServiceBindings(environment);
    if (serviceBindings.length === 0) {
      throw new Error("service-token MCP requires at least one exact token UUID and Client ID binding");
    }
  } else if (hasMcpAccessServiceConfiguration(environment)) {
    throw new Error("Managed OAuth MCP profile must not configure service-token identifiers");
  }
  const legacy = serviceBindings.find((binding) => binding.legacy) ?? null;
  const explicitAudience = environment.ELIOTR_MCP_ACCESS_AUDIENCE;
  if (explicitAudience !== undefined) strictAudience(explicitAudience, "ELIOTR_MCP_ACCESS_AUDIENCE");
  const explicitTeam = environment.ELIOTR_MCP_ACCESS_TEAM_DOMAIN;
  if (explicitTeam !== undefined) strictMcpTeam(explicitTeam, "ELIOTR_MCP_ACCESS_TEAM_DOMAIN");
  return Object.freeze({
    desired,
    hostname,
    ownerEmails,
    profile,
    serviceBindings,
    serviceBindingSha256: profile === "service-token"
      ? mcpAccessServiceBindingSha256(serviceBindings)
      : null,
    serviceTokenId: legacy?.token_id ?? null,
    clientId: legacy?.client_id ?? null,
    explicitAudience,
    explicitTeam,
    appName: `${desired.application.name_prefix}: ${hostname}/mcp`,
    policyName: `${desired.policy.name_prefix}: ${hostname}/mcp`,
    destination: `${hostname}/mcp`,
  });
}

export function resolveMcpAud(app, explicitAudience, allowEnvironmentFallback = true) {
  const candidates = [app?.aud, app?.aud_tag, app?.audience];
  const live = candidates.find((value) => typeof value === "string" && AUD_TAG_PATTERN.test(value));
  if (live) return { aud: live, source: "CLOUDFLARE_READBACK" };
  if (allowEnvironmentFallback && explicitAudience) return { aud: explicitAudience, source: "ENVIRONMENT_FALLBACK" };
  return { aud: null, source: "UNKNOWN" };
}

export function expectedMcpPolicy(config) {
  if (config.profile === "service-token") {
    return {
      name: config.policyName,
      decision: config.desired.policy.service_token_decision,
      include: config.serviceBindings.map((binding) => ({
        service_token: { token_id: binding.token_id },
      })),
    };
  }
  return {
    name: config.policyName,
    decision: config.desired.policy.decision,
    include: config.ownerEmails.map((email) => ({ email: { email } })),
  };
}
