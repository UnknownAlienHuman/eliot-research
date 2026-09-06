// Pagination edge cases: deterministic, no live Cloudflare calls.
// Split from test-cloudflare-usage-providers.mjs (FIX7W2 split-only; no behavior change).
// Run with: node scripts/test-cloudflare-usage-pagination.mjs

import assert from "node:assert/strict";
import {
  ProviderFailure,
  collectAccountUsage,
  createAiSearchInventoryProvider,
  createPaginatedInventoryProvider,
  createR2CursorInventoryProvider,
} from "./lib/cloudflare-usage-collection.mjs";

const ACCOUNT = "cccccccccccccccccccccccccccccccc";
const BEARER = "fictional-provider-bearer-for-tests-only";
const WHOAMI = `account ${ACCOUNT} active`;
const NOW = Date.parse("2026-09-06T12:00:00.000Z");

let cases = 0;
async function check(name, action) {
  await action();
  cases += 1;
  console.log(`Usage pagination: ${name}: PASS`);
}

function okJson(body, status = 200) {
  return { status, json: async () => body };
}

await check("D1 pagination metadata must not disappear mid-walk (Luna case)", async () => {
  const d1Endpoint = (id, page, perPage) => `https://api.cloudflare.com/client/v4/accounts/${id}/d1/database?page=${page}&per_page=${perPage}`;
  // Page 1 establishes a multi-page walk (total_count=2, total_pages=2);
  // page 2 returns its item with empty/missing result_info. The cumulative
  // count (2 vs 2) would still pass, so disappearance itself must reject.
  for (const pageTwo of [{ name: "empty", info: {} }, { name: "missing", info: undefined }]) {
    const vanishing = createPaginatedInventoryProvider({
      group: "d1-inventory-list",
      covers: ["d1_rows_read"],
      endpoint: d1Endpoint,
      perPage: 1,
      fetchImpl: async (url) => {
        const page = Number(new URL(url).searchParams.get("page"));
        if (page <= 1) {
          return okJson({ success: true, result: [{ uuid: "one" }], result_info: { page: 1, per_page: 1, total_count: 2, total_pages: 2 } });
        }
        const body = { success: true, result: [{ uuid: "two" }] };
        if (pageTwo.info !== undefined) body.result_info = pageTwo.info;
        return okJson(body);
      },
    });
    await assert.rejects(
      vanishing.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
      (error) => error instanceof ProviderFailure && (error.reason === "PARTIAL_PAGINATION" || error.reason === "MALFORMED"),
      `page-2 ${pageTwo.name} result_info must fail closed`,
    );
    const snapshot = await collectAccountUsage({
      bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: WHOAMI, providers: [vanishing],
    });
    assert.equal(snapshot.metrics.d1_rows_read, "unknown");
    assert.ok(snapshot.readback.provider_errors.some((line) => line.includes("d1-inventory-list")));
  }
  // A per_page/total that drifts or disappears across pages fails closed too.
  const droppedTotals = createPaginatedInventoryProvider({
    group: "d1-inventory-list",
    covers: [],
    endpoint: d1Endpoint,
    perPage: 1,
    fetchImpl: async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      if (page <= 1) {
        return okJson({ success: true, result: [{ uuid: "one" }], result_info: { page: 1, per_page: 1, total_count: 2, total_pages: 2 } });
      }
      return okJson({ success: true, result: [{ uuid: "two" }], result_info: { page: 2, per_page: 1 } });
    },
  });
  await assert.rejects(
    droppedTotals.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "PARTIAL_PAGINATION",
  );
  // A single short page without metadata stays admissible (totalPages=page=1).
  const singleShort = createPaginatedInventoryProvider({
    group: "d1-inventory-list",
    covers: [],
    endpoint: d1Endpoint,
    perPage: 100,
    fetchImpl: async () => okJson({ success: true, result: [{ uuid: "only" }], result_info: {} }),
  });
  const reported = await singleShort.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW });
  assert.equal(reported.inventory.length, 1);
  assert.equal(reported.coverage.fullAccount, true);
});

await check("ai-search short pages without totals never prove full coverage", async () => {
  const aiEndpoint = (id, page, perPage) => `https://api.cloudflare.com/client/v4/accounts/${id}/ai-search/instances?page=${page}&per_page=${perPage}`;
  // A short page without totals (or any other terminal signal on this shape)
  // is truncation-ambiguous: it must not yield fullAccount:true.
  const shortNoTotals = createAiSearchInventoryProvider({
    endpoint: aiEndpoint,
    fetchImpl: async () => okJson({ success: true, result: [{ id: "one" }] }),
  });
  await assert.rejects(
    shortNoTotals.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "PARTIAL_PAGINATION",
  );
  const snapshot = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: WHOAMI, providers: [shortNoTotals],
  });
  assert.equal(snapshot.metrics.ai_search_instances, "unknown");
  assert.ok(snapshot.readback.provider_errors.some((line) => line.includes("ai-search-inventory-list")));
  // Totals present on page 1 then absent on a later page fail closed too.
  const vanishing = createAiSearchInventoryProvider({
    endpoint: aiEndpoint,
    fetchImpl: async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      if (page <= 1) {
        return okJson({ success: true, result: [{ id: "one" }], result_info: { page: 1, total_pages: 2, per_page: 100 } });
      }
      return okJson({ success: true, result: [{ id: "two" }] });
    },
  });
  await assert.rejects(
    vanishing.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "PARTIAL_PAGINATION",
  );
  const vanished = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: WHOAMI, providers: [vanishing],
  });
  assert.equal(vanished.metrics.ai_search_instances, "unknown");
});

await check("ai-search established metadata never disappears (page/per_page/count/totals)", async () => {
  const aiEndpoint = (id, page, perPage) => `https://api.cloudflare.com/client/v4/accounts/${id}/ai-search/instances?page=${page}&per_page=${perPage}`;
  const fullFirst = { page: 1, per_page: 1, count: 1, total_count: 2, total_pages: 2 };
  // Manager repro: page 2 retains totals but omits per_page+count. The
  // cumulative count (2 vs 2) would still pass, so disappearance itself must
  // reject instead of fullAccount:true.
  const drops = [
    ["per_page+count", { page: 2, total_count: 2, total_pages: 2 }],
    ["count-only", { page: 2, per_page: 1, total_count: 2, total_pages: 2 }],
    ["per_page-only", { page: 2, count: 1, total_count: 2, total_pages: 2 }],
    ["totals", { page: 2, per_page: 1, count: 1 }],
    ["empty-container", {}],
  ];
  for (const [label, second] of drops) {
    const provider = createAiSearchInventoryProvider({
      endpoint: aiEndpoint,
      fetchImpl: async (url) => {
        const page = Number(new URL(url).searchParams.get("page"));
        if (page <= 1) {
          return okJson({ success: true, result: [{ id: "one" }], result_info: { ...fullFirst } });
        }
        return okJson({ success: true, result: [{ id: "two" }], result_info: { ...second } });
      },
    });
    await assert.rejects(
      provider.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
      (error) => error instanceof ProviderFailure && (error.reason === "PARTIAL_PAGINATION" || error.reason === "MALFORMED"),
      `ai-search page-2 ${label} disappearance must fail closed`,
    );
    const snapshot = await collectAccountUsage({
      bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: WHOAMI, providers: [provider],
    });
    assert.equal(snapshot.metrics.ai_search_instances, "unknown", `ai-search ${label} must stay unknown`);
  }
  // Page echo disappearance fails closed as well (totals present require echo).
  const noEcho = createAiSearchInventoryProvider({
    endpoint: aiEndpoint,
    fetchImpl: async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      if (page <= 1) {
        return okJson({ success: true, result: [{ id: "one" }], result_info: { ...fullFirst } });
      }
      return okJson({ success: true, result: [{ id: "two" }], result_info: { per_page: 1, count: 1, total_count: 2, total_pages: 2 } });
    },
  });
  await assert.rejects(
    noEcho.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && (error.reason === "PARTIAL_PAGINATION" || error.reason === "MALFORMED"),
    "ai-search page echo disappearance must fail closed",
  );
  // Container switch that drops established fields fails closed; a switch
  // that preserves every established field stays admissible.
  const switchDrop = createAiSearchInventoryProvider({
    endpoint: aiEndpoint,
    fetchImpl: async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      if (page <= 1) {
        return okJson({ success: true, result: [{ id: "one" }], result_info: { ...fullFirst } });
      }
      return okJson({ success: true, result: [{ id: "two" }], pagination: { page: 2, total_count: 2, total_pages: 2 } });
    },
  });
  await assert.rejects(
    switchDrop.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "PARTIAL_PAGINATION",
    "ai-search container switch that drops per_page+count must fail closed",
  );
  const switchKeep = createAiSearchInventoryProvider({
    endpoint: aiEndpoint,
    fetchImpl: async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      if (page <= 1) {
        return okJson({ success: true, result: [{ id: "one" }], result_info: { ...fullFirst } });
      }
      return okJson({ success: true, result: [{ id: "two" }], pagination: { page: 2, per_page: 1, count: 1, total_count: 2, total_pages: 2 } });
    },
  });
  const kept = await switchKeep.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW });
  assert.equal(kept.coverage.fullAccount, true);
  assert.equal(kept.values.ai_search_instances, 2);
  // Cumulative count mismatch still fails closed even with stable metadata.
  const shortCount = createAiSearchInventoryProvider({
    endpoint: aiEndpoint,
    fetchImpl: async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      if (page <= 1) {
        return okJson({ success: true, result: [{ id: "one" }], result_info: { page: 1, per_page: 1, count: 1, total_count: 3, total_pages: 3 } });
      }
      if (page === 2) {
        return okJson({ success: true, result: [{ id: "two" }], result_info: { page: 2, per_page: 1, count: 1, total_count: 3, total_pages: 3 } });
      }
      return okJson({ success: true, result: [], result_info: { page: 3, per_page: 1, count: 0, total_count: 3, total_pages: 3 } });
    },
  });
  await assert.rejects(
    shortCount.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "PARTIAL_PAGINATION",
    "ai-search cumulative mismatch must fail closed",
  );
});

await check("R2 cursor that never terminates rejects after the hop cap", async () => {
  const advancing = createR2CursorInventoryProvider({
    endpoint: (id, cursor) => cursor
      ? `https://api.cloudflare.com/client/v4/accounts/${id}/r2/buckets?cursor=${encodeURIComponent(cursor)}`
      : `https://api.cloudflare.com/client/v4/accounts/${id}/r2/buckets`,
    fetchImpl: async (url) => {
      const cursor = new URL(url).searchParams.get("cursor");
      const next = cursor === null ? "cursor-1" : `${cursor}-next`;
      return okJson({ success: true, result: { buckets: [{ name: next }], cursor: next } });
    },
  });
  await assert.rejects(
    advancing.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "PARTIAL_PAGINATION",
  );
});

await check("invalid pagination totals fail closed on every path", async () => {
  const d1Endpoint = (id, page, perPage) => `https://api.cloudflare.com/client/v4/accounts/${id}/d1/database?page=${page}&per_page=${perPage}`;
  // FIX8W: presence-first — every present-but-invalid total_pages is typed
  // MALFORMED, never silent-absent. NaN/Infinity survive in-memory (no JSON
  // string round-trip here); labels use String() since JSON.stringify(NaN)
  // collapses to "null".
  for (const totalPages of [0, -1, 1.5, "2", null, true, NaN, Infinity]) {
    const general = createPaginatedInventoryProvider({
      group: "d1-inventory-list",
      covers: ["d1_rows_read"],
      endpoint: d1Endpoint,
      fetchImpl: async () => okJson({ success: true, result: [{ uuid: "one" }], result_info: { page: 1, per_page: 100, total_pages: totalPages } }),
    });
    await assert.rejects(
      general.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
      (error) => error instanceof ProviderFailure && error.reason === "MALFORMED",
      `general total_pages=${String(totalPages)} must be MALFORMED`,
    );
    const ai = createAiSearchInventoryProvider({
      endpoint: (id, page, perPage) => `https://api.cloudflare.com/client/v4/accounts/${id}/ai-search/instances?page=${page}&per_page=${perPage}`,
      fetchImpl: async () => okJson({ success: true, result: [{ id: "one" }], result_info: { page: 1, per_page: 100, total_pages: totalPages } }),
    });
    await assert.rejects(
      ai.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
      (error) => error instanceof ProviderFailure && error.reason === "MALFORMED",
      `ai-search total_pages=${String(totalPages)} must be MALFORMED`,
    );
  }
});

await check("present-but-invalid page/per_page/count/total_count fail closed", async () => {
  const d1Endpoint = (id, page, perPage) => `https://api.cloudflare.com/client/v4/accounts/${id}/d1/database?page=${page}&per_page=${perPage}`;
  const aiEndpoint = (id, page, perPage) => `https://api.cloudflare.com/client/v4/accounts/${id}/ai-search/instances?page=${page}&per_page=${perPage}`;
  // Each case overrides one field on top of an otherwise-valid single-page
  // envelope; every override must be typed MALFORMED on both providers.
  const fieldCases = [
    ["page", 0], ["page", -1], ["page", 1.5], ["page", "1"], ["page", null], ["page", true], ["page", NaN], ["page", Infinity],
    ["per_page", 0], ["per_page", -1], ["per_page", 1.5], ["per_page", "100"], ["per_page", null], ["per_page", false], ["per_page", NaN], ["per_page", Infinity],
    ["count", -1], ["count", 1.5], ["count", "1"], ["count", null], ["count", true], ["count", NaN], ["count", Infinity],
    ["total_count", -1], ["total_count", 1.5], ["total_count", "1"], ["total_count", null], ["total_count", false], ["total_count", NaN], ["total_count", Infinity],
  ];
  for (const [field, bad] of fieldCases) {
    const base = { page: 1, per_page: 100, count: 1, total_count: 1, total_pages: 1 };
    const general = createPaginatedInventoryProvider({
      group: "d1-inventory-list",
      covers: [],
      endpoint: d1Endpoint,
      perPage: 100,
      fetchImpl: async () => okJson({ success: true, result: [{ uuid: "one" }], result_info: { ...base, [field]: bad } }),
    });
    await assert.rejects(
      general.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
      (error) => error instanceof ProviderFailure && error.reason === "MALFORMED",
      `general ${field}=${String(bad)} must be MALFORMED`,
    );
    const ai = createAiSearchInventoryProvider({
      endpoint: aiEndpoint,
      fetchImpl: async () => okJson({ success: true, result: [{ id: "one" }], result_info: { ...base, [field]: bad } }),
    });
    await assert.rejects(
      ai.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
      (error) => error instanceof ProviderFailure && error.reason === "MALFORMED",
      `ai-search ${field}=${String(bad)} must be MALFORMED`,
    );
  }
});

await check("malformed result_info never reads as absent", async () => {
  // FIX8W: explicit null is present-but-malformed (the old `?? {}` fallback
  // conflated it with absent). Booleans join the pre-existing
  // string/number/array cases; every entry must be typed MALFORMED.
  for (const malformed of ["oops", 42, ["page"], null, true, false]) {
    const general = createPaginatedInventoryProvider({
      group: "d1-inventory-list",
      covers: ["d1_rows_read"],
      endpoint: (id, page, perPage) => `https://api.cloudflare.com/client/v4/accounts/${id}/d1/database?page=${page}&per_page=${perPage}`,
      fetchImpl: async () => okJson({ success: true, result: [{ uuid: "one" }], result_info: malformed }),
      perPage: 100,
    });
    await assert.rejects(
      general.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
      (error) => error instanceof ProviderFailure && error.reason === "MALFORMED",
      `general result_info=${String(malformed)} must be MALFORMED`,
    );
    const ai = createAiSearchInventoryProvider({
      endpoint: (id, page, perPage) => `https://api.cloudflare.com/client/v4/accounts/${id}/ai-search/instances?page=${page}&per_page=${perPage}`,
      fetchImpl: async () => okJson({ success: true, result: [{ id: "one" }], result_info: malformed }),
    });
    await assert.rejects(
      ai.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
      (error) => error instanceof ProviderFailure && error.reason === "MALFORMED",
      `ai-search result_info=${String(malformed)} must be MALFORMED`,
    );
  }
  // Legitimately absent (undefined property) single-short response keeps its
  // contract on general, as does plain {}.
  for (const legit of [{ name: "missing", body: { success: true, result: [{ uuid: "only" }] } }, { name: "empty-object", body: { success: true, result: [{ uuid: "only" }], result_info: {} } }]) {
    const singleShort = createPaginatedInventoryProvider({
      group: "d1-inventory-list",
      covers: [],
      endpoint: (id, page, perPage) => `https://api.cloudflare.com/client/v4/accounts/${id}/d1/database?page=${page}&per_page=${perPage}`,
      perPage: 100,
      fetchImpl: async () => okJson(legit.body),
    });
    const reported = await singleShort.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW });
    assert.equal(reported.coverage.fullAccount, true, `general ${legit.name} single-short must stay fullAccount:true`);
  }
});

console.log(`Usage pagination: ${cases} groups passed; live Cloudflare NOT_EXECUTED`);
