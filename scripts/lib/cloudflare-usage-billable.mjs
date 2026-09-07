// Billing usage provider (Usage v2) plus the live provider registry.
//
// Extracted from cloudflare-usage-providers.mjs /
// cloudflare-usage-collection.mjs to keep every source file below the
// 600-line budget; readable extraction, not compaction. Re-exported through
// both modules so existing import paths keep working.
//
// The bearer lives in process memory only and never reaches snapshots,
// receipts, logs, or errors; this module never reads CLOUDFLARE_API_TOKEN.

import {
  CLOCK_SKEW_MS,
  METRIC_PROVENANCE,
  listCanonicalRequiredKeys,
} from "./cloudflare-usage-envelope.mjs";
import {
  ProviderFailure,
  UsageCollectionError,
  assertAccountUrl,
  safeFetchMeta,
} from "./cloudflare-usage-providers.mjs";
import {
  LIVE_API_BASE,
  callerSuppliedTransportKeys,
  defaultBillingEndpoint,
  isTestTransportProvider,
  markTestTransport,
} from "./cloudflare-usage-transport-class.mjs";
import {
  createAiSearchInventoryProvider,
  createPaginatedInventoryProvider,
  createR2CursorInventoryProvider,
} from "./cloudflare-usage-authority.mjs";

// Module-PRIVATE billing brand registry: the non-caller-assertable
// construction capability for AUTHORITATIVE_BILLING. Populated ONLY inside
// createBillableUsageProvider below AND only when the product runs on the
// internal default live transport (default billing endpoint, default global
// fetch, default frozen-empty REVIEWED_BILLABLE_TRIPLES map, unpinned
// window); any caller-supplied endpoint/fetchImpl/metricMap/expectedWindow/
// apiBase key yields an unbranded test-only product instead. No registrar is
// exported, so a forged plain object with kind "billing-usage" can never
// carry trust, and genuine factory construction with mocked transports can
// never produce production-authoritative evidence either. Products are frozen
// so post-construction collect-replacement cannot hijack identity.
const BILLING_BRANDS = new WeakSet();

export const BILLING_BRAND_CLASS = "billing-usage-v2";

// Read-only predicates: the sole trust queries for the billing channel.
// isTestTransportProvider (re-exported from the transport-class module) is
// the sole test-only query and never confers authority.
export function isUsageVBillingProvider(provider) {
  return BILLING_BRANDS.has(provider);
}

export { isTestTransportProvider };

export function billingBrandClass(provider) {
  return BILLING_BRANDS.has(provider) ? BILLING_BRAND_CLASS : null;
}

// Reviewed billing triples: `${x_BillableMetricId}:${x_BillableMetricName}:${ConsumedUnit}`
// mapped to an envelope metric. A triple is added here only after its FinOps
// FOCUS v1.3 row shape is observed live and reviewed. Until then the live
// registry carries an empty map and every live row fails closed as unknown
// (live Cloudflare billing remains NOT_EXECUTED).
export const REVIEWED_BILLABLE_TRIPLES = Object.freeze({});

// Billing counters the live registry admits through Usage v2. AI Search
// instance counts are inventory authority, never billing: the billing
// provider must not cover ai_search_instances, so a billing outage (no
// entitlement, partial interval) can never clobber the inventory-proved
// count with an unknown gap. Derived from module-private canonical authority
// (never an exported list) so export mutation cannot change coverage;
// the snapshot length is enforced where the registry is built.
const CANONICAL_BILLABLE_COVERS = listCanonicalRequiredKeys().filter((key) => key !== "ai_search_instances");
if (CANONICAL_BILLABLE_COVERS.length === 0) throw new Error("billing live covers must be non-empty");
const CANONICAL_KEY_SET = new Set(listCanonicalRequiredKeys());
export const BILLABLE_LIVE_COVERS = Object.freeze([...CANONICAL_BILLABLE_COVERS]);

// Billing usage provider: GET /accounts/{account_id}/billable/usage
// (Version 2, Alpha, Restricted; FinOps FOCUS v1.3 rows). Sends explicit
// from+to (month start through start-of-today; never a future month end,
// never over 31 days) and parses ONLY documented FOCUS fields. The retired
// synthetic {metric,unit,value} schema is MALFORMED. Every accepted row needs
// exact BillingAccountId identity plus real ChargePeriodStart/End evidence
// inside the queried interval; mapping binds a reviewed
// x_BillableMetricId + x_BillableMetricName + ConsumedUnit triple (the name
// is identity, never display text: a missing or substituted name misses the
// reviewed triple and fails closed). All other outcomes stay typed unknown.
// Receipts carry status/window metadata only.
const MAX_BILLING_QUERY_DAYS = 31;

function parseBillingTime(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function billingDayDate(millis) {
  return new Date(millis).toISOString().slice(0, 10);
}

export function createBillableUsageProvider(options = {}) {
  const {
    group = "billable-usage",
    covers = [],
    endpoint,
    fetchImpl = globalThis.fetch,
    metricMap = {},
    expectedWindow = null,
  } = options ?? {};
  // Brand is granted ONLY on the internal default live transport: no caller
  // supplied any transport/map key, so the product uses the default billing
  // endpoint, the default global fetch, and the default frozen-empty reviewed
  // triple map with an unpinned (month-start through start-of-today) window —
  // exactly the live semantics below. ANY caller-supplied key selects the
  // test-only path: fully functional collection, identity-marked test-only,
  // never branded. Explicitly passing even a default value still counts as
  // caller-supplied (key presence, never value comparison).
  const liveTransport = callerSuppliedTransportKeys(options).length === 0;
  const liveEndpoint = liveTransport ? defaultBillingEndpoint(LIVE_API_BASE) : endpoint;
  if (typeof liveEndpoint !== "function") throw new UsageCollectionError("COLLECTION_INVALID", "billable provider endpoint is required");
  const liveFetch = liveTransport ? globalThis.fetch : fetchImpl;
  const liveMap = liveTransport ? REVIEWED_BILLABLE_TRIPLES : metricMap;
  const liveWindow = liveTransport ? null : expectedWindow;
  const product = {
    group,
    covers: [...covers],
    kind: "billing-usage",
    async collect({ accountId, bearer, now }) {
      const nowMs = Number.isFinite(now) ? now : Date.now();
      if (typeof bearer !== "string" || bearer.length < 1) throw new ProviderFailure("NO_AUTH_ENDPOINT", `${group}: bearer required`);
      const clock = new Date(nowMs);
      const monthStartMs = Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), 1);
      const todayStartMs = Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), clock.getUTCDate());
      let expectedStartMs = null, expectedEndMs = null;
      if (liveWindow !== null && liveWindow !== undefined) {
        expectedStartMs = parseBillingTime(liveWindow.start);
        expectedEndMs = parseBillingTime(liveWindow.end);
        if (expectedStartMs === null || expectedEndMs === null || !(expectedStartMs < expectedEndMs)) {
          throw new ProviderFailure("WINDOW_MISMATCH", `${group} expected window is not a valid interval`);
        }
      }
      const queryFromMs = expectedStartMs ?? monthStartMs;
      if (queryFromMs > nowMs + CLOCK_SKEW_MS) {
        throw new ProviderFailure("WINDOW_MISMATCH", `${group} query starts in the future`);
      }
      const queryToMs = expectedEndMs === null ? todayStartMs : Math.min(expectedEndMs, todayStartMs);
      if (!(queryFromMs < queryToMs)) {
        throw new ProviderFailure("WINDOW_MISMATCH", `${group} empty billing interval proves no complete window`);
      }
      if (queryToMs - queryFromMs > MAX_BILLING_QUERY_DAYS * 24 * 60 * 60 * 1000) {
        throw new ProviderFailure("WINDOW_MISMATCH", `${group} billing query exceeds the 31-day limit`);
      }
      const fromDate = billingDayDate(queryFromMs);
      const toDate = billingDayDate(queryToMs);
      let url = liveEndpoint(accountId, fromDate, toDate);
      // Structural endpoint binding: the exact `/accounts/{accountId}/`
      // path segment must match and the pathname must carry
      // `/billable/usage`. An expected ID in the query/fragment while the
      // path binds another account is ACCOUNT_MISMATCH, never fetched.
      assertAccountUrl(url, accountId, group, "billing endpoint");
      try {
        const parsed = new URL(url);
        if (!parsed.pathname.includes("/billable/usage")) {
          throw new ProviderFailure("ACCOUNT_MISMATCH", `${group} left the bound billing endpoint`);
        }
      } catch (error) {
        if (error instanceof ProviderFailure) throw error;
        throw new ProviderFailure("MALFORMED", `${group} billing endpoint unparseable`);
      }
      const sentFrom = url.match(/[?&]from=([^&]*)/)?.[1];
      const sentTo = url.match(/[?&]to=([^&]*)/)?.[1];
      if ((sentFrom !== undefined && decodeURIComponent(sentFrom) !== fromDate) ||
        (sentTo !== undefined && decodeURIComponent(sentTo) !== toDate)) {
        throw new ProviderFailure("WINDOW_MISMATCH", `${group} endpoint query dates leave the validated interval`);
      }
      if (sentFrom === undefined || sentTo === undefined) {
        url += `${url.includes("?") ? "&" : "?"}from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`;
      }
      let response;
      try {
        response = await liveFetch(url, { headers: { authorization: `Bearer ${bearer}` } });
      } catch {
        throw new ProviderFailure("HTTP_ERROR", `${group} transport failure`);
      }
      const httpStatus = Number.isInteger(response?.status) ? response.status : null;
      if (httpStatus === 401 || httpStatus === 403) {
        throw new ProviderFailure("AUTH_SCOPE_DENIED", `${group} billing usage entitlement unavailable (http ${httpStatus})`, { httpStatus });
      }
      if (httpStatus === 404) {
        throw new ProviderFailure("NO_AUTH_ENDPOINT", `${group} billing endpoint unavailable (http 404)`, { httpStatus });
      }
      if (httpStatus === 429 || (Number.isInteger(httpStatus) && httpStatus >= 500)) {
        throw new ProviderFailure("HTTP_ERROR", `${group} http ${httpStatus}`, { httpStatus });
      }
      let body;
      try {
        body = await response.json();
      } catch {
        throw new ProviderFailure("MALFORMED", `${group} invalid JSON`, { httpStatus });
      }
      if (body?.success !== true) {
        throw new ProviderFailure("HTTP_ERROR", `${group} malformed (success:false)`, { httpStatus });
      }
      if (!Array.isArray(body?.result)) {
        throw new ProviderFailure("MALFORMED", `${group} missing usage rows`, { httpStatus });
      }
      const scoped = Array.isArray(covers) && covers.length > 0 ? new Set(covers) : null;
      const sums = new Map();
      const intervalsByMetric = new Map();
      const seenRows = new Set();
      for (const row of body.result) {
        if (!row || typeof row !== "object" || Array.isArray(row)) {
          throw new ProviderFailure("MALFORMED", `${group} usage row is not an object`, { httpStatus });
        }
        // Retired synthetic schema (metric/unit/value, no FOCUS identity).
        if ((row.metric !== undefined || row.unit !== undefined || row.value !== undefined) && row.x_BillableMetricId === undefined) {
          throw new ProviderFailure("MALFORMED", `${group} synthetic billing row rejected (not FOCUS v1.3)`, { httpStatus });
        }
        if (row.BillingAccountId === undefined || row.BillingAccountId === null) {
          throw new ProviderFailure("MALFORMED", `${group} usage row lacks BillingAccountId`, { httpStatus });
        }
        if (row.BillingAccountId !== accountId) {
          throw new ProviderFailure("ACCOUNT_MISMATCH", `${group} usage row binds a different account`, { httpStatus });
        }
        const metricId = row.x_BillableMetricId;
        const metricName = row.x_BillableMetricName;
        const unit = row.ConsumedUnit;
        const quantity = row.ConsumedQuantity;
        if (typeof metricId !== "string" || metricId === "" || typeof unit !== "string" || unit === "") {
          throw new ProviderFailure("MALFORMED", `${group} usage row lacks metric/unit identity`, { httpStatus });
        }
        // The metric name is identity, not display text: a missing name or a
        // substituted name misses the reviewed triple below and fails closed
        // instead of binding the wrong counter as authoritative billing.
        if (typeof metricName !== "string" || metricName === "") {
          throw new ProviderFailure("MALFORMED", `${group} usage row lacks metric name identity`, { httpStatus });
        }
        if (!(typeof quantity === "number" && Number.isFinite(quantity) && quantity >= 0)) {
          throw new ProviderFailure("MALFORMED", `${group} bad ConsumedQuantity`, { httpStatus });
        }
        const rowStartMs = parseBillingTime(row.ChargePeriodStart);
        const rowEndMs = parseBillingTime(row.ChargePeriodEnd);
        if (rowStartMs === null || rowEndMs === null || !(rowStartMs < rowEndMs)) {
          throw new ProviderFailure("MALFORMED", `${group} usage row lacks a valid charge period`, { httpStatus });
        }
        if (rowEndMs > nowMs + CLOCK_SKEW_MS) {
          throw new ProviderFailure("WINDOW_MISMATCH", `${group} usage row ends in the future`, { httpStatus });
        }
        if (rowStartMs < queryFromMs - CLOCK_SKEW_MS || rowEndMs > queryToMs + CLOCK_SKEW_MS) {
          throw new ProviderFailure("WINDOW_MISMATCH", `${group} usage row outside the queried interval`, { httpStatus });
        }
        // Reviewed ID+name+unit triple binding only: no bare-metric, no
        // display-name-only, and no ID+unit fallback; an unknown triple fails
        // closed instead of skipping usage.
        const mapped = liveMap[`${metricId}:${metricName}:${unit}`];
        if (mapped === undefined) {
          throw new ProviderFailure("MALFORMED", `${group} unknown billing metric/name/unit triple`, { httpStatus });
        }
        if (!CANONICAL_KEY_SET.has(mapped) || (scoped !== null && !scoped.has(mapped))) continue;
        const rowDigest = JSON.stringify(row);
        if (seenRows.has(rowDigest)) {
          throw new ProviderFailure("MALFORMED", `${group} duplicate usage row is ambiguous`, { httpStatus });
        }
        seenRows.add(rowDigest);
        const known = intervalsByMetric.get(mapped) ?? [];
        for (const prior of known) {
          if (rowStartMs < prior.end && prior.start < rowEndMs &&
            !(rowStartMs === prior.start && rowEndMs === prior.end)) {
            throw new ProviderFailure("WINDOW_MISMATCH", `${group} overlapping charge periods are ambiguous`, { httpStatus });
          }
        }
        known.push({ start: rowStartMs, end: rowEndMs });
        intervalsByMetric.set(mapped, known);
        sums.set(mapped, (sums.get(mapped) ?? 0) + quantity);
      }
      if (intervalsByMetric.size === 0) {
        throw new ProviderFailure("WINDOW_MISMATCH", `${group} empty usage result proves no complete window`, { httpStatus });
      }
      // Completeness per mapped metric: every admitted metric must
      // continuously cover the exact full queried window on its OWN
      // intervals. Intervals from another metric never bridge a gap
      // (cross-metric laundering fails closed); metrics with zero rows stay
      // absent (unknown downstream, never zero). A per-metric gap fails the
      // whole provider closed rather than admitting the complete metrics
      // alongside the gapped one under a single fullAccount:true receipt.
      for (const [metric, intervals] of intervalsByMetric) {
        const sorted = [...intervals].sort((left, right) => left.start - right.start || left.end - right.end);
        let cursor = queryFromMs;
        for (const interval of sorted) {
          if (interval.start > cursor + CLOCK_SKEW_MS) throw new ProviderFailure("WINDOW_MISMATCH", `${group} ${metric} partial usage interval`, { httpStatus });
          if (interval.end > cursor) cursor = interval.end;
        }
        if (cursor < queryToMs - CLOCK_SKEW_MS) throw new ProviderFailure("WINDOW_MISMATCH", `${group} ${metric} partial usage interval`, { httpStatus });
      }
      // Zero-row declared metric: every declared covers metric mapped by
      // metricMap must independently prove full exact-window coverage. A
      // mapped covers metric with no usable rows is WINDOW_MISMATCH for the
      // whole provider — the complete metrics are never admitted alongside
      // the gapped one under a single fullAccount:true receipt. Metrics NOT
      // in covers stay absent (unknown downstream, never zero).
      if (scoped !== null) {
        const mappedValues = new Set(Object.values(liveMap));
        for (const metric of scoped) {
          if (mappedValues.has(metric) && !intervalsByMetric.has(metric)) {
            throw new ProviderFailure("WINDOW_MISMATCH", `${group} ${metric} declared cover has no usage rows`, { httpStatus });
          }
        }
      }
      const windowStart = new Date(queryFromMs).toISOString();
      const windowEnd = new Date(queryToMs).toISOString();
      return {
        values: Object.fromEntries(sums.entries()),
        coverage: { accountId, fullAccount: true, windowStart, windowEnd },
        provenance: METRIC_PROVENANCE.AUTHORITATIVE_BILLING,
        receiptMeta: safeFetchMeta({ httpStatus, kind: "billing-usage", full: true, authoritative: true, reason: null }),
      };
    },
  };
  // Brand and freeze inside the factory closure — but ONLY on the default
  // live transport above. Caller-supplied transports take the test-only
  // path: frozen and fully functional, identity-marked test-only, never
  // branded, so mocked transports can never produce authoritative evidence.
  Object.freeze(product.covers);
  if (liveTransport) {
    BILLING_BRANDS.add(product);
  } else {
    markTestTransport(product);
  }
  return Object.freeze(product);
}

// Live registry builder: paginated inventory collectors per service where an
// authoritative list API exists, plus the Usage v2 billing provider, plus
// explicit limitations elsewhere. Never fabricates zero and never silently
// waives an uncovered metric.
// AI Search uses GET /accounts/{id}/ai-search/instances (never
// ai-search/indexes). R2 uses cursor pagination over result.buckets. Billing
// uses GET /accounts/{id}/billable/usage with account-bound from/to derived
// from the intended interval (month start through start-of-today at nowMs,
// never a future month end, never over 31 days) and the reviewed triple
// mapping. A registry-level billing failure (no entitlement etc.) gaps the
// declared billing covers in collectAccountUsage, leaving those metrics
// unknown rather than dropping the provider silently.
export function buildLiveProviderRegistry(options = {}) {
  const { accountId, nowMs = Date.now() } = options ?? {};
  if (typeof accountId !== "string" || accountId === "") {
    throw new UsageCollectionError("COLLECTION_INVALID", "accountId is required for the live registry");
  }
  // Live mode (no transport overrides): every product runs on the internal
  // default live transport, so every product is branded and production keeps
  // working byte-identically (default endpoints build the same account-bound
  // URLs from the collect-time accountId; the billing window defaults to the
  // same month-start through start-of-today interval). ANY caller-supplied
  // fetchImpl/apiBase/billableMetricMap key selects test mode: the legacy
  // explicit wiring below, whose products are functional but unbranded
  // test-only and can never carry authority.
  const testMode = callerSuppliedTransportKeys(options).length > 0;
  if (!testMode) {
    return [
      createPaginatedInventoryProvider({ group: "d1-inventory-list", covers: [] }),
      createR2CursorInventoryProvider({ group: "r2-inventory-list", covers: [] }),
      createPaginatedInventoryProvider({ group: "queue-inventory-list", covers: [] }),
      createAiSearchInventoryProvider({ group: "ai-search-inventory-list", covers: ["ai_search_instances"] }),
      createBillableUsageProvider({ group: "billable-usage", covers: [...BILLABLE_LIVE_COVERS] }),
    ];
  }
  const { fetchImpl = globalThis.fetch, apiBase = LIVE_API_BASE, billableMetricMap = REVIEWED_BILLABLE_TRIPLES } = options;
  const list = (service, page, perPage) =>
    `${apiBase}/accounts/${accountId}/${service}?page=${page}&per_page=${perPage}`;
  const r2CursorList = (id, cursor) =>
    cursor ? `${apiBase}/accounts/${id}/r2/buckets?cursor=${encodeURIComponent(cursor)}`
      : `${apiBase}/accounts/${id}/r2/buckets`;
  const clock = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
  const billableFrom = `${String(clock.getUTCFullYear()).padStart(4, "0")}-${String(clock.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const billableTo = new Date(Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), clock.getUTCDate())).toISOString().slice(0, 10);
  return [
    createPaginatedInventoryProvider({ group: "d1-inventory-list", covers: [], endpoint: (id, page, perPage) => list("d1/database", page, perPage), fetchImpl }),
    createR2CursorInventoryProvider({ group: "r2-inventory-list", covers: [], endpoint: r2CursorList, fetchImpl }),
    createPaginatedInventoryProvider({ group: "queue-inventory-list", covers: [], endpoint: (id, page, perPage) => list("queues", page, perPage), fetchImpl }),
    createAiSearchInventoryProvider({ group: "ai-search-inventory-list", covers: ["ai_search_instances"], endpoint: (id, page, perPage) => list("ai-search/instances", page, perPage), fetchImpl }),
    createBillableUsageProvider({
      group: "billable-usage",
      covers: [...BILLABLE_LIVE_COVERS],
      endpoint: (id, from, to) => `${apiBase}/accounts/${id}/billable/usage?from=${from}&to=${to}`,
      fetchImpl,
      metricMap: billableMetricMap,
      expectedWindow: { start: `${billableFrom}T00:00:00.000Z`, end: `${billableTo}T00:00:00.000Z` },
    }),
  ];
}
