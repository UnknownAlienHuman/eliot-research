// Layer-1 admission runner plus the in-process admission capability.
//
// ADMITTED is necessary but never sufficient for a remote/billable mutation:
// every deploy, each provisioner apply path, and admitHeavyOperation
// additionally requires an admission capability — an object-identity proof
// minted ONLY by the successful fresh default-live collection path in the
// current process, after browser OAuth account verification and complete
// provider trust. No structural object, recomputable digest,
// caller-supplied provider/snapshot/evaluation/receipt/evidence strings,
// source, or test seam can mint or present production authority: the mint is
// a non-exported function in this module (the same closure/authority root as
// issuance below), and only a read-only predicate (plus a read-only issuer
// predicate for tests) is exposed. Copies, spreads, structuredClone output,
// Proxies, hand-built objects, and persisted-bytes-deserialized objects are
// all new identities and fail the predicate. Persisted receipts remain
// tamper-evident informational/readback artifacts that can never grant
// authority on their own.

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
  SNAPSHOT_MAX_AGE_MS,
  accountRef,
  buildAdmissionReceipt,
  digestAccountId,
  evaluateUsageSnapshot,
  listCanonicalRequiredKeys,
  writeAdmissionReceiptAtomic,
} from "./cloudflare-usage-envelope.mjs";
import {
  USAGE_SOURCE_LIVE,
  USAGE_SOURCE_SEALED,
  assertLiveRegistryCoversAll,
  blankAccountSnapshot,
  collectAccountUsage,
} from "./cloudflare-usage-collection.mjs";
import {
  UsageCollectionError,
} from "./cloudflare-usage-providers.mjs";

// Module-PRIVATE production capability registry: capability object identity.
// Never exported; populated only by mintLiveCapability below on the fresh
// live success path. No registrar, token, symbol, secret, HMAC key, source
// whitelist, or filesystem location exists, so nothing a caller supplies —
// options, env, files, strings — can join this set.
// FIX14: private identity array with explicit === scans (no WeakSet, whose
// prototype is mutable ambient behavior a before-import poisoning could
// forge to admit any object).
const PRODUCTION_CAPABILITIES = [];

// Read-only predicate: the sole production-authority query. True only for
// the exact object identity minted below in this process.
export function isUsageAdmissionCapability(capability) {
  if (capability === null || (typeof capability !== "object" && typeof capability !== "function")) return false;
  for (let i = 0; i < PRODUCTION_CAPABILITIES.length; i += 1) {
    if (PRODUCTION_CAPABILITIES[i] === capability) return true;
  }
  return false;
}

// Read-only issuer predicate (pure, mints nothing): the structural half of
// the mint condition, exported so deterministic tests can assert issuance
// happens iff live-brand plus OAuth-verified plus full trust. The lifecycle
// half (fresh browser-OAuth verification in this process, live collection
// branch rather than an injected snapshot) is enforced by the call site in
// runUsagePreflight below, which is the only minter.
export function isLiveAdmissibleForCapability(snapshot, evaluation) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
  if (!evaluation || typeof evaluation !== "object" || evaluation.decision !== "ADMITTED") return false;
  if (snapshot.source !== USAGE_SOURCE_LIVE) return false;
  if (snapshot?.readback?.whoami_verified !== true) return false;
  const trust = snapshot?.readback?.metric_trust;
  if (!trust || typeof trust !== "object" || Array.isArray(trust)) return false;
  // Snapshot-then-validate over a local canonical copy: no vacuous every()
  // or zero-length set may admit. Exact coverage is required independently
  // here, even though collection and the envelope enforce it too.
  // FIX14: explicit === scans only (no Array.prototype.every, no Set, no
  // for..of iterator); trust ownership is verified exactly in both
  // directions (every required key own-present, no extra own keys), so an
  // inherited Object.prototype entry can never satisfy a missing key.
  const required = listCanonicalRequiredKeys();
  if (required.length === 0) return false;
  for (let i = 0; i < required.length; i += 1) {
    if (typeof required[i] !== "string" || required[i] === "") return false;
  }
  for (let i = 0; i < required.length; i += 1) {
    for (let j = i + 1; j < required.length; j += 1) {
      if (required[i] === required[j]) return false;
    }
  }
  const trustKeys = Object.keys(trust);
  if (trustKeys.length !== required.length) return false;
  for (let i = 0; i < required.length; i += 1) {
    let found = false;
    for (let j = 0; j < trustKeys.length; j += 1) {
      if (trustKeys[j] === required[i]) { found = true; break; }
    }
    if (!found) return false;
  }
  for (let i = 0; i < trustKeys.length; i += 1) {
    let known = false;
    for (let j = 0; j < required.length; j += 1) {
      if (trustKeys[i] === required[j]) { known = true; break; }
    }
    if (!known) return false;
  }
  for (let i = 0; i < required.length; i += 1) {
    const entry = trust[required[i]];
    if (!entry || typeof entry !== "object") return false;
    if (entry.state !== "trusted-partial") return false;
    if (typeof entry.brand !== "string" || entry.brand === "") return false;
    if (entry.testOnly === true) return false;
  }
  return true;
}

// The ONLY minter. Non-exported: reachable solely from the live success path
// below. The object carries no meaningful fields — identity is the proof, so
// there is nothing to copy, recompute, or assert structurally.
function mintLiveCapability() {
  const capability = Object.freeze({});
  PRODUCTION_CAPABILITIES[PRODUCTION_CAPABILITIES.length] = capability;
  return capability;
}

function collectionFail(code, message) {
  throw new UsageCollectionError(code, message);
}

function parseMaxAgeMs(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return SNAPSHOT_MAX_AGE_MS;
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    collectionFail("COLLECTION_INVALID", "ELIOTR_USAGE_MAX_AGE_MS must be a positive integer of milliseconds");
  }
  return parsed;
}

// Layer-1 admission runner for the preflight CLI and provisioner/deploy
// gates. Never exits; network only via official `wrangler whoami` spawn or
// injected providers. Returns { decision, evaluation, snapshot, receipt,
// capability }; capability is non-null ONLY on the fresh live success path
// (verified browser-OAuth identity plus live collection plus ADMITTED plus
// complete live trust). BLOCKED is a return, not a throw. Seams (readFile,
// getWhoamiOutput, providers, snapshot, cwd) are explicit options only,
// never ambient env. An explicitly injected `snapshot` (test-called builder
// path) evaluates through the real envelope but never mints: caller-supplied
// structures cannot become authority.
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
    // Explicit test-only snapshot (object/JSON). Never ambient env;
    // production entry points must never pass it. Real-envelope
    // evaluation AFTER identity verification below, capability always null.
    snapshot: injectedSnapshot = null,
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
    return { decision: "BLOCKED", evaluation, snapshot, receipt, capability: null };
  }
  const expectedDigest = digestAccountId(expectedAccountId);

  const finish = async (evaluation, snapshot, capability = null) => {
    const receipt = buildAdmissionReceipt({ evaluation, snapshot, now: nowMs, expectedAccountId });
    if (writeReceipt) {
      if (!receiptPath) collectionFail("COLLECTION_INVALID", "receipt path is required when receipt writing is enabled");
      await writeAdmissionReceiptAtomic(receiptPath, receipt);
    }
    return { decision: evaluation.decision, evaluation, snapshot, receipt, capability };
  };

  let authMode = "api-token";
  try {
    authMode = resolveAuthMode(env);
  } catch (error) {
    collectionFail("AUTH_MODE_INVALID", error?.message ?? "unknown auth mode");
  }

  // Identity FIRST: credential load plus exact whoami binding precede any
  // snapshot evaluation. Only explicit readFile/getWhoamiOutput/snapshot
  // options inject; ambient env never verifies or admits.
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
    // No ambient whoami seam: explicit injection or the official spawn below.
    if (typeof getWhoamiOutput === "function") {
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

  // Explicit-only snapshot: `snapshot` option (test-called builders) through
  // the real envelope after verification. Never mints: the structure was
  // caller-supplied, not freshly collected over verified live transport.
  // Ambient fixture env never admits.
  if (injectedSnapshot !== null && injectedSnapshot !== undefined) {
    let snapshot;
    try {
      snapshot = typeof injectedSnapshot === "string" ? JSON.parse(injectedSnapshot) : injectedSnapshot;
    } catch {
      collectionFail("SNAPSHOT_MALFORMED", "injected usage snapshot is malformed JSON");
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

  // Live OAuth collection over verified bearer/whoami. Empty providers seal
  // with unknown counters, never admit or fabricate zero. Bearer stays
  // memory-only; snapshot carries digests. A capability mints ONLY here, and
  // only when the fresh aggregate is ADMITTED with complete live trust: the
  // verified identity plus this live collection plus this evaluation are the
  // lifecycle half the issuer predicate cannot see.
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
  const capability = isLiveAdmissibleForCapability(snapshot, evaluation) ? mintLiveCapability() : null;
  return finish(evaluation, snapshot, capability);
}
