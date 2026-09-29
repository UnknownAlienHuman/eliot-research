import { normalizeTeamOrigin } from "./access-runtime-config.mjs";
import {
  hasMcpAccessServiceConfiguration,
  mcpAccessRuntimeClientSha256,
  mcpAccessServiceBindingSha256,
  readMcpAccessRuntimeClients,
  readMcpAccessServiceBindings,
} from "./mcp-access-service-bindings.mjs";

const AUD_TAG_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u;

function strictTeam(value, label) {
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
  if (explicitTeam !== undefined) strictTeam(explicitTeam, "ELIOTR_MCP_ACCESS_TEAM_DOMAIN");
  return Object.freeze({
    desired,
    hostname,
    ownerEmails,
    profile,
    serviceBindings,
    serviceBindingSha256: profile === "service-token"
      ? mcpAccessServiceBindingSha256(serviceBindings)
      : null,
    // Compatibility for prior single-token receipt reconciliation.
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

function allDestinations(app) {
  return (Array.isArray(app?.destinations) ? app.destinations : [])
    .map((item) => ({
      type: String(item?.type ?? ""),
      uri: String(item?.uri ?? "").replace(/^https?:\/\//u, "").replace(/\/$/u, "").toLowerCase(),
    }))
    .sort((left, right) => `${left.type}\n${left.uri}`.localeCompare(`${right.type}\n${right.uri}`));
}

function expectedPolicy(config) {
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

function serviceTokenIds(policy) {
  const rules = Array.isArray(policy?.include) ? policy.include : [];
  const values = [];
  for (const rule of rules) {
    if (typeof rule !== "object" || rule === null || Array.isArray(rule) ||
        Object.keys(rule).length !== 1 || typeof rule.service_token !== "object" ||
        rule.service_token === null || Array.isArray(rule.service_token) ||
        Object.keys(rule.service_token).length !== 1 ||
        typeof rule.service_token.token_id !== "string") {
      return null;
    }
    values.push(rule.service_token.token_id.toLowerCase());
  }
  return values.sort();
}

function emailIncludes(policy) {
  return (Array.isArray(policy?.include) ? policy.include : [])
    .flatMap((rule) => typeof rule?.email?.email === "string" ? [rule.email.email.toLowerCase()] : [])
    .sort();
}

export function assertMcpApplication(candidate, config) {
  const drift = [];
  if (candidate.name !== config.appName) drift.push({ field: "name", expected: config.appName, actual: candidate.name });
  if (candidate.type !== config.desired.application.type) drift.push({ field: "type", expected: config.desired.application.type, actual: candidate.type });
  if (candidate.domain !== config.destination) drift.push({ field: "domain", expected: config.destination, actual: candidate.domain });
  if ((candidate.session_duration ?? "24h") !== config.desired.application.session_duration) drift.push({ field: "session_duration", expected: config.desired.application.session_duration, actual: candidate.session_duration });
  if ((candidate.app_launcher_visible ?? false) !== config.desired.application.app_launcher_visible) drift.push({ field: "app_launcher_visible", expected: config.desired.application.app_launcher_visible, actual: candidate.app_launcher_visible });
  if (JSON.stringify(allDestinations(candidate)) !== JSON.stringify([{ type: "public", uri: config.destination }])) drift.push({ field: "destinations", expected: [{ type: "public", uri: config.destination }], actual: allDestinations(candidate) });
  if (candidate.path_cookie_attribute !== true) drift.push({ field: "path_cookie_attribute", expected: true, actual: candidate.path_cookie_attribute });
  if (Boolean(candidate.oauth_configuration?.enabled) !== (config.profile === "managed-oauth")) drift.push({ field: "oauth_configuration.enabled", expected: config.profile === "managed-oauth", actual: candidate.oauth_configuration?.enabled });
  if (drift.length) throw new Error(`MCP Access application drift; refusing in-place mutation: ${JSON.stringify(drift, null, 2)}`);
}

export function classifyMcpPolicies(items, config) {
  const owners = items.filter((item) => item.name === config.policyName);
  if (owners.length > 1) throw new Error(` multiple Access MCP policies named ${config.policyName}`.trim());
  const additional = items.filter((item) => item.name !== config.policyName);
  if (additional.length) throw new Error(`undeclared additional MCP Access policies may broaden access: ${JSON.stringify(additional.map((item) => ({ id: item.id ?? null, name: item.name ?? null })))}`);
  return { owner: owners[0] ?? null, additional };
}

export function assertMcpPolicy(policy, config, equal) {
  if (!policy) throw new Error("MCP Access policy readback is missing");
  const expected = expectedPolicy(config);
  const drift = [];
  if (policy.decision !== expected.decision) drift.push({ field: "decision", expected: expected.decision, actual: policy.decision });
  if (config.profile === "service-token") {
    const includeRules = Array.isArray(policy.include) ? policy.include : [];
    const requireRules = Array.isArray(policy.require) ? policy.require : [];
    const actual = serviceTokenIds(policy);
    const expectedIds = config.serviceBindings.map((binding) => binding.token_id).sort();
    if (includeRules.length !== expectedIds.length || requireRules.length !== 0 || actual === null || !equal(actual, expectedIds)) {
      drift.push({ field: "service_token.selectors", expected: expectedIds, actual });
    }
  } else if (!equal(emailIncludes(policy), config.ownerEmails) || (policy.include ?? []).length !== config.ownerEmails.length) {
    drift.push({ field: "include.email", expected: config.ownerEmails, actual: emailIncludes(policy) });
  }
  if ((policy.exclude ?? []).length || (config.profile === "managed-oauth" && (policy.require ?? []).length)) drift.push({ field: "exclude/require", expected: [], actual: { exclude: policy.exclude, require: policy.require } });
  if (drift.length) throw new Error(`MCP Access policy drift; refusing in-place mutation: ${JSON.stringify(drift, null, 2)}`);
}

export async function preflightMcp({ config, applications, request, accountId, enc, teamDomain, ordinaryApplication, resolveOrdinaryAud, equal, freshApplication }) {
  const matches = applications.filter((app) => app.name === config.appName);
  if (matches.length > 1) throw new Error(`multiple Access applications named ${config.appName}; refusing ambiguous MCP binding`);
  const collisions = applications.filter((app) => app.name !== config.appName && allDestinations(app).some((destination) => destination.uri === config.destination));
  if (collisions.length) throw new Error(`wrong Access application already claims ${config.destination}: ${JSON.stringify(collisions.map((app) => ({ id: app.id ?? null, name: app.name ?? null }))}`);
  const state = { application: matches[0] ?? null, applicationDisposition: "UNCHANGED", policyDisposition: "UNCHANGED", classified: { owner: null, additional: [] }, liveAud: null, serviceTokenRecords: [] };
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
      strictTeam(config.explicitTeam, "ELIOTR_MCP_ACCESS_TEAM_DOMAIN") !== teamDomain) {
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
  const policy = expectedPolicy(config);
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
        ...(legacy === null ? {} : {
          ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: legacy.client_id,
        }),
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
