import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readDeploymentJson } from "./deployment-verification.mjs";
import { launchCodeBlockers, readConfiguredTransport } from "../check-launch-code.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/u;
const SLICES = Object.freeze(["enabled_slices", "partial_slices", "disabled_slices"]);
const CAPABILITY_KEYS = Object.freeze(["protocol", "deployment_generation", "google_external_transport", ...SLICES,
  "federation_configured", "orientation_profile", "orientation_max_sources", "orientation_max_results", "routes",
  "exact_evidence_resolution_required", "transport_completion_is_research_completion", "ingest_live_qualified"]);
const SAFETY = Object.freeze({
  exact_evidence_resolution_required: true,
  transport_completion_is_research_completion: false,
  ingest_live_qualified: false,
});
const GOOGLE_TRANSPORTS = new Set(["disabled", "gemini-mcp", "drive-exchange"]);
const ROUTE_KEYS = Object.freeze(["method", "path", "operation", "auth", "maximum_request_bytes", "response_mode"]);
const fail = (message) => { throw new Error(message); };
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const bounded = (value, maximum = 256) => typeof value === "string" && value.length > 0 && value.length <= maximum &&
  !/[\u0000-\u0020\u007f]/u.test(value);

/** Read a bounded active-Worker identity and generation before maintenance upload. */
export async function readActiveDeploymentIdentity({ env, input, fetchImpl = fetch, readJson = readDeploymentJson } = {}) {
  if (!isRecord(env) || !isRecord(input) || typeof input.apiBase !== "string" ||
      typeof env.CLOUDFLARE_ACCOUNT_ID !== "string" || typeof env.CLOUDFLARE_API_TOKEN !== "string") {
    fail("Maintenance Worker identity inputs are invalid");
  }
  const account = encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID);
  const base = `${input.apiBase}/accounts/${account}/workers/scripts/eliotr-core`;
  const headers = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };
  const read = async (url) => {
    const { data } = await readJson(url, headers, { fetchImpl, maxBytes: 1024 * 1024 });
    if (Array.isArray(data?.errors) && data.errors.length > 0) fail("Maintenance Worker identity readback contains errors");
    return data;
  };
  const inventory = await read(`${input.apiBase}/accounts/${account}/workers/scripts`);
  if (!isRecord(inventory) || inventory.success !== true || !Array.isArray(inventory.result)) {
    fail("Maintenance Worker inventory readback is invalid");
  }
  const matches = inventory.result.filter((item) => item?.id === "eliotr-core");
  if (matches.length !== 1 || matches[0].compatibility_date !== "2026-08-28" || matches[0].has_assets !== true) {
    fail("Maintenance requires the exact existing eliotr-core Worker with assets");
  }

  const deployments = await read(`${base}/deployments`);
  const active = deployments?.success === true && Array.isArray(deployments.result?.deployments)
    ? deployments.result.deployments[0] : null;
  if (!isRecord(active) || !UUID.test(active.id ?? "") || !Number.isFinite(Date.parse(active.created_on ?? "")) ||
      typeof active.created_on !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(active.created_on) ||
      active.strategy !== "percentage" || !Array.isArray(active.versions) || active.versions.length !== 1 ||
      active.versions[0]?.percentage !== 100 || !UUID.test(active.versions[0]?.version_id ?? "")) {
    fail("Maintenance requires one active 100% Worker version");
  }
  const version = await read(`${base}/versions/${encodeURIComponent(active.versions[0].version_id)}`);
  const current = version?.success === true ? version.result : null;
  const bindings = normalizeBindings(current?.resources?.bindings);
  const generationBindings = bindings.filter((binding) => binding.name === "DEPLOYMENT_GENERATION");
  const runtimeDate = current?.resources?.script_runtime?.compatibility_date;
  const generation = generationBindings.length === 1 && generationBindings[0].type === "plain_text"
    ? generationBindings[0].text : null;
  const principalBindings = bindings.filter((binding) => binding.name === "FEDERATION_SERVER_PRINCIPAL_REF");
  const cursorBindings = bindings.filter((binding) => binding.name === "FEDERATION_CURSOR_HMAC_KEY");
  const federationPrincipalRef = principalBindings.length === 0 ? null :
    principalBindings.length === 1 && principalBindings[0].type === "plain_text" && bounded(principalBindings[0].text)
      ? principalBindings[0].text : undefined;
  const federationCursorKeyBound = cursorBindings.length === 1 && cursorBindings[0].type === "secret_text";
  if (!isRecord(current) || current.id !== active.versions[0].version_id ||
      !Number.isSafeInteger(current.number) || current.number < 1 ||
      typeof runtimeDate !== "string" || runtimeDate.slice(0, 10) !== "2026-08-28" ||
      !bounded(generation) || federationPrincipalRef === undefined || cursorBindings.length > 1 ||
      (cursorBindings.length === 1 && !federationCursorKeyBound) || !IDENTIFIER.test(env.CLOUDFLARE_ACCOUNT_ID)) {
    fail("Maintenance active Worker generation metadata is invalid");
  }
  return Object.freeze({ worker_id: "eliotr-core", compatibility_date: "2026-08-28", has_assets: true,
    deployment_id: active.id, version_id: active.versions[0].version_id, version_number: current.number,
    generation, federation_principal_ref: federationPrincipalRef, federation_cursor_key_bound: federationCursorKeyBound,
    traffic_percentage: 100 });
}

/** Read the authenticated active Worker capability profile through the Access hostname. */
export async function readAuthenticatedCapabilities({ input, fetchImpl = fetch, readJson = readDeploymentJson } = {}) {
  if (!isRecord(input) || typeof input.origin !== "string" || typeof input.cookie !== "string" ||
      input.cookie.length < 1 || input.cookie.length > 16_384 || !/^[A-Za-z0-9._~-]+$/u.test(input.cookie)) {
    fail("Maintenance requires an authenticated capability readback cookie");
  }
  const { data, status } = await readJson(`${input.origin}/api/v1/system/capabilities`, {
    Cookie: `CF_Authorization=${input.cookie}`, Accept: "application/json",
  }, { fetchImpl, maxBytes: 64 * 1024 });
  if (status !== 200 || !isRecord(data) || Object.keys(data).length !== 3 ||
      !Object.hasOwn(data, "data") || !Object.hasOwn(data, "trace_id") || !Object.hasOwn(data, "deployment_generation") ||
      !bounded(data.trace_id) || !bounded(data.deployment_generation) || !isRecord(data.data) ||
      data.data.deployment_generation !== data.deployment_generation) {
    fail("Maintenance capabilities envelope is invalid");
  }
  validateObservedCapabilityProfile(data.data);
  return Object.freeze({ generation: data.deployment_generation, capabilities: data.data, status });
}

/** Require the candidate Worker to preserve every observed capability except its generation. */
export function requireSameMaintenanceCapabilityReadback({ baseline, current } = {}) {
  if (!isRecord(baseline) || !isRecord(current) || !bounded(baseline.generation) || !bounded(current.generation) ||
      !isRecord(baseline.capabilities) || !isRecord(current.capabilities) ||
      baseline.capabilities.deployment_generation !== baseline.generation ||
      current.capabilities.deployment_generation !== current.generation) {
    fail("Maintenance capability readback comparison inputs are invalid");
  }
  validateObservedCapabilityProfile(baseline.capabilities);
  validateObservedCapabilityProfile(current.capabilities);
  const normalized = { ...current.capabilities, deployment_generation: baseline.generation };
  if (!sameJson(normalized, baseline.capabilities)) {
    fail("Maintenance capability profile changed during Worker deployment");
  }
  return Object.freeze({ state: "PASS", generation_changed: current.generation !== baseline.generation,
    profile: "unchanged" });
}

/** Require an unchanged, non-expanding candidate capability profile. */
export function assertMaintenanceCapabilityProfile({ candidate, observed, generatedConfig, activeWorkerIdentity } = {}) {
  if (!isRecord(candidate) || !isRecord(observed) || !isRecord(generatedConfig?.vars) || !isRecord(activeWorkerIdentity)) {
    fail("Maintenance capability comparison inputs are invalid");
  }
  validateObservedCapabilityProfile(observed);
  if (candidate.protocol !== observed.protocol) fail("Maintenance capabilities protocol would change");
  for (const key of SLICES) {
    const expected = candidate[key];
    const actual = observed[key];
    if (!Array.isArray(expected) || !sameStringSet(expected, actual)) {
      fail(`Maintenance capability ${key} would change or broaden`);
    }
  }
  const disabled = new Set(candidate.disabled_slices);
  if (!disabled.has("RETRIEVAL") || !disabled.has("ERASURE") ||
      candidate.enabled_slices.includes("RETRIEVAL") || candidate.partial_slices.includes("RETRIEVAL") ||
      candidate.enabled_slices.includes("ERASURE") || candidate.partial_slices.includes("ERASURE")) {
    fail("Maintenance must keep RETRIEVAL and ERASURE disabled");
  }
  if (!isRecord(candidate.safety_invariants) || !sameJson(candidate.safety_invariants, SAFETY) ||
      Object.entries(SAFETY).some(([key, expected]) => observed[key] !== expected)) {
    fail("Maintenance safety invariants are missing or changed");
  }

  const transport = generatedConfig.vars.GOOGLE_EXTERNAL_TRANSPORT;
  if (!GOOGLE_TRANSPORTS.has(transport) || observed.google_external_transport !== transport) {
    fail("Maintenance Google external transport would change");
  }
  if (!Array.isArray(candidate.routes) || !sameJson(normalizeRoutes(candidate.routes), normalizeRoutes(observed.routes))) {
    fail("Maintenance route surface is dynamic, changed or broader");
  }
  if (candidate.orientation_profile !== observed.orientation_profile ||
      candidate.orientation_max_sources !== observed.orientation_max_sources ||
      candidate.orientation_max_results !== observed.orientation_max_results) {
    fail("Maintenance orientation profile or scope limits would change");
  }
  const principalRef = candidate.federation_configuration?.principal_ref;
  const cursorKey = candidate.federation_configuration?.cursor_key;
  if (principalRef !== "FEDERATION_SERVER_PRINCIPAL_REF" || cursorKey !== "FEDERATION_CURSOR_HMAC_KEY") {
    fail("Maintenance federation capability expression is unknown");
  }
  const candidatePrincipal = Object.hasOwn(generatedConfig.vars, principalRef)
    ? generatedConfig.vars[principalRef] : null;
  if ((candidatePrincipal !== null && !bounded(candidatePrincipal)) ||
      candidatePrincipal !== activeWorkerIdentity.federation_principal_ref ||
      typeof activeWorkerIdentity.federation_cursor_key_bound !== "boolean" ||
      observed.federation_configured !== (candidatePrincipal !== null && activeWorkerIdentity.federation_cursor_key_bound)) {
    fail("Maintenance cannot prove unchanged federation capability configuration");
  }
  return Object.freeze({ state: "PASS", generation: observed.deployment_generation,
    profile: "unchanged", exact_evidence_resolution_required: true,
    transport_completion_is_research_completion: false, disabled_retrieval_erasure: "PASS" });
}

/** Capture the existing full-release blockers for honest maintenance receipts. */
export async function readFullReleaseBlockers({ root = ROOT, read = readFile } = {}) {
  const readText = async (path) => {
    const value = await read(path, "utf8");
    if (typeof value !== "string") throw new Error("Full-release readiness source is unreadable");
    return value;
  };
  const registry = JSON.parse(await readText(resolve(root, "docs/implementation/implementation-status.json")));
  const composition = await readText(resolve(root, "apps/eliotr-core/src/composition-root.ts"));
  const canonical = JSON.parse(await readText(resolve(root, "apps/eliotr-core/wrangler.jsonc")));
  const blockers = launchCodeBlockers(registry, composition);
  if (readConfiguredTransport(canonical) !== registry.release_profile.google_external_transport) {
    blockers.push("launch implementation registry Google transport differs from canonical deployment config");
  }
  return Object.freeze([...new Set(blockers)].sort());
}

/** Verify exactly the source-required Core and Search schema markers with bounded read-only D1 queries. */
export async function verifyDeploymentSchemaGenerations({ env, input, plan, root = ROOT,
  fetchImpl = fetch, read = readFile, readJson = readDeploymentJson } = {}) {
  if (!Array.isArray(plan) || plan.length !== 2 || plan[0]?.binding !== "CORE_DB" || plan[1]?.binding !== "SEARCH_DB") {
    fail("Deployment schema generation inputs are invalid");
  }
  const readiness = tsSource(await read(resolve(root, "apps/eliotr-core/src/readiness.ts"), "utf8"), "readiness.ts");
  const expected = new Map([
    ["CORE_DB", staticSchemaGeneration(readiness, "REQUIRED_CORE_SCHEMA_GENERATION")],
    ["SEARCH_DB", staticSchemaGeneration(readiness, "REQUIRED_SEARCH_SCHEMA_GENERATION")],
  ]);
  const verified = [];
  for (const stream of plan) {
    const required = expected.get(stream.binding);
    if (typeof required !== "string" || !UUID.test(stream.database_id ?? "")) fail("Deployment schema generation plan is invalid");
    const url = `${input.apiBase}/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/d1/database/${encodeURIComponent(stream.database_id)}/query`;
    const body = JSON.stringify({ sql: "SELECT value FROM schema_state WHERE key = 'schema_generation' LIMIT 2", params: [] });
    const { data } = await readJson(url, {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json",
    }, { maxBytes: 256 * 1024,
      fetchImpl: (target, init) => fetchImpl(target, { ...init, method: "POST", body }) });
    const result = data?.result?.[0];
    if (data?.success !== true || (Array.isArray(data.errors) && data.errors.length > 0) ||
        !Array.isArray(data.result) || data.result.length !== 1 || result?.success !== true ||
        !Array.isArray(result.results) || result.results.length !== 1 ||
        result.meta?.changed_db !== false || result.meta?.rows_written !== 0) {
      fail("Deployment schema generation readback is invalid");
    }
    const row = result.results[0];
    if (!isRecord(row) || Object.keys(row).length !== 1 || row.value !== required) {
      fail(`Deployment ${stream.binding} schema generation does not match source requirement`);
    }
    verified.push({ binding: stream.binding, database_id: stream.database_id,
      required_schema_generation: required, observed_schema_generation: row.value, readback: "PASS" });
  }
  return Object.freeze({ state: "PASS", streams: Object.freeze(verified) });
}

function validateObservedCapabilityProfile(value) {
  if (!isRecord(value) || Object.keys(value).length !== CAPABILITY_KEYS.length ||
      CAPABILITY_KEYS.some((key) => !Object.hasOwn(value, key)) ||
      value.protocol !== "eliotr.capabilities.v1" || !bounded(value.deployment_generation) ||
      typeof value.federation_configured !== "boolean" || !GOOGLE_TRANSPORTS.has(value.google_external_transport) ||
      !bounded(value.orientation_profile, 128) || !Number.isSafeInteger(value.orientation_max_sources) ||
      value.orientation_max_sources < 1 || !Number.isSafeInteger(value.orientation_max_results) || value.orientation_max_results < 1 ||
      Object.entries(SAFETY).some(([key, expected]) => value[key] !== expected)) {
    fail("Observed Worker capability profile is invalid or weakens safety invariants");
  }
  for (const key of SLICES) {
    if (!Array.isArray(value[key]) || value[key].length > 64 ||
        value[key].some((slice) => typeof slice !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(slice)) ||
        new Set(value[key]).size !== value[key].length) fail("Observed Worker capability slices are invalid");
  }
  const allSlices = SLICES.flatMap((key) => value[key]);
  if (new Set(allSlices).size !== allSlices.length || !["HEALTH", "ACCESS"].every((slice) => value.enabled_slices.includes(slice))) {
    fail("Observed Worker capability slices overlap or omit required surfaces");
  }
  normalizeRoutes(value.routes);
}

function normalizeRoutes(routes) {
  if (!Array.isArray(routes) || routes.length < 1 || routes.length > 512) fail("Worker route capability list is invalid");
  const normalized = routes.map((route) => {
    if (!isRecord(route) || Object.keys(route).length !== ROUTE_KEYS.length ||
        ROUTE_KEYS.some((key) => !Object.hasOwn(route, key)) ||
        !["GET", "POST", "PUT", "DELETE"].includes(route.method) || !bounded(route.path, 1024) ||
        !bounded(route.operation, 256) || !["public", "owner", "service", "owner_or_service"].includes(route.auth) ||
        !Number.isSafeInteger(route.maximum_request_bytes) || route.maximum_request_bytes < 0 ||
        !["json", "stream", "handle", "redirect"].includes(route.response_mode)) {
      fail("Worker route capability entry is invalid");
    }
    return Object.fromEntries(ROUTE_KEYS.map((key) => [key, route[key]]));
  });
  const identities = normalized.map((route) => `${route.method}\n${route.path}`);
  if (new Set(identities).size !== identities.length) fail("Worker route capability list contains duplicates");
  return normalized.sort((left, right) => {
    const leftKey = `${left.method}\n${left.path}`;
    const rightKey = `${right.method}\n${right.path}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function normalizeBindings(bindings) {
  let normalized;
  if (Array.isArray(bindings)) {
    normalized = bindings.map((binding) => {
      if (!isRecord(binding) || typeof (binding.binding ?? binding.name) !== "string" || typeof binding.type !== "string") {
        fail("Maintenance Worker version binding is invalid");
      }
      if (binding.binding !== undefined && binding.name !== undefined && binding.binding !== binding.name) {
        fail("Maintenance Worker version binding name is ambiguous");
      }
      return { name: binding.binding ?? binding.name, type: binding.type, text: binding.text };
    });
  } else {
    if (!isRecord(bindings)) fail("Maintenance Worker version bindings are missing");
    normalized = Object.entries(bindings).map(([name, binding]) => {
      if (!isRecord(binding) || typeof binding.type !== "string") fail("Maintenance Worker version binding is invalid");
      return { name, type: binding.type, text: binding.text };
    });
  }
  if (normalized.length > 256 || normalized.some((binding) => !IDENTIFIER.test(binding.name)) ||
      new Set(normalized.map((binding) => binding.name)).size !== normalized.length) {
    fail("Maintenance Worker version bindings are duplicate or oversized");
  }
  return normalized;
}

function staticSchemaGeneration(source, name) {
  const matches = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      const initializer = declaration.initializer;
      if (initializer && ts.isAsExpression(initializer) && ts.isTypeReferenceNode(initializer.type) &&
          ts.isIdentifier(initializer.type.typeName) && initializer.type.typeName.text === "const" &&
          ts.isStringLiteral(initializer.expression)) matches.push(initializer.expression.text);
    }
  }
  if (matches.length !== 1 || !bounded(matches[0])) fail(`Source schema generation contract is missing, duplicated or dynamic (${name})`);
  return matches[0];
}

function tsSource(text, fileName) {
  if (typeof text !== "string") fail("Source contract is unreadable");
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (source.parseDiagnostics.length) fail(`Source contract cannot be parsed (${fileName})`);
  return source;
}

function sameStringSet(left, right) {
  return Array.isArray(right) && left.length === right.length &&
    new Set(left).size === left.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function sameJson(left, right) {
  const canonical = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
  };
  return canonical(left) === canonical(right);
}
