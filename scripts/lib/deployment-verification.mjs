import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { validateAccessRuntimeConfiguration } from "./access-runtime-config.mjs";
import { assertMcpAccessBaselineObservation, assertMcpAccessTransitionBaseline,
  isMaintenanceMcpAccessBaselineObservation, isMaintenanceMcpAccessTransition,
  isMcpAccessTransitionVariable } from "./deployment-mcp-access-transition.mjs";
import { RESEARCH_RUNTIME_CONFIGURATION_KEYS, RESEARCH_RUNTIME_SEMANTIC_TRANSPORT_KEYS } from "./research-runtime-config.mjs";
import { resolveAuthMode, WRANGLER_OAUTH_MODE } from "./cloudflare-wrangler-oauth.mjs";

const MAX_SMOKE_BYTES = 64 * 1024;
const MAX_API_BYTES = 1024 * 1024;
const TIMEOUT_MS = 15_000;
const GOOGLE_EXTERNAL_TRANSPORTS = new Set(["disabled", "gemini-mcp", "drive-exchange"]);
const OWNER_TEMPLATE_GENERATION_FIELDS = Object.freeze([
  Object.freeze({
    variable: "ELIOTR_MODEL_SPEND_POLICY_JSON",
    protocol: "eliotr.research-owner-spend-template.v1",
    protocols: Object.freeze(["eliotr.research-owner-spend-template.v1", "eliotr.research-owner-spend-template.v2"]),
    path: Object.freeze(["deployment_generation"]),
  }),
  Object.freeze({
    variable: "ELIOTR_RESEARCH_REPORT_CONFIG_JSON",
    protocol: "eliotr.research-owner-report-admission-template.v1",
    protocols: Object.freeze(["eliotr.research-owner-report-admission-template.v1", "eliotr.research-owner-report-admission-template.v2"]),
    path: Object.freeze(["admission_policy", "deployment_generation"]),
  }),
]);
const OWNER_AUTHORITY_RUNTIME_VARIABLES = new Set([
  "ELIOTR_WORKSPACE_OWNER_BINDINGS_JSON", "ELIOTR_NAMESPACE_BOOTSTRAP_PROFILES_JSON",
]);
export const APPROVED_RUNTIME_CONFIGURATION_VARIABLES = Object.freeze([...new Set([
  ...RESEARCH_RUNTIME_CONFIGURATION_KEYS,
  ...RESEARCH_RUNTIME_SEMANTIC_TRANSPORT_KEYS,
])].filter((name) => !OWNER_AUTHORITY_RUNTIME_VARIABLES.has(name)).sort());
const OWNER_RUNTIME_TRANSITION_VARIABLES = new Set(APPROVED_RUNTIME_CONFIGURATION_VARIABLES);
const APPROVED_RUNTIME_CANDIDATE_PROTOCOL = "eliotr.approved-runtime-candidate.v1";
const APPROVED_RUNTIME_TRANSITION_PROTOCOL = "eliotr.approved-runtime-transition.v1";
const SHA256 = /^[0-9a-f]{64}$/u;
// Runtime-only credentials documented by the core Env contract. These remain
// optional across provider profiles; readback confirms only name and type.
const ALLOWED_SECRET_BINDINGS = new Set([
  "ELIOTR_MODEL_GATEWAY_TOKEN", "ELIOTR_MODEL_GATEWAY_READ_TOKEN", "ELIOTR_MODEL_PROVIDER_CONTROL_TOKEN",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_TOKEN_ENCRYPTION_KEY", "RESEARCH_CHANGES_CURSOR_KEY", "FEDERATION_CURSOR_HMAC_KEY",
  "OWNER_NOTIFICATION_WEBHOOK", "ELIOTR_BACKUP_OFFSITE_R2_ACCESS_KEY_ID",
  "ELIOTR_BACKUP_OFFSITE_R2_SECRET_ACCESS_KEY",
]);
const CLOUDFLARE_UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (label) => { throw new Error(label); };

function exactKeys(value, keys, label) {
  if (!isObject(value) || Object.keys(value).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(value, key))) fail(label);
}

function boundedString(value, maximum = 256) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u0020\u007f]/u.test(value);
}

/**
 * `options.authMode` is supplied only by deployment orchestration that still
 * has local gates to run before its late Wrangler OAuth identity check. In
 * that explicit OAuth mode this validates deployment configuration without
 * claiming a credential has been loaded or verified; the caller must rerun
 * the default validation after it injects the refreshed bearer.
 */
export function validateDeploymentInput(env, options = {}) {
  const authMode = options.authMode === undefined
    ? null
    : resolveAuthMode({ ELIOTR_CLOUDFLARE_AUTH_MODE: options.authMode });
  const oauthCredentialPending = authMode === WRANGLER_OAUTH_MODE;
  for (const key of ["CLOUDFLARE_ACCOUNT_ID", "ELIOTR_OWNER_EMAILS"]) {
    if (typeof env[key] !== "string" || !env[key].trim()) fail(`Missing ${key}`);
  }
  if (!oauthCredentialPending) {
    if (typeof env.CLOUDFLARE_API_TOKEN !== "string" || !env.CLOUDFLARE_API_TOKEN.trim()) {
      fail("Missing CLOUDFLARE_API_TOKEN");
    }
    if (!boundedString(env.CLOUDFLARE_API_TOKEN, 4096)) fail("Invalid Cloudflare API token");
  }
  const googleExternalTransport = env.ELIOTR_GOOGLE_EXTERNAL_TRANSPORT ?? null;
  if (googleExternalTransport !== null && !GOOGLE_EXTERNAL_TRANSPORTS.has(googleExternalTransport)) {
    fail("Invalid Google external transport profile");
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(env.CLOUDFLARE_ACCOUNT_ID)) fail("Invalid account identity");
  if (!["staging", "production"].includes(env.ELIOTR_ENVIRONMENT)) fail("Invalid live environment");
  if (!boundedString(env.ELIOTR_DEPLOYMENT_GENERATION)) fail("Invalid deployment generation");
  if (!["0", "1"].includes(env.ELIOTR_CUSTOM_DOMAIN)) fail("Invalid custom-domain mode");
  const hostname = env.ELIOTR_ACCESS_HOSTNAME;
  if (typeof hostname !== "string" || hostname.length > 253 || !hostname.includes(".") ||
      !hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) {
    fail("Invalid Access hostname");
  }
  const origin = `https://${hostname}`;
  const rawSmoke = env.ELIOTR_SMOKE_BASE_URL ?? origin;
  // Reject normalization tricks, paths, userinfo, ports and alternative hosts before any side effect.
  if (rawSmoke !== origin && rawSmoke !== `${origin}/`) fail("Smoke URL must equal the Access HTTPS origin");
  const cookie = env.ELIOTR_ACCESS_SMOKE_COOKIE;
  if (cookie !== undefined && cookie !== "" &&
      (!boundedString(cookie, 16_384) || !/^[A-Za-z0-9._~-]+$/u.test(cookie))) fail("Invalid Access smoke cookie");
  const ownerHttpTransport = env.ELIOTR_OWNER_HTTP_TRANSPORT ?? "cookie";
  if (!["cookie", "cloudflared"].includes(ownerHttpTransport) ||
      (ownerHttpTransport === "cloudflared" && cookie)) fail("Invalid owner HTTP transport");
  const api = new URL(env.CLOUDFLARE_API_BASE_URL ?? "https://api.cloudflare.com/client/v4");
  const official = api.protocol === "https:" && api.hostname === "api.cloudflare.com" && api.port === "";
  const fixture = api.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(api.hostname);
  if ((!official && !fixture) || api.username || api.password || api.search || api.hash ||
      !["/client/v4", "/client/v4/"].includes(api.pathname)) fail("Invalid Cloudflare API origin");
  return { origin, cookie: cookie || null, ownerHttpTransport, apiBase: api.href.replace(/\/$/u, ""),
    access: validateAccessRuntimeConfiguration(env), googleExternalTransport };
}

export function validateGeneratedDeployment(bytes, env, input) {
  let config;
  try { config = JSON.parse(bytes.toString("utf8")); } catch { fail("Invalid generated deployment JSON"); }
  if (!isObject(config) || !isObject(config.vars) ||
      Object.keys(config.vars).some((name) => ALLOWED_SECRET_BINDINGS.has(name)) ||
      config.name !== "eliotr-core" || config.minify !== true ||
      config.keep_vars === true || config.preview_urls !== false ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(config.compatibility_date ?? "") ||
      config.vars?.DEPLOYMENT_GENERATION !== env.ELIOTR_DEPLOYMENT_GENERATION ||
      config.vars?.ENVIRONMENT !== env.ELIOTR_ENVIRONMENT ||
      (input.googleExternalTransport !== null &&
       config.vars?.GOOGLE_EXTERNAL_TRANSPORT !== input.googleExternalTransport) ||
      config.vars?.ACCESS_TEAM_DOMAIN !== input.access.teamDomain ||
      config.vars?.ACCESS_AUDIENCE !== input.access.audience ||
      config.vars?.ACCESS_SERVICE_PRINCIPALS !== input.access.servicePrincipals.join(",")) {
    fail("Generated deployment identity or Access configuration drift");
  }
  const databases = config.d1_databases;
  if (!Array.isArray(databases) || databases.length !== 2 ||
      new Set(databases.map((db) => db?.database_id)).size !== 2) fail("Invalid generated D1 identities");
  for (const [binding, name] of [["CORE_DB", "eliotr-core"], ["SEARCH_DB", "eliotr-search"]]) {
    const matches = databases.filter((db) => db?.binding === binding);
    if (matches.length !== 1 || matches[0].database_name !== name ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(matches[0].database_id ?? "")) {
      fail("Invalid generated D1 identity");
    }
  }
  return config;
}

function parseDeploymentVariable(value, variable) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); }
  catch { fail(`Generated deployment variable is invalid JSON: ${variable}`); }
}

function ownerTemplateValue(value, descriptor) {
  const parsed = parseDeploymentVariable(value, descriptor.variable);
  if (!isObject(parsed)) return null;
  let current = parsed;
  for (const key of descriptor.path.slice(0, -1)) current = isObject(current) ? current[key] : null;
  if (!isObject(current) || current.protocol !== descriptor.protocol) return null;
  const generationKey = descriptor.path.at(-1);
  if (!boundedString(current[generationKey])) {
    fail(`Generated owner template generation is invalid: ${descriptor.variable}`);
  }
  return { value, parsed, current, generationKey };
}

/** Require versioned owner templates to name the candidate Worker generation. */
export function assertGeneratedOwnerTemplatesCurrent(config) {
  if (!isObject(config) || !isObject(config.vars) || !boundedString(config.vars.DEPLOYMENT_GENERATION)) {
    fail("Generated deployment generation is invalid");
  }
  const candidateGeneration = config.vars.DEPLOYMENT_GENERATION;
  for (const descriptor of OWNER_TEMPLATE_GENERATION_FIELDS) {
    if (!Object.hasOwn(config.vars, descriptor.variable)) continue;
    const parsed = parseDeploymentVariable(config.vars[descriptor.variable], descriptor.variable);
    let current = parsed;
    for (const key of descriptor.path.slice(0, -1)) current = isObject(current) ? current[key] : null;
    if (!isObject(current) || !descriptor.protocols.includes(current.protocol)) {
      fail(`Generated owner template protocol is invalid: ${descriptor.variable}`);
    }
    if (current.protocol === descriptor.protocol && !boundedString(current[descriptor.path.at(-1)])) {
      fail(`Generated owner template generation is invalid: ${descriptor.variable}`);
    }
    if (current.protocol === descriptor.protocol && current[descriptor.path.at(-1)] !== candidateGeneration) {
      fail(`Generated owner template generation does not match candidate: ${descriptor.variable}`);
    }
    if (current.protocol !== descriptor.protocol && Object.hasOwn(current, descriptor.path.at(-1))) {
      fail(`Generated owner template v2 contains a release generation: ${descriptor.variable}`);
    }
  }
  return candidateGeneration;
}

function isApprovedRuntimeCandidate(value, candidateGeneration) {
  return isObject(value) && Object.keys(value).length === 3 &&
    Object.hasOwn(value, "protocol") && Object.hasOwn(value, "deployment_generation") &&
    Object.hasOwn(value, "configuration_sha256") &&
    value.protocol === APPROVED_RUNTIME_CANDIDATE_PROTOCOL &&
    value.deployment_generation === candidateGeneration && typeof value.configuration_sha256 === "string" &&
    SHA256.test(value.configuration_sha256);
}

function isApprovedRuntimeTransition(value, candidate, active, versionId, observedGeneration) {
  if (!isObject(value) || Object.keys(value).length !== 4 ||
      !Object.hasOwn(value, "protocol") || !Object.hasOwn(value, "baseline") ||
      !Object.hasOwn(value, "candidate") || !Object.hasOwn(value, "owner_runtime_variables")) return false;
  const baseline = value.baseline;
  const expectedCandidate = value.candidate;
  if (!isObject(baseline) || Object.keys(baseline).length !== 4 ||
      !isObject(expectedCandidate) || Object.keys(expectedCandidate).length !== 2 ||
      !isApprovedRuntimeCandidate(candidate, expectedCandidate.deployment_generation) ||
      !Array.isArray(value.owner_runtime_variables) ||
      value.protocol !== APPROVED_RUNTIME_TRANSITION_PROTOCOL ||
      Object.keys(baseline).sort().join(",") !== "configuration_sha256,deployment_generation,deployment_id,version_id" ||
      Object.keys(expectedCandidate).sort().join(",") !== "configuration_sha256,deployment_generation" ||
      baseline.deployment_id !== active.id || baseline.version_id !== versionId ||
      baseline.deployment_generation !== observedGeneration || typeof baseline.configuration_sha256 !== "string" ||
      !SHA256.test(baseline.configuration_sha256) ||
      expectedCandidate.deployment_generation !== candidate.deployment_generation ||
      expectedCandidate.configuration_sha256 !== candidate.configuration_sha256 ||
      value.owner_runtime_variables.length !== OWNER_RUNTIME_TRANSITION_VARIABLES.size) return false;
  const variables = [...value.owner_runtime_variables];
  return variables.every((name) => typeof name === "string" && OWNER_RUNTIME_TRANSITION_VARIABLES.has(name)) &&
    new Set(variables).size === OWNER_RUNTIME_TRANSITION_VARIABLES.size &&
    [...OWNER_RUNTIME_TRANSITION_VARIABLES].every((name) => variables.includes(name));
}

function validateObservedRuntimeVariable(name, type, value) {
  if ((type === "plain_text" && typeof value !== "string") ||
      (type === "json" && (value === undefined || value === null))) {
    fail("Worker baseline runtime variable value is invalid");
  }
  if (name === "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0" ||
      name === "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_1") {
    if (type !== "plain_text" || Buffer.byteLength(value, "utf8") > 4_000) {
      fail("Worker baseline semantic configuration chunk is invalid");
    }
    return;
  }
  if (!name.endsWith("_JSON")) return;
  const parsed = typeof value === "string" ? parseDeploymentVariable(value, name) : value;
  if (!isObject(parsed)) fail("Worker baseline runtime JSON variable is invalid");
  if (name === "ELIOTR_MODEL_SPEND_POLICY_JSON") {
    const descriptor = OWNER_TEMPLATE_GENERATION_FIELDS[0];
    if (!descriptor.protocols.includes(parsed.protocol) || !boundedString(parsed.config_provenance_ref) ||
        !boundedString(parsed.principal_ref) || !Array.isArray(parsed.rules)) {
      fail("Worker baseline spend template schema is invalid");
    }
    if (parsed.protocol === descriptor.protocol && !boundedString(parsed.deployment_generation)) {
      fail("Worker baseline spend template generation is invalid");
    }
    if (parsed.protocol !== descriptor.protocol && Object.hasOwn(parsed, "deployment_generation")) {
      fail("Worker baseline spend template v2 contains a release generation");
    }
  } else if (name === "ELIOTR_RESEARCH_REPORT_CONFIG_JSON") {
    const admission = parsed.admission_policy;
    const descriptor = OWNER_TEMPLATE_GENERATION_FIELDS[1];
    if (parsed.schema !== "eliotr.research.report-config.v1" || !isObject(admission) ||
        !descriptor.protocols.includes(admission.protocol) || !boundedString(admission.config_provenance_ref) ||
        !boundedString(admission.principal_ref)) {
      fail("Worker baseline report template schema is invalid");
    }
    if (admission.protocol === descriptor.protocol && !boundedString(admission.deployment_generation)) {
      fail("Worker baseline report template generation is invalid");
    }
    if (admission.protocol !== descriptor.protocol && Object.hasOwn(admission, "deployment_generation")) {
      fail("Worker baseline report template v2 contains a release generation");
    }
  } else if (name === "ELIOTR_MODEL_PROFILE_DEFINITION_JSON") {
    if (!/^eliotr\.research\.model-profile-definition\.v[12]$/u.test(parsed.schema ?? "") ||
        !boundedString(parsed.config_provenance_ref) || !boundedString(parsed.model_profile_ref)) {
      fail("Worker baseline model profile schema is invalid");
    }
  }
}

/** Permit only the generation value to differ in a recognized owner template. */
export function isApprovedOwnerTemplateGenerationTransition(variable, observedValue, candidateValue, candidateGeneration) {
  const descriptor = OWNER_TEMPLATE_GENERATION_FIELDS.find((item) => item.variable === variable);
  if (descriptor === undefined || !boundedString(candidateGeneration)) return false;
  try {
    const observed = ownerTemplateValue(observedValue, descriptor);
    const candidate = ownerTemplateValue(candidateValue, descriptor);
    if (observed === null || candidate === null || candidate.current[candidate.generationKey] !== candidateGeneration) return false;
    const normalized = structuredClone(observed.parsed);
    let current = normalized;
    for (const key of descriptor.path.slice(0, -1)) current = current[key];
    current[descriptor.path.at(-1)] = candidateGeneration;
    return sameJsonValue(normalized, candidate.parsed);
  } catch {
    return false;
  }
}

// The deadline covers connection, headers AND body. No upstream body or fetch error is logged:
// those can contain reflected cookies, tokens or a proxy's sensitive diagnostics.
export async function readDeploymentJson(url, headers, {
  fetchImpl = fetch, maxBytes = MAX_SMOKE_BYTES, timeoutMs = TIMEOUT_MS,
} = {}) {
  const controller = new globalThis.AbortController();
  let timer;
  let reader;
  const request = async () => {
    const response = await fetchImpl(url, { method: "GET", headers, redirect: "manual",
      cache: "no-store", signal: controller.signal });
    if (response.status !== 200 || response.redirected) fail("Deployment readback requires HTTP 200 without redirect");
    if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      fail("Deployment readback requires application/json");
    }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) fail("Deployment readback body limit");
    if (response.body === null) fail("Deployment readback body missing");
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) fail("Deployment readback body limit");
      chunks.push(chunk.value);
    }
    let data;
    try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { fail("Deployment readback invalid UTF-8 or JSON"); }
    return { data, status: response.status };
  };
  try {
    return await Promise.race([
      request(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Deployment readback deadline")), timeoutMs);
      }),
    ]);
  } catch {
    throw new Error("Deployment readback rejected (HTTP, body, format or deadline)");
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
  }
}

export async function verifyDeploymentSmoke(env, input, options = {}) {
  if (!input.cookie && input.ownerHttpTransport !== "cloudflared") {
    return { state: "NOT_EXECUTED", reason: "Owner HTTP authentication is not configured; authenticated HTTP smoke was not executed." };
  }
  const generation = env.ELIOTR_DEPLOYMENT_GENERATION;
  const headers = { ...(input.cookie ? { Cookie: `CF_Authorization=${input.cookie}` } : {}), Accept: "application/json" };
  const results = [];
  for (const path of ["/healthz", "/api/v1/system/capabilities"]) {
    const { data, status } = await readDeploymentJson(`${input.origin}${path}`, headers, options);
    if (path === "/healthz") {
      exactKeys(data, ["ready", "deployment_generation", "checked_at"], "Invalid health response");
      const age = (options.now ?? Date.now)() - Date.parse(data.checked_at);
      if (data.ready !== true || data.deployment_generation !== generation ||
          typeof data.checked_at !== "string" || !Number.isFinite(age) || Math.abs(age) > 120_000) {
        fail("Health readiness, generation or freshness mismatch");
      }
    } else {
      exactKeys(data, ["data", "trace_id", "deployment_generation"], "Invalid capabilities envelope");
      const caps = data.data;
      if (data.deployment_generation !== generation || !boundedString(data.trace_id) ||
          !isObject(caps) || caps.protocol !== "eliotr.capabilities.v1" ||
          caps.deployment_generation !== generation || caps.exact_evidence_resolution_required !== true ||
          caps.transport_completion_is_research_completion !== false || typeof caps.ingest_live_qualified !== "boolean") {
        fail("Capabilities generation or authority mismatch");
      }
      for (const slices of [caps.enabled_slices, caps.disabled_slices]) {
        if (!Array.isArray(slices) || slices.length > 64 ||
            slices.some((slice) => typeof slice !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(slice)) ||
            new Set(slices).size !== slices.length) fail("Invalid capabilities slices");
      }
      if (!["HEALTH", "ACCESS"].every((slice) => caps.enabled_slices.includes(slice)) ||
          caps.enabled_slices.some((slice) => caps.disabled_slices.includes(slice))) fail("Conflicting capabilities slices");
    }
    results.push({ path, status });
  }
  return { state: "PASS", results };
}

export async function readDeploymentWorker(env, input, config, options = {}) {
  const account = encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID);
  const script = encodeURIComponent(config.name);
  const base = `${input.apiBase}/accounts/${account}/workers/scripts/${script}`;
  const headers = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };
  const read = async (url) => (await readDeploymentJson(url, headers,
    { ...options, maxBytes: MAX_API_BYTES })).data;
  const inventory = await read(`${input.apiBase}/accounts/${account}/workers/scripts`);
  if (!isObject(inventory) || inventory.success !== true || !Array.isArray(inventory.result)) {
    fail("Invalid Worker inventory readback");
  }
  const matches = inventory.result.filter((worker) => worker?.id === config.name);
  if (matches.length !== 1) fail("Ambiguous or absent Worker readback");
  const worker = matches[0];
  if (worker.compatibility_date !== config.compatibility_date || worker.has_assets !== true) {
    fail("Worker compatibility or assets drift");
  }

  // Cloudflare documents the first deployment as the one actively serving traffic.
  // Require a single 100% version so a gradual rollout cannot be mistaken for one build.
  const deployments = await read(`${base}/deployments`);
  const active = deployments?.success === true && Array.isArray(deployments.result?.deployments)
    ? deployments.result.deployments[0] : null;
  if (!isObject(active) || !CLOUDFLARE_UUID.test(active.id ?? "") ||
      typeof active.created_on !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(active.created_on) ||
      !Number.isFinite(Date.parse(active.created_on)) || active.strategy !== "percentage" ||
      !Array.isArray(active.versions) || active.versions.length !== 1 ||
      active.versions[0]?.percentage !== 100 || !CLOUDFLARE_UUID.test(active.versions[0]?.version_id ?? "")) {
    fail("Worker active deployment is absent, ambiguous or gradual");
  }
  const versionId = active.versions[0].version_id;
  const versionResponse = await read(`${base}/versions/${encodeURIComponent(versionId)}`);
  const version = versionResponse?.success === true ? versionResponse.result : null;
  const runtime = version?.resources?.script_runtime;
  const versionScript = version?.resources?.script;
  if (!isObject(version) || version.id !== versionId || !Number.isSafeInteger(version.number) || version.number < 1 ||
      !isObject(runtime) || !isObject(versionScript) ||
      !boundedString(versionScript.etag, 256)) {
    fail("Invalid active Worker version readback");
  }
  const versionDate = typeof runtime.compatibility_date === "string"
    ? runtime.compatibility_date.slice(0, 10) : null;
  if (versionDate !== config.compatibility_date) fail("Worker version compatibility drift");
  const expectedFlags = [...(config.compatibility_flags ?? [])].sort();
  // Workers Versions GET declares this array optional; omission represents no flags.
  // https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/
  const actualFlags = Object.hasOwn(runtime, "compatibility_flags") ? runtime.compatibility_flags : [];
  if (!Array.isArray(actualFlags) || actualFlags.some((flag) => typeof flag !== "string") ||
      JSON.stringify([...actualFlags].sort()) !== JSON.stringify(expectedFlags)) {
    fail("Worker version compatibility flags drift");
  }
  const exports = runtime.exports;
  if (!isObject(exports)) fail("Worker version exports missing");
  const configuredExports = config.exports ?? {};
  if (!isObject(configuredExports) || configuredExports.ResearchSession?.type !== "durable-object") {
    fail("Invalid generated Worker exports");
  }
  const expectedExportNames = Object.keys(configuredExports).sort();
  const actualExportNames = Object.keys(exports).filter((name) => name !== "default").sort();
  if (JSON.stringify(actualExportNames) !== JSON.stringify(expectedExportNames)) {
    fail("Worker version named exports drift");
  }
  for (const [name, expected] of Object.entries(configuredExports)) {
    const actual = exports[name];
    if (!isObject(expected) || !isObject(actual) || actual.type !== expected.type ||
        (expected.storage !== undefined && actual.storage !== expected.storage) ||
        (actual.state !== undefined && actual.state !== "created")) {
      fail("Worker version named export identity drift");
    }
  }

  const expectedBindings = expectedDeploymentBindings(config);
  const expectedVars = expectedDeploymentVars(config);
  const actualBindings = normalizeDeploymentBindings(version.resources.bindings);
  const actualByName = new Map();
  for (const binding of actualBindings) {
    if (!boundedString(binding.bindingName) || !boundedString(binding.type) || actualByName.has(binding.bindingName)) {
      fail("Worker version binding names are invalid or duplicated");
    }
    actualByName.set(binding.bindingName, binding);
  }
  const expectedGeneration = config.vars?.DEPLOYMENT_GENERATION;
  const expectedConfigurationBaseline = options.expectedConfigurationBaseline ?? null;
  const observedGeneration = options.observedDeploymentGeneration ??
    expectedConfigurationBaseline?.deployment_generation ?? expectedGeneration;
  const baselineRequested = options.observedDeploymentGeneration !== undefined || expectedConfigurationBaseline !== null;
  const approvedRuntimeCandidate = options.approvedRuntimeCandidate ?? null;
  const approvedRuntimeTransition = options.approvedRuntimeTransition ?? null;
  const mcpAccessBaselineObservation = options.mcpAccessBaselineObservation ?? null;
  const approvedMcpAccessTransition = options.approvedMcpAccessTransition ?? null;
  const candidateAuthorizationValid = isApprovedRuntimeCandidate(approvedRuntimeCandidate, expectedGeneration);
  const transitionAuthorizationValid = isApprovedRuntimeTransition(approvedRuntimeTransition,
    approvedRuntimeCandidate, active, versionId, observedGeneration);
  const mcpObservationAuthorizationValid = isMaintenanceMcpAccessBaselineObservation(mcpAccessBaselineObservation, {
    config, expectedGeneration, deploymentId: active.id, versionId, observedGeneration });
  const mcpTransitionAuthorizationValid = isMaintenanceMcpAccessTransition(approvedMcpAccessTransition, {
    config, expectedGeneration, deploymentId: active.id, versionId, observedGeneration });
  if ((approvedRuntimeCandidate !== null && !candidateAuthorizationValid) ||
      (approvedRuntimeTransition !== null && !transitionAuthorizationValid) ||
      (mcpAccessBaselineObservation !== null && !mcpObservationAuthorizationValid) ||
      (approvedMcpAccessTransition !== null && !mcpTransitionAuthorizationValid)) {
    fail("Approved runtime configuration transition intent is invalid");
  }
  const approvedRuntimeChanges = baselineRequested &&
    (candidateAuthorizationValid || transitionAuthorizationValid);
  const approvedMcpAccessChanges = baselineRequested &&
    (mcpObservationAuthorizationValid || mcpTransitionAuthorizationValid);
  const generationBinding = actualByName.get("DEPLOYMENT_GENERATION");
  if (!boundedString(expectedGeneration) || !boundedString(observedGeneration) || !generationBinding ||
      generationBinding.type !== "plain_text" || generationBinding.text !== observedGeneration) {
    fail("Worker version deployment generation binding drift");
  }
  const bindingReadback = [];
  for (const expected of expectedBindings) {
    const actual = actualByName.get(expected.name);
    if (!actual || actual.type !== expected.type ||
        Object.entries(expected.identity).some(([key, value]) => {
          if (expected.type === "durable_object_namespace" || expected.type === "workflow") {
            if (key === "script_name") return (actual.script_name ?? config.name) !== value;
            if (key === "environment") return (actual.environment ?? null) !== value;
          }
          return actual[key] !== value;
        })) {
      fail(`Worker version binding identity drift: ${expected.name}`);
    }
    bindingReadback.push({ name: expected.name, type: expected.type, identity: expected.identity });
  }
  const expectedNames = new Set(expectedBindings.map((binding) => binding.name));
  const variableReadback = [];
  const observedVariables = {};
  for (const [name, value] of Object.entries(expectedVars)) {
    if (expectedNames.has(name)) fail("Generated variable conflicts with a resource binding");
    const actual = actualByName.get(name);
    if (approvedMcpAccessChanges && isMcpAccessTransitionVariable(name)) {
      if (actual === undefined) continue;
      if (actual.type !== "plain_text" || typeof actual.text !== "string") {
        fail("Worker baseline MCP Access variable type is invalid");
      }
      variableReadback.push({ name, type: actual.type });
      observedVariables[name] = { type: actual.type, value: actual.text };
      continue;
    }
    if (approvedRuntimeChanges && OWNER_RUNTIME_TRANSITION_VARIABLES.has(name)) {
      if (actual === undefined) continue;
      if (actual.type !== "plain_text" && actual.type !== "json") {
        fail("Worker baseline runtime variable type is invalid");
      }
      const observedValue = actual.type === "plain_text" ? actual.text : actual.json;
      validateObservedRuntimeVariable(name, actual.type, observedValue);
      variableReadback.push({ name, type: actual.type });
      observedVariables[name] = { type: actual.type, value: structuredClone(observedValue) };
      continue;
    }
    const expectedType = typeof value === "string" ? "plain_text" : "json";
    const observedValue = expectedType === "plain_text" ? actual?.text : actual?.json;
    const isGenerationBinding = name === "DEPLOYMENT_GENERATION";
    const exactMatch = isGenerationBinding
      ? observedValue === observedGeneration
      : sameJsonValue(observedValue, value);
    const approvedTemplateTransition = baselineRequested && !isGenerationBinding &&
      OWNER_TEMPLATE_GENERATION_FIELDS.some((descriptor) => descriptor.variable === name) &&
      isApprovedOwnerTemplateGenerationTransition(name, observedValue, value, expectedGeneration);
    if (!actual || actual.type !== expectedType || (!exactMatch && !approvedTemplateTransition)) {
      fail("Worker version variable readback drift");
    }
    variableReadback.push({ name, type: expectedType });
    observedVariables[name] = { type: expectedType, value: structuredClone(observedValue) };
  }
  const observedSecrets = [];
  for (const binding of actualBindings) {
    const name = binding.bindingName;
    if (expectedNames.has(name) || Object.hasOwn(expectedVars, name)) continue;
    if (approvedMcpAccessChanges && isMcpAccessTransitionVariable(name)) {
      if (binding.type !== "plain_text" || typeof binding.text !== "string") {
        fail("Worker baseline MCP Access variable type is invalid");
      }
      variableReadback.push({ name, type: binding.type });
      observedVariables[name] = { type: binding.type, value: binding.text };
      continue;
    }
    if (approvedRuntimeChanges && OWNER_RUNTIME_TRANSITION_VARIABLES.has(name) &&
        (binding.type === "plain_text" || binding.type === "json")) {
      const observedValue = binding.type === "plain_text" ? binding.text : binding.json;
      validateObservedRuntimeVariable(name, binding.type, observedValue);
      variableReadback.push({ name, type: binding.type });
      observedVariables[name] = { type: binding.type, value: structuredClone(observedValue) };
      continue;
    }
    if (!ALLOWED_SECRET_BINDINGS.has(name) || binding.type !== "secret_text") {
      fail("Worker version has an undeclared binding or secret");
    }
    observedSecrets.push({ bindingName: name, type: binding.type });
  }

  const result = { id: worker.id, compatibility_date: worker.compatibility_date,
    modified_on: worker.modified_on ?? null, last_deployed_from: worker.last_deployed_from ?? null,
    has_assets: worker.has_assets, durable_object_export: configuredExports.ResearchSession?.type,
    deployment_generation_binding: "PASS",
    deployment_id: active.id, deployment_created_on: active.created_on, version_id: versionId,
    version_number: version.number, version_etag: versionScript.etag, traffic_percentage: 100,
    binding_readback: bindingReadback,
    vars_readback: { state: "PASS", binding_count: variableReadback.length } };
  if (baselineRequested) {
    const snapshot = deepFreeze({
      worker: structuredClone(worker),
      deployment: structuredClone(active),
      version: {
        id: version.id,
        number: version.number,
        script_etag: versionScript.etag,
        runtime: {
          compatibility_date: runtime.compatibility_date,
          compatibility_flags: [...actualFlags].sort(),
          exports: structuredClone(exports),
        },
        bindings: actualBindings.map((binding) => binding.type === "secret_text"
          ? { bindingName: binding.bindingName, type: binding.type }
          : structuredClone(binding)).sort((left, right) => left.bindingName.localeCompare(right.bindingName)),
      },
      variables: observedVariables,
      secret_bindings: observedSecrets.sort((left, right) => left.bindingName.localeCompare(right.bindingName)),
    });
    const canonicalSnapshot = canonicalJsonValue(snapshot);
    if (canonicalSnapshot === undefined) fail("Worker configuration baseline is not JSON-safe");
    const configurationBaseline = Object.freeze({
      deployment_id: active.id,
      version_id: versionId,
      deployment_generation: observedGeneration,
      configuration_sha256: createHash("sha256").update(canonicalSnapshot).digest("hex"),
      configuration: snapshot,
    });
    if (mcpObservationAuthorizationValid) {
      assertMcpAccessBaselineObservation(mcpAccessBaselineObservation, configurationBaseline);
    }
    if (mcpTransitionAuthorizationValid) {
      assertMcpAccessTransitionBaseline(approvedMcpAccessTransition, configurationBaseline);
    }
    if (transitionAuthorizationValid &&
        approvedRuntimeTransition.baseline.configuration_sha256 !== configurationBaseline.configuration_sha256) {
      fail("Worker configuration baseline changed during deployment preflight");
    }
    if (expectedConfigurationBaseline !== null &&
        !sameJsonValue(configurationBaseline, expectedConfigurationBaseline)) {
      fail("Worker configuration baseline changed during deployment preflight");
    }
    result.configuration_baseline = configurationBaseline;
  }
  return result;
}

function expectedDeploymentVars(config) {
  if (!isObject(config.vars) || Object.keys(config.vars).some((name) =>
    !/^[A-Z][A-Z0-9_]{0,127}$/u.test(name) || ALLOWED_SECRET_BINDINGS.has(name))) {
    fail("Generated deployment variables are invalid or include a secret");
  }
  for (const value of Object.values(config.vars)) {
    try {
      if (JSON.stringify(value) === undefined) fail("Generated deployment variable is not JSON-safe");
    } catch { fail("Generated deployment variable is not JSON-safe"); }
  }
  return config.vars;
}

function sameJsonValue(left, right) {
  try {
    const leftJson = canonicalJsonValue(left);
    const rightJson = canonicalJsonValue(right);
    return leftJson !== undefined && rightJson !== undefined && leftJson === rightJson;
  } catch { return false; }
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonValue).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJsonValue(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function expectedDeploymentBindings(config) {
  const expected = [];
  const add = (name, type, identity = {}) => {
    if (!boundedString(name) || !boundedString(type) || expected.some((binding) => binding.name === name)) {
      fail("Generated deployment binding names are invalid or duplicated");
    }
    if (!isObject(identity) || Object.entries(identity).some(([key, value]) =>
      !(key === "environment" && value === null) && !boundedString(value))) {
      fail("Generated deployment binding identity is incomplete");
    }
    expected.push({ name, type, identity });
  };
  if (!Array.isArray(config.d1_databases) || !Array.isArray(config.r2_buckets) ||
      !Array.isArray(config.queues?.producers) || !Array.isArray(config.durable_objects?.bindings) ||
      !Array.isArray(config.workflows) || !Array.isArray(config.analytics_engine_datasets)) {
    fail("Generated deployment resource bindings are incomplete");
  }
  for (const item of config.d1_databases) add(item?.binding, "d1", { id: item?.database_id });
  for (const item of config.r2_buckets) add(item?.binding, "r2_bucket", { bucket_name: item?.bucket_name });
  for (const item of config.queues.producers) add(item?.binding, "queue", { queue_name: item?.queue });
  for (const item of config.durable_objects.bindings) {
    add(item?.name, "durable_object_namespace", {
      class_name: item?.class_name, script_name: item?.script_name ?? config.name,
      environment: item?.environment ?? null,
    });
  }
  for (const item of config.workflows) {
    add(item?.binding, "workflow", { workflow_name: item?.name, class_name: item?.class_name,
      script_name: item?.script_name ?? config.name });
  }
  for (const item of config.analytics_engine_datasets) {
    add(item?.binding, "analytics_engine", { dataset: item?.dataset });
  }
  if (config.ai?.binding !== undefined) add(config.ai.binding, "ai");
  if (config.assets?.binding !== undefined) add(config.assets.binding, "assets");
  for (const item of config.ai_search_namespaces ?? []) {
    add(item?.binding, "ai_search_namespace", { namespace: item?.namespace });
  }
  for (const item of config.ai_search ?? []) {
    add(item?.binding, "ai_search", { instance_name: item?.instance_name });
  }
  const wasmModules = config.wasm_modules ?? {};
  if (!isObject(wasmModules)) fail("Invalid generated Wasm module bindings");
  for (const name of Object.keys(wasmModules)) add(name, "wasm_module");
  return expected;
}

function normalizeDeploymentBindings(bindings) {
  if (Array.isArray(bindings)) return bindings.map((binding) => {
    if (!isObject(binding)) fail("Invalid Worker version binding");
    return { ...binding, bindingName: binding.binding ?? binding.name };
  });
  if (!isObject(bindings)) fail("Worker version bindings missing");
  return Object.entries(bindings).map(([name, binding]) => {
    if (!isObject(binding)) fail("Invalid Worker version binding");
    return { ...binding, bindingName: name,
      ...(binding.type === "workflow" ? { workflow_name: binding.workflow_name ?? binding.name } : {}) };
  });
}
