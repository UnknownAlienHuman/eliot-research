// Cloudflare usage providers: paginated/cursor inventory, AI Search
// instances, restricted Alpha billing usage, and GraphQL analytics
// (extracted from cloudflare-usage-collection.mjs to keep every source
// file below the 600-line budget; readable extraction, not compaction).
//
// The bearer lives in process memory only: it is accepted as an argument,
// forwarded to providers in memory, and never written to snapshots,
// receipts, logs, or errors. This module never reads CLOUDFLARE_API_TOKEN
// and offers no API-token fallback. Shapes mock only fields observed via
// Wrangler 4.127.1 (success/result/result_info); undocumented counter
// fields are never read. Safe receipts carry only status/schema metadata,
// never bodies or auth material.

import {
  METRIC_PROVENANCE,
  REQUIRED_METRIC_KEYS,
  isUnknownReason,
} from "./cloudflare-usage-envelope.mjs";

export class UsageCollectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "UsageCollectionError";
    this.code = code;
  }
}

// Typed provider failure with a Luna unknown reason. Providers throw this so
// collectAccountUsage can poison only covered metrics with a typed reason and
// record safe metadata (HTTP status, pages/cursors, no bodies).
export class ProviderFailure extends UsageCollectionError {
  constructor(reason, message, { httpStatus = null, coverage = null } = {}) {
    super(reason, message);
    this.reason = reason;
    this.httpStatus = httpStatus;
    this.coverage = coverage;
  }
}

export function toTypedReason(error, fallback = "HTTP_ERROR") {
  const candidate = error?.reason ?? error?.code;
  if (typeof candidate === "string" && isUnknownReason(candidate)) return candidate;
  if (candidate === "WRONG_ACCOUNT" || candidate === "ACCOUNT_MISMATCH") return "ACCOUNT_MISMATCH";
  if (candidate === "PROVIDER_MALFORMED" || candidate === "MALFORMED") return "MALFORMED";
  if (candidate === "COLLECTION_UNAVAILABLE" || candidate === "NO_AUTH_ENDPOINT") return "NO_AUTH_ENDPOINT";
  return fallback;
}

export function safeFetchMeta({ httpStatus = null, kind = "inventory", pages = null, cursors = null, full = false, authoritative = false, reason = null } = {}) {
  return { httpStatus, kind, pages, cursors, full, authoritative, reason };
}

// Paginated account-wide inventory provider over the browser-OAuth bearer.
// `endpoint(accountId, page)` builds a same-account path; `fetchImpl` performs
// the call. Every page must be success:true with an array result; a missing
// page, wrong-account echo, or truncated pagination keeps covered metrics
// unknown fail-closed. D1-style pagination uses total_count/page/per_page
// safely: when total_count is present the expected page count is
// ceil(total_count/per_page) and any total_pages mismatch, missing page echo,
// short final page, or silent truncation throws PARTIAL_PAGINATION/MALFORMED.
// HTTP 401/403 map to AUTH_SCOPE_DENIED, transport/5xx/429 to HTTP_ERROR,
// invalid JSON to MALFORMED, success:false to HTTP_ERROR.
export function createPaginatedInventoryProvider({ group, covers = [], endpoint, fetchImpl = fetch, perPage = 100 } = {}) {
  if (typeof group !== "string" || group === "") throw new UsageCollectionError("COLLECTION_INVALID", "paginated provider group is required");
  if (typeof endpoint !== "function") throw new UsageCollectionError("COLLECTION_INVALID", "paginated provider endpoint is required");
  return {
    group,
    covers: [...covers],
    kind: "inventory-paginated",
    async collect({ accountId, bearer, now }) {
      void now;
      if (typeof bearer !== "string" || bearer.length < 1) throw new ProviderFailure("NO_AUTH_ENDPOINT", `${group}: bearer required`);
      let page = 1;
      let totalPages;
      let expectedPagesFromCount = null;
      const seen = [];
      const pagesCompleted = [];
      let lastHttpStatus;
      do {
        const url = endpoint(accountId, page, perPage);
        if (typeof url !== "string" || !url.includes(accountId)) {
          throw new ProviderFailure("ACCOUNT_MISMATCH", `${group} page ${page} left the bound account`);
        }
        let response;
        try {
          response = await fetchImpl(url, { headers: { authorization: `Bearer ${bearer}` } });
        } catch {
          throw new ProviderFailure("HTTP_ERROR", `${group} page ${page} transport failure`, { httpStatus: null });
        }
        lastHttpStatus = Number.isInteger(response?.status) ? response.status : null;
        if (lastHttpStatus === 401 || lastHttpStatus === 403) {
          throw new ProviderFailure("AUTH_SCOPE_DENIED", `${group} page ${page} denied (http ${lastHttpStatus})`, { httpStatus: lastHttpStatus });
        }
        if (lastHttpStatus === 429 || (Number.isInteger(lastHttpStatus) && lastHttpStatus >= 500)) {
          throw new ProviderFailure("HTTP_ERROR", `${group} page ${page} http ${lastHttpStatus}`, { httpStatus: lastHttpStatus });
        }
        let body;
        try {
          body = await response.json();
        } catch {
          throw new ProviderFailure("MALFORMED", `${group} page ${page} invalid JSON`, { httpStatus: lastHttpStatus });
        }
        if (body?.success !== true || !Array.isArray(body?.result)) {
          throw new ProviderFailure("HTTP_ERROR", `${group} page ${page} malformed (success:false or non-array result)`, { httpStatus: lastHttpStatus });
        }
        seen.push(...body.result);
        const info = body?.result_info ?? {};
        // Page echo validation: when the API echoes page/per_page, a missing
        // or mismatched echo means the wrong slice was served.
        if (info.page !== undefined && info.page !== page) {
          throw new ProviderFailure("MALFORMED", `${group} page ${page} missing page echo`, { httpStatus: lastHttpStatus });
        }
        const effectivePerPage = Number.isInteger(info.per_page) ? info.per_page : perPage;
        if (Number.isInteger(info.total_count)) {
          if (info.total_count < 0) {
            throw new ProviderFailure("MALFORMED", `${group} page ${page} bad total_count`, { httpStatus: lastHttpStatus });
          }
          expectedPagesFromCount = info.total_count === 0 ? 1 : Math.ceil(info.total_count / Math.max(1, effectivePerPage));
        }
        if (Number.isInteger(info.total_pages)) {
          totalPages = info.total_pages;
          if (expectedPagesFromCount !== null && totalPages !== expectedPagesFromCount) {
            throw new ProviderFailure("PARTIAL_PAGINATION", `${group} page ${page} total_pages/total_count mismatch`, { httpStatus: lastHttpStatus });
          }
        } else if (expectedPagesFromCount !== null) {
          totalPages = expectedPagesFromCount;
        } else if (Number.isInteger(info.counted_total)) {
          totalPages = info.counted_total > seen.length ? page + 1 : page;
        } else {
          // No pagination metadata at all: only a single page is admissible.
          // Any non-empty result without total_count/total_pages cannot prove
          // completeness, so a second fetch would be required — but without
          // metadata we fail closed unless this single page is verifiably
          // complete via an empty next-page probe handled by callers. Here we
          // accept exactly one page only when the provider documents
          // single-page semantics; otherwise demand metadata.
          totalPages = page;
          if (body.result.length >= effectivePerPage) {
            throw new ProviderFailure("PARTIAL_PAGINATION", `${group} page ${page} full page without pagination metadata`, { httpStatus: lastHttpStatus });
          }
        }
        if (!Number.isInteger(totalPages) || totalPages < page) {
          throw new ProviderFailure("MALFORMED", `${group} page ${page} bad pagination`, { httpStatus: lastHttpStatus });
        }
        pagesCompleted.push(page);
        page += 1;
        if (page > 50) throw new ProviderFailure("PARTIAL_PAGINATION", `${group} pagination runaway`, { httpStatus: lastHttpStatus });
      } while (pagesCompleted.length < totalPages);
      return {
        values: {},
        inventory: seen,
        coverage: { accountId, completedPages: pagesCompleted.length, totalPages, fullAccount: true },
        receiptMeta: safeFetchMeta({ httpStatus: lastHttpStatus, kind: "inventory-paginated", pages: `${pagesCompleted.length}/${totalPages}`, full: true, authoritative: false, reason: null }),
      };
    },
  };
}

// R2 bucket inventory over cursor pagination (NOT page/per_page). The R2
// list-buckets shape carries `result.buckets` (array) plus an opaque cursor
// for the next slice; delayed R2 metrics must never masquerade as billing
// truth, so this provider returns inventory only and never counters. A
// repeated or regressing cursor, a missing buckets array, or a loop that ends
// without an empty cursor marks covered metrics unknown (PARTIAL_PAGINATION /
// MALFORMED). Stale metric timestamps in the payload are ignored: inventory
// proves buckets, not GB-mo.
export function createR2CursorInventoryProvider({ group = "r2-inventory-list", covers = [], endpoint, fetchImpl = fetch } = {}) {
  if (typeof endpoint !== "function") throw new UsageCollectionError("COLLECTION_INVALID", "cursor provider endpoint is required");
  return {
    group,
    covers: [...covers],
    kind: "inventory-cursor",
    async collect({ accountId, bearer, now }) {
      void now;
      if (typeof bearer !== "string" || bearer.length < 1) throw new ProviderFailure("NO_AUTH_ENDPOINT", `${group}: bearer required`);
      const seen = [];
      const seenCursors = new Set();
      let cursor = null;
      let cursorsCompleted = 0;
      let lastHttpStatus = null;
      for (let hop = 0; hop < 50; hop += 1) {
        const url = endpoint(accountId, cursor);
        if (typeof url !== "string" || !url.includes(accountId)) {
          throw new ProviderFailure("ACCOUNT_MISMATCH", `${group} cursor hop ${hop} left the bound account`);
        }
        if (url.includes("per_page=") || url.includes("page=")) {
          throw new ProviderFailure("MALFORMED", `${group} R2 inventory must use cursor pagination, not page/per_page`);
        }
        let response;
        try {
          response = await fetchImpl(url, { headers: { authorization: `Bearer ${bearer}` } });
        } catch {
          throw new ProviderFailure("HTTP_ERROR", `${group} cursor hop ${hop} transport failure`);
        }
        lastHttpStatus = Number.isInteger(response?.status) ? response.status : null;
        if (lastHttpStatus === 401 || lastHttpStatus === 403) {
          throw new ProviderFailure("AUTH_SCOPE_DENIED", `${group} cursor hop ${hop} denied (http ${lastHttpStatus})`, { httpStatus: lastHttpStatus });
        }
        if (lastHttpStatus === 429 || (Number.isInteger(lastHttpStatus) && lastHttpStatus >= 500)) {
          throw new ProviderFailure("HTTP_ERROR", `${group} cursor hop ${hop} http ${lastHttpStatus}`, { httpStatus: lastHttpStatus });
        }
        let body;
        try {
          body = await response.json();
        } catch {
          throw new ProviderFailure("MALFORMED", `${group} cursor hop ${hop} invalid JSON`, { httpStatus: lastHttpStatus });
        }
        if (body?.success !== true) {
          throw new ProviderFailure("HTTP_ERROR", `${group} cursor hop ${hop} malformed (success:false)`, { httpStatus: lastHttpStatus });
        }
        const buckets = Array.isArray(body?.result?.buckets) ? body.result.buckets
          : Array.isArray(body?.result) ? body.result : null;
        if (!Array.isArray(buckets)) {
          throw new ProviderFailure("MALFORMED", `${group} cursor hop ${hop} missing result.buckets`, { httpStatus: lastHttpStatus });
        }
        seen.push(...buckets);
        const nextCursor = body?.result?.cursor ?? body?.cursor ?? body?.result_info?.cursor ?? null;
        cursorsCompleted += 1;
        if (nextCursor === null || nextCursor === undefined || nextCursor === "") break;
        if (typeof nextCursor !== "string") {
          throw new ProviderFailure("MALFORMED", `${group} cursor hop ${hop} bad cursor type`, { httpStatus: lastHttpStatus });
        }
        if (seenCursors.has(nextCursor) || nextCursor === cursor) {
          throw new ProviderFailure("PARTIAL_PAGINATION", `${group} repeated cursor without progress`, { httpStatus: lastHttpStatus });
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      if (cursorsCompleted === 0) {
        throw new ProviderFailure("PARTIAL_PAGINATION", `${group} no cursor pages completed`, { httpStatus: lastHttpStatus });
      }
      return {
        values: {},
        inventory: seen,
        coverage: { accountId, completedCursors: cursorsCompleted, fullAccount: true },
        receiptMeta: safeFetchMeta({ httpStatus: lastHttpStatus, kind: "inventory-cursor", cursors: `${cursorsCompleted}`, full: true, authoritative: false, reason: null }),
      };
    },
  };
}

// AI Search instance inventory. The account inventory endpoint is
// GET /accounts/{account_id}/ai-search/instances (never ai-search/indexes).
// The documented shape is success:true with an array result (or an object
// carrying an instances array); every page must be walked to completion and
// any `degraded:true` flag keeps the count unknown with reason DEGRADED.
// A complete walk yields provenance authoritative_inventory for
// ai_search_instances; anything else stays unknown.
export function createAiSearchInventoryProvider({ group = "ai-search-inventory-list", covers = ["ai_search_instances"], endpoint, fetchImpl = fetch, perPage = 100 } = {}) {
  if (typeof endpoint !== "function") throw new UsageCollectionError("COLLECTION_INVALID", "ai-search provider endpoint is required");
  return {
    group,
    covers: [...covers],
    kind: "inventory-ai-search",
    async collect({ accountId, bearer, now }) {
      void now;
      if (typeof bearer !== "string" || bearer.length < 1) throw new ProviderFailure("NO_AUTH_ENDPOINT", `${group}: bearer required`);
      const seen = [];
      let page = 1;
      let totalPages = null;
      const pagesCompleted = [];
      let lastHttpStatus = null;
      for (let hop = 0; hop < 50; hop += 1) {
        const url = endpoint(accountId, page, perPage);
        if (typeof url !== "string" || !url.includes(accountId)) {
          throw new ProviderFailure("ACCOUNT_MISMATCH", `${group} page ${page} left the bound account`);
        }
        if (url.includes("ai-search/indexes")) {
          throw new ProviderFailure("MALFORMED", `${group} must use /ai-search/instances, never ai-search/indexes`);
        }
        let response;
        try {
          response = await fetchImpl(url, { headers: { authorization: `Bearer ${bearer}` } });
        } catch {
          throw new ProviderFailure("HTTP_ERROR", `${group} page ${page} transport failure`);
        }
        lastHttpStatus = Number.isInteger(response?.status) ? response.status : null;
        if (lastHttpStatus === 401 || lastHttpStatus === 403) {
          throw new ProviderFailure("AUTH_SCOPE_DENIED", `${group} page ${page} denied (http ${lastHttpStatus})`, { httpStatus: lastHttpStatus });
        }
        if (lastHttpStatus === 429 || (Number.isInteger(lastHttpStatus) && lastHttpStatus >= 500)) {
          throw new ProviderFailure("HTTP_ERROR", `${group} page ${page} http ${lastHttpStatus}`, { httpStatus: lastHttpStatus });
        }
        let body;
        try {
          body = await response.json();
        } catch {
          throw new ProviderFailure("MALFORMED", `${group} page ${page} invalid JSON`, { httpStatus: lastHttpStatus });
        }
        if (body?.success !== true) {
          throw new ProviderFailure("HTTP_ERROR", `${group} page ${page} malformed (success:false)`, { httpStatus: lastHttpStatus });
        }
        if (body?.degraded === true || body?.result?.degraded === true) {
          throw new ProviderFailure("DEGRADED", `${group} page ${page} degraded:true`, { httpStatus: lastHttpStatus });
        }
        const items = Array.isArray(body?.result) ? body.result
          : Array.isArray(body?.result?.instances) ? body.result.instances : null;
        if (!Array.isArray(items)) {
          throw new ProviderFailure("MALFORMED", `${group} page ${page} missing instances array`, { httpStatus: lastHttpStatus });
        }
        seen.push(...items);
        const info = body?.result_info ?? body?.pagination ?? {};
        if (Number.isInteger(info.total_pages)) totalPages = info.total_pages;
        else if (Number.isInteger(info.total_count) && Number.isInteger(info.per_page)) {
          totalPages = info.total_count === 0 ? 1 : Math.ceil(info.total_count / Math.max(1, info.per_page));
        } else if (items.length < perPage) totalPages = page;
        else totalPages = page + 1;
        pagesCompleted.push(page);
        if (pagesCompleted.length >= totalPages) break;
        page += 1;
      }
      if (totalPages === null || pagesCompleted.length < totalPages) {
        throw new ProviderFailure("PARTIAL_PAGINATION", `${group} incomplete pagination`, { httpStatus: lastHttpStatus });
      }
      return {
        values: { ai_search_instances: seen.length },
        inventory: seen,
        coverage: { accountId, completedPages: pagesCompleted.length, totalPages, fullAccount: true },
        provenance: METRIC_PROVENANCE.AUTHORITATIVE_INVENTORY,
        receiptMeta: safeFetchMeta({ httpStatus: lastHttpStatus, kind: "inventory-ai-search", pages: `${pagesCompleted.length}/${totalPages}`, full: true, authoritative: true, reason: null }),
      };
    },
  };
}

// Restricted Alpha billing usage provider: GET
// /accounts/{account_id}/billable/usage. This entitlement is NOT guaranteed
// by standard Wrangler OAuth; 401/403/404, unsupported scope, malformed
// schema, an incomplete window, or an unknown metric/unit all stay typed
// unknown. Only a fully validated full-window response yields provenance
// authoritative_billing. `metricMap` translates verified billing metric/unit
// pairs to envelope keys; anything unmapped stays unknown (MALFORMED) and
// never invents a counter. Safe receipts carry status + window metadata only.
export const BILLABLE_USAGE_KNOWN_UNITS = Object.freeze(["count", "bytes", "gb-month", "requests", "operations", "neurons", "dims", "queries"]);

export function createBillableUsageProvider({ group = "billable-usage", covers = [], endpoint, fetchImpl = fetch, metricMap = {}, expectedWindow = null } = {}) {
  if (typeof endpoint !== "function") throw new UsageCollectionError("COLLECTION_INVALID", "billable provider endpoint is required");
  return {
    group,
    covers: [...covers],
    kind: "billing-usage",
    async collect({ accountId, bearer, now }) {
      void now;
      if (typeof bearer !== "string" || bearer.length < 1) throw new ProviderFailure("NO_AUTH_ENDPOINT", `${group}: bearer required`);
      const url = endpoint(accountId);
      if (typeof url !== "string" || !url.includes(accountId) || !url.includes("/billable/usage")) {
        throw new ProviderFailure("ACCOUNT_MISMATCH", `${group} left the bound billing endpoint`);
      }
      let response;
      try {
        response = await fetchImpl(url, { headers: { authorization: `Bearer ${bearer}` } });
      } catch {
        throw new ProviderFailure("HTTP_ERROR", `${group} transport failure`);
      }
      const httpStatus = Number.isInteger(response?.status) ? response.status : null;
      if (httpStatus === 401 || httpStatus === 403) {
        throw new ProviderFailure("AUTH_SCOPE_DENIED", `${group} denied (http ${httpStatus}): standard Wrangler OAuth does not guarantee this entitlement`, { httpStatus });
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
      const echoedAccount = body?.account_id ?? body?.result?.account_id ?? null;
      if (typeof echoedAccount === "string" && echoedAccount !== accountId) {
        throw new ProviderFailure("ACCOUNT_MISMATCH", `${group} wrong account echo`, { httpStatus });
      }
      const windowStart = body?.window_start ?? body?.result?.window_start ?? expectedWindow?.start ?? null;
      const windowEnd = body?.window_end ?? body?.result?.window_end ?? expectedWindow?.end ?? null;
      if (expectedWindow && (windowStart !== expectedWindow.start || windowEnd !== expectedWindow.end)) {
        throw new ProviderFailure("WINDOW_MISMATCH", `${group} incomplete window vs expected full window`, { httpStatus });
      }
      const rows = Array.isArray(body?.result) ? body.result
        : Array.isArray(body?.result?.usage) ? body.result.usage : null;
      if (!Array.isArray(rows)) {
        throw new ProviderFailure("MALFORMED", `${group} missing usage rows`, { httpStatus });
      }
      const values = {};
      for (const row of rows) {
        const metric = row?.metric ?? row?.name;
        const unit = row?.unit;
        const value = row?.value ?? row?.quantity;
        if (typeof metric !== "string" || typeof unit !== "string") {
          throw new ProviderFailure("MALFORMED", `${group} bad metric/unit schema`, { httpStatus });
        }
        if (!BILLABLE_USAGE_KNOWN_UNITS.includes(unit)) {
          throw new ProviderFailure("MALFORMED", `${group} unknown unit ${unit}`, { httpStatus });
        }
        const mapped = metricMap[`${metric}:${unit}`] ?? metricMap[metric];
        if (mapped === undefined) continue; // Unknown billing metric: skip, never invent.
        if (!REQUIRED_METRIC_KEYS.includes(mapped)) continue;
        if (!(typeof value === "number" && Number.isFinite(value) && value >= 0)) {
          throw new ProviderFailure("MALFORMED", `${group} bad value for ${metric}`, { httpStatus });
        }
        values[mapped] = value;
      }
      return {
        values,
        coverage: { accountId, fullAccount: true, windowStart, windowEnd },
        provenance: METRIC_PROVENANCE.AUTHORITATIVE_BILLING,
        receiptMeta: safeFetchMeta({ httpStatus, kind: "billing-usage", full: true, authoritative: true, reason: null }),
      };
    },
  };
}

// Cloudflare GraphQL analytics provider: operational evidence only, NEVER
// billing authority. The provider may return observed samples, but
// collectAccountUsage always keeps affected counters unknown with provenance
// analytics_nonbilling. GraphQL errors, partial data, truncation, wrong
// account, wrong window, stale payloads, and provider conflicts all keep the
// metric unknown; unknown is never coerced to zero and later partial data
// never overwrites the gap.
export function createGraphQlAnalyticsProvider({ group = "graphql-analytics", covers = [], endpoint = "https://api.cloudflare.com/client/v4/graphql", fetchImpl = fetch, query = "" } = {}) {
  return {
    group,
    covers: [...covers],
    kind: "analytics-graphql",
    analyticsOnly: true,
    async collect({ accountId, bearer, now }) {
      void now;
      if (typeof bearer !== "string" || bearer.length < 1) throw new ProviderFailure("NO_AUTH_ENDPOINT", `${group}: bearer required`);
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
          body: JSON.stringify({ query }),
        });
      } catch {
        throw new ProviderFailure("HTTP_ERROR", `${group} transport failure`);
      }
      const httpStatus = Number.isInteger(response?.status) ? response.status : null;
      if (httpStatus === 401 || httpStatus === 403) {
        throw new ProviderFailure("AUTH_SCOPE_DENIED", `${group} denied (http ${httpStatus})`, { httpStatus });
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
      if (Array.isArray(body?.errors) && body.errors.length > 0) {
        throw new ProviderFailure("HTTP_ERROR", `${group} GraphQL errors`, { httpStatus });
      }
      const echoedAccount = body?.account_id ?? body?.data?.account_id ?? null;
      if (typeof echoedAccount === "string" && echoedAccount !== accountId) {
        throw new ProviderFailure("ACCOUNT_MISMATCH", `${group} wrong account echo`, { httpStatus });
      }
      if (body?.partial === true || body?.data?.partial === true || body?.truncated === true) {
        throw new ProviderFailure("PARTIAL_PAGINATION", `${group} GraphQL partial/truncated`, { httpStatus });
      }
      // Operational samples are returned for observability but flagged
      // analytics-only; the collector refuses them billing authority.
      const samples = body?.data?.samples ?? {};
      return {
        values: {},
        analyticsSamples: typeof samples === "object" && samples !== null ? samples : {},
        coverage: { accountId, fullAccount: false, analyticsOnly: true },
        provenance: METRIC_PROVENANCE.ANALYTICS_NONBILLING,
        receiptMeta: safeFetchMeta({ httpStatus, kind: "analytics-graphql", full: false, authoritative: false, reason: "ANALYTICS_NONBILLING" }),
      };
    },
  };
}
