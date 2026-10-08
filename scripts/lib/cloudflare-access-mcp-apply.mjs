import { mcpAccessRuntimeClientSha256, readMcpAccessRuntimeClients } from "./mcp-access-service-bindings.mjs";
import { assertMcpApplication, assertMcpPolicy, classifyMcpPolicies } from "./cloudflare-access-mcp-contour.mjs";
import { expectedMcpPolicy, resolveMcpAud } from "./cloudflare-access-mcp-config.mjs";

async function createMcpPolicyWithReconciliation({ config, state, request, accountId, enc, policy }) {
  let readback;
  try {
    await request("POST", `/accounts/${enc(accountId)}/access/apps/${enc(state.application.id)}/policies`, policy);
  } catch (error) {
    readback = await request("GET", `/accounts/${enc(accountId)}/access/apps/${enc(state.application.id)}/policies?per_page=100`);
    state.classified = classifyMcpPolicies(Array.isArray(readback) ? readback : [], config);
    if (!state.classified.owner) throw error;
  }
  state.policyDisposition = "CREATED";
  if (readback === undefined) readback = await request("GET", `/accounts/${enc(accountId)}/access/apps/${enc(state.application.id)}/policies?per_page=100`);
  state.classified = classifyMcpPolicies(Array.isArray(readback) ? readback : [], config);
}

export async function applyMcp({ config, state, ordinaryApplication, request, accountId, enc, freshApplication, createApplicationWithReconciliation, equal, resolveOrdinaryAud }) {
  const owner = await freshApplication(ordinaryApplication.id);
  const ordinaryAud = resolveOrdinaryAud(owner, { allowEnvironmentFallback: false }).aud;
  if (!ordinaryAud) throw new Error("ordinary Access application readback lacks AUD before MCP provisioning");
  const policy = expectedMcpPolicy(config);
  if (!state.application) {
    state.application = await createApplicationWithReconciliation(config.appName, {
      type: config.desired.application.type,
      name: config.appName,
      domain: config.destination,
      destinations: [{ type: "public", uri: config.destination }],
      session_duration: config.desired.application.session_duration,
      app_launcher_visible: config.desired.application.app_launcher_visible,
      path_cookie_attribute: true,
      ...(config.profile === "managed-oauth" ? { oauth_configuration: { enabled: true } } : {}),
      policies: [policy],
    });
    state.applicationDisposition = "CREATED";
  }
  state.application = await freshApplication(state.application.id);
  assertMcpApplication(state.application, config);
  const result = await request("GET", `/accounts/${enc(accountId)}/access/apps/${enc(state.application.id)}/policies?per_page=100`);
  state.classified = classifyMcpPolicies(Array.isArray(result) ? result : [], config);
  if (!state.classified.owner) await createMcpPolicyWithReconciliation({ config, state, request, accountId, enc, policy });
  assertMcpPolicy(state.classified.owner, config, equal);
  state.liveAud = resolveMcpAud(state.application, config.explicitAudience, false);
  if (!state.liveAud.aud) throw new Error("MCP Access application readback lacks a bounded dedicated AUD");
  if (state.liveAud.aud === ordinaryAud) throw new Error("MCP Access audience must differ from the ordinary Access audience");
  if (config.explicitAudience && config.explicitAudience !== state.liveAud.aud) throw new Error("MCP Access audience differs from the created application readback");
  return state;
}

export function buildMcpReceipt({ config, state, teamFinal, sha256Hex }) {
  const legacy = config.profile === "service-token"
    ? config.serviceBindings.find((binding) => binding.legacy) ?? null
    : null;
  const runtimeClients = config.profile === "service-token"
    ? readMcpAccessRuntimeClients({
        ...(legacy === null ? {} : { ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: legacy.client_id }),
        ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS: JSON.stringify(
          config.serviceBindings.filter((binding) => !binding.legacy).map((binding) => binding.client_id),
        ),
      })
    : null;
  return {
    hostname: config.hostname,
    path: "/mcp",
    path_cookie_attribute: true,
    team_domain: teamFinal,
    aud: state.liveAud.aud,
    auth_profile: config.profile,
    oauth_configuration_enabled: config.profile === "managed-oauth",
    application: { id: state.application.id, name: config.appName, destination: config.destination, disposition: state.applicationDisposition },
    policy: {
      id: state.classified.owner?.id ?? null,
      name: config.policyName,
      decision: config.profile === "service-token" ? config.desired.policy.service_token_decision : config.desired.policy.decision,
      selector: config.profile === "service-token" ? "service_token" : "email",
      ...(config.profile === "service-token" ? {
        service_token_count: config.serviceBindings.length,
        service_token_bindings_sha256: config.serviceBindingSha256,
      } : {
        owner_email_count: config.ownerEmails.length,
        owner_email_set_sha256: sha256Hex(config.ownerEmails.join("\n")),
      }),
      disposition: state.policyDisposition,
    },
    ...(config.profile === "service-token" ? {
      service_token_count: config.serviceBindings.length,
      service_token_bindings_sha256: config.serviceBindingSha256,
      service_token_runtime_clients_sha256: mcpAccessRuntimeClientSha256(runtimeClients),
      ...(legacy === null ? {} : {
        service_token_id: legacy.token_id,
        service_token_client_id_sha256: sha256Hex(legacy.client_id),
      }),
    } : {}),
  };
}
