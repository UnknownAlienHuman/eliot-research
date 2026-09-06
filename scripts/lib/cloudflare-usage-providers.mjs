// Usage providers: paginated/cursor inventory, AI Search instances,
// billing usage (FOCUS v2), GraphQL analytics. The bearer lives in process
// memory only and never reaches snapshots, receipts, logs, or errors; this
// module never reads CLOUDFLARE_API_TOKEN. Mocked shapes use only observed
// fields (success/result/result_info); safe receipts carry status/schema
// metadata only, never bodies or auth material.

import {
  CLOCK_SKEW_MS,
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

// Typed provider failure with a Luna unknown reason, so collectAccountUsage
// can poison only covered metrics and record safe metadata (no bodies).
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
// Every page must be success:true with an array result. D1-style pagination
// uses total_count/page/per_page safely: total_pages must match
// ceil(total_count/per_page), echoes must match, metadata must not drift, and
// the cumulative count must equal a supplied total_count — otherwise
// PARTIAL_PAGINATION/MALFORMED keeps covered metrics unknown. HTTP 401/403
// map to AUTH_SCOPE_DENIED, transport/5xx/429 to HTTP_ERROR, invalid JSON to
// MALFORMED, success:false to HTTP_ERROR.
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
      // Stable pagination metadata: drift or short cumulative counts fail closed.
      const stable = {};
      const requireStable = (name, value) => {
        if (!Number.isInteger(value)) return;
        if (stable[name] === undefined) stable[name] = value;
        if (stable[name] !== value) {
          throw new ProviderFailure("PARTIAL_PAGINATION", `${group} page ${page} ${name} drift`, { httpStatus: lastHttpStatus });
        }
      };
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
        // Page echo: with pagination metadata, a missing/mismatched echo is wrong slice.
        const hasPaginationMeta = info.page !== undefined || info.per_page !== undefined ||
          info.count !== undefined || info.total_count !== undefined || info.total_pages !== undefined;
        if (hasPaginationMeta && info.page !== page) {
          throw new ProviderFailure("MALFORMED", `${group} page ${page} missing page echo`, { httpStatus: lastHttpStatus });
        }
        if (info.count !== undefined && info.count !== body.result.length) {
          throw new ProviderFailure("MALFORMED", `${group} page ${page} count echo mismatch`, { httpStatus: lastHttpStatus });
        }
        const effectivePerPage = Number.isInteger(info.per_page) ? info.per_page : perPage;
        requireStable("per_page", info.per_page);
        requireStable("total_count", info.total_count);
        if (Number.isInteger(info.total_count) && info.total_count < 0) throw new ProviderFailure("MALFORMED", `${group} page ${page} bad total_count`, { httpStatus: lastHttpStatus });
        if (Number.isInteger(info.total_count)) {
          expectedPagesFromCount = info.total_count === 0 ? 1 : Math.ceil(info.total_count / Math.max(1, effectivePerPage));
        }
        requireStable("total_pages", info.total_pages);
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
          // No pagination metadata: only a single short page is admissible.
          // A full page without metadata cannot prove completeness.
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
      if (stable.total_count !== undefined && seen.length !== stable.total_count) {
        throw new ProviderFailure("PARTIAL_PAGINATION", `${group} cumulative count ${seen.length} vs total_count ${stable.total_count}`, { httpStatus: lastHttpStatus });
      }
      return {
        values: {},
        inventory: seen,
        coverage: { accountId, completedPages: pagesCompleted.length, totalPages, fullAccount: true },
        receiptMeta: safeFetchMeta({ httpStatus: lastHttpStatus, kind: "inventory-paginated", pages: `${pagesCompleted.length}/${totalPages}`, full: true, authoritative: false, reason: null }),
      };
    },
  };
}

// R2 bucket inventory over cursor pagination (NOT page/per_page):
// `result.buckets` plus an opaque next cursor. Inventory only, never
// counters: a repeated cursor, missing buckets array, or a loop ending
// without an empty terminal cursor keeps covered metrics unknown.
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
      // Only an explicit empty terminal cursor proves completion; the hop
      // cap with a pending cursor is truncation, never full coverage.
      let terminated = false;
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
        if (nextCursor === null || nextCursor === undefined || nextCursor === "") {
          terminated = true;
          break;
        }
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
      if (!terminated) {
        throw new ProviderFailure("PARTIAL_PAGINATION", `${group} cursor pagination hit the hop cap with a next cursor pending`, { httpStatus: lastHttpStatus });
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

// AI Search instance inventory: GET /accounts/{account_id}/ai-search/instances
// (never ai-search/indexes); success:true with an array result (or an object
// carrying instances). A complete walk yields authoritative_inventory for
// ai_search_instances; degraded:true keeps the count unknown (DEGRADED).
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
      const stable = {};
      const requireStable = (name, value) => {
        if (!Number.isInteger(value)) return;
        if (stable[name] === undefined) stable[name] = value;
        if (stable[name] !== value) {
          throw new ProviderFailure("PARTIAL_PAGINATION", `${group} page ${page} ${name} drift`, { httpStatus: lastHttpStatus });
        }
      };
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
        // This API's own shape (result_info or pagination; D1 semantics not
        // forced): totals require a matching page echo, must not drift, and a
        // supplied total_count must equal the cumulative count.
        if ((info.total_count !== undefined || info.total_pages !== undefined) && info.page !== page) {
          throw new ProviderFailure("MALFORMED", `${group} page ${page} missing page echo`, { httpStatus: lastHttpStatus });
        }
        if (info.page !== undefined && info.page !== page) {
          throw new ProviderFailure("MALFORMED", `${group} page ${page} page echo mismatch`, { httpStatus: lastHttpStatus });
        }
        if (info.count !== undefined && info.count !== items.length) {
          throw new ProviderFailure("MALFORMED", `${group} page ${page} count echo mismatch`, { httpStatus: lastHttpStatus });
        }
        if (Number.isInteger(info.total_count) && info.total_count < 0) throw new ProviderFailure("MALFORMED", `${group} page ${page} bad total_count`, { httpStatus: lastHttpStatus });
        requireStable("total_count", info.total_count);
        requireStable("total_pages", info.total_pages);
        if (Number.isInteger(info.total_pages)) {
          totalPages = info.total_pages;
        }
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
      if (stable.total_count !== undefined && seen.length !== stable.total_count) {
        throw new ProviderFailure("PARTIAL_PAGINATION", `${group} cumulative count ${seen.length} vs total_count ${stable.total_count}`, { httpStatus: lastHttpStatus });
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

// Billing usage provider: GET /accounts/{account_id}/billable/usage
// (Version 2, Alpha, Restricted; FinOps FOCUS v1.3 rows). Sends explicit
// from+to (month start through start-of-today; never a future month end,
// never over 31 days) and parses ONLY documented FOCUS fields. The retired
// synthetic {metric,unit,value} schema is MALFORMED. Every accepted row needs
// exact BillingAccountId identity plus real ChargePeriodStart/End evidence
// inside the queried interval; mapping binds a reviewed x_BillableMetricId
// AND ConsumedUnit pair (no bare-metric or display-name fallback). All other
// outcomes stay typed unknown. Receipts carry status/window metadata only.
const MAX_BILLING_QUERY_DAYS = 31;

function parseBillingTime(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function billingDayDate(millis) {
  return new Date(millis).toISOString().slice(0, 10);
}

export function createBillableUsageProvider({ group = "billable-usage", covers = [], endpoint, fetchImpl = fetch, metricMap = {}, expectedWindow = null } = {}) {
  if (typeof endpoint !== "function") throw new UsageCollectionError("COLLECTION_INVALID", "billable provider endpoint is required");
  return {
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
      if (expectedWindow !== null && expectedWindow !== undefined) {
        expectedStartMs = parseBillingTime(expectedWindow.start);
        expectedEndMs = parseBillingTime(expectedWindow.end);
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
      let url = endpoint(accountId, fromDate, toDate);
      if (typeof url !== "string" || !url.includes(accountId) || !url.includes("/billable/usage")) {
        throw new ProviderFailure("ACCOUNT_MISMATCH", `${group} left the bound billing endpoint`);
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
        response = await fetchImpl(url, { headers: { authorization: `Bearer ${bearer}` } });
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
      const allIntervals = [];
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
        const unit = row.ConsumedUnit;
        const quantity = row.ConsumedQuantity;
        if (typeof metricId !== "string" || metricId === "" || typeof unit !== "string" || unit === "") {
          throw new ProviderFailure("MALFORMED", `${group} usage row lacks metric/unit identity`, { httpStatus });
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
        // Reviewed ID+unit binding only: no bare-metric or display-name
        // fallback; an unknown pair fails closed instead of skipping usage.
        const mapped = metricMap[`${metricId}:${unit}`];
        if (mapped === undefined) {
          throw new ProviderFailure("MALFORMED", `${group} unknown billing metric/unit pair`, { httpStatus });
        }
        if (!REQUIRED_METRIC_KEYS.includes(mapped) || (scoped !== null && !scoped.has(mapped))) continue;
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
        allIntervals.push({ start: rowStartMs, end: rowEndMs });
        sums.set(mapped, (sums.get(mapped) ?? 0) + quantity);
      }
      if (allIntervals.length === 0) {
        throw new ProviderFailure("WINDOW_MISMATCH", `${group} empty usage result proves no complete window`, { httpStatus });
      }
      // Completeness: row evidence must continuously cover the queried
      // interval. Gaps are days without evidence, never zeros.
      allIntervals.sort((left, right) => left.start - right.start || left.end - right.end);
      let cursor = queryFromMs;
      for (const interval of allIntervals) {
        if (interval.start > cursor + CLOCK_SKEW_MS) throw new ProviderFailure("WINDOW_MISMATCH", `${group} partial usage interval`, { httpStatus });
        if (interval.end > cursor) cursor = interval.end;
      }
      if (cursor < queryToMs - CLOCK_SKEW_MS) throw new ProviderFailure("WINDOW_MISMATCH", `${group} partial usage interval`, { httpStatus });
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
}

// GraphQL analytics: operational evidence only, NEVER billing authority.
// Samples stay diagnostic with provenance analytics_nonbilling; errors,
// partial data, wrong account, and conflicts keep metrics unknown, never zero.
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
