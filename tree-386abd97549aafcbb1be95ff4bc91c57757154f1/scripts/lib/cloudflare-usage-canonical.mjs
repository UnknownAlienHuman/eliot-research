// Canonical usage taxonomy + metric authority (split from
// cloudflare-usage-envelope.mjs to keep every source file below the 600-line
// budget; split by capability, not by line count).
//
// This module owns the decimal unit basis, the metric provenance taxonomy,
// the plan quota table (USAGE_METRICS), and the module-private canonical
// authority. FIX14: authorization lookup uses NO Map/Set and NO ambient
// mutable prototype. The canonical table is a private null-prototype exact
// record (no inheritance, no prototype chain), and every lookup is an
// explicit strict-=== scan over the private required-key list that never
// consults caller objects and never coerces keys (typeof string gate first,
// so Proxy/object/symbol keys with throwing toString/valueOf never coerce).
// Capturing Map/Set/Object.prototype intrinsics would still be unsafe under
// a before-import poisoning, so none are used here at all. Public facades
// (USAGE_METRICS, REQUIRED_METRIC_KEYS, METRIC_BY_KEY) are frozen
// non-authoritative views; authority reads only the private table.

export const DECIMAL_BYTES_PER_GB = 1_000_000_000;
export const DECIMAL_BYTES_PER_KB = 1_000;
export const QUEUE_CHUNK_BYTES = 64_000;
export const QUEUE_MESSAGE_OVERHEAD_BYTES = 100;

// Metric provenance taxonomy (Luna FIX3G): every reported counter carries one
// provenance. `unknown` metrics carry a typed reason below, never a zero.
//   authoritative_billing   - Restricted Alpha GET /accounts/{id}/billable/usage
//                             with account/date/metric/unit/full-window validation.
//   authoritative_inventory - Complete account-bound inventory proving a
//                             point-in-time count (for example AI Search
//                             instance count from /ai-search/instances).
//   analytics_nonbilling    - Cloudflare GraphQL analytics: operational evidence
//                             only, never billing authority.
//   ledger_estimate         - Controller-owned ledger + fresh full inventory
//                             proof (budget admission Layer 2).
//   unavailable             - No verified aggregate; metric stays unknown.
export const METRIC_PROVENANCE = Object.freeze({
  AUTHORITATIVE_BILLING: "authoritative_billing",
  AUTHORITATIVE_INVENTORY: "authoritative_inventory",
  ANALYTICS_NONBILLING: "analytics_nonbilling",
  LEDGER_ESTIMATE: "ledger_estimate",
  UNAVAILABLE: "unavailable",
});

// Typed unknown reasons (Luna FIX3G): every unknown metric names one.
export const UNKNOWN_REASONS = Object.freeze([
  "NO_AUTH_ENDPOINT",
  "AUTH_SCOPE_DENIED",
  "HTTP_ERROR",
  "MALFORMED",
  "PARTIAL_PAGINATION",
  "WINDOW_MISMATCH",
  "STALE",
  "ACCOUNT_MISMATCH",
  "DEGRADED",
]);

export function isProvenance(value) {
  if (typeof value !== "string") return false;
  return value === METRIC_PROVENANCE.AUTHORITATIVE_BILLING ||
    value === METRIC_PROVENANCE.AUTHORITATIVE_INVENTORY ||
    value === METRIC_PROVENANCE.ANALYTICS_NONBILLING ||
    value === METRIC_PROVENANCE.LEDGER_ESTIMATE ||
    value === METRIC_PROVENANCE.UNAVAILABLE;
}

export function isUnknownReason(value) {
  if (typeof value !== "string") return false;
  for (let i = 0; i < UNKNOWN_REASONS.length; i += 1) {
    if (UNKNOWN_REASONS[i] === value) return true;
  }
  return false;
}

export function bytesFromDecimalGb(gb) {
  if (typeof gb !== "number" || !Number.isFinite(gb) || gb < 0) throw new Error("gb must be a non-negative finite number");
  return Math.round(gb * DECIMAL_BYTES_PER_GB);
}

export function decimalGbFromBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) throw new Error("bytes must be a non-negative finite number");
  return bytes / DECIMAL_BYTES_PER_GB;
}

// SEALED allowlist: the ONLY remote effects authorized while sealed (stale /
// wrong-window / unknown-untrusted), and only after fresh account binding
// (verified whoami digest) plus a fresh inventory receipt.
export const SEALED_ALLOWLIST = Object.freeze([
  "wrangler-whoami-verify",
  "access-app-readback",
  "d1-inventory-list",
  "r2-inventory-list",
  "queue-inventory-list",
  "ai-search-inventory-list",
  "local-config-generate",
  "preflight-receipt-write",
]);

export function isSealedAllowlistedOperation(operation) {
  if (typeof operation !== "string") return false;
  for (let i = 0; i < SEALED_ALLOWLIST.length; i += 1) {
    if (SEALED_ALLOWLIST[i] === operation) return true;
  }
  return false;
}

// quota is the included Cloudflare plan quota (100%); envelope is the local
// 80% admission boundary. window selects the fencing discipline; `exact`
// marks point-in-time counts (AI Search instance inventory) rather than
// cumulative counters. Storage bytes are decimal-GB derived (see above).
export const USAGE_METRICS = [
  { key: "workers_requests", quota: 10_000_000, envelope: 8_000_000, window: "monthly", plan: "Workers Paid" },
  { key: "workers_cpu_ms", quota: 30_000_000, envelope: 24_000_000, window: "monthly", plan: "Workers Paid" },
  { key: "d1_storage_bytes", quota: 5 * DECIMAL_BYTES_PER_GB, envelope: 4 * DECIMAL_BYTES_PER_GB, window: "monthly", plan: "D1 paid inclusion (decimal GB)" },
  { key: "d1_rows_read", quota: 25_000_000_000, envelope: 20_000_000_000, window: "monthly", plan: "D1 paid inclusion" },
  { key: "d1_rows_written", quota: 50_000_000, envelope: 40_000_000, window: "monthly", plan: "D1 paid inclusion" },
  { key: "r2_storage_gb_month", quota: 10, envelope: 8, window: "monthly", plan: "R2 paid inclusion (decimal GB-mo)", unit: "decimal-GB-mo" },
  { key: "r2_class_a_ops", quota: 1_000_000, envelope: 800_000, window: "monthly", plan: "R2 paid inclusion" },
  { key: "r2_class_b_ops", quota: 10_000_000, envelope: 8_000_000, window: "monthly", plan: "R2 paid inclusion" },
  { key: "queue_ops", quota: 1_000_000, envelope: 800_000, window: "monthly", plan: "Queues paid inclusion (64,000-byte chunks)" },
  { key: "do_requests", quota: 1_000_000, envelope: 800_000, window: "monthly", plan: "Durable Objects paid inclusion" },
  { key: "do_gb_seconds", quota: 400_000, envelope: 320_000, window: "monthly", plan: "Durable Objects paid inclusion" },
  { key: "do_sql_reads", quota: 25_000_000_000, envelope: 20_000_000_000, window: "monthly", plan: "Durable Objects SQLite paid inclusion" },
  { key: "do_sql_writes", quota: 50_000_000, envelope: 40_000_000, window: "monthly", plan: "Durable Objects SQLite paid inclusion" },
  { key: "do_storage_bytes", quota: 5 * DECIMAL_BYTES_PER_GB, envelope: 4 * DECIMAL_BYTES_PER_GB, window: "monthly", plan: "Durable Objects paid inclusion (decimal GB)" },
  { key: "workers_ai_neurons_per_day", quota: 10_000, envelope: 8_000, window: "daily", plan: "Workers AI paid inclusion" },
  { key: "ai_search_instances", quota: 5, envelope: 5, window: "point", exact: true, plan: "AI Search (exactly 5)" },
  { key: "ai_search_queries_month", quota: 25_000, envelope: 20_000, window: "monthly", plan: "AI Search" },
  { key: "vectorize_queried_dims_month", quota: 50_000_000, envelope: 40_000_000, window: "monthly", plan: "Vectorize" },
  { key: "vectorize_stored_dims_month", quota: 10_000_000, envelope: 8_000_000, window: "monthly", plan: "Vectorize" },
];

export const REQUIRED_METRIC_KEYS = Object.freeze((() => {
  const keys = [];
  for (let i = 0; i < USAGE_METRICS.length; i += 1) keys[keys.length] = USAGE_METRICS[i].key;
  return keys;
})());
for (let i = 0; i < USAGE_METRICS.length; i += 1) Object.freeze(USAGE_METRICS[i]);
Object.freeze(USAGE_METRICS);

// Module-private canonical authority (never exported): independent frozen
// copies, so mutating an export cannot change decisions.
const CANONICAL_METRICS = Object.freeze((() => {
  const copies = [];
  for (let i = 0; i < USAGE_METRICS.length; i += 1) {
    copies[copies.length] = Object.freeze({ ...USAGE_METRICS[i] });
  }
  return copies;
})());
const CANONICAL_REQUIRED_KEYS = Object.freeze((() => {
  const keys = [];
  for (let i = 0; i < CANONICAL_METRICS.length; i += 1) keys[keys.length] = CANONICAL_METRICS[i].key;
  return keys;
})());
const CANONICAL_TABLE = (() => {
  const table = Object.create(null);
  for (let i = 0; i < CANONICAL_METRICS.length; i += 1) {
    const m = CANONICAL_METRICS[i];
    table[m.key] = m;
  }
  return Object.freeze(table);
})();
function readOnlyAuthorityError() { throw new Error("METRIC_BY_KEY is read-only authority state"); }
// Legacy export: immutable non-Map facade, ignored by authority. Not a Map,
// so Map.prototype.*.call throws; frozen so overwrite/defineProperty throws.
export const METRIC_BY_KEY = Object.freeze({ has(k) { return hasCanonicalMetric(k); }, get(k) { return getCanonicalMetric(k); }, get size() { return CANONICAL_REQUIRED_KEYS.length; }, set: readOnlyAuthorityError, delete: readOnlyAuthorityError, clear: readOnlyAuthorityError });
export function hasCanonicalMetric(k) {
  if (typeof k !== "string" || k === "") return false;
  for (let i = 0; i < CANONICAL_REQUIRED_KEYS.length; i += 1) {
    if (CANONICAL_REQUIRED_KEYS[i] === k) return true;
  }
  return false;
}
export function getCanonicalMetric(k) {
  if (typeof k !== "string" || k === "") return null;
  for (let i = 0; i < CANONICAL_REQUIRED_KEYS.length; i += 1) {
    if (CANONICAL_REQUIRED_KEYS[i] === k) return CANONICAL_TABLE[k];
  }
  return null;
}
export function listCanonicalRequiredKeys() {
  const out = [];
  for (let i = 0; i < CANONICAL_REQUIRED_KEYS.length; i += 1) {
    out[out.length] = CANONICAL_REQUIRED_KEYS[i];
  }
  return out;
}
export function listCanonicalMetrics() {
  const out = [];
  for (let i = 0; i < CANONICAL_METRICS.length; i += 1) {
    out[out.length] = CANONICAL_METRICS[i];
  }
  return out;
}
export function canonicalWindowOf(k) {
  const metric = getCanonicalMetric(k);
  return metric !== null ? metric.window : "monthly";
}
