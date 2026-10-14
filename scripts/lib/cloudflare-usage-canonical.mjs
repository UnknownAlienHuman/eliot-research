// Canonical usage taxonomy + metric authority (split from
// cloudflare-usage-envelope.mjs to keep every source file below the 600-line
// budget; split by capability, not by line count).
//
// This module owns the decimal unit basis, metric provenance taxonomy,
// included-usage envelopes, and private canonical metric map. Trust is
// established by the production collector, strict response/account/window
// validation, and process isolation. Public exports are read-only views;
// decisions use the private Map.

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

// quota is a documented monthly included-usage pool (100%); envelope is the
// existing local 80% admission boundary. AI Search instance inventory is a
// point observation only. Its plan ceiling and desired topology are checked
// by provisioning readback, so it deliberately has no quota or envelope.
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
  { key: "ai_search_instances", window: "point", exact: true, unit: "instances", plan: "AI Search inventory; provider ceiling and topology are checked separately" },
  { key: "ingestion_tokens_month", quota: 5_000_000, envelope: 4_000_000, window: "monthly", unit: "tokens", plan: "AI Search included monthly usage (all account plans)" },
  { key: "storage_gb_month", quota: 10, envelope: 8, window: "monthly", unit: "GB-month", plan: "AI Search included monthly usage (all account plans)" },
  { key: "semantic_vector_hybrid_queries_month", quota: 1_000, envelope: 800, window: "monthly", unit: "queries", plan: "AI Search included monthly usage (all account plans)" },
  { key: "full_text_queries_month", quota: 1_000, envelope: 800, window: "monthly", unit: "queries", plan: "AI Search included monthly usage (all account plans)" },
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

// Private authority is a real Map. Entries are independent frozen copies;
// callers cannot change policy by editing exported metric views.
const CANONICAL_METRICS = new Map(
  USAGE_METRICS.map((metric) => [metric.key, Object.freeze({ ...metric })]),
);
const CANONICAL_REQUIRED_KEYS = Object.freeze([...CANONICAL_METRICS.keys()]);
function readOnlyAuthorityError() { throw new Error("METRIC_BY_KEY is a read-only compatibility view"); }
// Compatibility view only. Authority never reads this facade.
export const METRIC_BY_KEY = Object.freeze({
  has(k) { return hasCanonicalMetric(k); },
  get(k) { return getCanonicalMetric(k); },
  get size() { return CANONICAL_METRICS.size; },
  set: readOnlyAuthorityError,
  delete: readOnlyAuthorityError,
  clear: readOnlyAuthorityError,
});
export function hasCanonicalMetric(k) {
  return typeof k === "string" && k !== "" && CANONICAL_METRICS.has(k);
}
export function getCanonicalMetric(k) {
  if (typeof k !== "string" || k === "") return null;
  return CANONICAL_METRICS.get(k) ?? null;
}
export function listCanonicalRequiredKeys() {
  return [...CANONICAL_REQUIRED_KEYS];
}
export function listCanonicalMetrics() {
  return [...CANONICAL_METRICS.values()];
}
export function canonicalWindowOf(k) {
  const metric = getCanonicalMetric(k);
  return metric !== null ? metric.window : "monthly";
}
export function canonicalUnitOf(k) {
  const metric = getCanonicalMetric(k);
  return metric !== null ? metric.unit ?? null : null;
}
