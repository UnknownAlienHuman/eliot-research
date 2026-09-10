// Usage transport classification: which factory inputs are live transport.
// Brand (production authority) is granted ONLY when a provider product uses
// the internal default live transport — default endpoint builders below plus
// the default global fetch plus the default frozen-empty metric map. ANY
// caller-supplied endpoint/fetch/transport/metricMap/test seam (detected by
// explicit key presence in the factory options object, never by value) marks
// the product test-only: fully functional for deterministic tests, but
// carrying no brand, so the collector can never grant it production
// authority. Factory construction alone is never sufficient for trust; brand
// lives in module-private WeakMaps, test-only marks in the WeakSet below, so
// plain objects, copies, spreads, and Proxies of either class stay untrusted.

// lives in module-private identity arrays, so plain objects, copies,
// spreads, and Proxies of either class stay untrusted. FIX14: identity
// arrays with explicit === scans (no WeakSet/WeakMap, no
// Object.prototype.hasOwnProperty, no Array.prototype.filter) so
// before-import Map/Set/Object prototype poisoning cannot forge trust and
// capturing a poisoned intrinsic is never needed.

export const LIVE_API_BASE = "https://api.cloudflare.com/client/v4";

// Option keys that select transport or mapping. group/covers/perPage stay
// functional parameters: they declare scope, never transport authenticity.
// expectedWindow pins the query window; it is recorded with the rest because
// a pinned window plus injected fetch is a complete test seam.
export const TRANSPORT_OPTION_KEYS = Object.freeze([
  "endpoint",
  "fetchImpl",
  "metricMap",
  "billableMetricMap",
  "expectedWindow",
  "apiBase",
]);

// Names the caller-supplied transport/map keys on a factory options object.
// Explicitly passing even the default value (for example fetchImpl: fetch)
// still counts as caller-supplied: only omission selects live transport.
// FIX14: own-enumeration (Object.keys is own-only, so inherited pollution
// never counts) plus explicit === scans — never hasOwnProperty, never
// filter/includes.
export function callerSuppliedTransportKeys(options = {}) {
  if (options === null || typeof options !== "object") return [];
  const ownKeys = Object.keys(options);
  const out = [];
  for (let i = 0; i < TRANSPORT_OPTION_KEYS.length; i += 1) {
    const key = TRANSPORT_OPTION_KEYS[i];
    for (let j = 0; j < ownKeys.length; j += 1) {
      if (ownKeys[j] === key) { out[out.length] = key; break; }
    }
  }
  return out;
}

// Module-PRIVATE test-transport registry: product object -> test-only mark.
// Never exported; populated only by the genuine factories when ANY transport
// key above was caller-supplied. Identity-based like the brand registries, so
// a forged plain object with a `testOnly` string field gains nothing and a
// copy/spread/Proxy of a test-only product does not inherit the mark.
const TEST_TRANSPORT_PRODUCTS = [];

export function markTestTransport(product) {
  TEST_TRANSPORT_PRODUCTS[TEST_TRANSPORT_PRODUCTS.length] = product;
  return product;
}

// Read-only predicate: the sole test-only query the collector may use. Brand
// predicates remain the sole authority queries; this one only selects the
// explicitly test-only non-authoritative admission path.
export function isTestTransportProvider(provider) {
  if (provider === null || (typeof provider !== "object" && typeof provider !== "function")) return false;
  for (let i = 0; i < TEST_TRANSPORT_PRODUCTS.length; i += 1) {
    if (TEST_TRANSPORT_PRODUCTS[i] === provider) return true;
  }
  return false;
}

// Default live endpoint builders. These construct the exact production URLs
// from the collect-time accountId (never a construction-time capture), so the
// live registry needs no transport overrides to stay branded.
// FIX14: null-prototype service table with === lookup (no inherited keys).
const PAGINATED_SERVICE_TABLE = (() => {
  const table = Object.create(null);
  table["d1-inventory-list"] = "d1/database";
  table["queue-inventory-list"] = "queues";
  return Object.freeze(table);
})();

export function defaultPaginatedEndpoint(group, apiBase = LIVE_API_BASE) {
  if (typeof group !== "string" || typeof apiBase !== "string") return null;
  if (group !== "d1-inventory-list" && group !== "queue-inventory-list") return null;
  const service = PAGINATED_SERVICE_TABLE[group];
  if (typeof service !== "string") return null;
  return (accountId, page, perPage) =>
    `${apiBase}/accounts/${accountId}/${service}?page=${page}&per_page=${perPage}`;
}

export function defaultAiSearchEndpoint(apiBase = LIVE_API_BASE) {
  if (typeof apiBase !== "string") return null;
  return (accountId, page, perPage) =>
    `${apiBase}/accounts/${accountId}/ai-search/instances?page=${page}&per_page=${perPage}`;
}

export function defaultR2CursorEndpoint(apiBase = LIVE_API_BASE) {
  if (typeof apiBase !== "string") return null;
  return (accountId, cursor) =>
    cursor
      ? `${apiBase}/accounts/${accountId}/r2/buckets?cursor=${encodeURIComponent(cursor)}`
      : `${apiBase}/accounts/${accountId}/r2/buckets`;
}

export function defaultBillingEndpoint(apiBase = LIVE_API_BASE) {
  if (typeof apiBase !== "string") return null;
  return (accountId, from, to) =>
    `${apiBase}/accounts/${accountId}/billable/usage?from=${from}&to=${to}`;
}
