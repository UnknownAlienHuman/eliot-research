import { assertMcpApplication, assertMcpPolicy, classifyMcpPolicies, mcpDestinationCollision } from "./cloudflare-access-mcp-contour.mjs";
import { resolveMcpAud, strictMcpTeam } from "./cloudflare-access-mcp-config.mjs";

export async function preflightMcp({ config, applications, request, accountId, enc, teamDomain, ordinaryApplication, resolveOrdinaryAud, equal, freshApplication }) {
  const matches = applications.filter((app) => app.name === config.appName);
  if (matches.length > 1) throw new Error(`multiple Access applications named ${config.appName}; refusing ambiguous MCP binding`);
  const collisions = applications.filter((app) => mcpDestinationCollision(app, config));
  if (collisions.length) throw new Error(`wrong Access application already claims ${config.destination}: ${JSON.stringify(collisions.map((app) => ({ id: app.id ?? null, name: app.name ?? null })))}`);
  const state = {
    application: matches[0] ?? null,
    applicationDisposition: "UNCHANGED",
    policyDisposition: "UNCHANGED",
    classified: { owner: null, additional: [] },
    liveAud: null,
    serviceTokenRecords: [],
  };
  if (state.application) {
    state.application = await freshApplication(state.application.id);
    assertMcpApplication(state.application, config);
    const result = await request("GET", `/accounts/${enc(accountId)}/access/apps/${enc(state.application.id)}/policies?per_page=100`);
    state.classified = classifyMcpPolicies(Array.isArray(result) ? result : [], config);
    if (state.classified.owner) assertMcpPolicy(state.classified.owner, config, equal);
    const ownerAud = resolveOrdinaryAud(ordinaryApplication);
    state.liveAud = resolveMcpAud(state.application, config.explicitAudience, false);
    if (!state.liveAud.aud) throw new Error("existing MCP Access application readback lacks a bounded dedicated AUD");
    if (ownerAud.aud && state.liveAud.aud === ownerAud.aud) throw new Error("MCP Access audience must differ from the ordinary Access audience");
    if (config.explicitAudience && state.liveAud.aud !== config.explicitAudience) throw new Error("MCP Access audience differs from the existing Access application readback");
  }
  if (config.profile === "service-token") {
    for (const binding of config.serviceBindings) {
      const token = await request("GET", `/accounts/${enc(accountId)}/access/service_tokens/${enc(binding.token_id)}`);
      if (!token || String(token.id).toLowerCase() !== binding.token_id || token.client_id !== binding.client_id) {
        throw new Error("Cloudflare service-token readback does not match a configured MCP token ID and Client ID binding");
      }
      state.serviceTokenRecords.push(token);
    }
  }
  if (config.explicitTeam !== undefined && teamDomain !== null &&
      strictMcpTeam(config.explicitTeam, "ELIOTR_MCP_ACCESS_TEAM_DOMAIN") !== teamDomain) {
    throw new Error("MCP team domain differs from the verified Access organization team domain");
  }
  return state;
}

export function mcpPlanSummary(config, state) {
  if (!config) return undefined;
  const live = state.application ? resolveMcpAud(state.application, config.explicitAudience) : { aud: null };
  return {
    hostname: config.hostname,
    path: "/mcp",
    path_cookie_attribute: true,
    application: { id: state.application?.id ?? null, name: config.appName, disposition: state.application ? "VERIFY" : "CREATE" },
    policy: { id: state.classified.owner?.id ?? null, name: config.policyName, disposition: state.classified.owner ? "VERIFY" : "CREATE", selector: config.profile === "service-token" ? "service_token" : "email" },
    auth_profile: config.profile,
    aud: live.aud,
    aud_disposition: live.aud ? "VERIFY" : "GENERATED_ON_CREATE",
    oauth_configuration_enabled: config.profile === "managed-oauth",
    ...(config.profile === "service-token" ? {
      service_token_count: config.serviceBindings.length,
      service_token_bindings_sha256: config.serviceBindingSha256,
    } : {}),
  };
}
