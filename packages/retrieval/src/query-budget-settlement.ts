import type { RetrievalRequestBudgets } from "./ports.js";
import {
  canonicalRetrievalJson,
  decodeRetrievalRequestBudgets,
  hasExactRetrievalKeys as hasExactKeys,
  isRetrievalRecord as isRecord,
  retrievalSha256Hex as sha256Hex,
} from "./query-codec.js";
import type { RetrievalResult } from "./service.js";

export interface RetrievalBudgetUsageV1 {
  /** Candidate rows admitted from all executed lanes into this query's fusion input. */
  readonly candidateUnitsUsed: number;
  /** Raw candidate rows returned by the managed SEM provider before aggregate candidate limiting. */
  readonly providerCandidatesReturned: number;
  /** Candidate-lane rows submitted to reciprocal-rank fusion (one unit per input row). */
  readonly fusionOperationsUsed: number;
  /** Exact resolver calls actually started while scanning the ranked tail. */
  readonly exactResolverScanUnitsUsed: number;
  /** Non-null exact evidence items materialized, including an item omitted for bytes. */
  readonly evidenceItemsUsed: number;
  /** UTF-8 bytes materialized from exact excerpts, including an over-limit omitted item. */
  readonly evidenceBytesUsed: number;
}

export interface RetrievalBudgetSettlementV1 {
  readonly protocol: "eliotr.retrieval-budget-settlement.v1";
  readonly receipt_ref: string;
  readonly execution_id: string;
  readonly request_digest: string;
  readonly result_digest: string;
  readonly trace_digest: string;
  readonly usage: RetrievalBudgetUsageV1;
  readonly request_budgets?: RetrievalRequestBudgets;
}

export interface SettleRetrievalBudgetUsageV1Input {
  readonly execution_id: string;
  readonly request_digest: string;
  readonly result: RetrievalResult;
  readonly usage: RetrievalBudgetUsageV1;
  readonly request_budgets?: RetrievalRequestBudgets;
}

const USAGE_KEYS = [
  "candidateUnitsUsed",
  "evidenceBytesUsed",
  "evidenceItemsUsed",
  "exactResolverScanUnitsUsed",
  "fusionOperationsUsed",
  "providerCandidatesReturned",
] as const;
const SETTLEMENT_KEYS = [
  "execution_id",
  "protocol",
  "receipt_ref",
  "request_digest",
  "result_digest",
  "trace_digest",
  "usage",
] as const;
function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function decodeUsage(value: unknown): RetrievalBudgetUsageV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, USAGE_KEYS)) return null;
  for (const key of USAGE_KEYS) {
    if (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || (value[key] as number) < 0) {
      return null;
    }
  }
  return {
    candidateUnitsUsed: value.candidateUnitsUsed as number,
    providerCandidatesReturned: value.providerCandidatesReturned as number,
    fusionOperationsUsed: value.fusionOperationsUsed as number,
    exactResolverScanUnitsUsed: value.exactResolverScanUnitsUsed as number,
    evidenceItemsUsed: value.evidenceItemsUsed as number,
    evidenceBytesUsed: value.evidenceBytesUsed as number,
  };
}

/** Aggregate measured usage across branch query legs without allocating budgets by lane. */
export function sumRetrievalBudgetUsageV1(
  usages: readonly RetrievalBudgetUsageV1[],
): RetrievalBudgetUsageV1 {
  const total: Record<(typeof USAGE_KEYS)[number], number> = {
    candidateUnitsUsed: 0,
    evidenceBytesUsed: 0,
    evidenceItemsUsed: 0,
    exactResolverScanUnitsUsed: 0,
    fusionOperationsUsed: 0,
    providerCandidatesReturned: 0,
  };
  for (const usage of usages) {
    const decoded = decodeUsage(usage);
    if (decoded === null) throw new TypeError("retrieval budget usage is invalid");
    for (const key of USAGE_KEYS) {
      const next = total[key] + decoded[key];
      if (!Number.isSafeInteger(next)) throw new RangeError("retrieval budget usage aggregate exceeds safe integer bounds");
      total[key] = next;
    }
  }
  return Object.freeze(total);
}

/** A random execution identity keeps trace and pack rows independent of request-digest collisions. */
export function createRetrievalExecutionIdV1(): string {
  return [...crypto.getRandomValues(new Uint8Array(24))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Bind operation-time usage to the canonical public result and trace. Hashes provide integrity only. */
export async function settleRetrievalBudgetUsageV1(
  input: SettleRetrievalBudgetUsageV1Input,
): Promise<RetrievalBudgetSettlementV1> {
  const executionId = input.execution_id;
  const usage = decodeUsage(input.usage);
  const budgets: RetrievalRequestBudgets | undefined = input.request_budgets === undefined
    ? undefined
    : decodeRetrievalRequestBudgets(input.request_budgets) ?? undefined;
  if (!/^[a-f0-9]{48}$/u.test(executionId) || !isDigest(input.request_digest) || usage === null ||
      (input.request_budgets !== undefined && budgets === undefined)) {
    throw new TypeError("retrieval budget settlement input is invalid");
  }
  const receiptRef = `budget-${executionId}`;
  const result = input.result;
  if (result.trace.budget_receipt_ref !== receiptRef ||
      result.trace.trace_ref.id !== `query-${executionId}` ||
      result.evidence_pack.pack_ref.id !== `pack-${executionId}` ||
      result.trace.evidence_pack_ref !== result.evidence_pack.pack_ref.id ||
      result.trace.trace_ref.id !== result.evidence_pack.trace_ref.id ||
      result.trace.trace_ref.revision !== result.evidence_pack.trace_ref.revision ||
      result.evidence_pack.scope_snapshot_ref.id !== result.trace.scope_snapshot.snapshot_id ||
      result.evidence_pack.scope_snapshot_ref.revision !== result.trace.scope_snapshot.revision) {
    throw new TypeError("retrieval budget settlement is not bound to its result identities");
  }
  const canonicalResult = canonicalRetrievalJson(result);
  const canonicalTrace = canonicalRetrievalJson(result.trace);
  return Object.freeze({
    protocol: "eliotr.retrieval-budget-settlement.v1",
    receipt_ref: receiptRef,
    execution_id: executionId,
    request_digest: input.request_digest,
    result_digest: await sha256Hex(canonicalResult),
    trace_digest: await sha256Hex(canonicalTrace),
    usage: Object.freeze(usage),
    ...(budgets === undefined ? {} : { request_budgets: Object.freeze(budgets) }),
  });
}

/** Strictly verify a persisted receipt against its request digest and durable public result. */
export async function decodeRetrievalBudgetSettlementV1(
  value: unknown,
  expectedRequestDigest: string,
  result: RetrievalResult,
): Promise<RetrievalBudgetSettlementV1 | null> {
  if (!isRecord(value) || !isDigest(expectedRequestDigest)) return null;
  const hasBudgets = Object.prototype.hasOwnProperty.call(value, "request_budgets");
  const expectedKeys = hasBudgets ? [...SETTLEMENT_KEYS, "request_budgets"] : SETTLEMENT_KEYS;
  if (!hasExactKeys(value, expectedKeys) || value.protocol !== "eliotr.retrieval-budget-settlement.v1" ||
      typeof value.execution_id !== "string" || !/^[a-f0-9]{48}$/u.test(value.execution_id) ||
      value.receipt_ref !== `budget-${value.execution_id}` || value.request_digest !== expectedRequestDigest ||
      !isDigest(value.result_digest) || !isDigest(value.trace_digest)) {
    return null;
  }
  const usage = decodeUsage(value.usage);
  const budgets: RetrievalRequestBudgets | undefined = hasBudgets
    ? decodeRetrievalRequestBudgets(value.request_budgets) ?? undefined
    : undefined;
  if (usage === null || (hasBudgets && budgets === undefined) ||
      result.trace.budget_receipt_ref !== value.receipt_ref ||
      result.trace.trace_ref.id !== `query-${value.execution_id}` ||
      result.evidence_pack.pack_ref.id !== `pack-${value.execution_id}` ||
      result.trace.evidence_pack_ref !== result.evidence_pack.pack_ref.id ||
      result.trace.trace_ref.id !== result.evidence_pack.trace_ref.id ||
      result.trace.trace_ref.revision !== result.evidence_pack.trace_ref.revision ||
      usage.evidenceItemsUsed < result.evidence_pack.resolved_evidence.length ||
      usage.evidenceBytesUsed < result.evidence_pack.total_utf8_bytes) {
    return null;
  }
  try {
    const resultDigest = await sha256Hex(canonicalRetrievalJson(result));
    const traceDigest = await sha256Hex(canonicalRetrievalJson(result.trace));
    if (value.result_digest !== resultDigest || value.trace_digest !== traceDigest) return null;
  } catch {
    return null;
  }
  return {
    protocol: "eliotr.retrieval-budget-settlement.v1",
    receipt_ref: value.receipt_ref as string,
    execution_id: value.execution_id,
    request_digest: expectedRequestDigest,
    result_digest: value.result_digest,
    trace_digest: value.trace_digest,
    usage,
    ...(budgets === undefined ? {} : { request_budgets: budgets }),
  };
}
