import { expectedMcpPolicy } from "./cloudflare-access-mcp-config.mjs";

function allDestinations(app) {
  return (Array.isArray(app?.destinations) ? app.destinations : [])
    .map((item) => ({
      type: String(item?.type ?? ""),
      uri: String(item?.uri ?? "").replace(/^https?:\/\//u, "").replace(/\/$/u, "").toLowerCase(),
    }))
    .sort((left, right) => `${left.type}\n${left.uri}`.localeCompare(`${right.type}\n${right.uri}`));
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

export function mcpDestinationCollision(app, config) {
  return app.name !== config.appName &&
    allDestinations(app).some((destination) => destination.uri === config.destination);
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
  if (owners.length > 1) throw new Error(`multiple Access MCP policies named ${config.policyName}`);
  const additional = items.filter((item) => item.name !== config.policyName);
  if (additional.length) throw new Error(`undeclared additional MCP Access policies may broaden access: ${JSON.stringify(additional.map((item) => ({ id: item.id ?? null, name: item.name ?? null })))}`);
  return { owner: owners[0] ?? null, additional };
}

export function assertMcpPolicy(policy, config, equal) {
  if (!policy) throw new Error("MCP Access policy readback is missing");
  const expected = expectedMcpPolicy(config);
  const drift = [];
  if (policy.decision !== expected.decision) drift.push({ field: "decision", expected: expected.decision, actual: policy.decision });
  if (config.profile === "service-token") {
    const observed = serviceTokenIds(policy);
    const expectedIds = config.serviceBindings.map((binding) => binding.token_id).sort();
    if (observed === null || !equal(observed, expectedIds)) {
      drift.push({ field: "service_token.selectors", expected_count: expectedIds.length, actual_count: observed?.length ?? null });
    }
  } else if (!equal(emailIncludes(policy), config.ownerEmails) || (policy.include ?? []).length !== config.ownerEmails.length) {
    drift.push({ field: "include.email", expected: config.ownerEmails, actual: emailIncludes(policy) });
  }
  if ((policy.exclude ?? []).length || (policy.require ?? []).length) {
    drift.push({ field: "exclude/require", expected: [], actual: { exclude: policy.exclude, require: policy.require } });
  }
  if (drift.length) throw new Error(`MCP Access policy drift; refusing in-place mutation: ${JSON.stringify(drift, null, 2)}`);
}
