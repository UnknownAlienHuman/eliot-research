// Provider authority brands: non-caller-assertable construction capability.
//
// Authority derives ONLY from module-private brand registries, never from
// mutable string fields (group/kind/provenance) a caller can assert on a
// plain object. The inventory registry below is populated ONLY inside the
// branded factory closures AND only when the product runs on the internal
// default live transport (default endpoint builders plus the default global
// fetch, selected by omitting every transport key): any caller-supplied
// endpoint/fetch/transport/metricMap/test seam yields an unbranded,
// identity-marked test-only product instead, so factory construction alone —
// genuine or not — never confers production authority. No registrar, token,
// or symbol is exported, so callers cannot attach trust to a forged object.
// Factory products are frozen so post-construction collect-replacement cannot
// hijack a branded identity. Read-only predicates (isInventoryProvider /
// isAiSearchInventoryProvider / inventoryBrandClass) are the sole trust
// queries; isTestTransportProvider is the sole test-only query and never
// confers authority. The collector grants authority only on brand, and admits
// test-only products only on the explicitly marked non-authoritative path.
// The billing channel brand lives in cloudflare-usage-billable.mjs next to
// its factory for the same reason.
//
// This module also owns METRIC_SOURCE_REGISTRY (moved from
// cloudflare-usage-collection.mjs to keep that file under the 600-line
// budget; re-exported there so import paths keep working): the registry names
// which groups may report which inventory metrics.

import {
  METRIC_PROVENANCE,
  listCanonicalRequiredKeys,
} from "./cloudflare-usage-envelope.mjs";
import {
  UsageCollectionError,
  createAiSearchInventoryProvider as rawAiSearch,
  createPaginatedInventoryProvider as rawPaginated,
  createR2CursorInventoryProvider as rawR2Cursor,
} from "./cloudflare-usage-providers.mjs";
import {
  callerSuppliedTransportKeys,
  defaultAiSearchEndpoint,
  defaultPaginatedEndpoint,
  defaultR2CursorEndpoint,
  isTestTransportProvider,
  markTestTransport,
} from "./cloudflare-usage-transport-class.mjs";

export { isTestTransportProvider };

// Module-PRIVATE inventory brand registry: provider object -> brand class.
// Never exported; populated only by the branded factories below.
const INVENTORY_BRANDS = new WeakMap();

export const INVENTORY_BRAND_PAGINATED = "inventory-paginated";
export const INVENTORY_BRAND_CURSOR = "inventory-cursor";
export const INVENTORY_BRAND_AI_SEARCH = "inventory-ai-search";

function brandInventoryProvider(product, brand) {
  Object.freeze(product.covers);
  INVENTORY_BRANDS.set(product, brand);
  return Object.freeze(product);
}

// Branded wrappers delegate construction to the genuine transport factories,
// then brand and freeze the product inside this closure — but ONLY when the
// caller supplied no transport (no endpoint/fetchImpl/metricMap/
// expectedWindow/apiBase keys): the product then runs on the internal default
// live transport (default endpoint builders over LIVE_API_BASE plus the
// default global fetch). ANY caller-supplied transport key yields a fully
// functional but UNBRANDED test-only product (identity-marked in the
// module-private test-transport registry): factory construction alone never
// confers authority, and no caller-supplied endpoint/fetch/transport can
// produce production-authoritative evidence. group/covers/perPage stay
// functional scope parameters on both paths.
function liveOrTestInventory(rawFactory, options, brand, defaultEndpoint) {
  const supplied = callerSuppliedTransportKeys(options);
  if (supplied.length === 0 && typeof defaultEndpoint === "function") {
    return brandInventoryProvider(
      rawFactory({ ...options, endpoint: defaultEndpoint, fetchImpl: globalThis.fetch }),
      brand,
    );
  }
  const { apiBase: _ignored, ...rest } = options ?? {};
  void _ignored;
  const product = rawFactory(rest);
  Object.freeze(product.covers);
  return markTestTransport(Object.freeze(product));
}

export function createPaginatedInventoryProvider(options = {}) {
  return liveOrTestInventory(
    rawPaginated,
    options,
    INVENTORY_BRAND_PAGINATED,
    defaultPaginatedEndpoint(options?.group),
  );
}

export function createR2CursorInventoryProvider(options = {}) {
  return liveOrTestInventory(
    rawR2Cursor,
    options,
    INVENTORY_BRAND_CURSOR,
    defaultR2CursorEndpoint(),
  );
}

export function createAiSearchInventoryProvider(options = {}) {
  return liveOrTestInventory(
    rawAiSearch,
    options,
    INVENTORY_BRAND_AI_SEARCH,
    defaultAiSearchEndpoint(),
  );
}

// Read-only predicates: the only trust queries the collector may use.
export function isInventoryProvider(provider) {
  return INVENTORY_BRANDS.has(provider);
}

export function isAiSearchInventoryProvider(provider) {
  return INVENTORY_BRANDS.get(provider) === INVENTORY_BRAND_AI_SEARCH;
}

export function inventoryBrandClass(provider) {
  return INVENTORY_BRANDS.get(provider) ?? null;
}

// Explicit authoritative source set per required metric. Counters exposed by
// this transport have no stable account-wide aggregate: they stay unknown
// with provenance `unavailable` and an explicit limitation and require a
// controller-owned project ledger plus a fresh full inventory before any
// runtime lease opens. Inventory lists (paginated, account-wide, including
// unrelated consumption) are authoritative for existence/shape but never
// fabricate a zero usage counter. Provenance per metric is one of
// authoritative_billing | authoritative_inventory | analytics_nonbilling |
// ledger_estimate | unavailable (see cloudflare-usage-envelope.mjs).
// Account-wide coverage spans Workers, D1, R2, Queues, SQLite Durable
// Objects, Workers AI, AI Search, Vectorize, and Access without inventing
// counters: Workers AI neurons, Queue billable ops, R2 Class A/B, AI Search
// aggregate queries, and Vectorize queried dims stay unknown unless verified
// billing usage or a demonstrably complete account-bound ledger proves them.
export const METRIC_SOURCE_REGISTRY = (() => {
  const registry = {
  workers_requests: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  workers_cpu_ms: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  d1_storage_bytes: { sources: ["d1-inventory-list"], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "inventory proves existence, not byte totals; ledger+inventory required" },
  d1_rows_read: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  d1_rows_written: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  r2_storage_gb_month: { sources: ["r2-inventory-list"], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "inventory proves buckets, not GB-mo; ledger+inventory required" },
  r2_class_a_ops: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  r2_class_b_ops: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  queue_ops: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  do_requests: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  do_gb_seconds: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  do_sql_reads: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  do_sql_writes: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  do_storage_bytes: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  workers_ai_neurons_per_day: { sources: [], window: "daily", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  ai_search_instances: { sources: ["ai-search-inventory-list"], window: "point", authoritative: true, provenance: METRIC_PROVENANCE.AUTHORITATIVE_INVENTORY, limitation: "" },
  ai_search_queries_month: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  vectorize_queried_dims_month: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  vectorize_stored_dims_month: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  };
  for (const entry of Object.values(registry)) { Object.freeze(entry.sources); Object.freeze(entry); }
  return Object.freeze(registry);
})();

// Module-private canonical registry: independent frozen copy, so export
// mutation cannot change decisions even if a freeze were bypassed.
const CANONICAL_REGISTRY = Object.freeze(Object.fromEntries(Object.entries(METRIC_SOURCE_REGISTRY).map(([k, v]) => [k, Object.freeze({ ...v, sources: Object.freeze([...v.sources]) })])));
export function getRegistryEntry(k) { return CANONICAL_REGISTRY[k] ?? null; }
export function getRegistryLimitation(k) { return CANONICAL_REGISTRY[k]?.limitation ?? "unregistered"; }
export function assertLiveRegistryCoversAll(registry = CANONICAL_REGISTRY) {
  const required = listCanonicalRequiredKeys();
  if (required.length === 0) {
    throw new UsageCollectionError("REGISTRY_INCOMPLETE", "authority metric set is empty; refusing vacuous admission");
  }
  const missing = required.filter((key) => !registry[key]);
  if (missing.length > 0) {
    throw new UsageCollectionError("REGISTRY_INCOMPLETE", `live registry lacks required metrics: ${missing.join(", ")}`);
  }
  const extra = Object.keys(registry).filter((key) => !required.includes(key));
  if (extra.length > 0) {
    throw new UsageCollectionError("REGISTRY_INCOMPLETE", `live registry carries unknown metrics: ${extra.join(", ")}`);
  }
  if (Object.keys(registry).length !== required.length) {
    throw new UsageCollectionError("REGISTRY_INCOMPLETE", "live registry metric set is not exactly the required set");
  }
  return true;
}
