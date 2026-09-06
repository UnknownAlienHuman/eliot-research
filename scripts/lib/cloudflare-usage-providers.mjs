// Usage providers: paginated/cursor inventory, AI Search instances,
// billing usage (FOCUS v2), GraphQL analytics. The bearer lives in process
// memory only and never reaches snapshots, receipts, logs, or errors; this
// module never reads CLOUDFLARE_API_TOKEN. Mocked shapes use only observed
// fields (success/result/result_info); safe receipts carry status/schema
// metadata only, never bodies or auth material.

import {
  METRIC_PROVENANCE,
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

// Structural account binding for provider URLs: the expected account must be
// the exact `/accounts/{accountId}/` path segment. Query/fragment laundering
// (expected ID in `?...=` while the path binds another account),
// ambiguity, and unparseable URLs all fail closed.
export function assertAccountUrl(url, accountId, group, context) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProviderFailure("MALFORMED", `${group} ${context} unparseable URL`);
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const index = segments.indexOf("accounts");
  if (index < 0 || segments[index + 1] !== accountId) {
    throw new ProviderFailure("ACCOUNT_MISMATCH", `${group} ${context} left the bound account`);
  }
}

function assertPlainResultInfo(raw, group, page, context, lastHttpStatus = null) {
  // Fail-closed presence check: explicit null is present-but-malformed, never
  // absent. Only truly absent (undefined) falls back to {} upstream.
  if (raw === undefined) return;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ProviderFailure("MALFORMED", `${group} page ${page} ${context} malformed`, { httpStatus: lastHttpStatus });
  }
}

// Fail-closed pagination field check: presence is tested FIRST (via
// !== undefined), then the value must be an exact in-domain integer.
// Present string/boolean/null/fraction/NaN/Infinity/negative/out-of-domain
// is typed MALFORMED, never silent-absent.
function assertPaginationField(info, name, min, group, page, lastHttpStatus) {
  if (info[name] === undefined) return;
  const value = info[name];
  if (!Number.isInteger(value) || value < min) {
    throw new ProviderFailure("MALFORMED", `${group} page ${page} bad ${name}`, { httpStatus: lastHttpStatus });
  }
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
      // Stable pagination metadata: drift, disappearance, or short cumulative
      // counts fail closed. Once an earlier page establishes a multi-page
      // walk, later pages must keep echoing the established metadata.
      const stable = {};
      const establishedMeta = new Set();
      let multiPageWalk = false;
      const requireStable = (name, value) => {
        if (!Number.isInteger(value)) {
          if (multiPageWalk && establishedMeta.has(name)) {
            throw new ProviderFailure("PARTIAL_PAGINATION", `${group} page ${page} ${name} disappeared`, { httpStatus: lastHttpStatus });
          }
          return;
        }
        if (stable[name] === undefined) stable[name] = value;
        if (stable[name] !== value) {
          throw new ProviderFailure("PARTIAL_PAGINATION", `${group} page ${page} ${name} drift`, { httpStatus: lastHttpStatus });
        }
        establishedMeta.add(name);
      };
      do {
        const url = endpoint(accountId, page, perPage);
        assertAccountUrl(url, accountId, group, `page ${page}`);
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
        assertPlainResultInfo(body?.result_info, group, page, "result_info", lastHttpStatus);
        const info = body?.result_info ?? {};
        // Pagination integers are fail-closed on PRESENCE first: any present
        // known key must be an exact in-domain integer, else MALFORMED.
        // Only truly absent (undefined) stays ignored-as-absent per contract.
        assertPaginationField(info, "page", 1, group, page, lastHttpStatus);
        assertPaginationField(info, "per_page", 1, group, page, lastHttpStatus);
        assertPaginationField(info, "total_pages", 1, group, page, lastHttpStatus);
        assertPaginationField(info, "count", 0, group, page, lastHttpStatus);
        assertPaginationField(info, "total_count", 0, group, page, lastHttpStatus);
        // Range backstop (subsumed by the presence-first checks above, kept
        // as defense): an in-domain violation is MALFORMED, never
        // fullAccount:true.
        if (Number.isInteger(info.total_pages) && info.total_pages < 1) {
          throw new ProviderFailure("MALFORMED", `${group} page ${page} bad total_pages`, { httpStatus: lastHttpStatus });
        }
        if (Number.isInteger(info.per_page) && info.per_page < 1) {
          throw new ProviderFailure("MALFORMED", `${group} page ${page} bad per_page`, { httpStatus: lastHttpStatus });
        }
        if (Number.isInteger(info.count) && info.count < 0) {
          throw new ProviderFailure("MALFORMED", `${group} page ${page} bad count`, { httpStatus: lastHttpStatus });
        }
        // Page echo: with pagination metadata, a missing/mismatched echo is wrong slice.
        // Once a multi-page walk is established, later pages must echo too:
        // metadata that disappears mid-walk fails closed (Luna case).
        const hasPaginationMeta = info.page !== undefined || info.per_page !== undefined ||
          info.count !== undefined || info.total_count !== undefined || info.total_pages !== undefined;
        if ((hasPaginationMeta || (page > 1 && multiPageWalk)) && info.page !== page) {
          throw new ProviderFailure("MALFORMED", `${group} page ${page} missing page echo`, { httpStatus: lastHttpStatus });
        }
        if (info.count !== undefined && info.count !== body.result.length) {
          throw new ProviderFailure("MALFORMED", `${group} page ${page} count echo mismatch`, { httpStatus: lastHttpStatus });
        }
        // Count echo semantics must not disappear mid-walk either (count
        // varies per page, so only presence is tracked, never stability).
        if (info.count !== undefined) {
          establishedMeta.add("count");
        } else if (page > 1 && multiPageWalk && establishedMeta.has("count")) {
          throw new ProviderFailure("PARTIAL_PAGINATION", `${group} page ${page} count echo disappeared`, { httpStatus: lastHttpStatus });
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
        // An implied totalPages>1 establishes a multi-page walk: every later
        // page must keep echoing the metadata above instead of going quiet.
        if (totalPages > 1) multiPageWalk = true;
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
        assertAccountUrl(url, accountId, group, `cursor hop ${hop}`);
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
        // Audit: result_info is only touched for its cursor here, but a
        // present-but-malformed result_info must still fail closed, never
        // read as absent (explicit null included).
        if (body?.result_info !== undefined && (body.result_info === null || typeof body.result_info !== "object" || Array.isArray(body.result_info))) {
          throw new ProviderFailure("MALFORMED", `${group} cursor hop ${hop} result_info malformed`, { httpStatus: lastHttpStatus });
        }
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
      // Totals seen on page 1 must stay visible: disappearance later fails closed.
      let sawTotalsOnFirstPage = false;
      const requireStable = (name, value) => {
        if (!Number.isInteger(value)) return;
        if (stable[name] === undefined) stable[name] = value;
        if (stable[name] !== value) {
          throw new ProviderFailure("PARTIAL_PAGINATION", `${group} page ${page} ${name} drift`, { httpStatus: lastHttpStatus });
        }
      };
      for (let hop = 0; hop < 50; hop += 1) {
        const url = endpoint(accountId, page, perPage);
        assertAccountUrl(url, accountId, group, `page ${page}`);
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
        assertPlainResultInfo(body?.result_info, group, page, "result_info", lastHttpStatus);
        assertPlainResultInfo(body?.pagination, group, page, "pagination", lastHttpStatus);
        // Presence before fallback: explicit null result_info is MALFORMED
        // (already thrown above), never a silent fallthrough to pagination.
        // Only truly absent (undefined) falls back.
        const info = body?.result_info !== undefined ? body.result_info
          : body?.pagination !== undefined ? body.pagination : {};
        // Same presence-first strict validation as the general provider.
        assertPaginationField(info, "page", 1, group, page, lastHttpStatus);
        assertPaginationField(info, "per_page", 1, group, page, lastHttpStatus);
        assertPaginationField(info, "total_pages", 1, group, page, lastHttpStatus);
        assertPaginationField(info, "count", 0, group, page, lastHttpStatus);
        assertPaginationField(info, "total_count", 0, group, page, lastHttpStatus);
        if (Number.isInteger(info.total_pages) && info.total_pages < 1) {
          throw new ProviderFailure("MALFORMED", `${group} page ${page} bad total_pages`, { httpStatus: lastHttpStatus });
        }
        if (Number.isInteger(info.per_page) && info.per_page < 1) {
          throw new ProviderFailure("MALFORMED", `${group} page ${page} bad per_page`, { httpStatus: lastHttpStatus });
        }
        if (Number.isInteger(info.count) && info.count < 0) {
          throw new ProviderFailure("MALFORMED", `${group} page ${page} bad count`, { httpStatus: lastHttpStatus });
        }
        // This API's own shape (result_info or pagination; D1 semantics not
        // forced): totals require a matching page echo, must not drift, and a
        // supplied total_count must equal the cumulative count. Termination is
        // decisive only: a short page WITHOUT totals (this shape carries no
        // other terminal signal) never proves full coverage, and totals that
        // disappear after page 1 fail closed instead of fullAccount:true.
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
        requireStable("per_page", info.per_page);
        requireStable("total_count", info.total_count);
        requireStable("total_pages", info.total_pages);
        const pageHasTotals = Number.isInteger(info.total_count) || Number.isInteger(info.total_pages);
        if (page === 1) {
          sawTotalsOnFirstPage = pageHasTotals;
        } else if (sawTotalsOnFirstPage && !pageHasTotals) {
          throw new ProviderFailure("PARTIAL_PAGINATION", `${group} page ${page} pagination totals disappeared`, { httpStatus: lastHttpStatus });
        }
        if (Number.isInteger(info.total_pages)) {
          totalPages = info.total_pages;
        } else if (Number.isInteger(info.total_count) && Number.isInteger(info.per_page)) {
          totalPages = info.total_count === 0 ? 1 : Math.ceil(info.total_count / Math.max(1, info.per_page));
        } else {
          // No totals on this shape: even a short page is
          // truncation-ambiguous (a boundary-sized page could hide a second
          // page), so completeness is unprovable and the walk fails closed.
          throw new ProviderFailure("PARTIAL_PAGINATION", `${group} page ${page} short page without totals proves no complete walk`, { httpStatus: lastHttpStatus });
        }
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
