// Account-wide usage collection over a browser/Wrangler-OAuth bearer.
// Bearer is memory-only (never snapshots/receipts/logs/errors); no
// CLOUDFLARE_API_TOKEN read or fallback. Account-wide aggregates already
// include unrelated consumption; colliding partials sum, gaps stay `unknown`
// and seal heavy work instead of guessing zero.

import {
  extractActiveAccountId,
} from "./cloudflare-wrangler-oauth.mjs";
import {
  METRIC_PROVENANCE,
  REQUIRED_METRIC_KEYS,
  USAGE_METRICS,
  CLOCK_SKEW_MS,
  UNKNOWN,
  UNKNOWN_REASONS,
  accountRef,
  digestAccountId,
} from "./cloudflare-usage-envelope.mjs";
import {
  UsageCollectionError,
} from "./cloudflare-usage-providers.mjs";
import {
  METRIC_SOURCE_REGISTRY,
  assertLiveRegistryCoversAll,
  inventoryBrandClass,
  isInventoryProvider,
} from "./cloudflare-usage-authority.mjs";
import {
  billingBrandClass,
  isUsageVBillingProvider,
} from "./cloudflare-usage-billable.mjs";
import {
  isTestTransportProvider,
} from "./cloudflare-usage-transport-class.mjs";

export { METRIC_PROVENANCE, UNKNOWN_REASONS };
export { METRIC_SOURCE_REGISTRY, assertLiveRegistryCoversAll };
export {
  ProviderFailure,
  UsageCollectionError,
  createGraphQlAnalyticsProvider,
  safeFetchMeta,
  toTypedReason,
} from "./cloudflare-usage-providers.mjs";
export {
  createAiSearchInventoryProvider,
  createPaginatedInventoryProvider,
  createR2CursorInventoryProvider,
  isAiSearchInventoryProvider,
  isInventoryProvider,
  inventoryBrandClass,
} from "./cloudflare-usage-authority.mjs";
export {
  BILLABLE_LIVE_COVERS,
  REVIEWED_BILLABLE_TRIPLES,
  billingBrandClass,
  buildLiveProviderRegistry,
  createBillableUsageProvider,
  isUsageVBillingProvider,
} from "./cloudflare-usage-billable.mjs";
export {
  isTestTransportProvider,
} from "./cloudflare-usage-transport-class.mjs";

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

// Local canonical snapshot: re-derived from the frozen USAGE_METRICS source at
// call time, then validated non-empty and exact. Mutating an export throws
// (frozen) and is ignored here regardless, so collection completeness cannot
// be emptied by a caller.
function canonicalRequiredSnapshot() {
  const fromMetrics = USAGE_METRICS.map((metric) => metric.key);
  const snapshotted = [...REQUIRED_METRIC_KEYS];
  if (snapshotted.length === 0 || fromMetrics.length === 0) {
    collectionFail("REGISTRY_INCOMPLETE", "authority metric set is empty; refusing vacuous collection");
  }
  if (snapshotted.length !== fromMetrics.length || !fromMetrics.every((key) => snapshotted.includes(key))) {
    collectionFail("REGISTRY_INCOMPLETE", "authority metric set does not exactly cover the canonical metrics");
  }
  return snapshotted;
}

// All-unknown snapshot: honest shape when no provider exposes a counter;
// fresh windows plus sealed source so evaluation seals, never admits.
export function blankAccountSnapshot({ expectedAccountId, now = Date.now(), source = USAGE_SOURCE_SEALED, readback = {} } = {}) {
  if (typeof expectedAccountId !== "string" || expectedAccountId.trim() === "") {
    collectionFail("COLLECTION_INVALID", "expectedAccountId is required for account binding");
  }
  const required = canonicalRequiredSnapshot();
  const metrics = {};
  for (const key of required) metrics[key] = UNKNOWN;
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

// Registry plus brand predicates live in ./cloudflare-usage-authority.mjs
// (re-exported above); providers in ./cloudflare-usage-providers.mjs,
// ./cloudflare-usage-billable.mjs, and ./cloudflare-usage-authority.mjs.

// Collect an account-wide aggregate over explicitly injected `providers`
// (empty by default: counters stay unknown). Partial-shard collisions sum;
// any gap (error, malformed, wrong account/window, partial pagination,
// conflicting full-account sources) keeps that metric unknown fail-closed.
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
  const required = canonicalRequiredSnapshot();
  for (const key of required) {
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
  // only the validated Usage v2 provider. Authority is a brand check, never
  // a string match: caller-asserted group/kind fields confer nothing.
  // Reporters without any provenance or authority signal keep the historic
  // summation path.
  const isAnalyticsReporter = (provider, reported) =>
    provider?.analyticsOnly === true || provider?.kind === "analytics-graphql" ||
    reported?.provenance === METRIC_PROVENANCE.ANALYTICS_NONBILLING;
  const claimsAuthority = (provider, reported) =>
    isAnalyticsReporter(provider, reported) || reported?.provenance != null ||
    isUsageVBillingProvider(provider) || isInventoryProvider(provider);
  // The same provider object twice must not double-count: the first result
  // stands and the duplicate is ignored fail-closed.
  const seenProviders = new Set();
  for (const provider of providers) {
    const group = provider?.group ?? "unnamed-provider";
    const declaredCovers = Array.isArray(provider?.covers) ? provider.covers : null;
    if (seenProviders.has(provider)) {
      providerErrors.push(`${group} duplicate provider instance ignored; keeping first result`);
      providerResults.push({ group, ok: false, keys: [], duplicate: true });
      continue;
    }
    seenProviders.add(provider);
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
          } else if (isUsageVBillingProvider(provider) &&
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
          if (!required.includes(key)) continue;
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
          required.includes(key) && typeof values[key] === "number");
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
      // Billing admits only the branded Usage v2 provider with full account
      // coverage; inventory admits only branded registry-built providers with
      // full account coverage. Plain, copied, spread-cloned, proxied, or
      // lookalike-group objects carry no brand and fail closed here. Genuine
      // factory products built with caller-supplied transports take the
      // explicitly test-only path instead: their numerics flow (so envelope,
      // deploy, and provisioner tests exercise the real pipeline) but the
      // trust record is marked test-only end-to-end (test-only state, no
      // brand), which builds snapshot-asserted receipt evidence that can
      // never authorize heavy work.
      let channelProvenance = METRIC_PROVENANCE.UNAVAILABLE;
      let channelBrand = null;
      let channelTestOnly = false;
      const refuseChannel = (reason, refusedProvenance) => {
        for (const key of claimedKeys) {
          if (!required.includes(key)) continue;
          markGap(key, `${group}: ${reason}`, refusedProvenance);
        }
        providerErrors.push(`${group} ${reason}; keeping unknown`);
        providerResults.push({ group, ok: false, keys: [] });
      };
      if (provenance === METRIC_PROVENANCE.AUTHORITATIVE_BILLING) {
        const testOnly = isTestTransportProvider(provider);
        if ((!isUsageVBillingProvider(provider) && !testOnly) || coverage?.fullAccount !== true) {
          refuseChannel("billing authority requires the validated Usage v2 provider with full account coverage", provenance);
          continue;
        }
        channelProvenance = provenance;
        channelBrand = testOnly ? null : billingBrandClass(provider);
        channelTestOnly = testOnly;
      } else if (provenance === METRIC_PROVENANCE.AUTHORITATIVE_INVENTORY) {
        const testOnly = isTestTransportProvider(provider);
        if ((!isInventoryProvider(provider) && !testOnly) || coverage?.fullAccount !== true) {
          refuseChannel("inventory authority requires a registry-built inventory provider with full account coverage", provenance);
          continue;
        }
        channelProvenance = provenance;
        channelBrand = testOnly ? null : inventoryBrandClass(provider);
        channelTestOnly = testOnly;
      } else if (provenance === METRIC_PROVENANCE.LEDGER_ESTIMATE) {
        refuseChannel("ledger estimates stay unknown without a complete account-bound ledger contract", provenance);
        continue;
      } else if (provenance === METRIC_PROVENANCE.UNAVAILABLE) {
        refuseChannel("reporter declares no verified aggregate", provenance);
        continue;
      } else if (provenance !== null) {
        refuseChannel("unknown provenance", METRIC_PROVENANCE.UNAVAILABLE);
        continue;
      } else if (isUsageVBillingProvider(provider) || isInventoryProvider(provider)) {
        refuseChannel("authority brand without provenance", METRIC_PROVENANCE.UNAVAILABLE);
        continue;
      } else {
        // No numeric is trusted without an allowed provenance plus coverage
        // proof: unprovenanced reporters are refused to a typed gap
        // (unknown), never admitted as trusted-partial/unavailable.
        refuseChannel("unprovenanced reporter declares no verified aggregate", METRIC_PROVENANCE.UNAVAILABLE);
        continue;
      }
      for (const [key, value] of Object.entries(values)) {
        if (!required.includes(key)) {
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
          state: channelTestOnly ? "test-only" : "trusted-partial",
          sources: [...new Set([...trust[key].sources, group])],
          coverage: coverage ?? { accountId: expectedAccountId, fullAccount: false },
          gap: null,
          provenance: channelProvenance,
          brand: channelBrand,
          ...(channelTestOnly ? { testOnly: true } : null),
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
          if (required.includes(key)) markGap(key, message);
        }
      }
    }
  }
  const metrics = {};
  for (const key of required) metrics[key] = totals[key] === null ? UNKNOWN : totals[key];
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
        required.map((key) => [key, METRIC_SOURCE_REGISTRY[key]?.limitation ?? "unregistered"]),
      ),
    },
    metrics,
  };
}

// Layer-1 admission (runUsagePreflight), the admission capability mint, and
// its read-only predicates live in ./cloudflare-usage-admission.mjs — the
// same closure/authority root as issuance — so this module stays a pure
// collection library under the 600-line budget and no mint API is reachable
// from data structures here.
