import {
  hasMcpAccessServiceConfiguration,
  mcpAccessRuntimeClientSha256,
  readMcpAccessRuntimeClients,
} from "./mcp-access-service-bindings.mjs";
import {
  readMcpReceiptAuthority,
  sha256Hex,
  strictMcpAudience,
  strictMcpHostname,
  strictMcpProfile,
  strictMcpTeamOrigin,
} from "./access-runtime-mcp-receipt.mjs";

const MCP_PATH = "/mcp";

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
  const receipt = readMcpReceiptAuthority(accessReceipt, hostname);
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
        throw new Error("MCP service-token Client IDs differ from the verified receipt client set");
      }
    } else if (clients.count !== 1 || clients.legacyClientId === null ||
               clients.additionalClientIds.length !== 0 ||
               sha256Hex(clients.legacyClientId) !== receipt.serviceTokenClientIdSha256) {
      throw new Error("MCP service-token Client ID differs from the legacy verified receipt digest");
    }
  }

  const source = receipt ? "RECEIPT" : audience !== null || teamDomain !== null ? "EXPLICIT_ENVIRONMENT" : "CREATE";
  if (!receipt && !checkOnly) throw new Error("MCP Access receipt is required for apply");
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
