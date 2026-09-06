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

// Metric provenance taxonomy (Luna FIX3G): every reported counter carries one
// provenance. `unknown` metrics carry a typed reason below, never a zero.
//   authoritative_billing   - Restricted Alpha GET /accounts/{id}/billable/usage
//                             with account/date/metric/unit/full-window validation.
//   authoritative_inventory - Complete account-bound inventory proving a
//                             point-in-time count (for example AI Search
//                             instance count from /ai-search/instances).
//   analytics_nonbilling    - Cloudflare GraphQL analytics: operational evidence
//                             only, never billing authority.
//   ledger_estimate         - Controller-owned ledger + fresh full inventory
//                             proof (budget admission Layer 2).
//   unavailable             - No verified aggregate; metric stays unknown.
export const METRIC_PROVENANCE = Object.freeze({
  AUTHORITATIVE_BILLING: "authoritative_billing",
  AUTHORITATIVE_INVENTORY: "authoritative_inventory",
  ANALYTICS_NONBILLING: "analytics_nonbilling",
  LEDGER_ESTIMATE: "ledger_estimate",
  UNAVAILABLE: "unavailable",
});

// Typed unknown reasons (Luna FIX3G): every unknown metric names one.
export const UNKNOWN_REASONS = Object.freeze([
  "NO_AUTH_ENDPOINT",
  "AUTH_SCOPE_DENIED",
  "HTTP_ERROR",
  "MALFORMED",
  "PARTIAL_PAGINATION",
  "WINDOW_MISMATCH",
  "STALE",
  "ACCOUNT_MISMATCH",
  "DEGRADED",
]);

export function isProvenance(value) {
  return Object.values(METRIC_PROVENANCE).includes(value);
}

export function isUnknownReason(value) {
  return UNKNOWN_REASONS.includes(value);
}

export const DECIMAL_BYTES_PER_GB = 1_000_000_000;
export const DECIMAL_BYTES_PER_KB = 1_000;
export const QUEUE_CHUNK_BYTES = 64_000;
export const QUEUE_MESSAGE_OVERHEAD_BYTES = 100;

// Plan scope (explicit, no mislabeling): this deployment budgets Workers Paid
// monthly inclusions and R2 paid inclusions. Free-tier daily limits are a
// separate optional profile and must never be presented as this envelope.
// Pricing GB/KB are decimal unless a doc below states otherwise. Monthly
// windows are UTC calendar-month approximations of subscription-renewal
// months; daily windows reset at UTC midnight. A snapshot whose window does
// not cover `now` (wrong window or reset crossing) seals/blocks fail-closed.
export const PLAN_SCOPE = {
  deployment: "Workers Paid monthly inclusions + R2 paid inclusions",
  workersPlan: "Workers Paid",
  r2Plan: "R2 paid inclusions",
  freeTier: "separate optional profile; never this envelope",
  monthlySemantics: "subscription-renewal month approximated as UTC calendar month",
  dailySemantics: "UTC midnight to UTC midnight",
  unitBasis: "decimal GB/KB (1 GB = 1,000,000,000 bytes) unless docs state otherwise",
};

// Official Cloudflare pricing/limits sources (truth for quotas/units).
// Retrieved 2026-09-06. Validated against installed Wrangler 4.127.1 schemas;
// response/pagination shapes in tests mock only fields observed in that
// toolchain. No undocumented counter fields are guessed.
export const DOC_SOURCES = [
  { url: "https://developers.cloudflare.com/workers/pricing/", covers: "workers_requests, workers_cpu_ms", retrieved: "2026-09-06" },
  { url: "https://developers.cloudflare.com/workers/platform/limits/", covers: "workers limits", retrieved: "2026-09-06" },
  { url: "https://developers.cloudflare.com/d1/pricing/", covers: "d1_storage, d1_rows_read, d1_rows_written", retrieved: "2026-09-06" },
  { url: "https://developers.cloudflare.com/r2/pricing/", covers: "r2_storage, r2_class_a_ops, r2_class_b_ops", retrieved: "2026-09-06" },
  { url: "https://developers.cloudflare.com/queues/pricing/", covers: "queue_ops 64KB chunk", retrieved: "2026-09-06" },
  { url: "https://developers.cloudflare.com/durable-objects/pricing/", covers: "do_requests, do_gb_seconds, do_sql, do_storage", retrieved: "2026-09-06" },
  { url: "https://developers.cloudflare.com/workers-ai/pricing/", covers: "workers_ai_neurons_per_day", retrieved: "2026-09-06" },
  { url: "https://developers.cloudflare.com/ai-search/limits-pricing/", covers: "ai_search_instances, ai_search_queries_month", retrieved: "2026-09-06" },
  { url: "https://developers.cloudflare.com/vectorize/pricing/", covers: "vectorize_queried_dims, vectorize_stored_dims", retrieved: "2026-09-06" },
];

export function bytesFromDecimalGb(gb) {
  if (typeof gb !== "number" || !Number.isFinite(gb) || gb < 0) throw new Error("gb must be a non-negative finite number");
  return Math.round(gb * DECIMAL_BYTES_PER_GB);
}

export function decimalGbFromBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) throw new Error("bytes must be a non-negative finite number");
  return bytes / DECIMAL_BYTES_PER_GB;
}

// SEALED allowlist: the ONLY remote effects authorized while sealed (stale /
// wrong-window / unknown-untrusted), and only after fresh account binding
// (verified whoami digest) plus a fresh inventory receipt. Everything else —
// Worker upload/exposure, route/domain, D1 migrations/queries, R2 writes,
// Queue create/config/produce/consume, Workflow/DO exec, Workers AI, AI
// Search index/query, Vectorize writes/queries — stays denied until ADMITTED
// or a controller-owned ledger + full inventory proof shows headroom.
export const SEALED_ALLOWLIST = Object.freeze([
  "wrangler-whoami-verify",
  "access-app-readback",
  "d1-inventory-list",
  "r2-inventory-list",
  "queue-inventory-list",
  "ai-search-inventory-list",
  "local-config-generate",
  "preflight-receipt-write",
]);

export function isSealedAllowlistedOperation(operation) {
  return typeof operation === "string" && SEALED_ALLOWLIST.includes(operation);
}

// quota is the included Cloudflare plan quota (100%); envelope is the local
// 80% admission boundary. window selects the fencing discipline; `exact`
// marks point-in-time counts (AI Search instance inventory) rather than
// cumulative counters. Storage bytes are decimal-GB derived (see above).
export const USAGE_METRICS = [
  { key: "workers_requests", quota: 10_000_000, envelope: 8_000_000, window: "monthly", plan: "Workers Paid" },
  { key: "workers_cpu_ms", quota: 30_000_000, envelope: 24_000_000, window: "monthly", plan: "Workers Paid" },
  { key: "d1_storage_bytes", quota: 5 * DECIMAL_BYTES_PER_GB, envelope: 4 * DECIMAL_BYTES_PER_GB, window: "monthly", plan: "D1 paid inclusion (decimal GB)" },
  { key: "d1_rows_read", quota: 25_000_000_000, envelope: 20_000_000_000, window: "monthly", plan: "D1 paid inclusion" },
  { key: "d1_rows_written", quota: 50_000_000, envelope: 40_000_000, window: "monthly", plan: "D1 paid inclusion" },
  { key: "r2_storage_gb_month", quota: 10, envelope: 8, window: "monthly", plan: "R2 paid inclusion (decimal GB-mo)", unit: "decimal-GB-mo" },
  { key: "r2_class_a_ops", quota: 1_000_000, envelope: 800_000, window: "monthly", plan: "R2 paid inclusion" },
  { key: "r2_class_b_ops", quota: 10_000_000, envelope: 8_000_000, window: "monthly", plan: "R2 paid inclusion" },
  { key: "queue_ops", quota: 1_000_000, envelope: 800_000, window: "monthly", plan: "Queues paid inclusion (64,000-byte chunks)" },
  { key: "do_requests", quota: 1_000_000, envelope: 800_000, window: "monthly", plan: "Durable Objects paid inclusion" },
  { key: "do_gb_seconds", quota: 400_000, envelope: 320_000, window: "monthly", plan: "Durable Objects paid inclusion" },
  { key: "do_sql_reads", quota: 25_000_000_000, envelope: 20_000_000_000, window: "monthly", plan: "Durable Objects SQLite paid inclusion" },
  { key: "do_sql_writes", quota: 50_000_000, envelope: 40_000_000, window: "monthly", plan: "Durable Objects SQLite paid inclusion" },
  { key: "do_storage_bytes", quota: 5 * DECIMAL_BYTES_PER_GB, envelope: 4 * DECIMAL_BYTES_PER_GB, window: "monthly", plan: "Durable Objects paid inclusion (decimal GB)" },
  { key: "workers_ai_neurons_per_day", quota: 10_000, envelope: 8_000, window: "daily", plan: "Workers AI paid inclusion" },
  { key: "ai_search_instances", quota: 5, envelope: 5, window: "point", exact: true, plan: "AI Search (exactly 5)" },
  { key: "ai_search_queries_month", quota: 25_000, envelope: 20_000, window: "monthly", plan: "AI Search" },
  { key: "vectorize_queried_dims_month", quota: 50_000_000, envelope: 40_000_000, window: "monthly", plan: "Vectorize" },
  { key: "vectorize_stored_dims_month", quota: 10_000_000, envelope: 8_000_000, window: "monthly", plan: "Vectorize" },
];

export const REQUIRED_METRIC_KEYS = USAGE_METRICS.map((metric) => metric.key);
export const METRIC_BY_KEY = new Map(USAGE_METRICS.map((metric) => [metric.key, metric]));

// Access contour (one owner-only hostname application, 24h session) is not a
// usage counter: it is enforced by the Access provisioner plus the core
// provisioner cross-check. The preflight records receipt presence only.
export const ACCESS_CONTOUR = {
  applications: 1,
  sessionDuration: "24h",
  contour: "HOSTNAME_BASED_ACCESS",
  workerLevelAccess: "PROHIBITED_FOR_RESEARCH_SESSION_WEBSOCKETS",
};

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
    failures.push(`${label}.kind must be monthly, daily or point`);
  }
  try {
    const start = parseTime(window.start, `${label}.start`);
    const end = parseTime(window.end, `${label}.end`);
    if (!(start < end)) failures.push(`${label} must satisfy start < end`);
  } catch (error) {
    failures.push(error.message);
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
  const missing = REQUIRED_METRIC_KEYS.filter((key) => !metricKeys.includes(key));
  const unexpected = metricKeys.filter((key) => !METRIC_BY_KEY.has(key));
  if (missing.length > 0) return blocked([`snapshot is missing required metrics: ${missing.join(", ")}`]);
  if (unexpected.length > 0) return blocked([`snapshot carries unknown metric keys: ${unexpected.join(", ")}`]);
  for (const key of REQUIRED_METRIC_KEYS) {
    const value = snapshot.metrics[key];
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
  if (stale) reasons.push("snapshot is stale; no headroom claim is admissible");

  const windowFailures = validateWindow(snapshot.window, "window");
  if (snapshot.daily_window !== undefined) {
    windowFailures.push(...validateWindow(snapshot.daily_window, "daily_window"));
  }
  if (windowFailures.length > 0) return blocked(windowFailures);
  const windowOk = windowCovers(snapshot.window, now) &&
    (snapshot.daily_window === undefined || windowCovers(snapshot.daily_window, now));
  if (!windowOk) reasons.push("snapshot window does not cover now; aggregate belongs to another billing window");

  for (const metric of USAGE_METRICS) {
    const value = snapshot.metrics[metric.key];
    if (isUnknown(value)) {
      unknown.push(metric.key);
      continue;
    }
    if (metric.exact) {
      if (value > metric.envelope) {
        over.push({ metric: metric.key, value, envelope: metric.envelope });
      } else if (value < metric.envelope) {
        advisory.push(`${metric.key} reports ${value}, below the required ${metric.envelope}; usage headroom exists but inventory is incomplete`);
      }
      continue;
    }
    if (value > metric.envelope) {
      over.push({ metric: metric.key, value, envelope: metric.envelope });
    } else if (value >= NEAR_LIMIT_RATIO * metric.envelope) {
      near.push({ metric: metric.key, value, envelope: metric.envelope });
    }
  }

  if (over.length > 0) {
    return {
      decision: "BLOCKED",
      sealed: false,
      over,
      unknown,
      near,
      advisory,
      stale,
      windowOk,
      reasons: [...reasons, ...over.map((item) => `${item.metric} at ${item.value} exceeds envelope ${item.envelope}`)],
    };
  }
  if (stale || !windowOk || unknown.length > 0) {
    const sealedReasons = [...reasons];
    if (unknown.length > 0) {
      sealedReasons.push(`no authoritative aggregate for: ${unknown.join(", ")}; heavy operations stay disabled`);
    }
    return { decision: "SEALED", sealed: true, over, unknown, near, advisory, stale, windowOk, reasons: sealedReasons };
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
    reasons: near.map((item) => `${item.metric} at ${item.value} is within 10% of envelope ${item.envelope}`),
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
export function buildAdmissionReceipt({ evaluation, snapshot, now = Date.now(), expectedAccountId }) {
  if (!evaluation || !snapshot) throw new Error("evaluation and snapshot are required");
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
    windows: {
      monthly: snapshot.window ?? null,
      daily: snapshot.daily_window ?? null,
    },
    source: snapshot.source ?? "unknown",
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
  const { expectedAccountDigest, now = Date.now(), maxAgeMs = RECEIPT_MAX_AGE_MS } = options;
  if (typeof expectedAccountDigest !== "string" || expectedAccountDigest === "") {
    throw new Error("expectedAccountDigest is required for receipt binding");
  }
  const reasons = [];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { ok: false, decision: "BLOCKED", reasons: ["admission receipt must be an object"] };
  }
  if (receipt.protocol !== USAGE_ADMISSION_PROTOCOL) {
    reasons.push(`admission receipt protocol must be ${USAGE_ADMISSION_PROTOCOL}`);
  }
  if (receipt.account_id_digest !== expectedAccountDigest) {
    reasons.push("admission receipt binds a different account digest; refusing substituted receipt");
  }
  if (!["ADMITTED", "SEALED", "BLOCKED"].includes(receipt.decision)) {
    reasons.push("admission receipt decision must be ADMITTED, SEALED or BLOCKED");
  }
  let createdAt = NaN;
  try {
    createdAt = parseTime(receipt.created_at, "created_at");
  } catch (error) {
    reasons.push(error.message);
  }
  if (Number.isFinite(createdAt) && (createdAt > now + CLOCK_SKEW_MS || now - createdAt > maxAgeMs)) {
    reasons.push("admission receipt is stale; re-run the usage preflight before mutating");
  }
  if (receipt.decision === "BLOCKED") reasons.push("admission receipt records BLOCKED");
  if (!Array.isArray(receipt.over_envelope) || !Array.isArray(receipt.unknown_metrics) || !Array.isArray(receipt.reasons)) {
    reasons.push("admission receipt must carry over_envelope, unknown_metrics and reasons arrays");
  }
  // ADMITTED is the only decision that authorizes heavy work, so a forged
  // ADMITTED (for example unknown_metrics non-empty, over-envelope entries,
  // incoherent sealed flag, wrong generation, unbound account ref, stale
  // snapshot, or malformed windows) must fail closed. SEALED/BLOCKED keep
  // their current semantics.
  if (receipt.decision === "ADMITTED") {
    if (!Array.isArray(receipt.unknown_metrics) || receipt.unknown_metrics.length !== 0) {
      reasons.push("admission receipt claims ADMITTED with unknown metrics; refusing forged receipt");
    }
    if (!Array.isArray(receipt.over_envelope) || receipt.over_envelope.length !== 0) {
      reasons.push("admission receipt claims ADMITTED over the envelope; refusing forged receipt");
    }
    if (receipt.sealed !== false) {
      reasons.push("admission receipt claims ADMITTED with an incoherent sealed flag; refusing forged receipt");
    }
    if (receipt.generation !== USAGE_ENVELOPE_GENERATION) {
      reasons.push("admission receipt generation binding is missing or stale; refusing forged receipt");
    }
    if (typeof receipt.account_ref !== "string" || receipt.account_ref === "" || receipt.account_ref === "cloudflare-account:missing") {
      reasons.push("admission receipt account ref binding is missing; refusing forged receipt");
    }
    try {
      const collectedAt = parseTime(receipt.collected_at, "collected_at");
      if (collectedAt > now + CLOCK_SKEW_MS || now - collectedAt > maxAgeMs) {
        reasons.push("admission receipt snapshot is stale; re-run the usage preflight before mutating");
      }
    } catch (error) {
      reasons.push(error.message);
    }
    const monthly = receipt.windows?.monthly;
    const monthlyFailures = validateWindow(monthly, "windows.monthly");
    if (monthlyFailures.length > 0) {
      reasons.push(...monthlyFailures);
    } else if (monthly.kind !== "monthly") {
      reasons.push("windows.monthly.kind must be monthly");
    }
    const daily = receipt.windows?.daily;
    if (daily !== null && daily !== undefined) {
      const dailyFailures = validateWindow(daily, "windows.daily");
      if (dailyFailures.length > 0) {
        reasons.push(...dailyFailures);
      } else if (daily.kind !== "daily") {
        reasons.push("windows.daily.kind must be daily");
      }
    } else {
      reasons.push("admission receipt windows.daily binding is missing; refusing forged receipt");
    }
  }
  return { ok: reasons.length === 0, decision: receipt.decision ?? "BLOCKED", reasons };
}
