// Cloudflare usage envelope: versioned canonical usage-snapshot / admission
// contract plus fail-closed envelope evaluation (FIX1 section B).
//
// The envelope is 80% of each included Cloudflare quota. It is NOT a
// Cloudflare hard cap: it is the local fail-closed admission boundary. Every
// required counter is account-wide (it already includes unrelated/Gotham
// consumption); `unknown` is never coerced to zero.
//
// Decisions:
//   ADMITTED - fresh authoritative aggregate, every metric known and inside
//              the envelope (near-limit values ride along as advisories).
//   SEALED   - fail-closed for heavy work: sealed zero/metadata-only
//              provisioning may proceed, while ingestion, queue produce /
//              consume, Workflow/DO execution, Workers AI calls, AI Search
//              index/query and Vectorize writes/queries stay disabled until a
//              fresh authoritative aggregate OR a controller-owned ledger plus
//              inventory proof shows headroom.
//   BLOCKED  - nothing proceeds; the caller must exit before its first
//              remote mutation (malformed/wrong-account/missing/over-envelope).
//
// All fixtures and committed examples use fictional data (example.invalid,
// fake hex identifiers). Exact account values live only in ignored local
// receipts under .eliotr-state/ and never enter this module's outputs.

import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  buildMetricEvidence,
  computeSnapshotDigest,
  validateMetricEvidence,
} from "./cloudflare-usage-receipt-evidence.mjs";
import {
  METRIC_PROVENANCE,
  canonicalWindowOf,
  hasCanonicalMetric,
  listCanonicalMetrics,
  listCanonicalRequiredKeys,
} from "./cloudflare-usage-canonical.mjs";

// Canonical taxonomy + metric authority live in
// ./cloudflare-usage-canonical.mjs (capability split for the 600-line
// budget); re-exported here so existing import paths keep working. The
// re-exported facades are non-authoritative views; authority reads only the
// private null-prototype table in that module.
export {
  DECIMAL_BYTES_PER_GB,
  DECIMAL_BYTES_PER_KB,
  QUEUE_CHUNK_BYTES,
  QUEUE_MESSAGE_OVERHEAD_BYTES,
  METRIC_PROVENANCE,
  UNKNOWN_REASONS,
  isProvenance,
  isUnknownReason,
  bytesFromDecimalGb,
  decimalGbFromBytes,
  SEALED_ALLOWLIST,
  isSealedAllowlistedOperation,
  USAGE_METRICS,
  REQUIRED_METRIC_KEYS,
  METRIC_BY_KEY,
  hasCanonicalMetric,
  getCanonicalMetric,
  listCanonicalRequiredKeys,
  listCanonicalMetrics,
  canonicalWindowOf,
} from "./cloudflare-usage-canonical.mjs";

export { computeSnapshotDigest };

export const USAGE_SNAPSHOT_PROTOCOL = "eliotr.cloudflare-usage-snapshot.v1";
export const USAGE_ADMISSION_PROTOCOL = "eliotr.cloudflare-usage-admission-receipt.v1";
export const USAGE_ENVELOPE_GENERATION = "usage-envelope-2026-09-06";
export const ENVELOPE_RATIO = 0.8;
export const NEAR_LIMIT_RATIO = 0.9;
export const SAFETY_MARGIN_RATIO = 0.05;
export const SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const RECEIPT_MAX_AGE_MS = 60 * 60 * 1000;
export const CLOCK_SKEW_MS = 5 * 60 * 1000;
export const UNKNOWN = "unknown";

// Plan scope (explicit, no mislabeling): this deployment budgets Workers Paid
// monthly inclusions and R2 paid inclusions. Free-tier daily limits are a
// separate optional profile and must never be presented as this envelope.
// Pricing GB/KB are decimal unless a doc below states otherwise. Monthly
// windows are UTC calendar-month approximations of subscription-renewal
// months; daily windows reset at UTC midnight. A snapshot whose window does
// not cover `now` (wrong window or reset crossing) seals/blocks fail-closed.
export const PLAN_SCOPE = Object.freeze({
  deployment: "Workers Paid monthly inclusions + R2 paid inclusions",
  workersPlan: "Workers Paid",
  r2Plan: "R2 paid inclusions",
  freeTier: "separate optional profile; never this envelope",
  monthlySemantics: "subscription-renewal month approximated as UTC calendar month",
  dailySemantics: "UTC midnight to UTC midnight",
  unitBasis: "decimal GB/KB (1 GB = 1,000,000,000 bytes) unless docs state otherwise",
});

// Official Cloudflare pricing/limits sources (truth for quotas/units).
// Retrieved 2026-09-06. Validated against installed Wrangler 4.127.1 schemas;
// response/pagination shapes in tests mock only fields observed in that
// toolchain. No undocumented counter fields are guessed.
export const DOC_SOURCES = Object.freeze([
  { url: "https://developers.cloudflare.com/workers/pricing/", covers: "workers_requests, workers_cpu_ms", retrieved: "2026-09-06" },
  { url: "https://developers.cloudflare.com/workers/platform/limits/", covers: "workers limits", retrieved: "2026-09-06" },
  { url: "https://developers.cloudflare.com/d1/pricing/", covers: "d1_storage, d1_rows_read, d1_rows_written", retrieved: "2026-09-06" },
  { url: "https://developers.cloudflare.com/r2/pricing/", covers: "r2_storage, r2_class_a_ops, r2_class_b_ops", retrieved: "2026-09-06" },
  { url: "https://developers.cloudflare.com/queues/pricing/", covers: "queue_ops 64KB chunk", retrieved: "2026-09-06" },
  { url: "https://developers.cloudflare.com/durable-objects/pricing/", covers: "do_requests, do_gb_seconds, do_sql, do_storage", retrieved: "2026-09-06" },
  { url: "https://developers.cloudflare.com/workers-ai/pricing/", covers: "workers_ai_neurons_per_day", retrieved: "2026-09-06" },
  { url: "https://developers.cloudflare.com/ai-search/limits-pricing/", covers: "ai_search_instances, ai_search_queries_month", retrieved: "2026-09-06" },
  { url: "https://developers.cloudflare.com/vectorize/pricing/", covers: "vectorize_queried_dims, vectorize_stored_dims", retrieved: "2026-09-06" },
]);
for (let i = 0; i < DOC_SOURCES.length; i += 1) Object.freeze(DOC_SOURCES[i]);

// Evidence taxonomy contract (injected into the receipt-evidence helper so
// canonical strings live in exactly one place and no import cycle exists).
// Note: requiredKeys references the canonical module's private list through
// the re-exported accessor below (never a caller-supplied array).
const RECEIPT_EVIDENCE_CONTRACT = {
  requiredKeys: Object.freeze(listCanonicalRequiredKeys()),
  windowKindOf: (key) => canonicalWindowOf(key),
  billingProvenance: METRIC_PROVENANCE.AUTHORITATIVE_BILLING,
  inventoryProvenance: METRIC_PROVENANCE.AUTHORITATIVE_INVENTORY,
  billingKindClass: "billing-usage-v2",
  inventoryKindClasses: ["inventory-ai-search", "inventory-paginated", "inventory-cursor"],
  snapshotProvenance: "snapshot-asserted",
  snapshotKindClass: "snapshot-asserted",
  unavailableProvenance: METRIC_PROVENANCE.UNAVAILABLE,
  clockSkewMs: CLOCK_SKEW_MS,
};

// Live-family predicate for authorization boundaries: true only when every
// per-metric evidence entry carries a live provider brand class
// (billing-usage-v2 or a registry inventory class). Test-only and
// snapshot-asserted families return false: they validate structurally at
// most and never authorize heavy work. The heavy gate re-checks this
// explicitly even though receipt validation already enforces it.
export function isLiveEvidenceFamily(receipt) {
  const evidence = receipt?.metric_evidence;
  if (!Array.isArray(evidence) || evidence.length === 0) return false;
  const canonicalKeys = listCanonicalRequiredKeys();
  if (canonicalKeys.length === 0) return false;
  if (evidence.length !== canonicalKeys.length) return false;
  for (let i = 0; i < evidence.length; i += 1) {
    const kindClass = evidence[i]?.provider_kind_class;
    if (kindClass === RECEIPT_EVIDENCE_CONTRACT.billingKindClass) continue;
    let inventoryMatch = false;
    const inventoryKinds = RECEIPT_EVIDENCE_CONTRACT.inventoryKindClasses;
    for (let j = 0; j < inventoryKinds.length; j += 1) {
      if (kindClass === inventoryKinds[j]) { inventoryMatch = true; break; }
    }
    if (!inventoryMatch) return false;
  }
  return true;
}

// Access contour (one owner-only hostname application, 24h session) is not a
// usage counter: it is enforced by the Access provisioner plus the core
// provisioner cross-check. The preflight records receipt presence only.
export const ACCESS_CONTOUR = Object.freeze({
  applications: 1,
  sessionDuration: "24h",
  contour: "HOSTNAME_BASED_ACCESS",
  workerLevelAccess: "PROHIBITED_FOR_RESEARCH_SESSION_WEBSOCKETS",
});

export function digestAccountId(accountId) {
  if (typeof accountId !== "string" || accountId.trim() === "") {
    throw new Error("account id must be a non-empty string before it can be digested");
  }
  return createHash("sha256").update(accountId, "utf8").digest("hex");
}

export function accountRef(accountId) {
  const raw = String(accountId);
  return `cloudflare-account:${raw.slice(0, 6)}…${raw.slice(-4)}`;
}

export function isUnknown(value) {
  return value === UNKNOWN;
}

function isValidCounter(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseTime(value, label) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO-8601 timestamp`);
  return parsed;
}

function validateWindow(window, label) {
  const failures = [];
  if (!window || typeof window !== "object" || Array.isArray(window)) {
    return ["window must be an object with kind/start/end"];
  }
  if (window.kind !== "monthly" && window.kind !== "daily" && window.kind !== "point") {
    failures[failures.length] = `${label}.kind must be monthly, daily or point`;
  }
  try {
    const start = parseTime(window.start, `${label}.start`);
    const end = parseTime(window.end, `${label}.end`);
    if (!(start < end)) failures[failures.length] = `${label} must satisfy start < end`;
  } catch (error) {
    failures[failures.length] = error.message;
  }
  return failures;
}

function windowCovers(window, now) {
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  return start <= now + CLOCK_SKEW_MS && now <= end;
}

// Fail-closed evaluation. Never throws for content reasons: every content
// failure is reported as BLOCKED/SEALED with non-secret reasons. Only
// programmer errors (missing options) throw.
export function evaluateUsageSnapshot(snapshot, options = {}) {
  const { expectedAccountDigest, now = Date.now(), maxAgeMs = SNAPSHOT_MAX_AGE_MS } = options;
  if (typeof expectedAccountDigest !== "string" || expectedAccountDigest === "") {
    throw new Error("expectedAccountDigest is required for account binding");
  }
  const reasons = [];
  const over = [];
  const unknown = [];
  const near = [];
  const advisory = [];

  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return blocked(["snapshot must be an object"]);
  }
  if (snapshot.protocol !== USAGE_SNAPSHOT_PROTOCOL) {
    return blocked([`snapshot protocol must be ${USAGE_SNAPSHOT_PROTOCOL}`]);
  }
  if (snapshot.account_id_digest !== expectedAccountDigest) {
    return blocked(["snapshot binds a different account digest; refusing substituted snapshot"]);
  }
  if (!snapshot.metrics || typeof snapshot.metrics !== "object" || Array.isArray(snapshot.metrics)) {
    return blocked(["snapshot.metrics must be an object keyed by required metric"]);
  }
  const metricKeys = Object.keys(snapshot.metrics);
  // Private canonical copy (never the public export): exact-set check with
  // explicit === scans only (no Array.prototype filter/includes, no Map/Set,
  // no caller-object authority). Object.keys is own-enumerable only, so
  // inherited prototype pollution never creates keys.
  const canonicalKeys = listCanonicalRequiredKeys();
  const canonicalMetrics = listCanonicalMetrics();
  if (canonicalKeys.length === 0) return blocked(["authority metric set is empty; refusing vacuous admission"]);
  const missing = [];
  for (let i = 0; i < canonicalKeys.length; i += 1) {
    const key = canonicalKeys[i];
    let found = false;
    for (let j = 0; j < metricKeys.length; j += 1) {
      if (metricKeys[j] === key) { found = true; break; }
    }
    if (!found) missing[missing.length] = key;
  }
  const unexpected = [];
  for (let i = 0; i < metricKeys.length; i += 1) {
    if (!hasCanonicalMetric(metricKeys[i])) unexpected[unexpected.length] = metricKeys[i];
  }
  if (missing.length > 0) {
    let list = "";
    for (let i = 0; i < missing.length; i += 1) list += (i > 0 ? ", " : "") + missing[i];
    return blocked([`snapshot is missing required metrics: ${list}`]);
  }
  if (unexpected.length > 0) {
    let list = "";
    for (let i = 0; i < unexpected.length; i += 1) list += (i > 0 ? ", " : "") + unexpected[i];
    return blocked([`snapshot carries unknown metric keys: ${list}`]);
  }
  if (metricKeys.length !== canonicalKeys.length) return blocked(["snapshot metric set is not exactly the required set"]);
  for (let i = 0; i < canonicalKeys.length; i += 1) {
    const key = canonicalKeys[i];
    const value = snapshot.metrics[key];
    if (value === undefined || value === null) return blocked([`metric ${key} is absent; refusing vacuous admission`]);
    if (!isUnknown(value) && !isValidCounter(value)) {
      return blocked([`metric ${key} must be a non-negative finite number or "unknown"`]);
    }
  }

  let collectedAt;
  try {
    collectedAt = parseTime(snapshot.collected_at, "collected_at");
  } catch (error) {
    return blocked([error.message]);
  }
  const stale = collectedAt > now + CLOCK_SKEW_MS || now - collectedAt > maxAgeMs;
  if (stale) reasons[reasons.length] = "snapshot is stale; no headroom claim is admissible";

  const windowFailures = validateWindow(snapshot.window, "window");
  if (snapshot.daily_window !== undefined) {
    const dailyFailures = validateWindow(snapshot.daily_window, "daily_window");
    for (let i = 0; i < dailyFailures.length; i += 1) windowFailures[windowFailures.length] = dailyFailures[i];
  }
  if (windowFailures.length > 0) return blocked(windowFailures);
  const windowOk = windowCovers(snapshot.window, now) &&
    (snapshot.daily_window === undefined || windowCovers(snapshot.daily_window, now));
  if (!windowOk) reasons[reasons.length] = "snapshot window does not cover now; aggregate belongs to another billing window";

  for (let i = 0; i < canonicalMetrics.length; i += 1) {
    const metric = canonicalMetrics[i];
    const value = snapshot.metrics[metric.key];
    if (value === undefined || value === null) return blocked([`metric ${metric.key} is absent; refusing vacuous admission`]);
    if (!isUnknown(value) && !isValidCounter(value)) return blocked([`metric ${metric.key} must be a non-negative finite number or "unknown"`]);
    if (isUnknown(value)) {
      unknown[unknown.length] = metric.key;
      continue;
    }
    if (metric.exact) {
      if (value > metric.envelope) {
        over[over.length] = { metric: metric.key, value, envelope: metric.envelope };
      } else if (value < metric.envelope) {
        advisory[advisory.length] = `${metric.key} reports ${value}, below the required ${metric.envelope}; usage headroom exists but inventory is incomplete`;
      }
      continue;
    }
    if (value > metric.envelope) {
      over[over.length] = { metric: metric.key, value, envelope: metric.envelope };
    } else if (value >= NEAR_LIMIT_RATIO * metric.envelope) {
      near[near.length] = { metric: metric.key, value, envelope: metric.envelope };
    }
  }

  if (over.length > 0) {
    const overReasons = [];
    for (let i = 0; i < reasons.length; i += 1) overReasons[overReasons.length] = reasons[i];
    for (let i = 0; i < over.length; i += 1) {
      const item = over[i];
      overReasons[overReasons.length] = `${item.metric} at ${item.value} exceeds envelope ${item.envelope}`;
    }
    return {
      decision: "BLOCKED",
      sealed: false,
      over,
      unknown,
      near,
      advisory,
      stale,
      windowOk,
      reasons: overReasons,
    };
  }
  if (stale || !windowOk || unknown.length > 0) {
    const sealedReasons = [];
    for (let i = 0; i < reasons.length; i += 1) sealedReasons[sealedReasons.length] = reasons[i];
    if (unknown.length > 0) {
      let list = "";
      for (let i = 0; i < unknown.length; i += 1) list += (i > 0 ? ", " : "") + unknown[i];
      sealedReasons[sealedReasons.length] = `no authoritative aggregate for: ${list}; heavy operations stay disabled`;
    }
    return { decision: "SEALED", sealed: true, over, unknown, near, advisory, stale, windowOk, reasons: sealedReasons };
  }
  const admittedReasons = [];
  for (let i = 0; i < near.length; i += 1) {
    const item = near[i];
    admittedReasons[admittedReasons.length] = `${item.metric} at ${item.value} is within 10% of envelope ${item.envelope}`;
  }
  return {
    decision: "ADMITTED",
    sealed: false,
    over,
    unknown,
    near,
    advisory,
    stale,
    windowOk,
    reasons: admittedReasons,
  };

  function blocked(blockReasons) {
    return {
      decision: "BLOCKED",
      sealed: false,
      over,
      unknown,
      near,
      advisory,
      stale: false,
      windowOk: false,
      reasons: blockReasons,
    };
  }
}

// Redacted admission receipt: digest plus truncated non-secret ref only.
// Never carries bearers, tokens, emails, or exact account identifiers.
// Every receipt binds per-metric evidence (metric, value, provider
// group+kind brand class, provenance, window, coverage) plus a snapshot
// digest over canonical source+generation+account+windows+metrics+evidence,
// so validation can recompute the binding and refuse forged or tampered
// shells. ADMITTED additionally requires a live provider evidence family
// (see the helper): test-only and snapshot-asserted families never authorize
// heavy work, no matter how self-consistent.
export function buildAdmissionReceipt({ evaluation, snapshot, now = Date.now(), expectedAccountId }) {
  if (!evaluation || !snapshot) throw new Error("evaluation and snapshot are required");
  const metrics = { ...(snapshot.metrics ?? {}) };
  const windows = {
    monthly: snapshot.window ?? null,
    daily: snapshot.daily_window ?? null,
  };
  const source = snapshot.source ?? "unknown";
  const metricEvidence = buildMetricEvidence(snapshot, RECEIPT_EVIDENCE_CONTRACT);
  const snapshotDigest = computeSnapshotDigest({
    accountIdDigest: snapshot.account_id_digest ?? "missing",
    source,
    generation: USAGE_ENVELOPE_GENERATION,
    windows,
    metrics,
    evidence: metricEvidence,
  });
  return {
    protocol: USAGE_ADMISSION_PROTOCOL,
    generation: USAGE_ENVELOPE_GENERATION,
    decision: evaluation.decision,
    sealed: evaluation.decision !== "ADMITTED",
    account_id_digest: snapshot.account_id_digest ?? "missing",
    account_ref: typeof expectedAccountId === "string" && expectedAccountId !== ""
      ? accountRef(expectedAccountId)
      : "cloudflare-account:missing",
    collected_at: snapshot.collected_at ?? null,
    windows,
    source,
    metrics,
    metric_evidence: metricEvidence,
    snapshot_digest: snapshotDigest,
    over_envelope: evaluation.over ?? [],
    unknown_metrics: evaluation.unknown ?? [],
    near_limit: evaluation.near ?? [],
    advisory: evaluation.advisory ?? [],
    reasons: evaluation.reasons ?? [],
    created_at: new Date(now).toISOString(),
  };
}

export async function writeAdmissionReceiptAtomic(receiptPath, receipt) {
  const text = `${JSON.stringify(receipt, null, 2)}\n`;
  await mkdir(dirname(receiptPath), { recursive: true });
  const temporary = `${receiptPath}.${process.pid}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, receiptPath);
  return receiptPath;
}

export function validateAdmissionReceipt(receipt, options = {}) {
  // Receipt-guarantee discipline (integrity only, never authenticity): this
  // validator proves tamper-evidence — the digest binding recomputes over the
  // carried source, generation, account, windows, metrics, and evidence — not
  // proof-of-live-collection. Anyone knowing the account ID can mint a
  // self-consistent shell (every digest input is computable from public shape
  // plus the account ID; the digest is unkeyed), so a persisted receipt is a
  // tamper-evident locator, never proof that live collection happened. A
  // self-consistent object created without fresh live collection NEVER
  // authorizes heavy/billable ops: ADMITTED requires a live provider evidence
  // family (test-only and snapshot-asserted families validate structurally at
  // most and are refused authorization here), and the heavy gate re-checks
  // the family explicitly. Heavy paths stay safe because provisioners/deploy/
  // preflight re-collect fresh in-process; the sole persisted-receipt
  // consumer (admitHeavyOperation) must source receipts only from the local
  // preflight write path.
  const { expectedAccountDigest, now = Date.now(), maxAgeMs = RECEIPT_MAX_AGE_MS } = options;
  if (typeof expectedAccountDigest !== "string" || expectedAccountDigest === "") {
    throw new Error("expectedAccountDigest is required for receipt binding");
  }
  const reasons = [];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { ok: false, decision: "BLOCKED", reasons: ["admission receipt must be an object"] };
  }
  if (receipt.protocol !== USAGE_ADMISSION_PROTOCOL) {
    reasons[reasons.length] = `admission receipt protocol must be ${USAGE_ADMISSION_PROTOCOL}`;
  }
  if (receipt.account_id_digest !== expectedAccountDigest) {
    reasons[reasons.length] = "admission receipt binds a different account digest; refusing substituted receipt";
  }
  if (receipt.decision !== "ADMITTED" && receipt.decision !== "SEALED" && receipt.decision !== "BLOCKED") {
    reasons[reasons.length] = "admission receipt decision must be ADMITTED, SEALED or BLOCKED";
  }
  let createdAt = NaN;
  try {
    createdAt = parseTime(receipt.created_at, "created_at");
  } catch (error) {
    reasons[reasons.length] = error.message;
  }
  if (Number.isFinite(createdAt) && (createdAt > now + CLOCK_SKEW_MS || now - createdAt > maxAgeMs)) {
    reasons[reasons.length] = "admission receipt is stale; re-run the usage preflight before mutating";
  }
  if (receipt.decision === "BLOCKED") reasons[reasons.length] = "admission receipt records BLOCKED";
  if (!Array.isArray(receipt.over_envelope) || !Array.isArray(receipt.unknown_metrics) || !Array.isArray(receipt.reasons)) {
    reasons[reasons.length] = "admission receipt must carry over_envelope, unknown_metrics and reasons arrays";
  }
  // Evidence binding: SEALED/BLOCKED receipts stay representable but must
  // still carry an intact digest; ADMITTED additionally requires complete,
  // single-family, trusted per-metric evidence (see the helper). Without
  // this, a hand-forged shell with a valid generation and empty
  // unknown_metrics would validate as ADMITTED.
  if (receipt.decision === "ADMITTED") {
    const strictReasons = validateMetricEvidence(receipt, RECEIPT_EVIDENCE_CONTRACT, { now, strict: true });
    for (let i = 0; i < strictReasons.length; i += 1) reasons[reasons.length] = strictReasons[i];
  } else {
    const looseReasons = validateMetricEvidence(receipt, RECEIPT_EVIDENCE_CONTRACT, { now, strict: false });
    for (let i = 0; i < looseReasons.length; i += 1) reasons[reasons.length] = looseReasons[i];
  }
  // ADMITTED is the only decision that authorizes heavy work, so a forged
  // ADMITTED (for example unknown_metrics non-empty, over-envelope entries,
  // incoherent sealed flag, wrong generation, unbound account ref, stale
  // snapshot, or malformed windows) must fail closed. SEALED/BLOCKED keep
  // their current semantics.
  if (receipt.decision === "ADMITTED") {
    if (!Array.isArray(receipt.unknown_metrics) || receipt.unknown_metrics.length !== 0) {
      reasons[reasons.length] = "admission receipt claims ADMITTED with unknown metrics; refusing forged receipt";
    }
    if (!Array.isArray(receipt.over_envelope) || receipt.over_envelope.length !== 0) {
      reasons[reasons.length] = "admission receipt claims ADMITTED over the envelope; refusing forged receipt";
    }
    if (receipt.sealed !== false) {
      reasons[reasons.length] = "admission receipt claims ADMITTED with an incoherent sealed flag; refusing forged receipt";
    }
    if (receipt.generation !== USAGE_ENVELOPE_GENERATION) {
      reasons[reasons.length] = "admission receipt generation binding is missing or stale; refusing forged receipt";
    }
    if (typeof receipt.account_ref !== "string" || receipt.account_ref === "" || receipt.account_ref === "cloudflare-account:missing") {
      reasons[reasons.length] = "admission receipt account ref binding is missing; refusing forged receipt";
    }
    try {
      const collectedAt = parseTime(receipt.collected_at, "collected_at");
      if (collectedAt > now + CLOCK_SKEW_MS || now - collectedAt > maxAgeMs) {
        reasons[reasons.length] = "admission receipt snapshot is stale; re-run the usage preflight before mutating";
      }
    } catch (error) {
      reasons[reasons.length] = error.message;
    }
    const monthly = receipt.windows?.monthly;
    const monthlyFailures = validateWindow(monthly, "windows.monthly");
    if (monthlyFailures.length > 0) {
      for (let i = 0; i < monthlyFailures.length; i += 1) reasons[reasons.length] = monthlyFailures[i];
    } else if (monthly.kind !== "monthly") {
      reasons[reasons.length] = "windows.monthly.kind must be monthly";
    }
    const daily = receipt.windows?.daily;
    if (daily !== null && daily !== undefined) {
      const dailyFailures = validateWindow(daily, "windows.daily");
      if (dailyFailures.length > 0) {
        for (let i = 0; i < dailyFailures.length; i += 1) reasons[reasons.length] = dailyFailures[i];
      } else if (daily.kind !== "daily") {
        reasons[reasons.length] = "windows.daily.kind must be daily";
      }
    } else {
      reasons[reasons.length] = "admission receipt windows.daily binding is missing; refusing forged receipt";
    }
  }
  return { ok: reasons.length === 0, decision: receipt.decision ?? "BLOCKED", reasons };
}
