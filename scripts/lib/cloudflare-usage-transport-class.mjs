// Transport classification: only a factory with omitted transport overrides
// is eligible for the default live-provider composition. Test seams remain
// explicitly marked and cannot produce a live brand. Process isolation is
// the boundary against hostile same-process code.

export const LIVE_API_BASE = "https://api.cloudflare.com/client/v4";

// Option keys that select transport or mapping. group/covers/perPage stay
// functional parameters: they declare scope, never transport authenticity.
// expectedWindow pins the query window; it is recorded with the rest because
// a pinned window plus injected fetch is a complete test seam.
export const TRANSPORT_OPTION_KEYS = Object.freeze([
  "endpoint",
  "listEndpoint",
  "detailEndpoint",
  "fetchImpl",
  "metricMap",
  "billableMetricMap",
  "expectedWindow",
  "apiBase",
]);

// Names the caller-supplied transport/map keys on a factory options object.
// Explicitly passing even the default value (for example fetchImpl: fetch)
// still counts as caller-supplied: only omission selects live transport.
// Only explicitly present own option keys select the test-only path.
export function callerSuppliedTransportKeys(options = {}) {
  if (options === null || typeof options !== "object") return [];
  const ownKeys = new Set(Object.keys(options));
  return TRANSPORT_OPTION_KEYS.filter((key) => ownKeys.has(key));
}

// Module-private identity set for test-only products. Process isolation is
// the trust boundary; caller fields cannot assert membership.
const TEST_TRANSPORT_PRODUCTS = new WeakSet();

export function markTestTransport(product) {
  TEST_TRANSPORT_PRODUCTS.add(product);
  return product;
}

// Read-only predicate: the sole test-only query the collector may use. Brand
// predicates remain the sole authority queries; this one only selects the
// explicitly test-only non-authoritative admission path.
export function isTestTransportProvider(provider) {
  if (provider === null || (typeof provider !== "object" && typeof provider !== "function")) return false;
  return TEST_TRANSPORT_PRODUCTS.has(provider);
}

// Default live endpoint builders. These construct the exact production URLs
// from the collect-time accountId (never a construction-time capture), so the
// live registry needs no transport overrides to stay branded.
const PAGINATED_SERVICE_TABLE = new Map([
  ["d1-inventory-list", "d1/database"],
  ["queue-inventory-list", "queues"],
]);

export function defaultPaginatedEndpoint(group, apiBase = LIVE_API_BASE) {
  if (typeof group !== "string" || typeof apiBase !== "string") return null;
  if (group !== "d1-inventory-list" && group !== "queue-inventory-list") return null;
  const service = PAGINATED_SERVICE_TABLE.get(group);
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

export function defaultD1DetailsEndpoint(apiBase = LIVE_API_BASE) {
  if (typeof apiBase !== "string") return null;
  return (accountId, databaseId) =>
    `${apiBase}/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}?fields=uuid,file_size`;
}

export function defaultBillingEndpoint(apiBase = LIVE_API_BASE) {
  if (typeof apiBase !== "string") return null;
  return (accountId, from, to) =>
    `${apiBase}/accounts/${accountId}/billable/usage?from=${from}&to=${to}`;
}
