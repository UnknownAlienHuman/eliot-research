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
  extractActiveAccountId,
  loadWranglerOAuthCredential,
  resolveAuthMode,
  scrubTokenEnv,
  verifyWranglerOAuthAccount,
} from "./cloudflare-wrangler-oauth.mjs";
import {
  METRIC_PROVENANCE,
  REQUIRED_METRIC_KEYS,
  CLOCK_SKEW_MS,
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
} from "./cloudflare-usage-providers.mjs";

export { METRIC_PROVENANCE, UNKNOWN_REASONS };
export {
  ProviderFailure,
  UsageCollectionError,
  createAiSearchInventoryProvider,
  createGraphQlAnalyticsProvider,
  createPaginatedInventoryProvider,
  createR2CursorInventoryProvider,
  safeFetchMeta,
  toTypedReason,
} from "./cloudflare-usage-providers.mjs";
export {
  BILLABLE_LIVE_COVERS,
  REVIEWED_BILLABLE_TRIPLES,
  buildLiveProviderRegistry,
  createBillableUsageProvider,
} from "./cloudflare-usage-billable.mjs";

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

// Providers live in ./cloudflare-usage-providers.mjs (inventory, analytics;
// re-exported above) and ./cloudflare-usage-billable.mjs (Usage v2 billing
// plus the live registry builder; re-exported above).

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
  if (extractActiveAccountId(whoamiOutput) !== expectedAccountId) {
    collectionFail("WRONG_ACCOUNT", "active browser profile does not match the expected account; refusing collection");
  }

  const totals = {};
  const gaps = {};
  const trust = {};
  for (const key of REQUIRED_METRIC_KEYS) {
    totals[key] = null;
    gaps[key] = false;
    trust[key] = { state: "unknown-untrusted", sources: [], coverage: null, gap: null, provenance: METRIC_PROVENANCE.UNAVAILABLE };
  }
  const providerResults = [];
  const providerErrors = [];
  const fullAccountReporters = {};
  const expectedWindow = monthlyWindowFor(now);
  const expectedDaily = dailyWindowFor(now);
  const expectedEndMs = Date.parse(expectedWindow.end);
  const todayStartMs = Date.parse(expectedDaily.start);
  const markGap = (key, reason, provenance = METRIC_PROVENANCE.UNAVAILABLE) => {
    gaps[key] = true;
    totals[key] = UNKNOWN;
    trust[key] = { state: "unknown-untrusted", sources: trust[key].sources, coverage: trust[key].coverage, gap: reason, provenance };
  };
  const parseCoverageTime = (value) => {
    const parsed = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  };
  // Provenance authorization: a numeric enters the snapshot only through an
  // authorized channel. Analytics samples stay diagnostic metadata; ledger
  // estimates have no complete account-bound ledger contract in this repo;
  // inventory counts admit only registry-authorized groups; billing admits
  // only the validated Usage v2 provider. Reporters without any provenance
  // or authority signal keep the historic summation path.
  const isAnalyticsReporter = (provider, reported) =>
    provider?.analyticsOnly === true || provider?.kind === "analytics-graphql" ||
    reported?.provenance === METRIC_PROVENANCE.ANALYTICS_NONBILLING;
  const claimsAuthority = (provider, reported) =>
    isAnalyticsReporter(provider, reported) || reported?.provenance != null ||
    provider?.kind === "billing-usage" || provider?.kind === "inventory-ai-search";
  for (const provider of providers) {
    const group = provider?.group ?? "unnamed-provider";
    const declaredCovers = Array.isArray(provider?.covers) ? provider.covers : null;
    try {
      // Bearer crosses only this memory call; providers must not persist it.
      const reported = await provider.collect({ accountId: expectedAccountId, bearer, now });
      const values = reported?.values ?? {};
      const coverage = reported?.coverage ?? null;
      const provenance = reported?.provenance ?? null;
      const analytics = isAnalyticsReporter(provider, reported);
      const authorityClaimed = claimsAuthority(provider, reported);
      const keys = [];
      // Coverage binding: wrong/missing account, invalid/future/mismatched
      // window, or partial pagination fails closed for every metric this
      // provider covers. Windows must start at the expected monthly/daily
      // boundary and never end in the future; billing usage must additionally
      // span month-start through today (never a future month end).
      let coverageOk = true;
      let coverageReason = "";
      if (coverage !== null) {
        if (coverage.accountId !== undefined && coverage.accountId !== expectedAccountId) {
          coverageOk = false;
          coverageReason = "wrong-account coverage";
        } else if (authorityClaimed && coverage.accountId !== expectedAccountId) {
          coverageOk = false;
          coverageReason = "missing account binding";
        } else if (coverage.windowStart !== undefined || coverage.windowEnd !== undefined) {
          const startMs = parseCoverageTime(coverage.windowStart);
          const endMs = parseCoverageTime(coverage.windowEnd);
          if (startMs === null || endMs === null || !(startMs < endMs)) {
            coverageOk = false;
            coverageReason = "malformed coverage window";
          } else if (endMs > now + CLOCK_SKEW_MS || startMs > now + CLOCK_SKEW_MS) {
            coverageOk = false;
            coverageReason = "future coverage window";
          } else if (coverage.windowStart !== expectedWindow.start && coverage.windowStart !== expectedDaily.start) {
            coverageOk = false;
            coverageReason = "mismatched coverage window";
          } else if (endMs > expectedEndMs) {
            coverageOk = false;
            coverageReason = "mismatched coverage window";
          } else if (provider?.kind === "billing-usage" &&
            (coverage.windowStart !== expectedWindow.start || endMs < todayStartMs - CLOCK_SKEW_MS)) {
            coverageOk = false;
            coverageReason = "partial billing interval";
          }
        }
        if (Number.isInteger(coverage.completedPages) && Number.isInteger(coverage.totalPages) &&
          coverage.completedPages < coverage.totalPages) {
          coverageOk = false;
          coverageReason = `partial pagination ${coverage.completedPages}/${coverage.totalPages}`;
        }
      } else if (authorityClaimed && Object.values(values).some((value) => typeof value === "number")) {
        coverageOk = false;
        coverageReason = "missing coverage binding";
      }
      const claimedKeys = declaredCovers ?? Object.keys(values);
      const reporterProvenance = analytics ? METRIC_PROVENANCE.ANALYTICS_NONBILLING
        : (provenance ?? METRIC_PROVENANCE.UNAVAILABLE);
      if (!coverageOk) {
        for (const key of claimedKeys) {
          if (!REQUIRED_METRIC_KEYS.includes(key)) continue;
          markGap(key, `${group}: ${coverageReason}`, reporterProvenance);
          providerErrors.push(`${group} coverage rejected for ${key}: ${coverageReason}; keeping unknown`);
        }
        providerResults.push({ group, ok: false, keys: [] });
        continue;
      }
      // Analytics is diagnostic metadata only: observed samples are recorded
      // by key, never admitted, and never gap other channels.
      if (analytics) {
        const sampleKeys = Object.keys(values).filter((key) =>
          REQUIRED_METRIC_KEYS.includes(key) && typeof values[key] === "number");
        if (sampleKeys.length > 0) {
          providerErrors.push(`${group} analytics samples are diagnostic-only, never billing authority`);
        }
        providerResults.push({ group, ok: true, keys: [], analytics: true, sample_keys: sampleKeys });
        for (const key of sampleKeys) {
          if (!gaps[key] && totals[key] === null) {
            trust[key] = { state: "unknown-untrusted", sources: [group], coverage, gap: null, provenance: reporterProvenance };
          }
        }
        continue;
      }
      // Channel authorization for reporters that claim a provenance.
      let channelProvenance = METRIC_PROVENANCE.UNAVAILABLE;
      const refuseChannel = (reason, refusedProvenance) => {
        for (const key of claimedKeys) {
          if (!REQUIRED_METRIC_KEYS.includes(key)) continue;
          markGap(key, `${group}: ${reason}`, refusedProvenance);
        }
        providerErrors.push(`${group} ${reason}; keeping unknown`);
        providerResults.push({ group, ok: false, keys: [] });
      };
      if (provenance === METRIC_PROVENANCE.AUTHORITATIVE_BILLING) {
        if (provider?.kind !== "billing-usage" || coverage?.fullAccount !== true) {
          refuseChannel("billing authority requires the validated Usage v2 provider", provenance);
          continue;
        }
        channelProvenance = provenance;
      } else if (provenance === METRIC_PROVENANCE.AUTHORITATIVE_INVENTORY) {
        channelProvenance = provenance;
      } else if (provenance === METRIC_PROVENANCE.LEDGER_ESTIMATE) {
        refuseChannel("ledger estimates stay unknown without a complete account-bound ledger contract", provenance);
        continue;
      } else if (provenance === METRIC_PROVENANCE.UNAVAILABLE) {
        refuseChannel("reporter declares no verified aggregate", provenance);
        continue;
      } else if (provenance !== null) {
        refuseChannel("unknown provenance", METRIC_PROVENANCE.UNAVAILABLE);
        continue;
      } else if (provider?.kind === "billing-usage" || provider?.kind === "inventory-ai-search") {
        refuseChannel("authority kind without provenance", METRIC_PROVENANCE.UNAVAILABLE);
        continue;
      } else {
        // No numeric is trusted without an allowed provenance plus coverage
        // proof: unprovenanced reporters are refused to a typed gap
        // (unknown), never admitted as trusted-partial/unavailable.
        refuseChannel("unprovenanced reporter declares no verified aggregate", METRIC_PROVENANCE.UNAVAILABLE);
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
        // Inventory counts admit only explicitly inventory-derived metrics
        // the contract allows (registry-authorized groups); billing usage
        // counters never ride inventory provenance.
        if (channelProvenance === METRIC_PROVENANCE.AUTHORITATIVE_INVENTORY) {
          const entry = METRIC_SOURCE_REGISTRY[key];
          if (!entry || entry.provenance !== METRIC_PROVENANCE.AUTHORITATIVE_INVENTORY ||
            !entry.sources.includes(provider?.group)) {
            markGap(key, `${group} inventory not authorized for ${key}`, channelProvenance);
            providerErrors.push(`${group} reported unauthorized inventory ${key}; keeping unknown`);
            continue;
          }
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
          gap: null,
          provenance: channelProvenance,
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

  let authMode = "api-token";
  try {
    authMode = resolveAuthMode(env);
  } catch (error) {
    collectionFail("AUTH_MODE_INVALID", error?.message ?? "unknown auth mode");
  }

  // Identity verification FIRST: in wrangler-oauth mode the credential load
  // plus the exact whoami account binding precede any env-snapshot
  // evaluation, so no env-controlled production path manufactures ADMITTED
  // or bypasses OAuth/account binding. The snapshot below is still evaluated
  // through the real envelope; tests inject via the readFile/getWhoamiOutput
  // seams and never precede verification.
  let oauthBearer = null;
  let oauthWhoamiOutput = null;
  if (authMode === WRANGLER_OAUTH_MODE) {
    const readFileImpl = readFile ?? (await import("node:fs/promises")).readFile;
    try {
      const credential = await loadWranglerOAuthCredential({ env, readFile: readFileImpl, now: nowMs });
      oauthBearer = credential.bearer;
    } catch (error) {
      if (error instanceof UsageCollectionError) throw error;
      throw new UsageCollectionError(error?.code ?? "OAUTH_UNAVAILABLE", error?.message ?? "OAuth credential unavailable");
    }
    const mockedWhoami = env?.ELIOTR_TEST_WRANGLER_WHOAMI_OUTPUT;
    if (mockedWhoami !== undefined && mockedWhoami !== "") {
      oauthWhoamiOutput = mockedWhoami;
    } else if (typeof getWhoamiOutput === "function") {
      oauthWhoamiOutput = await getWhoamiOutput();
    } else {
      const scrubbed = scrubTokenEnv({ ...env });
      const result = spawnSync("pnpm", ["exec", "wrangler", "whoami"],
        { cwd, env: scrubbed, encoding: "utf8", shell: process.platform === "win32" });
      if (result.error || result.status !== 0) {
        collectionFail("OAUTH_UNAVAILABLE",
          `Wrangler verification (wrangler whoami exit ${result.status ?? "unknown"}) failed. ${LOGIN_INSTRUCTION}`);
      }
      oauthWhoamiOutput = result.stdout ?? "";
    }
    try {
      await verifyWranglerOAuthAccount({ expectedAccountId, getWhoamiOutput: async () => oauthWhoamiOutput });
    } catch (error) {
      if (error instanceof UsageCollectionError) throw error;
      throw new UsageCollectionError(error?.code ?? "OAUTH_ACCOUNT_MISMATCH", error?.message ?? "account verification failed");
    }
  }

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

  // Live OAuth collection: identity was verified above before any snapshot
  // evaluation, so the bearer and whoami output below are the verified
  // values. The registry must cover every required metric (explicit source
  // set or explicit limitation). An empty provider list seals with unknown
  // counters — it never admits and never fabricates zero. Where no
  // authoritative aggregate exists the limitation above plus a
  // controller-owned ledger and fresh full inventory are required before any
  // runtime lease opens. Bearer stays memory-only; snapshot carries digests.
  assertLiveRegistryCoversAll();
  const snapshot = await collectAccountUsage({
    bearer: oauthBearer,
    expectedAccountId,
    now: nowMs,
    providers,
    whoamiOutput: oauthWhoamiOutput,
    source: USAGE_SOURCE_LIVE,
  });
  const evaluation = evaluateUsageSnapshot(snapshot, { expectedAccountDigest: expectedDigest, now: nowMs, maxAgeMs });
  evaluation.reasons.unshift(`live profile verified for ${accountRef(expectedAccountId)}; no authoritative counter aggregate exposed, heavy work sealed; ledger+full-inventory required`);
  return finish(evaluation, snapshot);
}
