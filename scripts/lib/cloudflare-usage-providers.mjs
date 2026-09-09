// Usage providers: paginated/cursor inventory, AI Search instances,
// GraphQL analytics. The bearer lives in process memory only and never
// reaches snapshots, receipts, logs, or errors; this module never reads
// CLOUDFLARE_API_TOKEN. Mocked shapes use only observed fields
// (success/result/result_info); safe receipts carry status/schema
// metadata only, never bodies or auth material.
// Intrinsic independence: security decisions use only typeof/===/indexed-for.
// Object.keys output is untrusted: enumerated once per object, scanned with
// ===, read only on match. No Set/Map/has/add/includes/filter/map/spread.
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
export class ProviderFailure extends UsageCollectionError {
  constructor(reason, message, { httpStatus = null, coverage = null } = {}) {
    super(reason, message);
    this.reason = reason;
    this.httpStatus = httpStatus;
    this.coverage = coverage;
  }
}
export function toTypedReason(error, fallback = "HTTP_ERROR") {
  let candidate;
  if (error !== null && error !== undefined && typeof error === "object") {
    const keys = ownKeysOf(error);
    if (hasOwnKey(keys, "reason") && typeof error["reason"] === "string") candidate = error["reason"];
    else if (hasOwnKey(keys, "code") && typeof error["code"] === "string") candidate = error["code"];
    else candidate = undefined;
  } else candidate = undefined;
  if (typeof candidate === "string" && isUnknownReason(candidate)) return candidate;
  if (candidate === "WRONG_ACCOUNT" || candidate === "ACCOUNT_MISMATCH") return "ACCOUNT_MISMATCH";
  if (candidate === "PROVIDER_MALFORMED" || candidate === "MALFORMED") return "MALFORMED";
  if (candidate === "COLLECTION_UNAVAILABLE" || candidate === "NO_AUTH_ENDPOINT") return "NO_AUTH_ENDPOINT";
  return fallback;
}
export function safeFetchMeta({ httpStatus = null, kind = "inventory", pages = null, cursors = null, full = false, authoritative = false, reason = null } = {}) {
  return { httpStatus, kind, pages, cursors, full, authoritative, reason };
}
function ownKeysOf(value) {
  if (value === null || value === undefined || typeof value !== "object") return [];
  let keys;
  try { keys = Object.keys(value); } catch { return []; }
  if (keys === null || keys === undefined || typeof keys !== "object" || typeof keys.length !== "number") return [];
  return keys;
}
function hasOwnKey(keys, name) {
  for (let i = 0; i < keys.length; i += 1) { if (keys[i] === name) return true; }
  return false;
}
function readOwn(value, keys, name) {
  if (!hasOwnKey(keys, name)) return undefined;
  return value[name];
}
function hasSub(haystack, needle) {
  if (typeof haystack !== "string" || typeof needle !== "string" || needle === "") return false;
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    let match = true;
    for (let j = 0; j < needle.length; j += 1) { if (haystack[i + j] !== needle[j]) { match = false; break; } }
    if (match) return true;
  }
  return false;
}
function indexOfExact(list, name) {
  for (let i = 0; i < list.length; i += 1) { if (list[i] === name) return i; }
  return -1;
}
function copyCovers(covers) {
  const out = [];
  if (covers === null || covers === undefined || typeof covers !== "object" || typeof covers.length !== "number") return out;
  for (let i = 0; i < covers.length; i += 1) { out[out.length] = covers[i]; }
  return out;
}
function readStatus(response) {
  if (response === null || response === undefined || typeof response !== "object") return null;
  const keys = ownKeysOf(response);
  const status = readOwn(response, keys, "status");
  return Number.isInteger(status) ? status : null;
}
const DEFAULT_IDENTITY_FIELDS = Object.freeze(["id", "uuid", "name"]);
const QUEUE_IDENTITY_FIELDS = Object.freeze(["queue_id", "queue_name"]);

function identityFieldsForGroup(group) {
  return group === "queue-inventory-list" ? QUEUE_IDENTITY_FIELDS : DEFAULT_IDENTITY_FIELDS;
}

function appendValidatedRow(seen, row, group, context, lastHttpStatus, identityFields = DEFAULT_IDENTITY_FIELDS) {
  if (row === null || row === undefined || typeof row !== "object" || Array.isArray(row)) { throw new ProviderFailure("MALFORMED", `${group} ${context} bad row`, { httpStatus: lastHttpStatus }); }
  const keys = ownKeysOf(row);
  const names = identityFields;
  let hasIdentity = false;
  for (let i = 0; i < names.length; i += 1) {
    const field = names[i];
    if (hasOwnKey(keys, field) && typeof row[field] === "string") {
      hasIdentity = true;
      const value = row[field];
      for (let s = 0; s < seen.length; s += 1) {
        const prev = seen[s];
        if (prev === null || prev === undefined || typeof prev !== "object" || Array.isArray(prev)) continue;
        const prevKeys = ownKeysOf(prev);
        if (hasOwnKey(prevKeys, field) && prev[field] === value) { throw new ProviderFailure("MALFORMED", `${group} ${context} duplicate identity`, { httpStatus: lastHttpStatus }); }
      }
    }
  }
  if (hasIdentity) { seen[seen.length] = row; return; }
  throw new ProviderFailure("MALFORMED", `${group} ${context} row without string identity`, { httpStatus: lastHttpStatus });
}
function appendRows(seen, rows, group, context, lastHttpStatus, identityFields = DEFAULT_IDENTITY_FIELDS) {
  if (rows === null || rows === undefined || typeof rows !== "object" || typeof rows.length !== "number" || !Array.isArray(rows)) { throw new ProviderFailure("MALFORMED", `${group} ${context} missing rows array`, { httpStatus: lastHttpStatus }); }
  for (let i = 0; i < rows.length; i += 1) { appendValidatedRow(seen, rows[i], group, context, lastHttpStatus, identityFields); }
}
export function assertAccountUrl(url, accountId, group, context) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProviderFailure("MALFORMED", `${group} ${context} unparseable URL`);
  }
  if (typeof accountId !== "string" || accountId === "" || accountId === "accounts") { throw new ProviderFailure("ACCOUNT_MISMATCH", `${group} ${context} left the bound account`); }
  const path = parsed.pathname;
  if (typeof path !== "string") throw new ProviderFailure("MALFORMED", `${group} ${context} unparseable URL`);
  const segments = [];
  let current = "";
  for (let i = 0; i < path.length; i += 1) {
    const ch = path[i];
    if (ch === "/") { if (current !== "") { segments[segments.length] = current; current = ""; } }
    else { current = current + ch; }
  }
  if (current !== "") segments[segments.length] = current;
  let at = -1;
  let count = 0;
  for (let i = 0; i < segments.length; i += 1) { if (segments[i] === "accounts") { if (at < 0) at = i; count += 1; } }
  if (at < 0 || count !== 1 || at + 1 >= segments.length || segments[at + 1] !== accountId) { throw new ProviderFailure("ACCOUNT_MISMATCH", `${group} ${context} left the bound account`); }
}
function assertPlainResultInfo(raw, group, page, context, lastHttpStatus = null) {
  if (raw === undefined) return;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) { throw new ProviderFailure("MALFORMED", `${group} page ${page} ${context} malformed`, { httpStatus: lastHttpStatus }); }
}
export function createPaginatedInventoryProvider({ group, covers = [], endpoint, fetchImpl = fetch, perPage = 100 } = {}) {
  if (typeof group !== "string" || group === "") throw new UsageCollectionError("COLLECTION_INVALID", "paginated provider group is required");
  if (typeof endpoint !== "function") throw new UsageCollectionError("COLLECTION_INVALID", "paginated provider endpoint is required");
  return {
    group,
    covers: copyCovers(covers),
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
      const stableNames = [];
      const stableValues = [];
      const stableGet = (name) => {
        const at = indexOfExact(stableNames, name);
        return at >= 0 ? stableValues[at] : undefined;
      };
      const stableSet = (name, value) => {
        const at = indexOfExact(stableNames, name);
        if (at >= 0) stableValues[at] = value;
        else { stableNames[stableNames.length] = name; stableValues[stableValues.length] = value; }
      };
      const establishedNames = [];
      let multiPageWalk = false;
      const isEstablished = (name) => indexOfExact(establishedNames, name) >= 0;
      const requireStable = (name, value) => {
        if (!Number.isInteger(value)) {
          if (multiPageWalk && isEstablished(name)) throw new ProviderFailure("PARTIAL_PAGINATION", `${group} page ${page} ${name} disappeared`, { httpStatus: lastHttpStatus });
          return;
        }
        const current = stableGet(name);
        if (current === undefined) stableSet(name, value);
        if (stableGet(name) !== value) throw new ProviderFailure("PARTIAL_PAGINATION", `${group} page ${page} ${name} drift`, { httpStatus: lastHttpStatus });
        if (!isEstablished(name)) establishedNames[establishedNames.length] = name;
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
        lastHttpStatus = readStatus(response);
        if (lastHttpStatus === 401 || lastHttpStatus === 403) { throw new ProviderFailure("AUTH_SCOPE_DENIED", `${group} page ${page} denied (http ${lastHttpStatus})`, { httpStatus: lastHttpStatus }); }
        if (lastHttpStatus === 429 || (Number.isInteger(lastHttpStatus) && lastHttpStatus >= 500)) { throw new ProviderFailure("HTTP_ERROR", `${group} page ${page} http ${lastHttpStatus}`, { httpStatus: lastHttpStatus }); }
        let body;
        try {
          body = await response.json();
        } catch {
          throw new ProviderFailure("MALFORMED", `${group} page ${page} invalid JSON`, { httpStatus: lastHttpStatus });
        }
        if (body === null || body === undefined || typeof body !== "object" || Array.isArray(body)) { throw new ProviderFailure("HTTP_ERROR", `${group} page ${page} malformed (success:false or non-array result)`, { httpStatus: lastHttpStatus }); }
        const bodyKeys = ownKeysOf(body);
        const successOwn = readOwn(body, bodyKeys, "success");
        const resultOwn = readOwn(body, bodyKeys, "result");
        if (successOwn !== true || resultOwn === null || resultOwn === undefined || typeof resultOwn !== "object" || !Array.isArray(resultOwn)) { throw new ProviderFailure("HTTP_ERROR", `${group} page ${page} malformed (success:false or non-array result)`, { httpStatus: lastHttpStatus }); }
        appendRows(seen, resultOwn, group, `page ${page}`, lastHttpStatus, identityFieldsForGroup(group));
        const resultInfoRaw = readOwn(body, bodyKeys, "result_info");
        assertPlainResultInfo(resultInfoRaw, group, page, "result_info", lastHttpStatus);
        const info = {};
        const infoKeysWanted = ["page", "per_page", "total_pages", "count", "total_count", "counted_total"];
        if (resultInfoRaw !== undefined) {
          if (resultInfoRaw === null || typeof resultInfoRaw !== "object" || Array.isArray(resultInfoRaw)) { throw new ProviderFailure("MALFORMED", `${group} page ${page} result_info malformed`, { httpStatus: lastHttpStatus }); }
          const rawKeys = ownKeysOf(resultInfoRaw);
          for (let i = 0; i < infoKeysWanted.length; i += 1) { if (hasOwnKey(rawKeys, infoKeysWanted[i])) info[infoKeysWanted[i]] = resultInfoRaw[infoKeysWanted[i]]; }
        }
        const infoKeys = ownKeysOf(info);
        const hasInfo = (n) => hasOwnKey(infoKeys, n);
        const valInfo = (n) => (hasInfo(n) ? info[n] : undefined);
        const checkField = (name, min) => {
          if (!hasInfo(name)) return;
          const value = valInfo(name);
          if (!Number.isInteger(value) || value < min) { throw new ProviderFailure("MALFORMED", `${group} page ${page} bad ${name}`, { httpStatus: lastHttpStatus }); }
        };
        checkField("page", 1);
        checkField("per_page", 1);
        checkField("total_pages", 1);
        checkField("count", 0);
        checkField("total_count", 0);
        const pageOwn = valInfo("page");
        const perPageOwn = valInfo("per_page");
        const totalPagesOwn = valInfo("total_pages");
        const countOwn = valInfo("count");
        const totalCountOwn = valInfo("total_count");
        const countedTotalOwn = valInfo("counted_total");
        if (Number.isInteger(totalPagesOwn) && totalPagesOwn < 1) { throw new ProviderFailure("MALFORMED", `${group} page ${page} bad total_pages`, { httpStatus: lastHttpStatus }); }
        if (Number.isInteger(perPageOwn) && perPageOwn < 1) { throw new ProviderFailure("MALFORMED", `${group} page ${page} bad per_page`, { httpStatus: lastHttpStatus }); }
        if (Number.isInteger(countOwn) && countOwn < 0) { throw new ProviderFailure("MALFORMED", `${group} page ${page} bad count`, { httpStatus: lastHttpStatus }); }
        const hasPaginationMeta = hasInfo("page") || hasInfo("per_page") || hasInfo("count") || hasInfo("total_count") || hasInfo("total_pages");
        if ((hasPaginationMeta || (page > 1 && multiPageWalk)) && pageOwn !== page) { throw new ProviderFailure("MALFORMED", `${group} page ${page} missing page echo`, { httpStatus: lastHttpStatus }); }
        if (hasInfo("count") && countOwn !== resultOwn.length) { throw new ProviderFailure("MALFORMED", `${group} page ${page} count echo mismatch`, { httpStatus: lastHttpStatus }); }
        if (hasInfo("count")) { if (!isEstablished("count")) establishedNames[establishedNames.length] = "count"; }
        else if (page > 1 && multiPageWalk && isEstablished("count")) { throw new ProviderFailure("PARTIAL_PAGINATION", `${group} page ${page} count echo disappeared`, { httpStatus: lastHttpStatus }); }
        const effectivePerPage = Number.isInteger(perPageOwn) ? perPageOwn : perPage;
        requireStable("per_page", perPageOwn);
        requireStable("total_count", totalCountOwn);
        if (Number.isInteger(totalCountOwn) && totalCountOwn < 0) throw new ProviderFailure("MALFORMED", `${group} page ${page} bad total_count`, { httpStatus: lastHttpStatus });
        if (Number.isInteger(totalCountOwn)) { expectedPagesFromCount = totalCountOwn === 0 ? 1 : Math.ceil(totalCountOwn / Math.max(1, effectivePerPage)); }
        requireStable("total_pages", totalPagesOwn);
        if (Number.isInteger(totalPagesOwn)) {
          totalPages = totalPagesOwn;
          if (expectedPagesFromCount !== null && totalPages !== expectedPagesFromCount) { throw new ProviderFailure("PARTIAL_PAGINATION", `${group} page ${page} total_pages/total_count mismatch`, { httpStatus: lastHttpStatus }); }
        } else if (expectedPagesFromCount !== null) { totalPages = expectedPagesFromCount; }
        else if (Number.isInteger(countedTotalOwn)) { totalPages = countedTotalOwn > seen.length ? page + 1 : page; }
        else {
          totalPages = page;
          if (resultOwn.length >= effectivePerPage) { throw new ProviderFailure("PARTIAL_PAGINATION", `${group} page ${page} full page without pagination metadata`, { httpStatus: lastHttpStatus }); }
        }
        if (!Number.isInteger(totalPages) || totalPages < page) { throw new ProviderFailure("MALFORMED", `${group} page ${page} bad pagination`, { httpStatus: lastHttpStatus }); }
        if (totalPages > 1) multiPageWalk = true;
        pagesCompleted[pagesCompleted.length] = page;
        page += 1;
        if (page > 50) throw new ProviderFailure("PARTIAL_PAGINATION", `${group} pagination runaway`, { httpStatus: lastHttpStatus });
      } while (pagesCompleted.length < totalPages);
      const stableTotal = stableGet("total_count");
      if (stableTotal !== undefined && seen.length !== stableTotal) { throw new ProviderFailure("PARTIAL_PAGINATION", `${group} cumulative count ${seen.length} vs total_count ${stableTotal}`, { httpStatus: lastHttpStatus }); }
      return {
        values: {},
        inventory: seen,
        coverage: { accountId, completedPages: pagesCompleted.length, totalPages, fullAccount: true },
        provenance: METRIC_PROVENANCE.AUTHORITATIVE_INVENTORY,
        receiptMeta: safeFetchMeta({ httpStatus: lastHttpStatus, kind: "inventory-paginated", pages: `${pagesCompleted.length}/${totalPages}`, full: true, authoritative: true, reason: null }),
      };
    },
  };
}
export function createR2CursorInventoryProvider({ group = "r2-inventory-list", covers = [], endpoint, fetchImpl = fetch } = {}) {
  if (typeof endpoint !== "function") throw new UsageCollectionError("COLLECTION_INVALID", "cursor provider endpoint is required");
  return {
    group,
    covers: copyCovers(covers),
    kind: "inventory-cursor",
    async collect({ accountId, bearer, now }) {
      void now;
      if (typeof bearer !== "string" || bearer.length < 1) throw new ProviderFailure("NO_AUTH_ENDPOINT", `${group}: bearer required`);
      const seen = [];
      const seenCursorList = [];
      let cursor = null;
      let cursorsCompleted = 0;
      let lastHttpStatus = null;
      let terminated = false;
      for (let hop = 0; hop < 50; hop += 1) {
        const url = endpoint(accountId, cursor);
        assertAccountUrl(url, accountId, group, `cursor hop ${hop}`);
        if (typeof url !== "string" || hasSub(url, "per_page=") || hasSub(url, "page=")) { throw new ProviderFailure("MALFORMED", `${group} R2 inventory must use cursor pagination, not page/per_page`); }
        let response;
        try {
          response = await fetchImpl(url, { headers: { authorization: `Bearer ${bearer}` } });
        } catch {
          throw new ProviderFailure("HTTP_ERROR", `${group} cursor hop ${hop} transport failure`);
        }
        lastHttpStatus = readStatus(response);
        if (lastHttpStatus === 401 || lastHttpStatus === 403) { throw new ProviderFailure("AUTH_SCOPE_DENIED", `${group} cursor hop ${hop} denied (http ${lastHttpStatus})`, { httpStatus: lastHttpStatus }); }
        if (lastHttpStatus === 429 || (Number.isInteger(lastHttpStatus) && lastHttpStatus >= 500)) { throw new ProviderFailure("HTTP_ERROR", `${group} cursor hop ${hop} http ${lastHttpStatus}`, { httpStatus: lastHttpStatus }); }
        let body;
        try {
          body = await response.json();
        } catch {
          throw new ProviderFailure("MALFORMED", `${group} cursor hop ${hop} invalid JSON`, { httpStatus: lastHttpStatus });
        }
        if (body === null || body === undefined || typeof body !== "object" || Array.isArray(body)) { throw new ProviderFailure("HTTP_ERROR", `${group} cursor hop ${hop} malformed (success:false)`, { httpStatus: lastHttpStatus }); }
        const bKeys = ownKeysOf(body);
        if (readOwn(body, bKeys, "success") !== true) { throw new ProviderFailure("HTTP_ERROR", `${group} cursor hop ${hop} malformed (success:false)`, { httpStatus: lastHttpStatus }); }
        const resultOwn = readOwn(body, bKeys, "result");
        let buckets = null;
        if (resultOwn !== null && resultOwn !== undefined && typeof resultOwn === "object" && !Array.isArray(resultOwn)) {
          const rKeys = ownKeysOf(resultOwn);
          const bucketsOwn = readOwn(resultOwn, rKeys, "buckets");
          if (bucketsOwn !== undefined) buckets = bucketsOwn;
          else buckets = null;
        } else if (Array.isArray(resultOwn)) { buckets = resultOwn; }
        appendRows(seen, buckets, group, `cursor hop ${hop}`, lastHttpStatus);
        if (hasOwnKey(bKeys, "result_info")) {
          const riRaw = body["result_info"];
          if (riRaw === null || typeof riRaw !== "object" || Array.isArray(riRaw)) { throw new ProviderFailure("MALFORMED", `${group} cursor hop ${hop} result_info malformed`, { httpStatus: lastHttpStatus }); }
        }
        let nextCursor = null;
        let nextFound = false;
        if (resultOwn !== null && resultOwn !== undefined && typeof resultOwn === "object" && !Array.isArray(resultOwn)) {
          const rKeys = ownKeysOf(resultOwn);
          if (hasOwnKey(rKeys, "cursor")) { nextCursor = resultOwn["cursor"]; nextFound = true; }
        }
        if (!nextFound && hasOwnKey(bKeys, "cursor")) { nextCursor = body["cursor"]; nextFound = true; }
        if (!nextFound && hasOwnKey(bKeys, "result_info")) {
          const ri = body["result_info"];
          if (ri !== null && typeof ri === "object" && !Array.isArray(ri)) {
            const riKeys = ownKeysOf(ri);
            if (hasOwnKey(riKeys, "cursor")) { nextCursor = ri["cursor"]; nextFound = true; }
          }
        }
        if (!nextFound) nextCursor = null;
        cursorsCompleted += 1;
        if (nextCursor === null || nextCursor === undefined || nextCursor === "") { terminated = true; break; }
        if (typeof nextCursor !== "string") { throw new ProviderFailure("MALFORMED", `${group} cursor hop ${hop} bad cursor type`, { httpStatus: lastHttpStatus }); }
        if (indexOfExact(seenCursorList, nextCursor) >= 0 || nextCursor === cursor) { throw new ProviderFailure("PARTIAL_PAGINATION", `${group} repeated cursor without progress`, { httpStatus: lastHttpStatus }); }
        seenCursorList[seenCursorList.length] = nextCursor;
        cursor = nextCursor;
      }
      if (cursorsCompleted === 0) { throw new ProviderFailure("PARTIAL_PAGINATION", `${group} no cursor pages completed`, { httpStatus: lastHttpStatus }); }
      if (!terminated) { throw new ProviderFailure("PARTIAL_PAGINATION", `${group} cursor pagination hit the hop cap with a next cursor pending`, { httpStatus: lastHttpStatus }); }
      return {
        values: {},
        inventory: seen,
        coverage: { accountId, completedCursors: cursorsCompleted, fullAccount: true },
        provenance: METRIC_PROVENANCE.AUTHORITATIVE_INVENTORY,
        receiptMeta: safeFetchMeta({ httpStatus: lastHttpStatus, kind: "inventory-cursor", cursors: `${cursorsCompleted}`, full: true, authoritative: true, reason: null }),
      };
    },
  };
}
export function createAiSearchInventoryProvider({ group = "ai-search-inventory-list", covers = ["ai_search_instances"], endpoint, fetchImpl = fetch, perPage = 100 } = {}) {
  if (typeof endpoint !== "function") throw new UsageCollectionError("COLLECTION_INVALID", "ai-search provider endpoint is required");
  return {
    group,
    covers: copyCovers(covers),
    kind: "inventory-ai-search",
    async collect({ accountId, bearer, now }) {
      void now;
      if (typeof bearer !== "string" || bearer.length < 1) throw new ProviderFailure("NO_AUTH_ENDPOINT", `${group}: bearer required`);
      const seen = [];
      let page = 1;
      let totalPages = null;
      const pagesCompleted = [];
      let lastHttpStatus = null;
      const stableNames = [];
      const stableValues = [];
      const stableAiGet = (name) => {
        const at = indexOfExact(stableNames, name);
        return at >= 0 ? stableValues[at] : undefined;
      };
      const stableAiSet = (name, value) => {
        const at = indexOfExact(stableNames, name);
        if (at >= 0) stableValues[at] = value;
        else { stableNames[stableNames.length] = name; stableValues[stableValues.length] = value; }
      };
      const establishedNames = [];
      const establishedSources = [];
      const estIndex = (name) => indexOfExact(establishedNames, name);
      const estSourceOf = (name) => {
        const i = estIndex(name);
        return i >= 0 ? establishedSources[i] : "unknown";
      };
      const markEstablished = (name, source) => { if (estIndex(name) < 0) { establishedNames[establishedNames.length] = name; establishedSources[establishedSources.length] = source; } };
      const requireStable = (name, value, source) => {
        if (!Number.isInteger(value)) {
          if (estIndex(name) >= 0) { throw new ProviderFailure("PARTIAL_PAGINATION", `${group} page ${page} ${name} disappeared${estSourceOf(name) !== source ? ` via container switch ${estSourceOf(name)}->${source}` : ""}`, { httpStatus: lastHttpStatus }); }
          return;
        }
        const current = stableAiGet(name);
        if (current === undefined) stableAiSet(name, value);
        if (stableAiGet(name) !== value) throw new ProviderFailure("PARTIAL_PAGINATION", `${group} page ${page} ${name} drift`, { httpStatus: lastHttpStatus });
        markEstablished(name, source);
      };
      for (let hop = 0; hop < 50; hop += 1) {
        const url = endpoint(accountId, page, perPage);
        assertAccountUrl(url, accountId, group, `page ${page}`);
        if (typeof url !== "string" || hasSub(url, "ai-search/indexes")) { throw new ProviderFailure("MALFORMED", `${group} must use /ai-search/instances, never ai-search/indexes`); }
        let response;
        try {
          response = await fetchImpl(url, { headers: { authorization: `Bearer ${bearer}` } });
        } catch {
          throw new ProviderFailure("HTTP_ERROR", `${group} page ${page} transport failure`);
        }
        lastHttpStatus = readStatus(response);
        if (lastHttpStatus === 401 || lastHttpStatus === 403) { throw new ProviderFailure("AUTH_SCOPE_DENIED", `${group} page ${page} denied (http ${lastHttpStatus})`, { httpStatus: lastHttpStatus }); }
        if (lastHttpStatus === 429 || (Number.isInteger(lastHttpStatus) && lastHttpStatus >= 500)) { throw new ProviderFailure("HTTP_ERROR", `${group} page ${page} http ${lastHttpStatus}`, { httpStatus: lastHttpStatus }); }
        let body;
        try {
          body = await response.json();
        } catch {
          throw new ProviderFailure("MALFORMED", `${group} page ${page} invalid JSON`, { httpStatus: lastHttpStatus });
        }
        if (body === null || body === undefined || typeof body !== "object" || Array.isArray(body)) { throw new ProviderFailure("HTTP_ERROR", `${group} page ${page} malformed (success:false)`, { httpStatus: lastHttpStatus }); }
        const aKeys = ownKeysOf(body);
        if (readOwn(body, aKeys, "success") !== true) { throw new ProviderFailure("HTTP_ERROR", `${group} page ${page} malformed (success:false)`, { httpStatus: lastHttpStatus }); }
        let degradedOwn = false;
        if (hasOwnKey(aKeys, "degraded") && body["degraded"] === true) degradedOwn = true;
        const resultOwn = readOwn(body, aKeys, "result");
        if (resultOwn !== null && resultOwn !== undefined && typeof resultOwn === "object" && !Array.isArray(resultOwn)) {
          const rKeys = ownKeysOf(resultOwn);
          if (hasOwnKey(rKeys, "degraded") && resultOwn["degraded"] === true) degradedOwn = true;
        }
        if (degradedOwn) { throw new ProviderFailure("DEGRADED", `${group} page ${page} degraded:true`, { httpStatus: lastHttpStatus }); }
        let items = null;
        if (Array.isArray(resultOwn)) { items = resultOwn; }
        else if (resultOwn !== null && resultOwn !== undefined && typeof resultOwn === "object" && !Array.isArray(resultOwn)) {
          const rKeys = ownKeysOf(resultOwn);
          const instancesOwn = readOwn(resultOwn, rKeys, "instances");
          if (Array.isArray(instancesOwn)) items = instancesOwn;
        }
        appendRows(seen, items === null ? null : items, group, `page ${page}`, lastHttpStatus);
        if (!Array.isArray(items)) { throw new ProviderFailure("MALFORMED", `${group} page ${page} missing instances array`, { httpStatus: lastHttpStatus }); }
        const itemsLength = items.length;
        if (hasOwnKey(aKeys, "result_info")) assertPlainResultInfo(body["result_info"], group, page, "result_info", lastHttpStatus);
        else assertPlainResultInfo(undefined, group, page, "result_info", lastHttpStatus);
        if (hasOwnKey(aKeys, "pagination")) assertPlainResultInfo(body["pagination"], group, page, "pagination", lastHttpStatus);
        else assertPlainResultInfo(undefined, group, page, "pagination", lastHttpStatus);
        const wanted = ["page", "per_page", "total_pages", "count", "total_count"];
        const resultInfoVals = {};
        const paginationVals = {};
        if (hasOwnKey(aKeys, "result_info")) {
          const raw = body["result_info"];
          const rawKeys = ownKeysOf(raw);
          for (let i = 0; i < wanted.length; i += 1) { if (hasOwnKey(rawKeys, wanted[i])) resultInfoVals[wanted[i]] = raw[wanted[i]]; }
        }
        if (hasOwnKey(aKeys, "pagination")) {
          const raw = body["pagination"];
          const rawKeys = ownKeysOf(raw);
          for (let i = 0; i < wanted.length; i += 1) { if (hasOwnKey(rawKeys, wanted[i])) paginationVals[wanted[i]] = raw[wanted[i]]; }
        }
        const info = {};
        const pagKeys = ownKeysOf(paginationVals);
        const riKeys = ownKeysOf(resultInfoVals);
        for (let i = 0; i < wanted.length; i += 1) { if (hasOwnKey(pagKeys, wanted[i])) info[wanted[i]] = paginationVals[wanted[i]]; }
        for (let i = 0; i < wanted.length; i += 1) { if (hasOwnKey(riKeys, wanted[i])) info[wanted[i]] = resultInfoVals[wanted[i]]; }
        const infoKeys = ownKeysOf(info);
        const hasI = (n) => hasOwnKey(infoKeys, n);
        const valI = (n) => (hasI(n) ? info[n] : undefined);
        const fieldSource = (name) => (hasOwnKey(riKeys, name) ? "result_info" : hasOwnKey(pagKeys, name) ? "pagination" : "none");
        const checkAi = (name, min) => {
          if (!hasI(name)) return;
          const value = valI(name);
          if (!Number.isInteger(value) || value < min) { throw new ProviderFailure("MALFORMED", `${group} page ${page} bad ${name}`, { httpStatus: lastHttpStatus }); }
        };
        checkAi("page", 1);
        checkAi("per_page", 1);
        checkAi("total_pages", 1);
        checkAi("count", 0);
        checkAi("total_count", 0);
        const aiPage = valI("page");
        const aiPerPage = valI("per_page");
        const aiTotalPages = valI("total_pages");
        const aiCount = valI("count");
        const aiTotalCount = valI("total_count");
        if (Number.isInteger(aiTotalPages) && aiTotalPages < 1) { throw new ProviderFailure("MALFORMED", `${group} page ${page} bad total_pages`, { httpStatus: lastHttpStatus }); }
        if (Number.isInteger(aiPerPage) && aiPerPage < 1) { throw new ProviderFailure("MALFORMED", `${group} page ${page} bad per_page`, { httpStatus: lastHttpStatus }); }
        if (Number.isInteger(aiCount) && aiCount < 0) { throw new ProviderFailure("MALFORMED", `${group} page ${page} bad count`, { httpStatus: lastHttpStatus }); }
        if ((hasI("total_count") || hasI("total_pages")) && aiPage !== page) { throw new ProviderFailure("MALFORMED", `${group} page ${page} missing page echo`, { httpStatus: lastHttpStatus }); }
        if (hasI("page") && aiPage !== page) { throw new ProviderFailure("MALFORMED", `${group} page ${page} page echo mismatch`, { httpStatus: lastHttpStatus }); }
        if (hasI("count") && aiCount !== itemsLength) { throw new ProviderFailure("MALFORMED", `${group} page ${page} count echo mismatch`, { httpStatus: lastHttpStatus }); }
        if (Number.isInteger(aiTotalCount) && aiTotalCount < 0) throw new ProviderFailure("MALFORMED", `${group} page ${page} bad total_count`, { httpStatus: lastHttpStatus });
        if (Number.isInteger(aiPage)) { markEstablished("page", fieldSource("page")); }
        else if (estIndex("page") >= 0) { throw new ProviderFailure("PARTIAL_PAGINATION", `${group} page ${page} page echo disappeared${estSourceOf("page") !== fieldSource("page") ? ` via container switch ${estSourceOf("page")}->${fieldSource("page")}` : ""}`, { httpStatus: lastHttpStatus }); }
        if (Number.isInteger(aiCount)) { markEstablished("count", fieldSource("count")); }
        else if (estIndex("count") >= 0) { throw new ProviderFailure("PARTIAL_PAGINATION", `${group} page ${page} count echo disappeared${estSourceOf("count") !== fieldSource("count") ? ` via container switch ${estSourceOf("count")}->${fieldSource("count")}` : ""}`, { httpStatus: lastHttpStatus }); }
        requireStable("per_page", aiPerPage, fieldSource("per_page"));
        requireStable("total_count", aiTotalCount, fieldSource("total_count"));
        requireStable("total_pages", aiTotalPages, fieldSource("total_pages"));
        if (Number.isInteger(aiTotalPages)) { totalPages = aiTotalPages; }
        else if (Number.isInteger(aiTotalCount) && Number.isInteger(aiPerPage)) { totalPages = aiTotalCount === 0 ? 1 : Math.ceil(aiTotalCount / Math.max(1, aiPerPage)); }
        else { throw new ProviderFailure("PARTIAL_PAGINATION", `${group} page ${page} short page without totals proves no complete walk`, { httpStatus: lastHttpStatus }); }
        pagesCompleted[pagesCompleted.length] = page;
        if (pagesCompleted.length >= totalPages) break;
        page += 1;
      }
      if (totalPages === null || pagesCompleted.length < totalPages) { throw new ProviderFailure("PARTIAL_PAGINATION", `${group} incomplete pagination`, { httpStatus: lastHttpStatus }); }
      const stableAiTotal = stableAiGet("total_count");
      if (stableAiTotal !== undefined && seen.length !== stableAiTotal) { throw new ProviderFailure("PARTIAL_PAGINATION", `${group} cumulative count ${seen.length} vs total_count ${stableAiTotal}`, { httpStatus: lastHttpStatus }); }
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
export function createGraphQlAnalyticsProvider({ group = "graphql-analytics", covers = [], endpoint = "https://api.cloudflare.com/client/v4/graphql", fetchImpl = fetch, query = "" } = {}) {
  return {
    group,
    covers: copyCovers(covers),
    kind: "analytics-graphql",
    analyticsOnly: true,
    async collect({ accountId, bearer, now }) {
      void now;
      if (typeof bearer !== "string" || bearer.length < 1) throw new ProviderFailure("NO_AUTH_ENDPOINT", `${group}: bearer required`);
      let response;
      try {
        response = await fetchImpl(endpoint, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify({ query }) });
      } catch {
        throw new ProviderFailure("HTTP_ERROR", `${group} transport failure`);
      }
      const httpStatus = readStatus(response);
      if (httpStatus === 401 || httpStatus === 403) { throw new ProviderFailure("AUTH_SCOPE_DENIED", `${group} denied (http ${httpStatus})`, { httpStatus }); }
      if (httpStatus === 429 || (Number.isInteger(httpStatus) && httpStatus >= 500)) { throw new ProviderFailure("HTTP_ERROR", `${group} http ${httpStatus}`, { httpStatus }); }
      let body;
      try {
        body = await response.json();
      } catch {
        throw new ProviderFailure("MALFORMED", `${group} invalid JSON`, { httpStatus });
      }
      if (body === null || body === undefined || typeof body !== "object" || Array.isArray(body)) { throw new ProviderFailure("MALFORMED", `${group} invalid JSON`, { httpStatus }); }
      const gKeys = ownKeysOf(body);
      if (hasOwnKey(gKeys, "errors")) {
        const errorsOwn = body["errors"];
        if (errorsOwn === undefined || errorsOwn === null) { /* absent-as-empty: ignore */ }
        else if (Array.isArray(errorsOwn)) {
          if (errorsOwn.length > 0) { throw new ProviderFailure("HTTP_ERROR", `${group} GraphQL errors`, { httpStatus }); }
        } else { throw new ProviderFailure("MALFORMED", `${group} GraphQL errors malformed`, { httpStatus }); }
      }
      let dataOwn = null;
      let hasData = false;
      if (hasOwnKey(gKeys, "data")) {
        const candidate = body["data"];
        if (candidate === undefined || candidate === null) { /* absent-as-empty: ignore */ }
        else if (typeof candidate === "object" && !Array.isArray(candidate)) { dataOwn = candidate; hasData = true; }
        else { throw new ProviderFailure("MALFORMED", `${group} GraphQL data malformed`, { httpStatus }); }
      }
      const dataKeys = hasData ? ownKeysOf(dataOwn) : [];
      let topEcho;
      let nestedEcho;
      if (hasOwnKey(gKeys, "account_id")) {
        const candidate = body["account_id"];
        if (candidate !== undefined && candidate !== null && typeof candidate !== "string") { throw new ProviderFailure("MALFORMED", `${group} wrong account echo type`, { httpStatus }); }
        topEcho = candidate;
      } else topEcho = undefined;
      if (hasData && hasOwnKey(dataKeys, "account_id")) {
        const candidate = dataOwn["account_id"];
        if (candidate !== undefined && candidate !== null && typeof candidate !== "string") { throw new ProviderFailure("MALFORMED", `${group} wrong account echo type`, { httpStatus }); }
        nestedEcho = candidate;
      } else nestedEcho = undefined;
      if (typeof topEcho === "string" && topEcho !== accountId) { throw new ProviderFailure("ACCOUNT_MISMATCH", `${group} wrong account echo`, { httpStatus }); }
      if (typeof nestedEcho === "string" && nestedEcho !== accountId) { throw new ProviderFailure("ACCOUNT_MISMATCH", `${group} wrong account echo`, { httpStatus }); }
      let partialOwn = false;
      if (hasOwnKey(gKeys, "partial") && body["partial"] === true) partialOwn = true;
      if (hasData && hasOwnKey(dataKeys, "partial") && dataOwn["partial"] === true) partialOwn = true;
      if (hasOwnKey(gKeys, "truncated") && body["truncated"] === true) partialOwn = true;
      if (partialOwn) { throw new ProviderFailure("PARTIAL_PAGINATION", `${group} GraphQL partial/truncated`, { httpStatus }); }
      let samples = {};
      if (hasData && hasOwnKey(dataKeys, "samples")) {
        const candidate = dataOwn["samples"];
        if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) samples = candidate;
      }
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
