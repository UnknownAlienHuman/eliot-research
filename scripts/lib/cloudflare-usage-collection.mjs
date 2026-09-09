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
  CLOCK_SKEW_MS,
  UNKNOWN,
  UNKNOWN_REASONS,
  accountRef,
  digestAccountId,
  listCanonicalMetrics,
  listCanonicalRequiredKeys,
} from "./cloudflare-usage-envelope.mjs";
import {
  UsageCollectionError,
} from "./cloudflare-usage-providers.mjs";
import {
  getRegistryEntry,
  getRegistryLimitation,
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
export { METRIC_SOURCE_REGISTRY, assertLiveRegistryCoversAll } from "./cloudflare-usage-authority.mjs";
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

function inventoryCoverageSummary(coverage) {
  if (coverage !== null && typeof coverage === "object" &&
    Number.isInteger(coverage.completedPages) && Number.isInteger(coverage.totalPages)) {
    return `${coverage.completedPages}/${coverage.totalPages}`;
  }
  if (coverage !== null && typeof coverage === "object" && Number.isInteger(coverage.completedCursors)) {
    return `cursors:${coverage.completedCursors}`;
  }
  return "1/1";
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

// Local canonical snapshot: module-private authority via read-only API at
// call time, then validated non-empty and exact independently (keys vs metric
// objects, never an export). Exports are never read here.
function canonicalRequiredSnapshot() {
  const snapshotted = listCanonicalRequiredKeys();
  const metrics = listCanonicalMetrics();
  const fromMetrics = [];
  for (let i = 0; i < metrics.length; i += 1) fromMetrics[fromMetrics.length] = metrics[i].key;
  if (snapshotted.length === 0 || fromMetrics.length === 0) {
    collectionFail("REGISTRY_INCOMPLETE", "authority metric set is empty; refusing vacuous collection");
  }
  if (snapshotted.length !== fromMetrics.length) {
    collectionFail("REGISTRY_INCOMPLETE", "authority metric set does not exactly cover the canonical metrics");
  }
  for (let i = 0; i < fromMetrics.length; i += 1) {
    let found = false;
    for (let j = 0; j < snapshotted.length; j += 1) {
      if (snapshotted[j] === fromMetrics[i]) { found = true; break; }
    }
    if (!found) collectionFail("REGISTRY_INCOMPLETE", "authority metric set does not exactly cover the canonical metrics");
  }
  for (let i = 0; i < snapshotted.length; i += 1) {
    for (let j = i + 1; j < snapshotted.length; j += 1) {
      if (snapshotted[i] === snapshotted[j]) {
        collectionFail("REGISTRY_INCOMPLETE", "authority metric set carries duplicates; refusing vacuous collection");
      }
    }
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
  for (let i = 0; i < required.length; i += 1) metrics[required[i]] = UNKNOWN;
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

// Collect an account-wide aggregate over the supplied `providers` registry
// (the admission layer selects the default live registry when omitted).
// Partial-shard collisions sum;
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
  const requiredHas = (key) => {
    if (typeof key !== "string") return false;
    for (let i = 0; i < required.length; i += 1) {
      if (required[i] === key) return true;
    }
    return false;
  };
  for (let i = 0; i < required.length; i += 1) {
    const key = required[i];
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
  // FIX14: own-key numeric scan (no Object.values/Array.prototype.some).
  const hasNumericValue = (values) => {
    if (!values || typeof values !== "object") return false;
    const keys = Object.keys(values);
    for (let i = 0; i < keys.length; i += 1) {
      if (typeof values[keys[i]] === "number") return true;
    }
    return false;
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
  // FIX14: identity array with explicit === (no Set, whose prototype is
  // mutable ambient behavior).
  const seenProviders = [];
  const providerList = Array.isArray(providers) ? providers : [];
  for (let pi = 0; pi < providerList.length; pi += 1) {
    const provider = providerList[pi];
    const group = provider?.group ?? "unnamed-provider";
    const declaredCovers = Array.isArray(provider?.covers) ? provider.covers : null;
    let duplicate = false;
    for (let i = 0; i < seenProviders.length; i += 1) {
      if (seenProviders[i] === provider) { duplicate = true; break; }
    }
    if (duplicate) {
      providerErrors[providerErrors.length] = `${group} duplicate provider instance ignored; keeping first result`;
      providerResults[providerResults.length] = { group, ok: false, keys: [], duplicate: true };
      continue;
    }
    seenProviders[seenProviders.length] = provider;
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
      } else if (authorityClaimed && hasNumericValue(values)) {
        coverageOk = false;
        coverageReason = "missing coverage binding";
      }
      const claimedKeys = declaredCovers ?? Object.keys(values);
      const reporterProvenance = analytics ? METRIC_PROVENANCE.ANALYTICS_NONBILLING
        : (provenance ?? METRIC_PROVENANCE.UNAVAILABLE);
      if (!coverageOk) {
        for (let i = 0; i < claimedKeys.length; i += 1) {
          const key = claimedKeys[i];
          if (!requiredHas(key)) continue;
          markGap(key, `${group}: ${coverageReason}`, reporterProvenance);
          providerErrors[providerErrors.length] = `${group} coverage rejected for ${key}: ${coverageReason}; keeping unknown`;
        }
        providerResults[providerResults.length] = { group, ok: false, keys: [] };
        continue;
      }
      // Analytics is diagnostic metadata only: observed samples are recorded
      // by key, never admitted, and never gap other channels.
      if (analytics) {
        const valueKeys = Object.keys(values);
        const sampleKeys = [];
        for (let i = 0; i < valueKeys.length; i += 1) {
          const key = valueKeys[i];
          if (requiredHas(key) && typeof values[key] === "number") sampleKeys[sampleKeys.length] = key;
        }
        if (sampleKeys.length > 0) {
          providerErrors[providerErrors.length] = `${group} analytics samples are diagnostic-only, never billing authority`;
        }
        providerResults[providerResults.length] = { group, ok: true, keys: [], analytics: true, sample_keys: sampleKeys };
        for (let i = 0; i < sampleKeys.length; i += 1) {
          const key = sampleKeys[i];
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
        for (let i = 0; i < claimedKeys.length; i += 1) {
          const key = claimedKeys[i];
          if (!requiredHas(key)) continue;
          markGap(key, `${group}: ${reason}`, refusedProvenance);
        }
        providerErrors[providerErrors.length] = `${group} ${reason}; keeping unknown`;
        providerResults[providerResults.length] = { group, ok: false, keys: [] };
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
      const valueKeys = Object.keys(values);
      for (let vi = 0; vi < valueKeys.length; vi += 1) {
        const key = valueKeys[vi];
        const value = values[key];
        if (!requiredHas(key)) {
          providerErrors[providerErrors.length] = `${group} reported unknown metric ${key}`;
          continue;
        }
        if (!isReportableValue(value)) {
          markGap(key, `${group} malformed sample`);
          providerErrors[providerErrors.length] = `${group} reported malformed ${key}; keeping unknown`;
          continue;
        }
        // Inventory counts admit only explicitly inventory-derived metrics
        // the contract allows (registry-authorized groups); billing usage
        // counters never ride inventory provenance.
        if (channelProvenance === METRIC_PROVENANCE.AUTHORITATIVE_INVENTORY) {
          const entry = getRegistryEntry(key);
          let sourceAllowed = false;
          if (entry && entry.provenance === METRIC_PROVENANCE.AUTHORITATIVE_INVENTORY && Array.isArray(entry.sources)) {
            for (let i = 0; i < entry.sources.length; i += 1) {
              if (entry.sources[i] === provider?.group) { sourceAllowed = true; break; }
            }
          }
          if (!entry || entry.provenance !== METRIC_PROVENANCE.AUTHORITATIVE_INVENTORY || !sourceAllowed) {
            markGap(key, `${group} inventory not authorized for ${key}`, channelProvenance);
            providerErrors[providerErrors.length] = `${group} reported unauthorized inventory ${key}; keeping unknown`;
            continue;
          }
        }
        keys[keys.length] = key;
        if (value === UNKNOWN) {
          if (totals[key] === null) totals[key] = UNKNOWN;
          continue;
        }
        if (gaps[key]) {
          // Numeric data never erases an unknown gap.
          providerErrors[providerErrors.length] = `${group} numeric ${key} ignored: prior gap keeps unknown`;
          continue;
        }
        if (coverage?.fullAccount === true) {
          if (fullAccountReporters[key] && fullAccountReporters[key] !== group) {
            markGap(key, `conflicting full-account sources ${fullAccountReporters[key]} vs ${group}`);
            providerErrors[providerErrors.length] = `${group} conflicting full-account ${key}; keeping unknown`;
            continue;
          }
          fullAccountReporters[key] = group;
        }
        if (totals[key] === null || totals[key] === UNKNOWN) {
          totals[key] = value;
        } else {
          totals[key] = totals[key] + value;
        }
        const priorSources = Array.isArray(trust[key].sources) ? trust[key].sources : [];
        const mergedSources = [];
        for (let i = 0; i < priorSources.length; i += 1) mergedSources[mergedSources.length] = priorSources[i];
        let groupSeen = false;
        for (let i = 0; i < mergedSources.length; i += 1) {
          if (mergedSources[i] === group) { groupSeen = true; break; }
        }
        if (!groupSeen) mergedSources[mergedSources.length] = group;
        trust[key] = {
          state: channelTestOnly ? "test-only" : "trusted-partial",
          sources: mergedSources,
          coverage: coverage ?? { accountId: expectedAccountId, fullAccount: false },
          gap: null,
          provenance: channelProvenance,
          brand: channelBrand,
          ...(channelTestOnly ? { testOnly: true } : null),
        };
      }
      // Inventory-only providers prove pagination readback without counters.
      if (Object.keys(values).length === 0 && reported?.inventory !== undefined) {
        providerResults[providerResults.length] = {
          group,
          ok: true,
          keys: [],
          pages: inventoryCoverageSummary(coverage),
          inventory_count: Array.isArray(reported.inventory) ? reported.inventory.length : 0,
        };
      } else {
        providerResults[providerResults.length] = { group, ok: true, keys };
      }
    } catch (error) {
      providerResults[providerResults.length] = { group, ok: false, keys: [] };
      const message = `${group} failed: ${error?.code ?? error?.message ?? "unknown"}`;
      providerErrors[providerErrors.length] = message;
      // A failed provider gaps only metrics it declared; undeclared failures
      // never poison unrelated counters.
      if (declaredCovers) {
        for (let i = 0; i < declaredCovers.length; i += 1) {
          const key = declaredCovers[i];
          if (requiredHas(key)) markGap(key, message);
        }
      }
    }
  }
  const metrics = {};
  for (let i = 0; i < required.length; i += 1) {
    const key = required[i];
    metrics[key] = totals[key] === null ? UNKNOWN : totals[key];
  }
  const registryLimitations = {};
  for (let i = 0; i < required.length; i += 1) {
    registryLimitations[required[i]] = getRegistryLimitation(required[i]);
  }
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
      registry_limitations: registryLimitations,
    },
    metrics,
  };
}

// Layer-1 admission (runUsagePreflight), the admission capability mint, and
// its read-only predicates live in ./cloudflare-usage-admission.mjs — the
// same closure/authority root as issuance — so this module stays a pure
// collection library under the 600-line budget and no mint API is reachable
// from data structures here.
