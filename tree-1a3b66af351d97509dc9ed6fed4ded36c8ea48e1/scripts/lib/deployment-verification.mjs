import { TextDecoder } from "node:util";
import { validateAccessRuntimeConfiguration } from "./access-runtime-config.mjs";

const MAX_SMOKE_BYTES = 64 * 1024;
const MAX_API_BYTES = 1024 * 1024;
const TIMEOUT_MS = 15_000;
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

export function validateDeploymentInput(env) {
  for (const key of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "ELIOTR_OWNER_EMAILS"]) {
    if (typeof env[key] !== "string" || !env[key].trim()) fail(`Missing ${key}`);
  }
  if (!boundedString(env.CLOUDFLARE_API_TOKEN, 4096)) fail("Invalid Cloudflare API token");
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
  const api = new URL(env.CLOUDFLARE_API_BASE_URL ?? "https://api.cloudflare.com/client/v4");
  const official = api.protocol === "https:" && api.hostname === "api.cloudflare.com" && api.port === "";
  const fixture = api.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(api.hostname);
  if ((!official && !fixture) || api.username || api.password || api.search || api.hash ||
      !["/client/v4", "/client/v4/"].includes(api.pathname)) fail("Invalid Cloudflare API origin");
  return { origin, cookie: cookie || null, apiBase: api.href.replace(/\/$/u, ""),
    access: validateAccessRuntimeConfiguration(env) };
}

export function validateGeneratedDeployment(bytes, env, input) {
  let config;
  try { config = JSON.parse(bytes.toString("utf8")); } catch { fail("Invalid generated deployment JSON"); }
  if (!isObject(config) || config.name !== "eliotr-core" || config.minify !== true ||
      config.keep_vars === true || config.preview_urls !== false ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(config.compatibility_date ?? "") ||
      config.vars?.DEPLOYMENT_GENERATION !== env.ELIOTR_DEPLOYMENT_GENERATION ||
      config.vars?.ENVIRONMENT !== env.ELIOTR_ENVIRONMENT ||
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
  if (!input.cookie) return { state: "NOT_EXECUTED", reason: "ELIOTR_ACCESS_SMOKE_COOKIE is not set; authenticated HTTP smoke was not executed." };
  const generation = env.ELIOTR_DEPLOYMENT_GENERATION;
  const headers = { Cookie: `CF_Authorization=${input.cookie}`, Accept: "application/json" };
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
  // This is a bounded inventory/export observation, not a proof of every binding or product path.
  const url = `${input.apiBase}/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/workers/scripts`;
  const { data } = await readDeploymentJson(url, { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
    { ...options, maxBytes: MAX_API_BYTES });
  if (!isObject(data) || data.success !== true || !Array.isArray(data.result)) fail("Invalid Worker inventory readback");
  const matches = data.result.filter((worker) => worker?.id === config.name);
  if (matches.length !== 1) fail("Ambiguous or absent Worker readback");
  const worker = matches[0];
  if (worker.compatibility_date !== config.compatibility_date || worker.has_assets !== true ||
      worker.exports?.ResearchSession?.type !== "durable-object") fail("Worker compatibility, assets or export drift");
  return { id: worker.id, compatibility_date: worker.compatibility_date,
    modified_on: worker.modified_on ?? null, last_deployed_from: worker.last_deployed_from ?? null,
    has_assets: worker.has_assets, durable_object_export: worker.exports.ResearchSession.type };
}
