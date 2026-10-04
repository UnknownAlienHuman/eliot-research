import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOGIN_INSTRUCTION,
  loadWranglerOAuthCredential,
  resolveAuthMode,
  scrubTokenEnv,
  verifyWranglerOAuthAccount,
  WRANGLER_OAUTH_MODE,
} from "./cloudflare-wrangler-oauth.mjs";

export const AI_SEARCH_PREBILLING_CUTOFF_MS = Date.parse("2026-10-31T00:00:00.000Z");

const PROTOCOL = "eliotr.ai-search-prebilling-metadata-capability.v1";
const API_BASE = "https://api.cloudflare.com/client/v4";
const NAMESPACE_DESCRIPTION = "Eliot Research private managed retrieval namespace";
const MANIFEST_GENERATION = "g2-qwen3-2026-09-03";
const MANAGED_INSTANCE_IDS = Object.freeze([
  "private-prose-g2",
  "private-literal-g2",
  "wiki-g2",
  "artifact-g2",
  "web-capture-g2",
]);
const PAGE_SIZE = 100;
const PAGE_LIMIT = 50;
const NAMESPACE_LIMIT = 100;
const INSTANCE_LIMIT = 100;
const FORBIDDEN_CREATE_FIELDS = new Set([
  "source", "sources", "items", "item", "itemcount", "r2bucket", "r2bucketname",
  "sourceurl", "importurl", "crawlurl", "sitemapurl", "documentsurl", "documenturl",
  "import", "crawl", "sitemap", "upload", "ingestion", "document", "documents",
]);
const MAX_CLOCK_SKEW_MS = 2 * 60_000;
const MAX_INVENTORY_AGE_MS = 2 * 60_000;
const CAPABILITY_TTL_MS = 30_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifestUrl = new URL("../../infra/ai-search/instances.json", import.meta.url);

// Capabilities have no public constructor and their records never leave this
// module. The WeakSet is the write authorization identity; the WeakMap binds
// that identity to the native OAuth/inventory proof and one-use request set.
const issuedCapabilities = new WeakSet();
const capabilityRecords = new WeakMap();
const weakSetAdd = WeakSet.prototype.add.bind(issuedCapabilities);
const weakSetHas = WeakSet.prototype.has.bind(issuedCapabilities);
const weakMapSet = WeakMap.prototype.set.bind(capabilityRecords);
const weakMapGet = WeakMap.prototype.get.bind(capabilityRecords);
const setDelete = Function.call.bind(Set.prototype.delete);
const monotonicNow = process.hrtime.bigint.bind(process.hrtime);
const nativeFetch = globalThis.fetch?.bind(globalThis);

function fail(message) {
  const error = new Error(`AI Search prebilling metadata admission denied: ${message}`);
  error.code = "AI_SEARCH_PREBILLING_ADMISSION_DENIED";
  throw error;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("AI Search prebilling metadata admission denied: request contains a non-JSON value");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceBytes(source) {
  if (Buffer.isBuffer(source)) return source;
  if (typeof source === "string") return Buffer.from(source, "utf8");
  fail("manifest source must be exact UTF-8 bytes");
}

function hashJson(value) {
  return sha256(canonicalJson(value));
}

function hasForbiddenSourceField(value) {
  if (Array.isArray(value)) return value.some(hasForbiddenSourceField);
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, child]) => {
    const normalized = key.toLowerCase().replace(/[_-]/gu, "");
    return FORBIDDEN_CREATE_FIELDS.has(normalized) || normalized.includes("source") ||
      normalized.startsWith("item") || normalized.startsWith("r2bucket") || hasForbiddenSourceField(child);
  });
}

function validateManifest(manifest) {
  if (!isObject(manifest) || manifest.protocol !== "eliotr.ai-search-generation.v1" ||
      manifest.namespace !== "eliotr" || manifest.generation !== MANIFEST_GENERATION ||
      !Array.isArray(manifest.instances) || manifest.instances.length !== 5) {
    fail("only the fixed five-instance eliotr manifest is eligible");
  }
  const ids = new Set();
  for (const spec of manifest.instances) {
    if (!isObject(spec) || typeof spec.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(spec.id) ||
        ids.has(spec.id) || !isObject(spec.create) || spec.create.id !== spec.id ||
        hasForbiddenSourceField(spec.create)) {
      fail("manifest instance bodies must be unique, exact, and empty of source/item ingestion fields");
    }
    ids.add(spec.id);
  }
  if (MANAGED_INSTANCE_IDS.some((id) => !ids.has(id))) {
    fail("manifest instance identities differ from the approved metadata set");
  }
}

function validateAccountId(accountId) {
  if (typeof accountId !== "string" || !/^[a-f0-9]{32}$/iu.test(accountId)) {
    fail("verified Cloudflare account id is malformed");
  }
}

function validateRows(rows, identityFields, label) {
  if (!Array.isArray(rows)) fail(`${label} inventory is not an array`);
  const seen = new Map(identityFields.map((field) => [field, new Set()]));
  for (const row of rows) {
    if (!isObject(row)) fail(`${label} inventory contains a malformed row`);
    for (const field of identityFields) {
      const value = row[field];
      if (typeof value !== "string" || value.length === 0 || value.length > 256 || seen.get(field).has(value)) {
        fail(`${label} inventory has a missing or duplicate ${field}`);
      }
      seen.get(field).add(value);
    }
  }
}

/**
 * Require a complete, ordered, stable Cloudflare result_info page walk.
 * This helper is pure and cannot issue a production capability.
 */
export function validateCompleteAiSearchListPages(pages, {
  perPage = PAGE_SIZE,
  identityFields = ["id"],
  label = "AI Search",
} = {}) {
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > PAGE_LIMIT ||
      !Number.isInteger(perPage) || perPage < 1 || perPage > PAGE_SIZE) {
    fail(`${label} inventory pagination is absent or exceeds its bound`);
  }
  let expectedRows;
  let expectedPages;
  let reportedPages;
  const rows = [];
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const info = page?.result_info;
    if (!isObject(page) || page.success !== true || !Array.isArray(page.result) || !isObject(info)) {
      fail(`${label} inventory page ${index + 1} is malformed`);
    }
    const pageNumber = index + 1;
    if (info.page !== pageNumber || info.per_page !== perPage || info.count !== page.result.length ||
        !Number.isInteger(info.total_count) || info.total_count < 0 ||
        (Object.hasOwn(info, "total_pages") &&
          (!Number.isInteger(info.total_pages) || info.total_pages < 0))) {
      fail(`${label} inventory page ${pageNumber} has incomplete or contradictory pagination metadata`);
    }
    if (index === 0) {
      expectedRows = info.total_count;
      // Cloudflare's current OpenAPI response exposes count/page/per_page/
      // total_count; total_pages is not present. Derive the full page walk
      // from total_count, while still checking it if a future response adds it.
      reportedPages = Object.hasOwn(info, "total_pages");
      expectedPages = Math.ceil(expectedRows / perPage);
      if (reportedPages && info.total_pages !== expectedPages) {
        fail(`${label} inventory page count contradicts total_count`);
      }
    } else if (info.total_count !== expectedRows ||
        Object.hasOwn(info, "total_pages") !== reportedPages ||
        (reportedPages && info.total_pages !== expectedPages)) {
      fail(`${label} inventory pagination changed while pages were read`);
    }
    const pagesToRead = Math.max(1, expectedPages);
    if (pageNumber > pagesToRead) {
      fail(`${label} inventory contains an unexpected page`);
    }
    const expectedPageRows = Math.min(perPage, Math.max(0, expectedRows - perPage * (pageNumber - 1)));
    if (page.result.length !== expectedPageRows) {
      fail(`${label} inventory page ${pageNumber} has a short or oversized result page`);
    }
    rows.push(...page.result);
  }
  if (pages.length !== Math.max(1, expectedPages) || rows.length !== expectedRows) {
    fail(`${label} inventory is partial`);
  }
  validateRows(rows, identityFields, label);
  return rows;
}

/**
 * Validate native Date-header observations and calculate a short expiry.
 * Tests may exercise this pure policy with fixed values; it never mints a cap.
 */
export function evaluateAiSearchPrebillingClock({
  localNowMs,
  observations,
  cutoffMs = AI_SEARCH_PREBILLING_CUTOFF_MS,
}) {
  if (!Number.isSafeInteger(localNowMs) || !Number.isSafeInteger(cutoffMs) || localNowMs >= cutoffMs ||
      !Array.isArray(observations) || observations.length === 0) {
    fail("trusted prebilling date evidence is missing or expired");
  }
  let oldestServerMs = Number.POSITIVE_INFINITY;
  let newestServerMs = Number.NEGATIVE_INFINITY;
  let oldestObservedLocalMs = Number.POSITIVE_INFINITY;
  let newestObservedLocalMs = Number.NEGATIVE_INFINITY;
  for (const observation of observations) {
    const { serverDateMs, observedLocalMs } = observation ?? {};
    if (!Number.isSafeInteger(serverDateMs) || !Number.isSafeInteger(observedLocalMs) ||
        Math.abs(observedLocalMs - serverDateMs) > MAX_CLOCK_SKEW_MS ||
        observedLocalMs > localNowMs || localNowMs - observedLocalMs > MAX_INVENTORY_AGE_MS) {
      fail("Cloudflare Date header is missing, stale, or outside the local clock-skew bound");
    }
    oldestServerMs = Math.min(oldestServerMs, serverDateMs);
    newestServerMs = Math.max(newestServerMs, serverDateMs);
    oldestObservedLocalMs = Math.min(oldestObservedLocalMs, observedLocalMs);
    newestObservedLocalMs = Math.max(newestObservedLocalMs, observedLocalMs);
  }
  if (newestServerMs - oldestServerMs > MAX_INVENTORY_AGE_MS ||
      localNowMs - oldestObservedLocalMs > MAX_INVENTORY_AGE_MS ||
      localNowMs - newestObservedLocalMs > MAX_INVENTORY_AGE_MS) {
    fail("complete inventory exceeded its freshness window");
  }
  if (newestServerMs >= cutoffMs) fail("Cloudflare server date is at or beyond the prebilling cutoff");
  const expiresAtMs = Math.min(localNowMs + CAPABILITY_TTL_MS, newestServerMs + CAPABILITY_TTL_MS, cutoffMs);
  if (expiresAtMs <= localNowMs) fail("prebilling metadata capability would already be expired");
  return expiresAtMs;
}

function requestKey(accountId, method, path, body) {
  return JSON.stringify([accountId, method, path, hashJson(body)]);
}

/**
 * Pure one-use allowance consumer shared with the production identity check.
 * The Set passed in production is private in a WeakMap; callers cannot mint a
 * capability by constructing a Set or by importing this helper.
 */
export function consumeBoundPrebillingAllowance(remaining, expectedAccountId, request) {
  if (!(remaining instanceof Set) || !isObject(request) || request.method !== "POST" ||
      request.accountId !== expectedAccountId || typeof request.path !== "string" ||
      !setDelete(remaining, requestKey(expectedAccountId, request.method, request.path, request.body))) {
    fail("write does not match one remaining exact metadata POST allowance");
  }
  return true;
}

/** Build exact allowed metadata POSTs from a fixed manifest and full inventory. */
export function planAiSearchPrebillingMetadataPosts({ accountId, manifest, manifestSource, namespaceRows, instancesByNamespace }) {
  validateAccountId(accountId);
  validateManifest(manifest);
  if (!(instancesByNamespace instanceof Map)) fail("complete nested namespace inventory is required");
  // The current namespace API identifies rows by unique name; it does not
  // return an id field.
  validateRows(namespaceRows, ["name"], "namespace");
  if (namespaceRows.length > NAMESPACE_LIMIT || instancesByNamespace.size !== namespaceRows.length) {
    fail("complete account inventory exceeds the free metadata limit or is partial");
  }
  let totalInstances = 0;
  for (const namespace of namespaceRows) {
    const rows = instancesByNamespace.get(namespace.name);
    validateRows(rows, ["id"], `namespace ${namespace.name} instance`);
    totalInstances += rows.length;
  }
  for (const name of instancesByNamespace.keys()) {
    if (!namespaceRows.some((namespace) => namespace.name === name)) fail("instance inventory contains an unknown namespace");
  }
  if (totalInstances > INSTANCE_LIMIT) fail("complete account inventory exceeds the free instance limit");

  const enc = encodeURIComponent;
  const namespacePath = `/accounts/${enc(accountId)}/ai-search/namespaces/${enc(manifest.namespace)}`;
  const namespaceCollectionPath = `/accounts/${enc(accountId)}/ai-search/namespaces`;
  const existingNamespace = namespaceRows.find((row) => row.name === manifest.namespace);
  const existingIds = new Set((existingNamespace ? instancesByNamespace.get(manifest.namespace) : []).map((row) => row.id));
  const missingSpecs = manifest.instances.filter((spec) => !existingIds.has(spec.id));
  if (!existingNamespace && namespaceRows.length + 1 > NAMESPACE_LIMIT) fail("namespace metadata limit would be exceeded");
  if (totalInstances + missingSpecs.length > INSTANCE_LIMIT) fail("instance metadata limit would be exceeded");

  const posts = [];
  if (!existingNamespace) {
    const body = { name: manifest.namespace, description: NAMESPACE_DESCRIPTION };
    posts.push({ method: "POST", path: namespaceCollectionPath, body,
      key: requestKey(accountId, "POST", namespaceCollectionPath, body) });
  }
  for (const spec of missingSpecs) {
    const body = spec.create;
    const path = `${namespacePath}/instances`;
    posts.push({ method: "POST", path, body,
      key: requestKey(accountId, "POST", path, body) });
  }
  return {
    protocol: PROTOCOL,
    manifestDigest: sha256(sourceBytes(manifestSource)),
    accountId,
    posts,
    inventoryDigest: sha256(canonicalJson({
      namespaces: namespaceRows.map(({ name }) => ({ name })).sort((a, b) => a.name.localeCompare(b.name)),
      instances: [...instancesByNamespace.entries()].map(([name, rows]) => ({
        namespace: name,
        ids: rows.map((row) => row.id).sort(),
      })).sort((a, b) => a.namespace.localeCompare(b.namespace)),
    })),
  };
}

function parseHttpDate(value) {
  if (typeof value !== "string" || !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(value)) {
    fail("Cloudflare response omitted a trusted HTTP Date header");
  }
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || new Date(parsed).toUTCString() !== value) {
    fail("Cloudflare response Date header could not be parsed exactly");
  }
  return parsed;
}

async function readCompleteList(path, bearer, observations, label) {
  const pages = [];
  let pageCount = null;
  for (let pageNumber = 1; pageCount === null || pageNumber <= pageCount; pageNumber += 1) {
    if (pageNumber > PAGE_LIMIT) fail(`${label} pagination exceeded its hard page bound`);
    const url = new URL(`${API_BASE}${path}`);
    url.searchParams.set("page", String(pageNumber));
    url.searchParams.set("per_page", String(PAGE_SIZE));
    let response;
    try {
      response = await nativeFetch(url, { method: "GET", headers: { authorization: `Bearer ${bearer}` } });
    } catch {
      fail(`${label} inventory read failed before capability issuance`);
    }
    const observedLocalMs = Date.now();
    const serverDateMs = parseHttpDate(response?.headers?.get?.("date"));
    observations.push({ serverDateMs, observedLocalMs });
    let payload;
    try {
      payload = await response.json();
    } catch {
      fail(`${label} inventory response was not valid JSON`);
    }
    if (!response.ok || !isObject(payload) || payload.success !== true || !Array.isArray(payload.result) ||
        !isObject(payload.result_info)) {
      fail(`${label} inventory read failed or returned a partial response`);
    }
    const info = payload.result_info;
    const total = info.total_count;
    const derivedPages = Number.isInteger(total) && total >= 0 ? Math.ceil(total / PAGE_SIZE) : -1;
    if (!Number.isInteger(total) || total < 0 || total > NAMESPACE_LIMIT ||
        info.page !== pageNumber || info.per_page !== PAGE_SIZE || info.count !== payload.result.length ||
        (Object.hasOwn(info, "total_pages") && info.total_pages !== derivedPages)) {
      fail(`${label} inventory pagination is malformed or exceeds the free metadata limit`);
    }
    pageCount ??= Math.max(1, derivedPages);
    pages.push(payload);
  }
  return validateCompleteAiSearchListPages(pages, {
    perPage: PAGE_SIZE,
    identityFields: label === "namespace" ? ["name"] : ["id"],
    label,
  });
}

function nativeOAuthEnvironment() {
  const env = process.env;
  if (Object.keys(env).some((key) => key.startsWith("ELIOTR_TEST_") || key.startsWith("ELIOTR_USAGE_"))) {
    fail("test or usage-admission override variables are forbidden for native prebilling issuance");
  }
  if (["ELIOTR_WRANGLER_CONFIG_FILE", "WRANGLER_CONFIG_FILE", "WRANGLER_HOME", "XDG_CONFIG_HOME"].some((key) => env[key])) {
    fail("custom OAuth config-path overrides are forbidden for native prebilling issuance");
  }
  if (env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_KEY || env.CLOUDFLARE_TOKEN) {
    fail("prebilling metadata requires the verified Wrangler OAuth profile, not an injected API token");
  }
  if (resolveAuthMode(env) !== WRANGLER_OAUTH_MODE) {
    fail("prebilling metadata requires ELIOTR_CLOUDFLARE_AUTH_MODE=wrangler-oauth");
  }
  if (env.CLOUDFLARE_API_BASE_URL !== undefined && env.CLOUDFLARE_API_BASE_URL !== API_BASE) {
    fail("prebilling metadata must use the official Cloudflare API origin");
  }
  validateAccountId(env.CLOUDFLARE_ACCOUNT_ID);

  const credentialEnv = { ...env };
  for (const key of ["ELIOTR_WRANGLER_CONFIG_FILE", "WRANGLER_CONFIG_FILE", "WRANGLER_HOME", "XDG_CONFIG_HOME"]) {
    delete credentialEnv[key];
  }
  return { env: credentialEnv, accountId: env.CLOUDFLARE_ACCOUNT_ID };
}

async function verifyNativeOAuthAccount(env, accountId) {
  // whoami uses Wrangler's official OAuth profile and may refresh its token.
  // Load the bearer only after account verification has allowed that refresh.
  const result = spawnSync("pnpm", ["exec", "wrangler", "whoami"], {
    cwd: repositoryRoot,
    env: scrubTokenEnv(env),
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.error || result.status !== 0) {
    fail(`official Wrangler whoami verification failed. ${LOGIN_INSTRUCTION}`);
  }
  await verifyWranglerOAuthAccount({
    expectedAccountId: accountId,
    getWhoamiOutput: async () => result.stdout ?? "",
  });
  return loadWranglerOAuthCredential({ env, now: Date.now() });
}

async function collectNativeInventory(accountId, bearer) {
  const observations = [];
  const namespaces = await readCompleteList(
    `/accounts/${encodeURIComponent(accountId)}/ai-search/namespaces`, bearer, observations, "namespace",
  );
  if (namespaces.length > NAMESPACE_LIMIT) fail("namespace inventory exceeds the free metadata limit");
  const instancesByNamespace = new Map();
  for (const namespace of namespaces) {
    const path = `/accounts/${encodeURIComponent(accountId)}/ai-search/namespaces/${encodeURIComponent(namespace.name)}/instances`;
    const instances = await readCompleteList(path, bearer, observations, `namespace ${namespace.name} instance`);
    instancesByNamespace.set(namespace.name, instances);
  }
  return { namespaces, instancesByNamespace, observations };
}

/** Native-only, zero-argument issuer. It cannot accept test transports, time, identity, or inventory. */
export async function issueAiSearchPrebillingMetadataCapability() {
  if (typeof nativeFetch !== "function") fail("native fetch is unavailable");
  const { env, accountId } = nativeOAuthEnvironment();
  const credential = await verifyNativeOAuthAccount(env, accountId);
  const manifestSource = await readFile(manifestUrl);
  let manifest;
  try {
    manifest = JSON.parse(manifestSource.toString("utf8"));
  } catch {
    fail("fixed AI Search manifest is malformed");
  }
  validateManifest(manifest);
  const inventory = await collectNativeInventory(accountId, credential.bearer);
  const localNowMs = Date.now();
  const expiresAtMs = Math.min(
    evaluateAiSearchPrebillingClock({ localNowMs, observations: inventory.observations }),
    credential.expiresAtMs,
  );
  if (expiresAtMs <= Date.now()) fail("OAuth credential expires before a metadata write can be attempted");
  const plan = planAiSearchPrebillingMetadataPosts({
    accountId,
    manifest,
    manifestSource,
    namespaceRows: inventory.namespaces,
    instancesByNamespace: inventory.instancesByNamespace,
  });
  const mintLocalNowMs = Date.now();
  if (expiresAtMs <= mintLocalNowMs) fail("OAuth credential expires before a metadata write can be attempted");
  const capability = Object.freeze(Object.create(null));
  weakSetAdd(capability);
  weakMapSet(capability, {
    protocol: PROTOCOL,
    accountId,
    oauthAccountId: accountId,
    manifestDigest: plan.manifestDigest,
    inventoryDigest: plan.inventoryDigest,
    inventoryComplete: true,
    inventoryNamespaceCount: inventory.namespaces.length,
    inventoryInstanceCount: [...inventory.instancesByNamespace.values()].reduce((sum, rows) => sum + rows.length, 0),
    inventoryPageReads: inventory.observations.length,
    inventoryObservedAtMs: Math.max(...inventory.observations.map(({ observedLocalMs }) => observedLocalMs)),
    dateEvidenceDigest: sha256(canonicalJson(inventory.observations)),
    oauthVerified: true,
    issuedAtMs: mintLocalNowMs,
    expiresAtMs,
    monotonicExpiresAtNs: monotonicNow() + BigInt(expiresAtMs - mintLocalNowMs) * 1_000_000n,
    remaining: new Set(plan.posts.map((post) => post.key)),
  });
  return capability;
}

export function assertAiSearchPrebillingManifest(capability, manifestSource) {
  if (!weakSetHas(capability)) fail("caller supplied a forged or foreign capability");
  const record = weakMapGet(capability);
  if (!record || record.protocol !== PROTOCOL || record.oauthAccountId !== record.accountId ||
      record.inventoryComplete !== true || record.inventoryPageReads < 1 ||
      record.expiresAtMs <= Date.now() ||
      monotonicNow() >= record.monotonicExpiresAtNs ||
      sha256(sourceBytes(manifestSource)) !== record.manifestDigest) {
    fail("capability is expired or bound to a different manifest source");
  }
  return true;
}

export function consumeAiSearchPrebillingMetadataPost(capability, request) {
  if (!weakSetHas(capability)) fail("caller supplied a forged or foreign capability");
  const record = weakMapGet(capability);
  if (!record || record.protocol !== PROTOCOL || record.oauthVerified !== true ||
      record.oauthAccountId !== record.accountId || record.inventoryComplete !== true ||
      record.inventoryPageReads < 1 ||
      record.expiresAtMs <= Date.now() || monotonicNow() >= record.monotonicExpiresAtNs) {
    fail("capability is expired or lacks native OAuth and inventory authority");
  }
  consumeBoundPrebillingAllowance(record.remaining, record.accountId, request);
  return true;
}
