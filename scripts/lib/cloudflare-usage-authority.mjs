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

// Module-private identity capability. Process isolation is the trust boundary;
// the WeakMap only prevents ordinary callers from asserting a provider brand.
const INVENTORY_BRANDS = new WeakMap();

export const INVENTORY_BRAND_PAGINATED = "inventory-paginated";
export const INVENTORY_BRAND_CURSOR = "inventory-cursor";
export const INVENTORY_BRAND_AI_SEARCH = "inventory-ai-search";

function brandOf(provider) {
  if (provider === null || (typeof provider !== "object" && typeof provider !== "function")) return null;
  return INVENTORY_BRANDS.get(provider) ?? null;
}

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
  return brandOf(provider) !== null;
}

export function isAiSearchInventoryProvider(provider) {
  return brandOf(provider) === INVENTORY_BRAND_AI_SEARCH;
}

export function inventoryBrandClass(provider) {
  return brandOf(provider);
}

// Sources and precise coverage limitations per required metric. Metadata
// stocks and adaptive analytics are diagnostic only: they cannot establish
// the canonical monthly/daily billing quantities. Inventory lists prove
// existence/shape, never an inferred zero usage counter. Provenance is one of
// authoritative_billing | authoritative_inventory | analytics_nonbilling |
// ledger_estimate | unavailable (see cloudflare-usage-envelope.mjs).
// Account-wide coverage spans Workers, D1, R2, Queues, SQLite Durable
// Objects, Workers AI, AI Search, Vectorize, and Access without inventing
// counters. AI Search GA included usage is documented, but account-wide
// monthly usage remains unavailable until an exact source and billing
// identity are reviewed.
export const METRIC_SOURCE_REGISTRY = (() => {
  const registry = {
  workers_requests: { sources: ["workers-requests-diagnostic"], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.ANALYTICS_NONBILLING, limitation: "Workers adaptive analytics requests are diagnostic, not verified monthly billing usage" },
  workers_cpu_ms: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "documented Workers CPU quantiles do not provide an exact monthly CPU-ms sum" },
  d1_storage_bytes: { sources: ["d1-storage-diagnostic"], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.ANALYTICS_NONBILLING, limitation: "D1 metadata file_size is observed current stock across reads, not atomic or monthly storage usage" },
  d1_rows_read: { sources: ["d1-rows-diagnostic"], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.ANALYTICS_NONBILLING, limitation: "D1 adaptive rows-read analytics are diagnostic, not verified monthly billing usage" },
  d1_rows_written: { sources: ["d1-rows-diagnostic"], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.ANALYTICS_NONBILLING, limitation: "D1 adaptive rows-written analytics are diagnostic, not verified monthly billing usage" },
  r2_storage_gb_month: { sources: ["r2-inventory-list"], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "bucket inventory has no GB-month quantity; no OAuth-compatible exact monthly source is qualified" },
  r2_class_a_ops: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "bucket inventory has no Class A operation quantity; no OAuth-compatible exact monthly source is qualified" },
  r2_class_b_ops: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "bucket inventory has no Class B operation quantity; no OAuth-compatible exact monthly source is qualified" },
  queue_ops: { sources: ["queue-ops-diagnostic"], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.ANALYTICS_NONBILLING, limitation: "Queues adaptive billableOperations are diagnostic estimates, not verified monthly billing usage" },
  do_requests: { sources: ["do-requests-diagnostic"], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.ANALYTICS_NONBILLING, limitation: "Durable Objects adaptive request metrics omit the WebSocket billing ratio and do not establish monthly billed requests" },
  do_gb_seconds: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "documented Durable Objects CPU time does not establish billable GB-seconds" },
  do_sql_reads: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no documented OAuth-compatible exact account-wide monthly Durable Objects SQL-read source is qualified" },
  do_sql_writes: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no documented OAuth-compatible exact account-wide monthly Durable Objects SQL-write source is qualified" },
  do_storage_bytes: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "Durable Objects storedBytes maximum is a stock statistic, not exact monthly storage usage" },
  workers_ai_neurons_per_day: { sources: [], window: "daily", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no documented OAuth-compatible exact account-wide daily neuron source is qualified" },
  ai_search_instances: { sources: ["ai-search-inventory-list"], window: "point", authoritative: true, provenance: METRIC_PROVENANCE.AUTHORITATIVE_INVENTORY, limitation: "" },
  ingestion_tokens_month: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "AI Search GA included tokens do not expose actual account usage; no exact monthly OAuth source or reviewed billing triple is qualified" },
  storage_gb_month: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "AI Search instance inventory is point-in-time stock, not GB-month usage; no exact monthly OAuth source or reviewed billing triple is qualified" },
  semantic_vector_hybrid_queries_month: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "AI Search instance stats expose indexing status, not account-wide semantic/vector/hybrid query usage; no reviewed billing triple is qualified" },
  full_text_queries_month: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "AI Search instance stats expose indexing status, not account-wide full-text query usage; no reviewed billing triple is qualified" },
  vectorize_queried_dims_month: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "Vectorize index info has no monthly queried-dimension usage; Wrangler has no documented Vectorize-specific scope" },
  vectorize_stored_dims_month: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "per-index dimensions and vectorCount are current stock, not account-wide monthly stored-dimension usage" },
  };
  const registryKeys = Object.keys(registry);
  for (let i = 0; i < registryKeys.length; i += 1) {
    const entry = registry[registryKeys[i]];
    Object.freeze(entry.sources); Object.freeze(entry);
  }
  return Object.freeze(registry);
})();

// A private Map is the authority; this copy is independent of the public,
// frozen documentation view.
const CANONICAL_REGISTRY = new Map(
  Object.entries(METRIC_SOURCE_REGISTRY).map(([key, value]) => [
    key,
    Object.freeze({ ...value, sources: Object.freeze([...value.sources]) }),
  ]),
);
function canonicalRegistryHas(k) {
  return typeof k === "string" && k !== "" && CANONICAL_REGISTRY.has(k);
}
export function getRegistryEntry(k) {
  return CANONICAL_REGISTRY.get(k) ?? null;
}
export function getRegistryLimitation(k) {
  const limitation = CANONICAL_REGISTRY.get(k)?.limitation;
  return typeof limitation === "string" ? limitation : "unregistered";
}
export function assertLiveRegistryCoversAll(registry = null) {
  const required = listCanonicalRequiredKeys();
  if (required.length === 0) {
    throw new UsageCollectionError("REGISTRY_INCOMPLETE", "authority metric set is empty; refusing vacuous admission");
  }
  if (registry === null || registry === undefined) {
    const missing = required.filter((key) => !canonicalRegistryHas(key));
    if (missing.length > 0) {
      throw new UsageCollectionError("REGISTRY_INCOMPLETE", "live registry lacks required metrics: " + missing.join(", "));
    }
    if (CANONICAL_REGISTRY.size !== required.length) {
      throw new UsageCollectionError("REGISTRY_INCOMPLETE", "live registry metric set is not exactly the required set");
    }
    return true;
  }
  const registryKeys = Object.keys(registry);
  const requiredSet = new Set(required);
  const keySet = new Set(registryKeys);
  const missing = required.filter((key) => !keySet.has(key) || registry[key] === undefined || registry[key] === null);
  if (missing.length > 0) {
    throw new UsageCollectionError("REGISTRY_INCOMPLETE", "live registry lacks required metrics: " + missing.join(", "));
  }
  const extra = registryKeys.filter((key) => !requiredSet.has(key));
  if (extra.length > 0) {
    throw new UsageCollectionError("REGISTRY_INCOMPLETE", "live registry carries unknown metrics: " + extra.join(", "));
  }
  if (registryKeys.length !== required.length) {
    throw new UsageCollectionError("REGISTRY_INCOMPLETE", "live registry metric set is not exactly the required set");
  }
  return true;
}
