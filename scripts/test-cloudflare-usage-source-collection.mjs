import assert from "node:assert/strict";
import test from "node:test";

import { METRIC_PROVENANCE } from "./lib/cloudflare-usage-envelope.mjs";
import { buildLiveProviderRegistry, createBillableUsageProvider } from "./lib/cloudflare-usage-billable.mjs";
import { createD1StorageObservationProvider, D1_STORAGE_OBSERVATION_GROUP } from "./lib/cloudflare-usage-source-collection.mjs";
import { isTestTransportProvider, LIVE_API_BASE } from "./lib/cloudflare-usage-transport-class.mjs";

const ACCOUNT_ID = "cccccccccccccccccccccccccccccccc";
const BEARER = "fixture-bearer";

function response(result, resultInfo = undefined, status = 200) {
  const body = { success: true, errors: [], messages: [], result };
  if (resultInfo !== undefined) body.result_info = resultInfo;
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function inventory(ids, extraInfo = {}) {
  return response(ids.map((uuid) => ({ uuid })), {
    count: ids.length,
    page: 1,
    per_page: 100,
    total_count: ids.length,
    ...extraInfo,
  });
}

function stableFetcher({ ids = ["db-a", "db-b"], sizes = { "db-a": 10, "db-b": 5 }, mutate = null } = {}) {
  const requests = [];
  let listReadCount = 0;
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    const parsed = new URL(url);
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.headers.authorization, `Bearer ${BEARER}`);
    if (parsed.pathname === `/client/v4/accounts/${ACCOUNT_ID}/d1/database`) {
      listReadCount += 1;
      let observedIds = ids;
      if (typeof mutate === "function") observedIds = mutate(listReadCount, ids);
      return inventory(observedIds);
    }
    const prefix = `/client/v4/accounts/${ACCOUNT_ID}/d1/database/`;
    assert.ok(parsed.pathname.startsWith(prefix));
    assert.equal(parsed.search, "?fields=uuid,file_size");
    const databaseId = decodeURIComponent(parsed.pathname.slice(prefix.length));
    const configured = sizes[databaseId];
    if (configured === undefined) return response({ uuid: databaseId }, undefined, 404);
    return response({ uuid: databaseId, file_size: configured });
  };
  return { fetchImpl, requests };
}

test("D1 diagnostic observes reconciled point stock without monthly authority", async () => {
  const { fetchImpl, requests } = stableFetcher();
  const provider = createD1StorageObservationProvider({ fetchImpl });
  const result = await provider.collect({ accountId: ACCOUNT_ID, bearer: BEARER, now: Date.now() });

  assert.equal(provider.group, D1_STORAGE_OBSERVATION_GROUP);
  assert.deepEqual(result.values, { d1_storage_bytes: 15 });
  assert.equal(result.coverage.accountId, ACCOUNT_ID);
  assert.equal(result.coverage.fullAccount, false);
  assert.equal(result.provenance, METRIC_PROVENANCE.ANALYTICS_NONBILLING);
  assert.equal(result.diagnosticObservation.atomic, false);
  assert.equal(result.diagnosticObservation.monthlyBillingAuthority, false);
  assert.equal(result.diagnosticObservation.databaseCount, 2);
  assert.equal(result.diagnosticObservation.detailReadbacks, 4);
  assert.equal(requests.length, 6);
  assert.ok(requests.every((entry) => !entry.url.includes("billable/usage")));
  assert.equal(isTestTransportProvider(provider), true);
});

test("D1 diagnostic fails closed when inventory changes between readbacks", async () => {
  const { fetchImpl } = stableFetcher({
    ids: ["db-a"],
    sizes: { "db-a": 10, "db-b": 20 },
    mutate: (read, ids) => read === 2 ? [...ids, "db-b"] : ids,
  });
  const provider = createD1StorageObservationProvider({ fetchImpl });
  await assert.rejects(
    provider.collect({ accountId: ACCOUNT_ID, bearer: BEARER }),
    (error) => error.code === "PARTIAL_PAGINATION",
  );
});

test("D1 diagnostic rejects contradictory result counts", async () => {
  const { fetchImpl } = stableFetcher({ ids: ["db-a"], sizes: { "db-a": 10 } });
  const provider = createD1StorageObservationProvider({
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/d1/database")) {
        return inventory(["db-a"], { total_count: 2 });
      }
      return fetchImpl(url, init);
    },
  });
  await assert.rejects(
    provider.collect({ accountId: ACCOUNT_ID, bearer: BEARER }),
    (error) => error.code === "PARTIAL_PAGINATION",
  );
});

test("D1 diagnostic rejects a details result with a different database UUID", async () => {
  const { fetchImpl } = stableFetcher({ ids: ["db-a"], sizes: { "db-a": 10 } });
  const provider = createD1StorageObservationProvider({
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/db-a")) return response({ uuid: "db-other", file_size: 10 });
      return fetchImpl(url, init);
    },
  });
  await assert.rejects(
    provider.collect({ accountId: ACCOUNT_ID, bearer: BEARER }),
    (error) => error.code === "MALFORMED",
  );
});

test("D1 diagnostic preserves generic HTTP status distinctions without entitlement inference", async () => {
  const provider = createD1StorageObservationProvider({ fetchImpl: async () => new Response("", { status: 403 }) });
  await assert.rejects(
    provider.collect({ accountId: ACCOUNT_ID, bearer: BEARER }),
    (error) => error.code === "HTTP_FORBIDDEN" && error.classification === "authorization-denial" && error.httpStatus === 403,
  );
});

test("D1 diagnostic does not start a request after collection cancellation", async () => {
  let fetchCount = 0;
  const provider = createD1StorageObservationProvider({
    fetchImpl: async () => {
      fetchCount += 1;
      return inventory([]);
    },
  });
  const controller = new globalThis.AbortController();
  controller.abort();
  await assert.rejects(
    provider.collect({ accountId: ACCOUNT_ID, bearer: BEARER, signal: controller.signal }),
    (error) => error.code === "HTTP_STATUS_UNKNOWN",
  );
  assert.equal(fetchCount, 0);
});

test("injected D1 endpoints are test-only and remain account-path bound", async () => {
  let fetchCount = 0;
  const provider = createD1StorageObservationProvider({
    listEndpoint: () => `https://api.cloudflare.com/client/v4/accounts/not-${ACCOUNT_ID}/d1/database?page=1&per_page=100`,
    fetchImpl: async () => {
      fetchCount += 1;
      return inventory([]);
    },
  });
  assert.equal(isTestTransportProvider(provider), true);
  await assert.rejects(
    provider.collect({ accountId: ACCOUNT_ID, bearer: BEARER }),
    (error) => error.code === "ACCOUNT_MISMATCH",
  );
  assert.equal(fetchCount, 0);
});

test("live registry omits restricted billing, while the legacy factory remains explicit", () => {
  const registry = buildLiveProviderRegistry({ accountId: ACCOUNT_ID });
  assert.equal(registry.some((provider) => provider.group === "billable-usage"), false);
  assert.ok(registry.some((provider) => provider.group === D1_STORAGE_OBSERVATION_GROUP));
  assert.equal(typeof createBillableUsageProvider, "function");

  const testRegistry = buildLiveProviderRegistry({
    accountId: ACCOUNT_ID,
    apiBase: LIVE_API_BASE,
    fetchImpl: async () => response([]),
  });
  const d1Diagnostic = testRegistry.find((provider) => provider.group === D1_STORAGE_OBSERVATION_GROUP);
  assert.equal(isTestTransportProvider(d1Diagnostic), true);
  assert.equal(testRegistry.some((provider) => provider.group === "billable-usage"), false);
});
