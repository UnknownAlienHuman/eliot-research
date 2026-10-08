// Fixed Cloudflare GraphQL analytics sources. These rows are diagnostic
// samples only: adaptive analytics are not billing authority or proof of full
// account coverage.

import { METRIC_PROVENANCE } from "./cloudflare-usage-envelope.mjs";
import { ProviderFailure, UsageCollectionError, safeFetchMeta } from "./cloudflare-usage-providers.mjs";
import {
  UsageSourceDecodeError,
  decodeCloudflareUsageJson,
} from "./cloudflare-usage-source-decoder.mjs";
import {
  LIVE_API_BASE,
  callerSuppliedTransportKeys,
  markTestTransport,
} from "./cloudflare-usage-transport-class.mjs";

const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_REQUEST_MS = 10_000;
const MAX_ROWS = 1000;
const GRAPHQL_PATH = "/graphql";

const SOURCE_DEFINITIONS = Object.freeze([
  Object.freeze({
    group: "workers-requests-diagnostic",
    dataset: "workersInvocationsAdaptive",
    fields: Object.freeze([Object.freeze(["requests", "workers_requests"])]),
  }),
  Object.freeze({
    group: "d1-rows-diagnostic",
    dataset: "d1AnalyticsAdaptiveGroups",
    dateFilter: true,
    fields: Object.freeze([
      Object.freeze(["rowsRead", "d1_rows_read"]),
      Object.freeze(["rowsWritten", "d1_rows_written"]),
    ]),
  }),
  Object.freeze({
    group: "queue-ops-diagnostic",
    dataset: "queueMessageOperationsAdaptiveGroups",
    fields: Object.freeze([Object.freeze(["billableOperations", "queue_ops"])]),
  }),
  Object.freeze({
    group: "do-requests-diagnostic",
    dataset: "durableObjectsInvocationsAdaptiveGroups",
    fields: Object.freeze([Object.freeze(["requests", "do_requests"])]),
  }),
]);

function fail(group, code, message, { httpStatus = null, classification = null } = {}) {
  const error = new ProviderFailure(code, message, { httpStatus });
  if (typeof classification === "string") error.classification = classification;
  throw error;
}

function keysOf(value, group, httpStatus) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(group, "MALFORMED", `${group} GraphQL response was malformed`, { httpStatus });
  }
  try {
    return Object.keys(value);
  } catch {
    fail(group, "MALFORMED", `${group} GraphQL response was malformed`, { httpStatus });
  }
  return [];
}

function hasKey(keys, expected) {
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i] === expected) return true;
  }
  return false;
}

function validateKeys(keys, allowed, group, httpStatus) {
  for (let i = 0; i < keys.length; i += 1) {
    if (!hasKey(allowed, keys[i])) {
      fail(group, "MALFORMED", `${group} GraphQL response was malformed`, { httpStatus });
    }
  }
}

function safeEndpoint(apiBase, group) {
  let parsed;
  try {
    parsed = new URL(apiBase);
  } catch {
    fail(group, "COLLECTION_INVALID", `${group} GraphQL endpoint was malformed`);
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" ||
    parsed.search !== "" || parsed.hash !== "") {
    fail(group, "COLLECTION_INVALID", `${group} GraphQL endpoint was malformed`);
  }
  const path = parsed.pathname.endsWith("/") ? parsed.pathname.slice(0, -1) : parsed.pathname;
  return `${parsed.origin}${path}${GRAPHQL_PATH}`;
}

function validatedWindow(now, group) {
  let time;
  try {
    time = now instanceof Date ? Date.prototype.getTime.call(now) : now;
  } catch {
    time = NaN;
  }
  if (typeof time !== "number" || !Number.isSafeInteger(time) || time < 0 || time > Date.now()) {
    fail(group, "WINDOW_MISMATCH", `${group} collection time was invalid`);
  }
  const end = new Date(time);
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  if (time <= start.getTime()) {
    fail(group, "WINDOW_MISMATCH", `${group} monthly observation window was empty`);
  }
  return Object.freeze({ start: start.toISOString(), end: end.toISOString() });
}

function makeQuery(definition, accountId, window) {
  let sumFields = "";
  for (let i = 0; i < definition.fields.length; i += 1) {
    sumFields += `${i === 0 ? "" : " "}${definition.fields[i][0]}`;
  }
  const start = definition.dateFilter ? window.start.slice(0, 10) : window.start;
  const end = definition.dateFilter ? window.end.slice(0, 10) : window.end;
  const filterName = definition.dateFilter ? "date" : "datetime";
  return `query { viewer { accounts(filter: {accountTag: ${JSON.stringify(accountId)}}) { ${definition.dataset}(limit: ${MAX_ROWS}, filter: {${filterName}_geq: ${JSON.stringify(start)}, ${filterName}_leq: ${JSON.stringify(end)}}) { sum { ${sumFields} } } } } }`;
}

function decodeGraphqlPayload(body, definition, accountId, httpStatus) {
  const topKeys = keysOf(body, definition.group, httpStatus);
  validateKeys(topKeys, ["data", "errors", "extensions"], definition.group, httpStatus);

  if (hasKey(topKeys, "errors")) {
    const errors = body.errors;
    if (errors !== null && !Array.isArray(errors)) {
      fail(definition.group, "MALFORMED", `${definition.group} GraphQL errors were malformed`, { httpStatus });
    }
    if (Array.isArray(errors) && errors.length > 0) {
      fail(definition.group, "HTTP_RESPONSE_ERROR", `${definition.group} GraphQL query returned errors`, {
        httpStatus,
        classification: "provider-data-gap",
      });
    }
  }
  if (hasKey(topKeys, "extensions")) {
    keysOf(body.extensions, definition.group, httpStatus);
  }
  if (!hasKey(topKeys, "data")) {
    fail(definition.group, "MALFORMED", `${definition.group} GraphQL data was missing`, { httpStatus });
  }

  const data = body.data;
  const dataKeys = keysOf(data, definition.group, httpStatus);
  validateKeys(dataKeys, ["viewer"], definition.group, httpStatus);
  const viewer = data.viewer;
  const viewerKeys = keysOf(viewer, definition.group, httpStatus);
  validateKeys(viewerKeys, ["accounts"], definition.group, httpStatus);
  const accounts = viewer.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) {
    fail(definition.group, "ACCOUNT_MISMATCH", `${definition.group} account binding did not match`, { httpStatus });
  }

  const account = accounts[0];
  const accountKeys = keysOf(account, definition.group, httpStatus);
  validateKeys(accountKeys, ["accountTag", definition.dataset], definition.group, httpStatus);
  if (hasKey(accountKeys, "accountTag") && account.accountTag !== accountId) {
    fail(definition.group, "ACCOUNT_MISMATCH", `${definition.group} account binding did not match`, { httpStatus });
  }
  if (!hasKey(accountKeys, definition.dataset) || !Array.isArray(account[definition.dataset])) {
    fail(definition.group, "MALFORMED", `${definition.group} analytics rows were malformed`, { httpStatus });
  }
  const rows = account[definition.dataset];
  if (rows.length >= MAX_ROWS) {
    fail(definition.group, "PARTIAL_PAGINATION", `${definition.group} analytics reached its row limit`, { httpStatus });
  }
  const sums = [];
  for (let i = 0; i < definition.fields.length; i += 1) sums[i] = 0;
  const complete = [];
  for (let i = 0; i < definition.fields.length; i += 1) complete[i] = rows.length > 0;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const rowKeys = keysOf(row, definition.group, httpStatus);
    validateKeys(rowKeys, ["sum"], definition.group, httpStatus);
    if (!hasKey(rowKeys, "sum")) {
      fail(definition.group, "MALFORMED", `${definition.group} analytics row sum was missing`, { httpStatus });
    }
    const sum = row.sum;
    const sumKeys = keysOf(sum, definition.group, httpStatus);
    const allowedSumFields = [];
    for (let i = 0; i < definition.fields.length; i += 1) allowedSumFields[i] = definition.fields[i][0];
    validateKeys(sumKeys, allowedSumFields, definition.group, httpStatus);
    for (let i = 0; i < definition.fields.length; i += 1) {
      const sourceField = definition.fields[i][0];
      if (!hasKey(sumKeys, sourceField)) {
        complete[i] = false;
        continue;
      }
      const value = sum[sourceField];
      if (!Number.isSafeInteger(value) || value < 0) {
        fail(definition.group, "MALFORMED", `${definition.group} analytics sum was invalid`, { httpStatus });
      }
      const total = sums[i] + value;
      if (!Number.isSafeInteger(total)) {
        fail(definition.group, "MALFORMED", `${definition.group} analytics sum was invalid`, { httpStatus });
      }
      sums[i] = total;
    }
  }

  const values = {};
  for (let i = 0; i < definition.fields.length; i += 1) {
    if (complete[i]) values[definition.fields[i][1]] = sums[i];
  }
  return values;
}

function mapDecoderFailure(error, group, httpStatus) {
  if (error instanceof UsageSourceDecodeError) {
    fail(group, error.code, error.message, {
      httpStatus: Number.isInteger(error.httpStatus) ? error.httpStatus : null,
      classification: error.classification,
    });
  }
  fail(group, "HTTP_STATUS_UNKNOWN", `${group} response could not be decoded`, {
    httpStatus,
    classification: "unknown-transport-or-response-gap",
  });
}

function raceWithRequestAbort(promise, signal, group) {
  let rejectAborted;
  const aborted = new Promise((resolve, reject) => {
    void resolve;
    rejectAborted = () => reject(new ProviderFailure(
      "HTTP_STATUS_UNKNOWN",
      `${group} request was cancelled or exceeded its time budget`,
    ));
    if (signal.aborted) rejectAborted();
    else signal.addEventListener("abort", rejectAborted, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => {
    if (rejectAborted) signal.removeEventListener("abort", rejectAborted);
  });
}

function validateCollectionSignal(signal, group) {
  if (signal === undefined || signal === null) return;
  try {
    if (typeof signal !== "object" || typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function") {
      throw new Error("invalid signal");
    }
  } catch {
    throw new UsageCollectionError("COLLECTION_INVALID", `${group} cancellation signal was invalid`);
  }
}

function makeProvider(definition, endpoint, fetchImpl, testOnly) {
  const covers = [];
  for (let i = 0; i < definition.fields.length; i += 1) covers[i] = definition.fields[i][1];

  const provider = {
    group: definition.group,
    covers,
    kind: "analytics-graphql",
    analyticsOnly: true,
    async collect({ accountId, bearer, now = Date.now(), signal } = {}) {
      const group = definition.group;
      if (typeof bearer !== "string" || bearer.length === 0) {
        throw new ProviderFailure("NO_AUTH_ENDPOINT", `${group}: bearer required`);
      }
      if (typeof accountId !== "string" || !/^[0-9a-fA-F]{32}$/.test(accountId)) {
        throw new ProviderFailure("ACCOUNT_MISMATCH", `${group}: account binding is required`);
      }
      validateCollectionSignal(signal, group);
      if (signal?.aborted) {
        fail(group, "HTTP_STATUS_UNKNOWN", `${group} request was cancelled`, {
          classification: "cancelled-or-deadline",
        });
      }
      const window = validatedWindow(now, group);
      const controller = new globalThis.AbortController();
      const abortRequest = () => controller.abort();
      if (signal?.aborted) controller.abort();
      else signal?.addEventListener("abort", abortRequest, { once: true });
      const timer = setTimeout(abortRequest, MAX_REQUEST_MS);
      let httpStatus = null;
      try {
        let response;
        try {
          response = await fetchImpl(endpoint, {
            method: "POST",
            redirect: "error",
            signal: controller.signal,
            headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
            body: JSON.stringify({ query: makeQuery(definition, accountId, window) }),
          });
        } catch {
          fail(group, "HTTP_STATUS_UNKNOWN", `${group} transport result is unknown`, {
            classification: controller.signal.aborted ? "cancelled-or-deadline" : "unknown-transport-or-response-gap",
          });
        }
        let decoded;
        try {
          const decoding = decodeCloudflareUsageJson(response, { maxBytes: MAX_RESPONSE_BYTES });
          decoded = await raceWithRequestAbort(decoding, controller.signal, group);
        } catch (error) {
          if (controller.signal.aborted) {
            fail(group, "HTTP_STATUS_UNKNOWN", `${group} response exceeded its time budget`, {
              classification: "cancelled-or-deadline",
            });
          }
          mapDecoderFailure(error, group, httpStatus);
        }
        httpStatus = decoded.httpStatus;
        if (controller.signal.aborted) {
          fail(group, "HTTP_STATUS_UNKNOWN", `${group} response exceeded its time budget`, {
            classification: "cancelled-or-deadline",
          });
        }
        const values = decodeGraphqlPayload(decoded.body, definition, accountId, httpStatus);
        return {
          values,
          coverage: {
            accountId,
            windowStart: window.start,
            windowEnd: window.end,
            fullAccount: false,
            analyticsOnly: true,
          },
          provenance: METRIC_PROVENANCE.ANALYTICS_NONBILLING,
          receiptMeta: safeFetchMeta({
            httpStatus,
            kind: "analytics-graphql",
            full: false,
            authoritative: false,
            reason: "ANALYTICS_NONBILLING",
          }),
        };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abortRequest);
      }
    },
  };

  Object.freeze(provider.covers);
  if (testOnly) markTestTransport(provider);
  return Object.freeze(provider);
}

export function createCloudflareUsageAnalyticsProviders(options = {}) {
  const suppliedKeys = callerSuppliedTransportKeys(options);
  const testOnly = suppliedKeys.length > 0;
  const apiBase = typeof options?.apiBase === "string" ? options.apiBase : LIVE_API_BASE;
  const fetchImpl = typeof options?.fetchImpl === "function" ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new UsageCollectionError("COLLECTION_INVALID", "Cloudflare analytics transport is incomplete");
  }
  const providers = [];
  for (let i = 0; i < SOURCE_DEFINITIONS.length; i += 1) {
    const definition = SOURCE_DEFINITIONS[i];
    providers[i] = makeProvider(definition, safeEndpoint(apiBase, definition.group), fetchImpl, testOnly);
  }
  return Object.freeze(providers);
}
