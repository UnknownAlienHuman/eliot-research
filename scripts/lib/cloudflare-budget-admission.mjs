// Runtime budget admission: atomic counters/leases with daily/monthly
// fencing, retry/DLQ accounting, concurrency protection and a safety margin
// (FIX1 section B).
//
// Layer 2 of the two-layer guard. Layer 1 (usage preflight receipt) proves
// account-wide headroom; this ledger gates individual runtime operations:
// every expensive or retryable operation reserves its envelope share
// atomically BEFORE the billable binding is invoked. A denial is a
// non-secret object; the caller must never invoke the billable binding when
// blocked.
//
// All functions are synchronous (check-and-reserve holds no await), so
// admission is atomic under Node's event loop. Fencing keys derive from UTC:
// daily counters reset at UTC midnight, monthly counters at the UTC month
// boundary. `unknown` ledger state never coerces to zero: a metric without a
// known envelope share or without headroom proof is denied.

import {
  QUEUE_CHUNK_BYTES,
  QUEUE_MESSAGE_OVERHEAD_BYTES,
  RECEIPT_MAX_AGE_MS,
  SAFETY_MARGIN_RATIO,
  getCanonicalMetric,
  hasCanonicalMetric,
  isLiveEvidenceFamily,
  listCanonicalRequiredKeys,
  validateAdmissionReceipt,
} from "./cloudflare-usage-envelope.mjs";
import {
  isUsageAdmissionCapability,
} from "./cloudflare-usage-admission.mjs";

export const DEFAULT_CONCURRENCY_CAP = 4;
export const QUEUE_BILLABLE_CHUNK_BYTES = QUEUE_CHUNK_BYTES;
export const QUEUE_BILLABLE_OVERHEAD_BYTES = QUEUE_MESSAGE_OVERHEAD_BYTES;

export class BudgetAdmissionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BudgetAdmissionError";
    this.code = code;
  }
}

function dayKeyFor(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function monthKeyFor(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 7);
}

function windowForMetric(metricKey) {
  const metric = getCanonicalMetric(metricKey);
  if (!metric) {
    throw new BudgetAdmissionError("UNKNOWN_METRIC", `metric ${metricKey} is not part of the usage envelope`);
  }
  return metric.window;
}

export function createBudgetLedger() {
  return {
    monthly: new Map(),
    daily: new Map(),
    leases: new Map(),
    retries: 0,
    dlqRedrives: 0,
  };
}

function bucketFor(ledger, metricKey, now) {
  const window = windowForMetric(metricKey);
  if (window === "daily") {
    const period = dayKeyFor(now);
    const slot = ledger.daily.get(metricKey);
    if (!slot || slot.period !== period) {
      const fresh = { period, used: 0 };
      ledger.daily.set(metricKey, fresh);
      return fresh;
    }
    return slot;
  }
  if (window === "monthly") {
    const period = monthKeyFor(now);
    const slot = ledger.monthly.get(metricKey);
    if (!slot || slot.period !== period) {
      const fresh = { period, used: 0 };
      ledger.monthly.set(metricKey, fresh);
      return fresh;
    }
    return slot;
  }
  // Point-in-time inventory (for example AI Search instance count) is owned
  // by provisioning readback, not by incremental reservation.
  return { period: "point", used: 0 };
}

function assertQuantity(quantity) {
  if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity < 0) {
    throw new BudgetAdmissionError("INVALID_QUANTITY", "quantity must be a non-negative finite number");
  }
}

// Atomic reserve against the envelope share minus the safety margin.
export function admitOperation(ledger, { metricKey, quantity, now = Date.now() } = {}) {
  if (!ledger) throw new BudgetAdmissionError("INVALID_LEDGER", "ledger is required");
  assertQuantity(quantity);
  if (listCanonicalRequiredKeys().length === 0) {
    return { allowed: false, metric: metricKey, reason: "UNKNOWN_METRIC_NO_HEADROOM_PROOF", used: 0, remaining: 0, projected: quantity };
  }
  const metric = getCanonicalMetric(metricKey);
  if (!metric) {
    return { allowed: false, metric: metricKey, reason: "UNKNOWN_METRIC_NO_HEADROOM_PROOF", used: 0, remaining: 0, projected: quantity };
  }
  if (metric.exact) {
    if (quantity !== 0) {
      return { allowed: false, metric: metricKey, reason: "EXACT_COUNT_MANAGED_BY_PROVISIONER", used: 0, remaining: 0, projected: quantity };
    }
    return { allowed: true, metric: metricKey, reason: "EXACT_COUNT_NO_CONSUMPTION", used: 0, remaining: metric.envelope, projected: 0 };
  }
  const slot = bucketFor(ledger, metricKey, now);
  const cap = Math.floor(metric.envelope * (1 - SAFETY_MARGIN_RATIO));
  const projected = slot.used + quantity;
  if (projected > cap) {
    return { allowed: false, metric: metricKey, reason: "OVER_ENVELOPE_SHARE", used: slot.used, remaining: Math.max(0, cap - slot.used), projected };
  }
  slot.used = projected;
  return { allowed: true, metric: metricKey, reason: "WITHIN_ENVELOPE_SHARE", used: slot.used, remaining: cap - slot.used, projected };
}

// Queues billable ops (per https://developers.cloudflare.com/queues/pricing/,
// retrieved 2026-09-06): 1 op per 64,000-byte chunk written, read, or deleted,
// including a ~100-byte per-message overhead. Retries add reads, DLQ writes
// add chunked writes, deletions/expiry add deletes. All rounding is
// conservative ceil — never undercount.
//
// Examples: 1 byte -> 1 op; 64,000 bytes payload + 100 overhead = 64,100 ->
// 2 ops; 65,000 bytes -> ceil(65,100/64,000) = 2 ops; 127,000 bytes ->
// ceil(127,100/64,000) = 2 ops; 128,000 bytes -> ceil(128,100/64,000) = 3 ops.
export function queueOpsForBytes(byteLength) {
  if (typeof byteLength !== "number" || !Number.isFinite(byteLength) || byteLength < 0) {
    throw new BudgetAdmissionError("INVALID_QUANTITY", "byteLength must be a non-negative finite number");
  }
  return Math.max(1, Math.ceil((Math.ceil(byteLength) + QUEUE_BILLABLE_OVERHEAD_BYTES) / QUEUE_BILLABLE_CHUNK_BYTES));
}

export function queueOpsForMessage(byteLength = 0) {
  return queueOpsForBytes(byteLength);
}

export function queueOpsForBatch(byteLengths) {
  if (!Array.isArray(byteLengths)) {
    throw new BudgetAdmissionError("INVALID_QUANTITY", "byteLengths must be an array");
  }
  let total = 0;
  for (const length of byteLengths) total += queueOpsForBytes(length);
  return total;
}

export function recordQueueWrite(ledger, { bytes, messages = 1, now = Date.now() } = {}) {
  if (!Number.isInteger(messages) || messages < 1) {
    throw new BudgetAdmissionError("INVALID_QUANTITY", "messages must be a positive integer");
  }
  const actual = Array.isArray(bytes) ? queueOpsForBatch(bytes) : queueOpsForBytes(bytes ?? 0) * messages;
  const admission = admitOperation(ledger, { metricKey: "queue_ops", quantity: actual, now });
  return { ...admission, ops: actual };
}

export function recordQueueRead(ledger, { bytes, messages = 1, now = Date.now() } = {}) {
  return recordQueueWrite(ledger, { bytes, messages, now });
}

export function recordQueueDelete(ledger, { bytes, messages = 1, now = Date.now() } = {}) {
  return recordQueueWrite(ledger, { bytes, messages, now });
}

// Retry accounting: every delivery attempt (including DLQ redrives) consumes
// queue operations, so retries cannot silently exceed the Queue envelope.
// Chunk-aware: callers SHOULD pass bytesPerAttempt / bytesEach so large
// payloads are not undercounted; omitted sizes conservatively count 1 op per
// message (the minimum for any non-empty delivery).
export function recordRetryDelivery(ledger, { attempts, bytesPerAttempt, now = Date.now() } = {}) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new BudgetAdmissionError("INVALID_QUANTITY", "attempts must be a positive integer");
  }
  // Each retry is a re-read: chunked when the payload size is known, else the
  // conservative 1-op minimum per attempt (caller must supply sizes for large
  // payloads to avoid undercount).
  const ops = Array.isArray(bytesPerAttempt)
    ? queueOpsForBatch(bytesPerAttempt)
    : queueOpsForBytes(bytesPerAttempt ?? 0) * attempts;
  const admission = admitOperation(ledger, { metricKey: "queue_ops", quantity: ops, now });
  if (admission.allowed) ledger.retries += ops;
  return { ...admission, ops, retries: ledger.retries };
}

export function recordDlqRedrive(ledger, { messages, bytesEach, now = Date.now() } = {}) {
  if (!Number.isInteger(messages) || messages < 1) {
    throw new BudgetAdmissionError("INVALID_QUANTITY", "messages must be a positive integer");
  }
  // DLQ redrive writes each message again: chunked writes, same minimum rule.
  const ops = Array.isArray(bytesEach)
    ? queueOpsForBatch(bytesEach)
    : queueOpsForBytes(bytesEach ?? 0) * messages;
  const admission = admitOperation(ledger, { metricKey: "queue_ops", quantity: ops, now });
  if (admission.allowed) ledger.dlqRedrives += ops;
  return { ...admission, ops, dlqRedrives: ledger.dlqRedrives };
}

// Concurrency protection: at most `cap` concurrent heavy leases per
// operation name. Acquisition and release are synchronous.
export function acquireLease(ledger, { operation, now = Date.now(), cap = DEFAULT_CONCURRENCY_CAP } = {}) {
  if (!ledger) throw new BudgetAdmissionError("INVALID_LEDGER", "ledger is required");
  if (typeof operation !== "string" || operation.trim() === "") {
    throw new BudgetAdmissionError("INVALID_OPERATION", "operation name is required");
  }
  void now;
  const held = ledger.leases.get(operation) ?? 0;
  if (held >= cap) {
    return { allowed: false, operation, reason: "CONCURRENCY_CAP_EXHAUSTED", held, cap };
  }
  ledger.leases.set(operation, held + 1);
  return { allowed: true, operation, reason: "LEASE_ACQUIRED", held: held + 1, cap };
}

export function releaseLease(ledger, { operation } = {}) {
  if (!ledger) throw new BudgetAdmissionError("INVALID_LEDGER", "ledger is required");
  const held = ledger.leases.get(operation) ?? 0;
  if (held <= 0) {
    throw new BudgetAdmissionError("LEASE_UNDERFLOW", `no held lease for operation ${operation}`);
  }
  ledger.leases.set(operation, held - 1);
  return { operation, held: held - 1 };
}

// Heavy-operation gate: ingestion, queue produce/consume, Workflow/DO
// execution, Workers AI calls, AI Search index/query and Vectorize
// writes/queries stay disabled until the caller presents the same-process
// admission capability minted by the fresh live collection lifecycle, AND
// EITHER a fresh ADMITTED aggregate receipt with a LIVE provider evidence
// family OR a fresh controller-owned ledger+inventory proof shows headroom.
// ADMITTED (even validator-clean with a live family) is necessary but never
// sufficient: without the capability the gate denies. Denials carry no
// secrets and must precede any billable call.
// Provenance discipline (receipts are integrity-only locators, never proof of
// live collection): a self-consistent receipt minted without fresh live
// collection NEVER authorizes heavy work here, and neither does any
// structural copy of a genuine capability — only the exact minted object
// identity passes. Test-only and snapshot-asserted evidence families are
// refused even when structurally intact and validator-clean — the family is
// re-checked explicitly below, so no validator drift can launder a fixture
// into authorization. This function is the sole persisted-receipt consumer,
// and its `receipt` must come only from the local preflight write path
// (same-machine, same-run receipt file). Never pass committed fixtures,
// transported files, or cross-machine copies — re-collect instead.
export function admitHeavyOperation(ledger, options = {}) {
  const {
    operation,
    metricKey,
    quantity,
    now = Date.now(),
    receipt = null,
    expectedAccountDigest = null,
    inventoryProof = null,
    receiptMaxAgeMs = RECEIPT_MAX_AGE_MS,
    // Same-process admission capability from runUsagePreflight. New objects
    // with identical shape (copies, clones, deserialized bytes) fail the
    // identity predicate and deny.
    capability = null,
  } = options;
  if (typeof operation !== "string" || operation.trim() === "") {
    throw new BudgetAdmissionError("INVALID_OPERATION", "operation name is required");
  }
  if (receipt && expectedAccountDigest) {
    const check = validateAdmissionReceipt(receipt, { expectedAccountDigest, now, maxAgeMs: receiptMaxAgeMs });
    if (check.ok && check.decision === "ADMITTED") {
      if (!isLiveEvidenceFamily(receipt)) {
        return { allowed: false, operation, metric: metricKey, proof: "NONE", reason: "SEALED_NO_HEADROOM_PROOF" };
      }
      // Capability is the additional necessary condition: a validator-clean
      // live-family receipt without the same-process mint still denies, so a
      // recomputed digest or hand-built live evidence can never authorize.
      if (!isUsageAdmissionCapability(capability)) {
        return { allowed: false, operation, metric: metricKey, proof: "NONE", reason: "MISSING_ADMISSION_CAPABILITY" };
      }
      const admission = admitOperation(ledger, { metricKey, quantity, now });
      return { ...admission, operation, proof: "FRESH_ADMITTED_AGGREGATE" };
    }
    if (check.ok && check.decision === "SEALED") {
      return { allowed: false, operation, metric: metricKey, proof: "NONE", reason: "SEALED_NO_HEADROOM_PROOF" };
    }
  }
  if (inventoryProof && expectedAccountDigest) {
    const proof = validateInventoryProof(inventoryProof, { expectedAccountDigest, now, maxAgeMs: receiptMaxAgeMs });
    if (!proof.ok) {
      return { allowed: false, operation, metric: metricKey, proof: "NONE", reason: `INVENTORY_PROOF_REJECTED:${proof.reasons[0] ?? "invalid"}` };
    }
    const known = proof.perMetric[metricKey];
    if (typeof known !== "number") {
      return { allowed: false, operation, metric: metricKey, proof: "NONE", reason: "SEALED_NO_HEADROOM_PROOF" };
    }
    const metric = getCanonicalMetric(metricKey);
    if (!metric) return { allowed: false, operation, metric: metricKey, proof: "NONE", reason: "SEALED_NO_HEADROOM_PROOF" };
    const cap = Math.floor(metric.envelope * (1 - SAFETY_MARGIN_RATIO));
    if (known + quantity > cap) {
      return { allowed: false, operation, metric: metricKey, proof: "LEDGER_INVENTORY", reason: "OVER_ENVELOPE_SHARE" };
    }
    // Ledger proofs prove headroom, not liveness: the capability is still
    // required before any reservation.
    if (!isUsageAdmissionCapability(capability)) {
      return { allowed: false, operation, metric: metricKey, proof: "NONE", reason: "MISSING_ADMISSION_CAPABILITY" };
    }
    const admission = admitOperation(ledger, { metricKey, quantity, now });
    return { ...admission, operation, proof: "LEDGER_INVENTORY" };
  }
  return { allowed: false, operation, metric: metricKey, proof: "NONE", reason: "SEALED_NO_HEADROOM_PROOF" };
}

function validateInventoryProof(proof, { expectedAccountDigest, now, maxAgeMs }) {
  const reasons = [];
  if (!proof || typeof proof !== "object") return { ok: false, perMetric: {}, reasons: ["inventory proof must be an object"] };
  if (proof.account_id_digest !== expectedAccountDigest) {
    reasons.push("inventory proof binds a different account digest");
  }
  const collectedAt = Date.parse(proof.collected_at ?? "");
  if (!Number.isFinite(collectedAt)) {
    reasons.push("inventory proof collected_at must be an ISO-8601 timestamp");
  } else if (collectedAt > now + 5 * 60 * 1000 || now - collectedAt > maxAgeMs) {
    reasons.push("inventory proof is stale");
  }
  const perMetric = {};
  if (!proof.perMetric || typeof proof.perMetric !== "object") {
    reasons.push("inventory proof must carry perMetric headroom counters");
  } else {
    for (const [key, value] of Object.entries(proof.perMetric)) {
      if (!hasCanonicalMetric(key) || typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        reasons.push(`inventory proof carries invalid counter ${key}`);
      } else {
        perMetric[key] = value;
      }
    }
  }
  return { ok: reasons.length === 0, perMetric, reasons };
}

export function ledgerSnapshot(ledger) {
  return {
    monthly: Object.fromEntries(ledger.monthly.entries()),
    daily: Object.fromEntries(ledger.daily.entries()),
    leases: Object.fromEntries(ledger.leases.entries()),
    retries: ledger.retries,
    dlqRedrives: ledger.dlqRedrives,
  };
}
