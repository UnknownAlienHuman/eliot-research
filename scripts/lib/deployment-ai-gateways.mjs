import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { createCloudflareMcpTransport } from "./cloudflare-mcp-oauth.mjs";
import { resolveAuthMode, scrubTokenEnv, WRANGLER_OAUTH_MODE } from "./cloudflare-wrangler-oauth.mjs";

const PROTOCOL = "eliotr.maintenance-ai-gateway-profile.v1";
const INVENTORY_PATH = (accountId) => `/accounts/${encodeURIComponent(accountId)}/ai-gateway/gateways?per_page=100`;
const TARGET_IDS = Object.freeze({ reasoning: "eliotr-reasoning", retrieval: "eliotr-retrieval" });
const SETTINGS = Object.freeze(["id", "cache_invalidate_on_update", "cache_ttl", "collect_logs",
  "rate_limiting_interval", "rate_limiting_limit", "authentication"]);
const PROFILE_BRANDS = new WeakSet();
const STATIC_AUTH_KEYS = Object.freeze(["CF_API_TOKEN"]);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message) => { throw new Error(`Maintenance AI Gateway readback ${message}`); };

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function validateInputs({ env, input, activeWorkerIdentity } = {}) {
  if (!isRecord(env) || !isRecord(input) || typeof input.apiBase !== "string" ||
      typeof env.CLOUDFLARE_ACCOUNT_ID !== "string" || !/^[a-f0-9]{32}$/u.test(env.CLOUDFLARE_ACCOUNT_ID) ||
      resolveAuthMode(env) !== WRANGLER_OAUTH_MODE ||
      typeof env.ELIOTR_CLOUDFLARE_MCP_CWD !== "string" || !isAbsolute(env.ELIOTR_CLOUDFLARE_MCP_CWD.trim()) ||
      STATIC_AUTH_KEYS.some((key) => typeof env[key] === "string" && env[key].trim() !== "")) {
    fail("inputs require an account, managed Wrangler OAuth, token-scrubbed MCP CWD, and a valid deployment input");
  }
  let apiBase;
  try { apiBase = new URL(input.apiBase); } catch { fail("deployment API base is invalid"); }
  if (apiBase.protocol !== "https:" || apiBase.hostname !== "api.cloudflare.com" ||
      apiBase.pathname.replace(/\/$/u, "") !== "/client/v4" || apiBase.search !== "" || apiBase.hash !== "") {
    fail("deployment API base is outside the official Cloudflare API");
  }
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const urls = activeWorkerIdentity?.ai_gateway_urls;
  if (!isRecord(activeWorkerIdentity) || activeWorkerIdentity.worker_id !== "eliotr-core" ||
      !isRecord(urls) || Object.keys(urls).length !== 2 ||
      !Object.hasOwn(urls, "reasoning") || !Object.hasOwn(urls, "retrieval") ||
      urls.reasoning !== `https://gateway.ai.cloudflare.com/v1/${accountId}/${TARGET_IDS.reasoning}` ||
      urls.retrieval !== `https://gateway.ai.cloudflare.com/v1/${accountId}/${TARGET_IDS.retrieval}`) {
    fail("active Worker gateway URLs do not match the exact account and project targets");
  }
  return { accountId, urls };
}

function assertRetrievalDisabled(profile, label) {
  if (!isRecord(profile) || !Array.isArray(profile.disabled_slices) ||
      !Array.isArray(profile.enabled_slices) || !Array.isArray(profile.partial_slices) ||
      !profile.disabled_slices.includes("RETRIEVAL") || profile.enabled_slices.includes("RETRIEVAL") ||
      profile.partial_slices.includes("RETRIEVAL")) {
    fail(`${label} must keep RETRIEVAL disabled`);
  }
}

function normalizeGateway(gateway, id) {
  if (!isRecord(gateway) || gateway.id !== id ||
      typeof gateway.cache_invalidate_on_update !== "boolean" ||
      !Number.isSafeInteger(gateway.cache_ttl) || gateway.cache_ttl < 0 ||
      typeof gateway.collect_logs !== "boolean" ||
      !Number.isSafeInteger(gateway.rate_limiting_interval) || gateway.rate_limiting_interval < 0 ||
      !Number.isSafeInteger(gateway.rate_limiting_limit) || gateway.rate_limiting_limit < 0 ||
      typeof gateway.authentication !== "boolean") {
    fail(`gateway ${id} settings are malformed`);
  }
  return Object.fromEntries(SETTINGS.map((key) => [key, gateway[key]]));
}

function normalizeInventory(inventory) {
  if (!Array.isArray(inventory) || inventory.length > 10_000) fail("account gateway inventory is incomplete");
  const seen = new Set();
  const project = new Map();
  for (const item of inventory) {
    if (!isRecord(item) || typeof item.id !== "string" || item.id.length < 1 || item.id.length > 128 ||
        /[\u0000-\u001f\u007f]/u.test(item.id) || seen.has(item.id)) {
      fail("account gateway inventory has a malformed or repeated identity");
    }
    seen.add(item.id);
    if (item.id === TARGET_IDS.reasoning || item.id === TARGET_IDS.retrieval) {
      project.set(item.id, normalizeGateway(item, item.id));
    } else if (item.id.startsWith("eliotr-")) {
      fail("account inventory contains an unknown project gateway");
    }
  }
  const reasoning = project.get(TARGET_IDS.reasoning) ?? null;
  const retrieval = project.get(TARGET_IDS.retrieval) ?? null;
  if (reasoning === null || reasoning.authentication !== true) {
    fail("required reasoning gateway is absent or unauthenticated");
  }
  return { reasoning, retrieval };
}

async function readGatewayInventory({ env, accountId, createTransport }) {
  const childEnv = scrubTokenEnv(env);
  const transport = createTransport({ cwd: env.ELIOTR_CLOUDFLARE_MCP_CWD.trim(), accountId,
    env: childEnv, resourceReadback: "ai-gateways" });
  if (!isRecord(transport) || typeof transport.request !== "function" || typeof transport.close !== "function") {
    try { transport?.close?.(); } catch { /* best-effort close of malformed injected transport */ }
    fail("transport is unavailable");
  }
  try {
    const inventory = await transport.request("GET", INVENTORY_PATH(accountId));
    return normalizeInventory(inventory);
  } finally {
    transport.close();
  }
}

function profileMaterial(accountId, urls, gateways) {
  return {
    protocol: PROTOCOL,
    account_id: accountId,
    targets: { reasoning_url: urls.reasoning, retrieval_url: urls.retrieval },
    gateways,
  };
}

export async function captureMaintenanceAiGateways({ env, input, activeWorkerIdentity, candidate, observed,
  createTransport = createCloudflareMcpTransport } = {}) {
  const { accountId, urls } = validateInputs({ env, input, activeWorkerIdentity });
  assertRetrievalDisabled(candidate, "candidate");
  assertRetrievalDisabled(observed, "observed capability profile");
  const gateways = await readGatewayInventory({ env, accountId, createTransport });
  const material = profileMaterial(accountId, urls, gateways);
  const profile = deepFreeze({ state: "PINNED", ...material, profile_sha256: sha256(material) });
  PROFILE_BRANDS.add(profile);
  return profile;
}

export async function requireSameMaintenanceAiGateways({ profile, env, input, activeWorkerIdentity,
  createTransport = createCloudflareMcpTransport } = {}) {
  if (!isRecord(profile) || !PROFILE_BRANDS.has(profile) || profile.state !== "PINNED" ||
      profile.protocol !== PROTOCOL || typeof profile.profile_sha256 !== "string") {
    fail("baseline profile is not privately branded");
  }
  const { accountId, urls } = validateInputs({ env, input, activeWorkerIdentity });
  if (accountId !== profile.account_id || urls.reasoning !== profile.targets.reasoning_url ||
      urls.retrieval !== profile.targets.retrieval_url) {
    fail("account or active Worker gateway targets changed");
  }
  const gateways = await readGatewayInventory({ env, accountId, createTransport });
  const currentMaterial = profileMaterial(accountId, urls, gateways);
  if (sha256(currentMaterial) !== profile.profile_sha256 ||
      JSON.stringify(currentMaterial) !== JSON.stringify({ protocol: profile.protocol, account_id: profile.account_id,
        targets: profile.targets, gateways: profile.gateways })) {
    fail("gateway presence or settings changed after baseline capture");
  }
  return deepFreeze({ state: "PASS", protocol: PROTOCOL, account_id: accountId,
    profile_sha256: profile.profile_sha256, targets: { reasoning_url: urls.reasoning, retrieval_url: urls.retrieval },
    gateway_presence: { reasoning: "PRESENT", retrieval: gateways.retrieval === null ? "ABSENT" : "PRESENT" } });
}
