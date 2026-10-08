// Bounded D1 stock observation for Cloudflare usage diagnostics.
//
// D1's documented `file_size` is a point observation. It is not a monthly
// billable total and never carries production admission authority. The
// collector reads the complete bounded database ID list, reads every
// database detail twice, and reconciles the ID list after those reads. Any
// incomplete, changing, oversized, or malformed result remains unknown.

import { METRIC_PROVENANCE } from "./cloudflare-usage-envelope.mjs";
import { ProviderFailure, UsageCollectionError, assertAccountUrl, safeFetchMeta } from "./cloudflare-usage-providers.mjs";
import {
  LIVE_API_BASE,
  callerSuppliedTransportKeys,
  defaultD1DetailsEndpoint,
  defaultPaginatedEndpoint,
  markTestTransport,
} from "./cloudflare-usage-transport-class.mjs";
import {
  UsageSourceDecodeError,
  decodeCloudflareUsageResult,
} from "./cloudflare-usage-source-decoder.mjs";

export const D1_STORAGE_OBSERVATION_GROUP = "d1-storage-diagnostic";
export const D1_STORAGE_OBSERVATION_COVERS = Object.freeze(["d1_storage_bytes"]);

const D1_LIST_PAGE_SIZE = 100;
const MAX_D1_DATABASES_PER_COLLECTION = 50;
const MAX_D1_RESPONSE_BYTES = 512 * 1024;
const MAX_D1_REQUEST_MS = 10_000;
const MAX_D1_COLLECTION_MS = 30_000;
const D1_LIST_PATH_SUFFIX = "/d1/database";

function hasKey(keys, expected) {
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i] === expected) return true;
  }
  return false;
}

function findOwnString(value, key) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (!hasKey(keys, key)) return null;
  const candidate = value[key];
  return typeof candidate === "string" && candidate !== "" ? candidate : null;
}

function findOwnNumber(value, key) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (!hasKey(keys, key)) return null;
  const candidate = value[key];
  return Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null;
}

function fail(code, message, { httpStatus = null, classification = null } = {}) {
  const failure = new ProviderFailure(code, message, { httpStatus });
  if (typeof classification === "string") failure.classification = classification;
  throw failure;
}

function mapDecoderError(error) {
  const recognized = error instanceof UsageSourceDecodeError;
  const code = recognized && typeof error.code === "string" ? error.code : "MALFORMED";
  const message = recognized ? error.message : "Cloudflare D1 source response was malformed";
  fail(code, message, {
    httpStatus: recognized && Number.isInteger(error.httpStatus) ? error.httpStatus : null,
    classification: recognized && typeof error.classification === "string" ? error.classification : "malformed-data",
  });
}

function validatedApiBasePath(apiBase, group) {
  let base;
  try {
    base = new URL(apiBase);
  } catch {
    fail("MALFORMED", `${group} API base was malformed`);
  }
  if (base.protocol !== "https:" || base.username !== "" || base.password !== "" || base.search !== "" || base.hash !== "") {
    fail("ACCOUNT_MISMATCH", `${group} API base left the documented HTTPS transport`);
  }
  const path = base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname;
  return { origin: base.origin, path };
}

function assertD1ListUrl(url, apiBase, accountId, group, page, perPage) {
  assertAccountUrl(url, accountId, group, `list page ${page}`);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail("MALFORMED", `${group} list URL was malformed`);
  }
  const base = validatedApiBasePath(apiBase, group);
  const expectedPath = `${base.path}/accounts/${accountId}${D1_LIST_PATH_SUFFIX}`;
  if (parsed.origin !== base.origin || parsed.pathname !== expectedPath || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") {
    fail("ACCOUNT_MISMATCH", `${group} left the documented D1 database list path`);
  }
  if (parsed.search !== `?page=${page}&per_page=${perPage}`) {
    fail("PARTIAL_PAGINATION", `${group} list URL did not preserve its bounded pagination request`);
  }
}

function assertD1DetailUrl(url, apiBase, accountId, databaseId, group, phase) {
  assertAccountUrl(url, accountId, group, `${phase} detail`);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail("MALFORMED", `${group} detail URL was malformed`);
  }
  const base = validatedApiBasePath(apiBase, group);
  const expectedPath = `${base.path}/accounts/${accountId}/d1/database/${encodeURIComponent(databaseId)}`;
  if (parsed.origin !== base.origin || parsed.pathname !== expectedPath || parsed.username !== "" || parsed.password !== "" ||
    parsed.search !== "?fields=uuid,file_size" || parsed.hash !== "") {
    fail("ACCOUNT_MISMATCH", `${group} left the documented D1 database detail path`);
  }
}

function listIdentityRows(rows, resultInfo, group) {
  if (resultInfo === null || typeof resultInfo !== "object") {
    fail("PARTIAL_PAGINATION", `${group} list has no complete pagination readback`);
  }
  const page = findOwnNumber(resultInfo, "page");
  const perPage = findOwnNumber(resultInfo, "per_page");
  const totalCount = findOwnNumber(resultInfo, "total_count");
  const count = findOwnNumber(resultInfo, "count");
  if (page !== 1 || perPage !== D1_LIST_PAGE_SIZE || totalCount === null || totalCount > MAX_D1_DATABASES_PER_COLLECTION) {
    fail("PARTIAL_PAGINATION", `${group} list exceeded or failed the bounded complete inventory contract`);
  }
  if (count !== null && count !== rows.length) {
    fail("MALFORMED", `${group} list count disagreed with its result rows`);
  }
  if (totalCount !== rows.length) {
    fail("PARTIAL_PAGINATION", `${group} list did not return every account database`);
  }
  const ids = [];
  for (let i = 0; i < rows.length; i += 1) {
    const id = findOwnString(rows[i], "uuid");
    if (id === null) fail("MALFORMED", `${group} list row has no documented database UUID`);
    for (let j = 0; j < ids.length; j += 1) {
      if (ids[j] === id) fail("MALFORMED", `${group} list repeated a database UUID`);
    }
    ids[ids.length] = id;
  }
  return ids;
}

function sameIdentitySet(left, right) {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    let found = false;
    for (let j = 0; j < right.length; j += 1) {
      if (left[i] === right[j]) { found = true; break; }
    }
    if (!found) return false;
  }
  return true;
}

function addBytes(total, value, group) {
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(total + value)) {
    fail("MALFORMED", `${group} observed D1 file_size was not a safe non-negative integer`);
  }
  return total + value;
}

function observedAt() {
  return new Date().toISOString();
}

export function createD1StorageObservationProvider(options = {}) {
  const transportKeys = callerSuppliedTransportKeys(options);
  const testOnly = transportKeys.length > 0;
  const apiBase = typeof options?.apiBase === "string" ? options.apiBase : LIVE_API_BASE;
  const listEndpoint = typeof options?.listEndpoint === "function"
    ? options.listEndpoint
    : defaultPaginatedEndpoint("d1-inventory-list", apiBase);
  const detailEndpoint = typeof options?.detailEndpoint === "function"
    ? options.detailEndpoint
    : defaultD1DetailsEndpoint(apiBase);
  const fetchImpl = typeof options?.fetchImpl === "function" ? options.fetchImpl : globalThis.fetch;
  if (typeof listEndpoint !== "function" || typeof detailEndpoint !== "function" || typeof fetchImpl !== "function") {
    throw new UsageCollectionError("COLLECTION_INVALID", "D1 storage diagnostic transport is incomplete");
  }

  async function fetchDecoded(url, bearer, phase, expectedResultKind, collectionSignal) {
    if (collectionSignal?.aborted) {
      fail("HTTP_STATUS_UNKNOWN", `${D1_STORAGE_OBSERVATION_GROUP} collection was cancelled or exceeded its time budget`, {
        classification: "cancelled-or-deadline",
      });
    }
    const requestController = new globalThis.AbortController();
    const abortRequest = () => requestController.abort();
    if (collectionSignal?.aborted) requestController.abort();
    else collectionSignal?.addEventListener("abort", abortRequest, { once: true });
    const requestTimer = setTimeout(abortRequest, MAX_D1_REQUEST_MS);
    try {
      let response;
      try {
        response = await fetchImpl(url, {
          redirect: "error",
          signal: requestController.signal,
          headers: { authorization: `Bearer ${bearer}` },
        });
      } catch {
        fail("HTTP_STATUS_UNKNOWN", `${D1_STORAGE_OBSERVATION_GROUP} ${phase} transport result is unknown`, {
          classification: requestController.signal.aborted ? "cancelled-or-deadline" : "unknown-transport-or-response-gap",
        });
      }
      let decoded;
      try {
        decoded = await decodeCloudflareUsageResult(response, {
          expectedResultKind,
          maxBytes: MAX_D1_RESPONSE_BYTES,
        });
      } catch (error) {
        if (requestController.signal.aborted) {
          fail("HTTP_STATUS_UNKNOWN", `${D1_STORAGE_OBSERVATION_GROUP} ${phase} response exceeded its time budget`, {
            classification: "cancelled-or-deadline",
          });
        }
        mapDecoderError(error);
      }
      if (requestController.signal.aborted) {
        fail("HTTP_STATUS_UNKNOWN", `${D1_STORAGE_OBSERVATION_GROUP} ${phase} response exceeded its time budget`, {
          classification: "cancelled-or-deadline",
        });
      }
      return decoded;
    } finally {
      clearTimeout(requestTimer);
      collectionSignal?.removeEventListener("abort", abortRequest);
    }
  }

  async function readIds(accountId, bearer, phase, collectionSignal) {
    const page = 1;
    const url = listEndpoint(accountId, page, D1_LIST_PAGE_SIZE);
    assertD1ListUrl(url, apiBase, accountId, D1_STORAGE_OBSERVATION_GROUP, page, D1_LIST_PAGE_SIZE);
    const decoded = await fetchDecoded(url, bearer, `${phase} list`, "array", collectionSignal);
    return listIdentityRows(decoded.result, decoded.resultInfo, D1_STORAGE_OBSERVATION_GROUP);
  }

  async function readSize(accountId, bearer, databaseId, phase, collectionSignal) {
    const url = detailEndpoint(accountId, databaseId);
    assertD1DetailUrl(url, apiBase, accountId, databaseId, D1_STORAGE_OBSERVATION_GROUP, phase);
    const decoded = await fetchDecoded(url, bearer, `${phase} detail`, "object", collectionSignal);
    const resultId = findOwnString(decoded.result, "uuid");
    const fileSize = findOwnNumber(decoded.result, "file_size");
    if (resultId !== databaseId || fileSize === null) {
      fail("MALFORMED", `${D1_STORAGE_OBSERVATION_GROUP} detail lacked matching UUID or numeric file_size`, {
        httpStatus: decoded.httpStatus,
        classification: "malformed-data",
      });
    }
    return fileSize;
  }

  const product = {
    group: D1_STORAGE_OBSERVATION_GROUP,
    covers: ["d1_storage_bytes"],
    kind: "d1-storage-diagnostic",
    analyticsOnly: true,
    async collect({ accountId, bearer, now, signal }) {
      void now;
      if (typeof bearer !== "string" || bearer.length < 1) {
        throw new ProviderFailure("NO_AUTH_ENDPOINT", `${D1_STORAGE_OBSERVATION_GROUP}: bearer required`);
      }
      if (typeof accountId !== "string" || accountId === "") {
        throw new ProviderFailure("ACCOUNT_MISMATCH", `${D1_STORAGE_OBSERVATION_GROUP}: account binding is required`);
      }
      if (signal !== undefined && signal !== null && (typeof signal !== "object" ||
        typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function" ||
        typeof signal.removeEventListener !== "function")) {
        throw new UsageCollectionError("COLLECTION_INVALID", "D1 storage diagnostic signal must be an AbortSignal");
      }
      if (signal?.aborted) {
        fail("HTTP_STATUS_UNKNOWN", `${D1_STORAGE_OBSERVATION_GROUP} collection was cancelled`, {
          classification: "cancelled-or-deadline",
        });
      }
      const collectionStart = observedAt();
      const collectionController = new globalThis.AbortController();
      const abortCollection = () => collectionController.abort();
      if (signal) signal.addEventListener("abort", abortCollection, { once: true });
      const collectionTimer = setTimeout(abortCollection, MAX_D1_COLLECTION_MS);
      try {
        const firstIds = await readIds(accountId, bearer, "initial", collectionController.signal);
        const firstSizes = [];
        let firstTotal = 0;
        for (let i = 0; i < firstIds.length; i += 1) {
          const size = await readSize(accountId, bearer, firstIds[i], "initial", collectionController.signal);
          firstSizes[firstSizes.length] = size;
          firstTotal = addBytes(firstTotal, size, D1_STORAGE_OBSERVATION_GROUP);
        }
        const secondIds = await readIds(accountId, bearer, "reconciliation", collectionController.signal);
        if (!sameIdentitySet(firstIds, secondIds)) {
          fail("PARTIAL_PAGINATION", `${D1_STORAGE_OBSERVATION_GROUP} database inventory changed during observation`);
        }
        let secondTotal = 0;
        for (let i = 0; i < secondIds.length; i += 1) {
          const size = await readSize(accountId, bearer, secondIds[i], "reconciliation", collectionController.signal);
          let original = null;
          for (let j = 0; j < firstIds.length; j += 1) {
            if (firstIds[j] === secondIds[i]) { original = firstSizes[j]; break; }
          }
          if (original === null || original !== size) {
            fail("PARTIAL_PAGINATION", `${D1_STORAGE_OBSERVATION_GROUP} database stock changed during observation`);
          }
          secondTotal = addBytes(secondTotal, size, D1_STORAGE_OBSERVATION_GROUP);
        }
        if (firstTotal !== secondTotal) {
          fail("PARTIAL_PAGINATION", `${D1_STORAGE_OBSERVATION_GROUP} detail readbacks disagreed`);
        }
        const collectionEnd = observedAt();
        return {
          values: { d1_storage_bytes: secondTotal },
          coverage: {
            accountId,
            fullAccount: false,
            observedAtStart: collectionStart,
            observedAtEnd: collectionEnd,
          },
          provenance: METRIC_PROVENANCE.ANALYTICS_NONBILLING,
          diagnosticObservation: {
            kind: "d1-current-stock-observation",
            value: secondTotal,
            unit: "bytes",
            databaseCount: secondIds.length,
            detailReadbacks: secondIds.length * 2,
            reconciled: true,
            atomic: false,
            monthlyBillingAuthority: false,
            collectionStart,
            collectionEnd,
          },
          receiptMeta: safeFetchMeta({
            kind: "d1-storage-diagnostic",
            full: false,
            authoritative: false,
            reason: "observed point stock; not monthly billable usage",
          }),
        };
      } catch (error) {
        if (collectionController.signal.aborted) {
          fail("HTTP_STATUS_UNKNOWN", `${D1_STORAGE_OBSERVATION_GROUP} collection was cancelled or exceeded its time budget`, {
            classification: "cancelled-or-deadline",
          });
        }
        throw error;
      } finally {
        clearTimeout(collectionTimer);
        signal?.removeEventListener("abort", abortCollection);
      }
    },
  };
  Object.freeze(product.covers);
  if (testOnly) markTestTransport(product);
  return Object.freeze(product);
}
