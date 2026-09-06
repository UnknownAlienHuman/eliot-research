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
  REQUIRED_METRIC_KEYS,
  SNAPSHOT_MAX_AGE_MS,
  UNKNOWN,
  accountRef,
  buildAdmissionReceipt,
  digestAccountId,
  evaluateUsageSnapshot,
  writeAdmissionReceiptAtomic,
} from "./cloudflare-usage-envelope.mjs";

export const USAGE_SOURCE_LIVE = "wrangler-oauth-live";
export const USAGE_SOURCE_SEALED = "sealed-no-authoritative-aggregate";
export const USAGE_SOURCE_FIXTURE = "test-fixture";

export class UsageCollectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "UsageCollectionError";
    this.code = code;
  }
}

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

// Collect an account-wide aggregate. `providers` is an explicitly injected
// extension point (empty by default: every counter stays unknown until a
// reviewed provider proves headroom). Each provider reports
// `{ group, values: { metricKey: number | "unknown" } }`; collisions are
// summed so unrelated consumption is never dropped.
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
  for (const key of REQUIRED_METRIC_KEYS) totals[key] = null;
  const providerResults = [];
  const providerErrors = [];
  for (const provider of providers) {
    const group = provider?.group ?? "unnamed-provider";
    try {
      // Bearer crosses only this memory call; providers must not persist it.
      const reported = await provider.collect({ accountId: expectedAccountId, bearer, now });
      const values = reported?.values ?? {};
      const keys = [];
      for (const [key, value] of Object.entries(values)) {
        if (!REQUIRED_METRIC_KEYS.includes(key)) {
          providerErrors.push(`${group} reported unknown metric ${key}`);
          continue;
        }
        if (!isReportableValue(value)) {
          providerErrors.push(`${group} reported malformed ${key}; treating as unknown`);
          continue;
        }
        keys.push(key);
        if (value === UNKNOWN) {
          if (totals[key] === null) totals[key] = UNKNOWN;
        } else if (totals[key] === null || totals[key] === UNKNOWN) {
          totals[key] = value;
        } else {
          totals[key] = totals[key] + value;
        }
      }
      providerResults.push({ group, ok: true, keys });
    } catch (error) {
      providerResults.push({ group, ok: false, keys: [] });
      providerErrors.push(`${group} failed: ${error?.code ?? error?.message ?? "unknown"}`);
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

  // No usage providers are wired yet: Cloudflare exposes no single stable
  // account-wide counter transport here, so every counter stays `unknown`
  // and heavy work seals. The bearer is memory-only and the snapshot
  // carries digests, never secrets.
  const snapshot = await collectAccountUsage({
    bearer,
    expectedAccountId,
    now: nowMs,
    providers,
    whoamiOutput,
    source: USAGE_SOURCE_LIVE,
  });
  const evaluation = evaluateUsageSnapshot(snapshot, { expectedAccountDigest: expectedDigest, now: nowMs, maxAgeMs });
  evaluation.reasons.unshift(`live profile verified for ${accountRef(expectedAccountId)}; no authoritative counter aggregate exposed, heavy work sealed`);
  return finish(evaluation, snapshot);
}
