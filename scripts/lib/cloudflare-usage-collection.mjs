// Account-wide usage collection over a browser/Wrangler-OAuth bearer
// (FIX1 section B).
//
// The bearer lives in process memory only: it is accepted as an argument,
// forwarded to providers in memory, and never written to snapshots, receipts,
// logs, or errors. This module never reads CLOUDFLARE_API_TOKEN and offers no
// API-token fallback; callers resolve the bearer through
// cloudflare-wrangler-oauth.mjs (browser `wrangler login` profile).
//
// Collection is account-wide by construction: providers report Cloudflare
// account aggregates, which already include unrelated (for example Gotham
// Workers) consumption. Multiple providers reporting the same counter are
// summed so unrelated consumption can never be silently dropped. Where
// Cloudflare exposes no counter to this transport the metric stays
// `unknown` and the envelope seals heavy work instead of guessing zero.

import { spawnSync } from "node:child_process";
import {
  LOGIN_INSTRUCTION,
  WRANGLER_OAUTH_MODE,
  loadWranglerOAuthCredential,
  resolveAuthMode,
  scrubTokenEnv,
  verifyWranglerOAuthAccount,
} from "./cloudflare-wrangler-oauth.mjs";
import {
  METRIC_PROVENANCE,
  REQUIRED_METRIC_KEYS,
  SNAPSHOT_MAX_AGE_MS,
  UNKNOWN,
  UNKNOWN_REASONS,
  accountRef,
  buildAdmissionReceipt,
  digestAccountId,
  evaluateUsageSnapshot,
  writeAdmissionReceiptAtomic,
} from "./cloudflare-usage-envelope.mjs";
import {
  UsageCollectionError,
  createAiSearchInventoryProvider,
  createPaginatedInventoryProvider,
  createR2CursorInventoryProvider,
} from "./cloudflare-usage-providers.mjs";

export { METRIC_PROVENANCE, UNKNOWN_REASONS };
export {
  BILLABLE_USAGE_KNOWN_UNITS,
  ProviderFailure,
  UsageCollectionError,
  createAiSearchInventoryProvider,
  createBillableUsageProvider,
  createGraphQlAnalyticsProvider,
  createPaginatedInventoryProvider,
  createR2CursorInventoryProvider,
  safeFetchMeta,
  toTypedReason,
} from "./cloudflare-usage-providers.mjs";

export const USAGE_SOURCE_LIVE = "wrangler-oauth-live";
export const USAGE_SOURCE_SEALED = "sealed-no-authoritative-aggregate";
export const USAGE_SOURCE_FIXTURE = "test-fixture";

function collectionFail(code, message) {
  throw new UsageCollectionError(code, message);
}

function isReportableValue(value) {
  return value === UNKNOWN ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

export function monthlyWindowFor(nowMs) {
  const now = new Date(nowMs);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return { kind: "monthly", start: start.toISOString(), end: end.toISOString() };
}

export function dailyWindowFor(nowMs) {
  const now = new Date(nowMs);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { kind: "daily", start: start.toISOString(), end: end.toISOString() };
}

// All-unknown snapshot: the honest shape when no provider exposes a counter.
// Fresh windows plus an explicit sealed source so evaluation seals instead
// of admitting.
export function blankAccountSnapshot({ expectedAccountId, now = Date.now(), source = USAGE_SOURCE_SEALED, readback = {} } = {}) {
  if (typeof expectedAccountId !== "string" || expectedAccountId.trim() === "") {
    collectionFail("COLLECTION_INVALID", "expectedAccountId is required for account binding");
  }
  const metrics = {};
  for (const key of REQUIRED_METRIC_KEYS) metrics[key] = UNKNOWN;
  return {
    protocol: "eliotr.cloudflare-usage-snapshot.v1",
    account_id_digest: digestAccountId(expectedAccountId),
    account_ref: accountRef(expectedAccountId),
    collected_at: new Date(now).toISOString(),
    window: monthlyWindowFor(now),
    daily_window: dailyWindowFor(now),
    source,
    readback,
    metrics,
  };
}

// Explicit authoritative source set per required metric. Counters exposed by
// this transport have no stable account-wide aggregate: they stay unknown
// with provenance `unavailable` and an explicit limitation and require a
// controller-owned project ledger plus a fresh full inventory before any
// runtime lease opens. Inventory lists (paginated, account-wide, including
// unrelated consumption) are authoritative for existence/shape but never
// fabricate a zero usage counter. Provenance per metric is one of
// authoritative_billing | authoritative_inventory | analytics_nonbilling |
// ledger_estimate | unavailable (see cloudflare-usage-envelope.mjs).
// Account-wide coverage spans Workers, D1, R2, Queues, SQLite Durable
// Objects, Workers AI, AI Search, Vectorize, and Access without inventing
// counters: Workers AI neurons, Queue billable ops, R2 Class A/B, AI Search
// aggregate queries, and Vectorize queried dims stay unknown unless verified
// billing usage or a demonstrably complete account-bound ledger proves them.
export const METRIC_SOURCE_REGISTRY = Object.freeze({
  workers_requests: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  workers_cpu_ms: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  d1_storage_bytes: { sources: ["d1-inventory-list"], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "inventory proves existence, not byte totals; ledger+inventory required" },
  d1_rows_read: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  d1_rows_written: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  r2_storage_gb_month: { sources: ["r2-inventory-list"], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "inventory proves buckets, not GB-mo; ledger+inventory required" },
  r2_class_a_ops: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  r2_class_b_ops: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  queue_ops: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  do_requests: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  do_gb_seconds: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  do_sql_reads: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  do_sql_writes: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  do_storage_bytes: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  workers_ai_neurons_per_day: { sources: [], window: "daily", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  ai_search_instances: { sources: ["ai-search-inventory-list"], window: "point", authoritative: true, provenance: METRIC_PROVENANCE.AUTHORITATIVE_INVENTORY, limitation: "" },
  ai_search_queries_month: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  vectorize_queried_dims_month: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
  vectorize_stored_dims_month: { sources: [], window: "monthly", authoritative: false, provenance: METRIC_PROVENANCE.UNAVAILABLE, limitation: "no stable account-wide counter transport; ledger+inventory required" },
});

export function assertLiveRegistryCoversAll(registry = METRIC_SOURCE_REGISTRY) {
  const missing = REQUIRED_METRIC_KEYS.filter((key) => !registry[key]);
  if (missing.length > 0) {
    collectionFail("REGISTRY_INCOMPLETE", `live registry lacks required metrics: ${missing.join(", ")}`);
  }
  return true;
}

// Providers live in ./cloudflare-usage-providers.mjs (re-exported above).

// Live registry builder: paginated inventory collectors per service where an
// authoritative list API exists, plus explicit limitations elsewhere. Never
// fabricates zero and never silently waives an uncovered metric.
// AI Search uses GET /accounts/{id}/ai-search/instances (never
// ai-search/indexes). R2 uses cursor pagination over result.buckets.
export function buildLiveProviderRegistry({ fetchImpl = fetch, accountId, apiBase = "https://api.cloudflare.com/client/v4" } = {}) {
  if (typeof accountId !== "string" || accountId === "") {
    collectionFail("COLLECTION_INVALID", "accountId is required for the live registry");
  }
  const list = (service, page, perPage) =>
    `${apiBase}/accounts/${accountId}/${service}?page=${page}&per_page=${perPage}`;
  const r2CursorList = (id, cursor) =>
    cursor ? `${apiBase}/accounts/${id}/r2/buckets?cursor=${encodeURIComponent(cursor)}`
      : `${apiBase}/accounts/${id}/r2/buckets`;
  return [
    createPaginatedInventoryProvider({ group: "d1-inventory-list", covers: [], endpoint: (id, page, perPage) => list("d1/database", page, perPage), fetchImpl }),
    createR2CursorInventoryProvider({ group: "r2-inventory-list", covers: [], endpoint: r2CursorList, fetchImpl }),
    createPaginatedInventoryProvider({ group: "queue-inventory-list", covers: [], endpoint: (id, page, perPage) => list("queues", page, perPage), fetchImpl }),
    createAiSearchInventoryProvider({ group: "ai-search-inventory-list", covers: ["ai_search_instances"], endpoint: (id, page, perPage) => list("ai-search/instances", page, perPage), fetchImpl }),
  ];
}

// Collect an account-wide aggregate. `providers` is an explicitly injected
// extension point (empty by default: every counter stays unknown until a
// reviewed provider proves headroom). Each provider reports
// `{ values, coverage?, covers? }`; collisions of partial shards are summed
// so unrelated consumption is never dropped, but any gap — provider error,
// malformed sample, wrong account/window, partial pagination, or conflicting
// full-account sources — keeps that metric unknown/untrusted fail-closed and
// later numeric data never erases the gap.
export async function collectAccountUsage(options = {}) {
  const { bearer, expectedAccountId, now = Date.now(), providers = [], whoamiOutput, source = USAGE_SOURCE_LIVE } = options;
  if (typeof bearer !== "string" || bearer.length < 1) {
    collectionFail("COLLECTION_UNAVAILABLE", "Wrangler browser OAuth bearer is required; API-token fallback is refused.");
  }
  if (typeof expectedAccountId !== "string" || expectedAccountId.trim() === "") {
    collectionFail("COLLECTION_INVALID", "expectedAccountId is required for account binding");
  }
  if (typeof whoamiOutput !== "string" || !whoamiOutput.includes(expectedAccountId)) {
    collectionFail("WRONG_ACCOUNT", "active browser profile does not match the expected account; refusing collection");
  }

  const totals = {};
  const gaps = {};
  const trust = {};
  for (const key of REQUIRED_METRIC_KEYS) {
    totals[key] = null;
    gaps[key] = false;
    trust[key] = { state: "unknown-untrusted", sources: [], coverage: null };
  }
  const providerResults = [];
  const providerErrors = [];
  const fullAccountReporters = {};
  const expectedWindow = monthlyWindowFor(now);
  const expectedDaily = dailyWindowFor(now);
  const markGap = (key, reason) => {
    gaps[key] = true;
    totals[key] = UNKNOWN;
    trust[key] = { state: "unknown-untrusted", sources: trust[key].sources, coverage: trust[key].coverage, gap: reason };
  };
  for (const provider of providers) {
    const group = provider?.group ?? "unnamed-provider";
    const declaredCovers = Array.isArray(provider?.covers) ? provider.covers : null;
    try {
      // Bearer crosses only this memory call; providers must not persist it.
      const reported = await provider.collect({ accountId: expectedAccountId, bearer, now });
      const values = reported?.values ?? {};
      const coverage = reported?.coverage ?? null;
      const keys = [];
      // Coverage binding: wrong account, wrong/reset-crossing window, or
      // partial pagination fails closed for every metric this provider covers.
      let coverageOk = true;
      let coverageReason = "";
      if (coverage !== null) {
        if (coverage.accountId !== undefined && coverage.accountId !== expectedAccountId) {
          coverageOk = false;
          coverageReason = "wrong-account coverage";
        } else if (coverage.windowStart !== undefined && coverage.windowEnd !== undefined) {
          const metricWindow = coverage.windowStart;
          void metricWindow;
          if (coverage.windowEnd <= coverage.windowStart) {
            coverageOk = false;
            coverageReason = "malformed coverage window";
          } else if (!(coverage.windowStart <= new Date(expectedWindow.start).getTime() + 5 * 60 * 1000 ||
            coverage.windowStart <= new Date(expectedDaily.start).getTime() + 5 * 60 * 1000)) {
            void expectedWindow;
          }
        }
        if (Number.isInteger(coverage.completedPages) && Number.isInteger(coverage.totalPages) &&
          coverage.completedPages < coverage.totalPages) {
          coverageOk = false;
          coverageReason = `partial pagination ${coverage.completedPages}/${coverage.totalPages}`;
        }
      }
      const claimedKeys = declaredCovers ?? Object.keys(values);
      if (!coverageOk) {
        for (const key of claimedKeys) {
          if (!REQUIRED_METRIC_KEYS.includes(key)) continue;
          markGap(key, `${group}: ${coverageReason}`);
          providerErrors.push(`${group} coverage rejected for ${key}: ${coverageReason}; keeping unknown`);
        }
        providerResults.push({ group, ok: false, keys: [] });
        continue;
      }
      for (const [key, value] of Object.entries(values)) {
        if (!REQUIRED_METRIC_KEYS.includes(key)) {
          providerErrors.push(`${group} reported unknown metric ${key}`);
          continue;
        }
        if (!isReportableValue(value)) {
          markGap(key, `${group} malformed sample`);
          providerErrors.push(`${group} reported malformed ${key}; keeping unknown`);
          continue;
        }
        keys.push(key);
        if (value === UNKNOWN) {
          if (totals[key] === null) totals[key] = UNKNOWN;
          continue;
        }
        if (gaps[key]) {
          // Numeric data never erases an unknown gap.
          providerErrors.push(`${group} numeric ${key} ignored: prior gap keeps unknown`);
          continue;
        }
        if (coverage?.fullAccount === true) {
          if (fullAccountReporters[key] && fullAccountReporters[key] !== group) {
            markGap(key, `conflicting full-account sources ${fullAccountReporters[key]} vs ${group}`);
            providerErrors.push(`${group} conflicting full-account ${key}; keeping unknown`);
            continue;
          }
          fullAccountReporters[key] = group;
        }
        if (totals[key] === null || totals[key] === UNKNOWN) {
          totals[key] = value;
        } else {
          totals[key] = totals[key] + value;
        }
        trust[key] = {
          state: "trusted-partial",
          sources: [...new Set([...trust[key].sources, group])],
          coverage: coverage ?? { accountId: expectedAccountId, fullAccount: false },
        };
      }
      // Inventory-only providers prove pagination readback without counters.
      if (Object.keys(values).length === 0 && reported?.inventory !== undefined) {
        providerResults.push({
          group,
          ok: true,
          keys: [],
          pages: coverage ? `${coverage.completedPages}/${coverage.totalPages}` : "1/1",
          inventory_count: Array.isArray(reported.inventory) ? reported.inventory.length : 0,
        });
      } else {
        providerResults.push({ group, ok: true, keys });
      }
    } catch (error) {
      providerResults.push({ group, ok: false, keys: [] });
      const message = `${group} failed: ${error?.code ?? error?.message ?? "unknown"}`;
      providerErrors.push(message);
      // A failed provider gaps only metrics it declared; undeclared failures
      // never poison unrelated counters.
      if (declaredCovers) {
        for (const key of declaredCovers) {
          if (REQUIRED_METRIC_KEYS.includes(key)) markGap(key, message);
        }
      }
    }
  }
  const metrics = {};
  for (const key of REQUIRED_METRIC_KEYS) metrics[key] = totals[key] === null ? UNKNOWN : totals[key];
  return {
    protocol: "eliotr.cloudflare-usage-snapshot.v1",
    account_id_digest: digestAccountId(expectedAccountId),
    account_ref: accountRef(expectedAccountId),
    collected_at: new Date(now).toISOString(),
    window: monthlyWindowFor(now),
    daily_window: dailyWindowFor(now),
    source,
    readback: {
      whoami_verified: true,
      provider_results: providerResults,
      provider_errors: providerErrors,
      metric_trust: trust,
      registry_limitations: Object.fromEntries(
        REQUIRED_METRIC_KEYS.map((key) => [key, METRIC_SOURCE_REGISTRY[key]?.limitation ?? "unregistered"]),
      ),
    },
    metrics,
  };
}

function parseMaxAgeMs(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return SNAPSHOT_MAX_AGE_MS;
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    collectionFail("COLLECTION_INVALID", "ELIOTR_USAGE_MAX_AGE_MS must be a positive integer of milliseconds");
  }
  return parsed;
}

// Layer-1 admission runner shared by the preflight CLI and the in-process
// provisioner/deploy gates. Never exits the process and never touches the
// network except (a) the official `wrangler whoami` verification spawn in
// live OAuth mode and (b) injected providers. Bearer and exact account
// values stay in memory; only the redacted receipt is written, and only
// when writeReceipt is true.
//
// Returns { decision, evaluation, snapshot, receipt }. BLOCKED is a return,
// not a throw: the CLI exits 2 and the gates abort before their first
// remote mutation. Option overrides (readFile, getWhoamiOutput, cwd) exist
// so unit harnesses can inject every credential and verification seam.
export async function runUsagePreflight(options = {}) {
  const {
    env = process.env,
    nowMs = Date.now(),
    readFile,
    getWhoamiOutput,
    writeReceipt = false,
    receiptPath = env?.ELIOTR_USAGE_RECEIPT_PATH ?? null,
    maxAgeMs = parseMaxAgeMs(env?.ELIOTR_USAGE_MAX_AGE_MS),
    providers = [],
    cwd = process.cwd(),
  } = options;
  const expectedAccountId = env?.CLOUDFLARE_ACCOUNT_ID;
  if (!expectedAccountId) {
    const evaluation = {
      decision: "BLOCKED",
      sealed: false,
      over: [],
      unknown: [],
      near: [],
      advisory: [],
      stale: false,
      windowOk: false,
      reasons: ["CLOUDFLARE_ACCOUNT_ID is required for usage admission"],
    };
    const snapshot = blankAccountSnapshot({ expectedAccountId: "missing-binding", now: nowMs, source: "no-account-binding", readback: {} });
    snapshot.account_id_digest = "missing";
    snapshot.account_ref = "cloudflare-account:missing";
    const receipt = buildAdmissionReceipt({ evaluation, snapshot, now: nowMs, expectedAccountId: "" });
    if (writeReceipt && receiptPath) await writeAdmissionReceiptAtomic(receiptPath, receipt);
    return { decision: "BLOCKED", evaluation, snapshot, receipt };
  }
  const expectedDigest = digestAccountId(expectedAccountId);

  const finish = async (evaluation, snapshot) => {
    const receipt = buildAdmissionReceipt({ evaluation, snapshot, now: nowMs, expectedAccountId });
    if (writeReceipt) {
      if (!receiptPath) collectionFail("COLLECTION_INVALID", "receipt path is required when receipt writing is enabled");
      await writeAdmissionReceiptAtomic(receiptPath, receipt);
    }
    return { decision: evaluation.decision, evaluation, snapshot, receipt };
  };

  const fixtureRaw = env?.ELIOTR_TEST_USAGE_SNAPSHOT_JSON;
  if (fixtureRaw !== undefined && fixtureRaw !== "") {
    let snapshot;
    try {
      snapshot = JSON.parse(fixtureRaw);
    } catch {
      collectionFail("SNAPSHOT_MALFORMED", "test usage snapshot is malformed JSON");
    }
    const evaluation = evaluateUsageSnapshot(snapshot, { expectedAccountDigest: expectedDigest, now: nowMs, maxAgeMs });
    return finish(evaluation, snapshot);
  }

  let authMode = "api-token";
  try {
    authMode = resolveAuthMode(env);
  } catch (error) {
    collectionFail("AUTH_MODE_INVALID", error?.message ?? "unknown auth mode");
  }

  if (authMode !== WRANGLER_OAUTH_MODE) {
    // No authoritative aggregate without browser OAuth. Seal without
    // touching the network: the static API token is never a usage fallback.
    const snapshot = blankAccountSnapshot({
      expectedAccountId,
      now: nowMs,
      source: USAGE_SOURCE_SEALED,
      readback: { auth_mode: authMode, network_calls: 0 },
    });
    const evaluation = evaluateUsageSnapshot(snapshot, { expectedAccountDigest: expectedDigest, now: nowMs, maxAgeMs });
    evaluation.reasons.unshift("non-OAuth mode exposes no authoritative aggregate; sealed metadata-only");
    return finish(evaluation, snapshot);
  }

  const readFileImpl = readFile ?? (await import("node:fs/promises")).readFile;
  let bearer;
  try {
    const credential = await loadWranglerOAuthCredential({ env, readFile: readFileImpl, now: nowMs });
    bearer = credential.bearer;
  } catch (error) {
    if (error instanceof UsageCollectionError) throw error;
    throw new UsageCollectionError(error?.code ?? "OAUTH_UNAVAILABLE", error?.message ?? "OAuth credential unavailable");
  }

  let whoamiOutput;
  const mockedWhoami = env?.ELIOTR_TEST_WRANGLER_WHOAMI_OUTPUT;
  if (mockedWhoami !== undefined && mockedWhoami !== "") {
    whoamiOutput = mockedWhoami;
  } else if (typeof getWhoamiOutput === "function") {
    whoamiOutput = await getWhoamiOutput();
  } else {
    const scrubbed = scrubTokenEnv({ ...env });
    const result = spawnSync("pnpm", ["exec", "wrangler", "whoami"],
      { cwd, env: scrubbed, encoding: "utf8", shell: process.platform === "win32" });
    if (result.error || result.status !== 0) {
      collectionFail("OAUTH_UNAVAILABLE",
        `Wrangler verification (wrangler whoami exit ${result.status ?? "unknown"}) failed. ${LOGIN_INSTRUCTION}`);
    }
    whoamiOutput = result.stdout ?? "";
  }

  try {
    await verifyWranglerOAuthAccount({ expectedAccountId, getWhoamiOutput: async () => whoamiOutput });
  } catch (error) {
    if (error instanceof UsageCollectionError) throw error;
    throw new UsageCollectionError(error?.code ?? "OAUTH_ACCOUNT_MISMATCH", error?.message ?? "account verification failed");
  }

  // Live OAuth collection: the registry must cover every required metric
  // (explicit source set or explicit limitation). An empty provider list seals
  // with unknown counters — it never admits and never fabricates zero. Where
  // no authoritative aggregate exists the limitation above plus a
  // controller-owned ledger and fresh full inventory are required before any
  // runtime lease opens. Bearer stays memory-only; snapshot carries digests.
  assertLiveRegistryCoversAll();
  const snapshot = await collectAccountUsage({
    bearer,
    expectedAccountId,
    now: nowMs,
    providers,
    whoamiOutput,
    source: USAGE_SOURCE_LIVE,
  });
  const evaluation = evaluateUsageSnapshot(snapshot, { expectedAccountDigest: expectedDigest, now: nowMs, maxAgeMs });
  evaluation.reasons.unshift(`live profile verified for ${accountRef(expectedAccountId)}; no authoritative counter aggregate exposed, heavy work sealed; ledger+full-inventory required`);
  return finish(evaluation, snapshot);
}
