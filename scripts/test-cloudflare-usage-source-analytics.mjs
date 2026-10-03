import assert from "node:assert/strict";
import test from "node:test";

import { METRIC_PROVENANCE, UNKNOWN } from "./lib/cloudflare-usage-envelope.mjs";
import { buildLiveProviderRegistry } from "./lib/cloudflare-usage-billable.mjs";
import { collectAccountUsage } from "./lib/cloudflare-usage-collection.mjs";
import { createCloudflareUsageAnalyticsProviders } from "./lib/cloudflare-usage-source-analytics.mjs";
import { isTestTransportProvider, LIVE_API_BASE } from "./lib/cloudflare-usage-transport-class.mjs";

const ACCOUNT_ID = "cccccccccccccccccccccccccccccccc";
const BEARER = "fixture-bearer-do-not-echo";
const NOW = Date.parse("2026-10-03T01:02:03.000Z");

const CASES = Object.freeze([
  Object.freeze({ group: "workers-requests-diagnostic", dataset: "workersInvocationsAdaptive", fields: Object.freeze(["requests"]), keys: Object.freeze(["workers_requests"]) }),
  Object.freeze({ group: "d1-rows-diagnostic", dataset: "d1AnalyticsAdaptiveGroups", fields: Object.freeze(["rowsRead", "rowsWritten"]), keys: Object.freeze(["d1_rows_read", "d1_rows_written"]) }),
  Object.freeze({ group: "queue-ops-diagnostic", dataset: "queueMessageOperationsAdaptiveGroups", fields: Object.freeze(["billableOperations"]), keys: Object.freeze(["queue_ops"]) }),
  Object.freeze({ group: "do-requests-diagnostic", dataset: "durableObjectsInvocationsAdaptiveGroups", fields: Object.freeze(["requests"]), keys: Object.freeze(["do_requests"]) }),
]);

function graphqlResponse(dataset, rows, { accountTag = undefined, errors = null, status = 200 } = {}) {
  const account = { [dataset]: rows };
  if (accountTag !== undefined) account.accountTag = accountTag;
  return new Response(JSON.stringify({ data: { viewer: { accounts: [account] } }, errors }), { status });
}

function providers(fetchImpl) {
  return createCloudflareUsageAnalyticsProviders({ apiBase: LIVE_API_BASE, fetchImpl });
}

test("four fixed analytics providers return bounded nonbilling samples", async () => {
  const requests = [];
  const analytics = providers(async (url, init) => {
    requests.push({ url: String(url), init });
    const query = JSON.parse(init.body).query;
    const definition = CASES.find((item) => query.includes(item.dataset));
    assert.ok(definition);
    const row1 = {};
    const row2 = {};
    for (let i = 0; i < definition.fields.length; i += 1) {
      row1[definition.fields[i]] = i + 2;
      row2[definition.fields[i]] = i + 5;
    }
    return graphqlResponse(definition.dataset, [{ sum: row1 }, { sum: row2 }]);
  });

  assert.equal(analytics.length, 4);
  assert.ok(Object.isFrozen(analytics));
  for (let i = 0; i < analytics.length; i += 1) {
    const provider = analytics[i];
    const definition = CASES[i];
    const result = await provider.collect({ accountId: ACCOUNT_ID, bearer: BEARER, now: NOW });
    assert.equal(provider.group, definition.group);
    assert.equal(provider.kind, "analytics-graphql");
    assert.equal(provider.analyticsOnly, true);
    assert.ok(Object.isFrozen(provider));
    assert.ok(Object.isFrozen(provider.covers));
    assert.equal(provider.covers.length, definition.keys.length);
    assert.equal(result.provenance, METRIC_PROVENANCE.ANALYTICS_NONBILLING);
    assert.equal(result.coverage.accountId, ACCOUNT_ID);
    assert.equal(result.coverage.windowStart, "2026-10-01T00:00:00.000Z");
    assert.equal(result.coverage.windowEnd, "2026-10-03T01:02:03.000Z");
    assert.equal(result.coverage.fullAccount, false);
    assert.equal(result.coverage.analyticsOnly, true);
    for (let j = 0; j < definition.fields.length; j += 1) {
      assert.equal(result.values[definition.keys[j]], (j + 2) + (j + 5));
    }
  }

  assert.equal(requests.length, 4);
  for (let i = 0; i < requests.length; i += 1) {
    const { url, init } = requests[i];
    const query = JSON.parse(init.body).query;
    const definition = CASES[i];
    assert.equal(url, `${LIVE_API_BASE}/graphql`);
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.headers.authorization, `Bearer ${BEARER}`);
    assert.ok(query.includes(`accountTag: "${ACCOUNT_ID}"`));
    assert.ok(query.includes(`${definition.dataset}(limit: 1000`));
    if (definition.group === "d1-rows-diagnostic") {
      assert.ok(query.includes("date_geq: \"2026-10-01\""));
      assert.ok(query.includes("date_leq: \"2026-10-03\""));
    } else {
      assert.ok(query.includes("datetime_geq: \"2026-10-01T00:00:00.000Z\""));
      assert.ok(query.includes("datetime_leq: \"2026-10-03T01:02:03.000Z\""));
    }
    assert.ok(!query.includes("dimensions"));
    assert.ok(!query.includes("billable/usage"));
  }
  const d1Query = JSON.parse(requests[1].init.body).query;
  assert.ok(d1Query.includes("date_geq: \"2026-10-01\""));
  assert.ok(d1Query.includes("date_leq: \"2026-10-03\""));
  assert.ok(!d1Query.includes("datetime_geq"));
  assert.ok(analytics.every((provider) => isTestTransportProvider(provider)));
});

test("default analytics providers use fixed live transport without a test brand", () => {
  const analytics = createCloudflareUsageAnalyticsProviders();
  assert.equal(analytics.length, 4);
  for (let i = 0; i < analytics.length; i += 1) {
    assert.equal(isTestTransportProvider(analytics[i]), false);
  }
  const registry = buildLiveProviderRegistry({ accountId: ACCOUNT_ID });
  assert.ok(CASES.every((item) => registry.some((provider) => provider.group === item.group)));
  assert.equal(registry.some((provider) => provider.group === "billable-usage"), false);
});

test("empty GraphQL datasets never become zero counters", async () => {
  const provider = providers(async () => graphqlResponse(CASES[0].dataset, []))[0];
  const result = await provider.collect({ accountId: ACCOUNT_ID, bearer: BEARER, now: NOW });
  assert.deepEqual(result.values, {});
});

test("an optional mismatched account echo is rejected", async () => {
  const provider = providers(async () => graphqlResponse(CASES[0].dataset, [{ sum: { requests: 3 } }], {
    accountTag: "ffffffffffffffffffffffffffffffff",
  }))[0];
  await assert.rejects(
    provider.collect({ accountId: ACCOUNT_ID, bearer: BEARER, now: NOW }),
    (error) => error.code === "ACCOUNT_MISMATCH" && !error.message.includes(BEARER),
  );
});

test("malformed and negative returned sum fields fail closed", async () => {
  for (const value of [-1, Number.NaN, "3"]) {
    const provider = providers(async () => graphqlResponse(CASES[0].dataset, [{ sum: { requests: value } }]))[0];
    await assert.rejects(
      provider.collect({ accountId: ACCOUNT_ID, bearer: BEARER, now: NOW }),
      (error) => error.code === "MALFORMED" && !error.message.includes(BEARER),
    );
  }
});

test("missing D1 row sums remain unknown instead of filling zero", async () => {
  const provider = providers(async () => graphqlResponse(CASES[1].dataset, [
    { sum: { rowsRead: 2, rowsWritten: 7 } },
    { sum: { rowsRead: 3 } },
  ]))[1];
  const result = await provider.collect({ accountId: ACCOUNT_ID, bearer: BEARER, now: NOW });
  assert.deepEqual(result.values, { d1_rows_read: 5 });
});

test("GraphQL errors become a safe provider-data gap without echoing provider text", async () => {
  const secretBody = `sensitive-provider-message-${BEARER}`;
  const provider = providers(async () => graphqlResponse(CASES[0].dataset, [], {
    errors: [{ message: secretBody }],
  }))[0];
  await assert.rejects(
    provider.collect({ accountId: ACCOUNT_ID, bearer: BEARER, now: NOW }),
    (error) => error.code === "HTTP_RESPONSE_ERROR" && error.classification === "provider-data-gap" &&
      !error.message.includes(secretBody) && !error.message.includes(BEARER),
  );
});

test("unknown GraphQL fields and account cardinality fail closed", async () => {
  const unexpected = providers(async () => new Response(JSON.stringify({
    data: { viewer: { accounts: [{ [CASES[0].dataset]: [{ sum: { requests: 1 }, dimensions: {} }] }] } },
    errors: null,
  })))[0];
  await assert.rejects(
    unexpected.collect({ accountId: ACCOUNT_ID, bearer: BEARER, now: NOW }),
    (error) => error.code === "MALFORMED",
  );

  const noAccount = providers(async () => new Response(JSON.stringify({
    data: { viewer: { accounts: [] } },
    errors: null,
  })))[0];
  await assert.rejects(
    noAccount.collect({ accountId: ACCOUNT_ID, bearer: BEARER, now: NOW }),
    (error) => error.code === "ACCOUNT_MISMATCH",
  );
});

test("oversized response bodies are rejected without retaining their content", async () => {
  const provider = providers(async () => new Response("x".repeat(512 * 1024 + 1)))[0];
  await assert.rejects(
    provider.collect({ accountId: ACCOUNT_ID, bearer: BEARER, now: NOW }),
    (error) => error.code === "MALFORMED" && error.message.length < 200 && !error.message.includes(BEARER),
  );
});

test("collection cancellation prevents a request", async () => {
  let requestCount = 0;
  const provider = providers(async () => {
    requestCount += 1;
    return graphqlResponse(CASES[0].dataset, []);
  })[0];
  const controller = new globalThis.AbortController();
  controller.abort();
  await assert.rejects(
    provider.collect({ accountId: ACCOUNT_ID, bearer: BEARER, now: NOW, signal: controller.signal }),
    (error) => error.code === "HTTP_STATUS_UNKNOWN",
  );
  assert.equal(requestCount, 0);
});

test("request timeout also bounds a stalled response body", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay === 10_000 ? 0 : delay, ...args);
  try {
    const provider = providers(async () => new Response(new globalThis.ReadableStream({
      pull() {
        return new Promise(() => {});
      },
    })))[0];
    await assert.rejects(
      provider.collect({ accountId: ACCOUNT_ID, bearer: BEARER, now: NOW }),
      (error) => error.code === "HTTP_STATUS_UNKNOWN" &&
        error.classification === "cancelled-or-deadline" && !error.message.includes(BEARER),
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("analytics numbers remain diagnostics and never enter canonical metrics", async () => {
  const provider = providers(async () => graphqlResponse(CASES[0].dataset, [{ sum: { requests: 42 } }]))[0];
  const snapshot = await collectAccountUsage({
    bearer: BEARER,
    expectedAccountId: ACCOUNT_ID,
    now: NOW,
    whoamiOutput: `Account ${ACCOUNT_ID} via browser OAuth`,
    providers: [provider],
  });
  assert.equal(snapshot.metrics.workers_requests, UNKNOWN);
  const result = snapshot.readback.provider_results.find((item) => item.group === CASES[0].group);
  assert.equal(result.analytics, true);
  assert.deepEqual(result.sample_keys, ["workers_requests"]);
  assert.deepEqual(result.diagnostic_values, { workers_requests: 42 });
  assert.equal(snapshot.readback.metric_trust.workers_requests.state, "unknown-untrusted");
});
