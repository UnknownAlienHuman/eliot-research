import {
  modelGatewaySha256,
  type ModelGatewayPricingPort,
} from "@eliotr/cloudflare-ai";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import { createD1ResearchModelPricingQuotePort } from "./research-model-pricing-quote.js";
import { readD1ModelGatewayFingerprint } from "./research-model-fingerprint-store.js";

export type ResearchModelSpendObservationErrorCode =
  | "SPEND_OBSERVATION_INPUT_INVALID"
  | "SPEND_OBSERVATION_READBACK_CORRUPT"
  | "SPEND_OBSERVATION_PERSISTENCE_UNCERTAIN";

export class ResearchModelSpendObservationError extends Error {
  public readonly code: ResearchModelSpendObservationErrorCode;
  public readonly retryable: boolean;

  public constructor(code: ResearchModelSpendObservationErrorCode, message: string, retryable = false, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchModelSpendObservationError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type SpendObservationVerdict = "PASS" | "FAIL" | "BLOCKED";
export type SpendSettlement = "SETTLED" | "UNSETTLED" | "NO_ATTEMPT";

export interface SpendObservationCostTargets {
  /** Maximum billable USD per operation (provider-billed; BYOK is reported separately). */
  readonly max_usd_per_operation: number;
  /** Maximum billable USD across the whole window. */
  readonly max_total_usd: number;
}

export interface OperationQuotedCost {
  readonly operation_kind: string;
  readonly platform_usd: number;
  readonly workers_ai_usd: number;
  readonly byok_usd: number;
  readonly max_total_usd: number;
  readonly quoted_total_usd: number;
}

export interface AttemptSettlementCounts {
  readonly total: number;
  readonly started: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
}

export interface RepricingStatus {
  readonly status: "AVAILABLE" | "UNAVAILABLE" | "NOT_APPLICABLE";
  readonly reason?: string;
}

export interface OperationSpendObservation {
  readonly authorization_ref: string;
  readonly operation_id: string;
  readonly workflow_operation_id: string;
  readonly stage_index: number;
  readonly operation_kind: string;
  readonly reservation_id: string;
  readonly principal_ref: string;
  readonly quoted: OperationQuotedCost;
  readonly settlement: SpendSettlement;
  readonly attempts: AttemptSettlementCounts;
  /** Provider-billed USD across SUCCEEDED attempts; null when unknowable. */
  readonly actual_usd: number | null;
  /** BYOK spend is never mixed into billed totals; reported separately. */
  readonly byok_usd: number;
  /** Independent reprice of observed tokens against the approved snapshot. */
  readonly repriced_usd: number | null;
  readonly repricing: RepricingStatus;
  readonly verdict: SpendObservationVerdict;
  readonly reasons: readonly string[];
}

const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const MAX_JSON_BYTES = 65536;

export function spendObservationFail(
  code: ResearchModelSpendObservationErrorCode,
  message: string,
  retryable = false,
  cause?: unknown,
): never {
  throw new ResearchModelSpendObservationError(code, message, retryable, cause);
}

export function spendText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    spendObservationFail("SPEND_OBSERVATION_READBACK_CORRUPT", `${label} is invalid`);
  }
  return value;
}

export function spendIdentifier(value: unknown, label: string): string {
  const result = spendText(value, label);
  if (!IDENTIFIER.test(result)) spendObservationFail("SPEND_OBSERVATION_READBACK_CORRUPT", `${label} is invalid`);
  return result;
}

export function spendTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") spendObservationFail("SPEND_OBSERVATION_INPUT_INVALID", `${label} is not a string`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    spendObservationFail("SPEND_OBSERVATION_INPUT_INVALID", `${label} is not canonical ISO-8601`);
  }
  return value;
}

export function spendMoney(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    spendObservationFail("SPEND_OBSERVATION_READBACK_CORRUPT", `${label} is invalid`);
  }
  return value;
}

export function spendNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    spendObservationFail("SPEND_OBSERVATION_READBACK_CORRUPT", `${label} is invalid`);
  }
  return value;
}

export function spendCanonicalStoredJson(raw: unknown, label: string): unknown {
  if (typeof raw !== "string" || raw.length === 0 || new TextEncoder().encode(raw).byteLength > MAX_JSON_BYTES) {
    spendObservationFail("SPEND_OBSERVATION_READBACK_CORRUPT", `${label} is missing or exceeds the D1 bound`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    spendObservationFail("SPEND_OBSERVATION_READBACK_CORRUPT", `${label} is not valid JSON`, false, cause);
  }
  if (canonicalJson(parsed) !== raw) spendObservationFail("SPEND_OBSERVATION_READBACK_CORRUPT", `${label} is not canonical JSON`);
  return parsed;
}

export function spendRoundUsd(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

export interface AdmissionRow {
  readonly authorization_ref: string;
  readonly operation_id: string;
  readonly workflow_operation_id: string;
  readonly stage_index: number;
  readonly reservation_id: string;
  readonly quote_json: string;
  readonly route_ref: string;
  readonly principal_ref: string;
  readonly created_at: string;
}

export function parseAdmissionRow(row: Record<string, unknown>): AdmissionRow {
  const stageIndex = row.stage_index;
  if (!Number.isSafeInteger(stageIndex) || ![12, 13, 14].includes(stageIndex as number)) {
    spendObservationFail("SPEND_OBSERVATION_READBACK_CORRUPT", "spend admission stage_index is invalid");
  }
  const quoteJson = row.quote_json;
  if (typeof quoteJson !== "string") spendObservationFail("SPEND_OBSERVATION_READBACK_CORRUPT", "spend admission quote is missing");
  return {
    authorization_ref: spendIdentifier(row.authorization_ref, "admission.authorization_ref"),
    operation_id: spendIdentifier(row.operation_id, "admission.operation_id"),
    workflow_operation_id: spendIdentifier(row.workflow_operation_id, "admission.workflow_operation_id"),
    stage_index: stageIndex as number,
    reservation_id: spendIdentifier(row.reservation_id, "admission.reservation_id"),
    quote_json: quoteJson,
    route_ref: spendIdentifier(row.route_ref, "admission.route_ref"),
    principal_ref: spendIdentifier(row.principal_ref, "admission.principal_ref"),
    created_at: spendText(row.created_at, "admission.created_at"),
  };
}

export interface AttemptRow {
  readonly attempt_id: string;
  readonly reservation_id: string;
  readonly operation_kind: string;
  readonly state: string;
  readonly receipt_json: string | null;
  readonly receipt_sha256: string | null;
  readonly started_at: string;
}

export function parseAttemptRow(row: Record<string, unknown>): AttemptRow {
  const state = row.state;
  if (typeof state !== "string" || !["STARTED", "SUCCEEDED", "FAILED", "CANCELLED"].includes(state)) {
    spendObservationFail("SPEND_OBSERVATION_READBACK_CORRUPT", "model attempt state is invalid");
  }
  const receiptJson = row.receipt_json;
  const receiptSha = row.receipt_sha256;
  if (receiptJson !== null && typeof receiptJson !== "string") {
    spendObservationFail("SPEND_OBSERVATION_READBACK_CORRUPT", "model attempt receipt is invalid");
  }
  if (receiptSha !== null && (typeof receiptSha !== "string" || !SHA256.test(receiptSha))) {
    spendObservationFail("SPEND_OBSERVATION_READBACK_CORRUPT", "model attempt receipt digest is invalid");
  }
  if ((receiptJson === null) !== (receiptSha === null)) {
    spendObservationFail("SPEND_OBSERVATION_READBACK_CORRUPT", "model receipt and digest binding disagree");
  }
  return {
    attempt_id: spendIdentifier(row.attempt_id, "attempt.attempt_id"),
    reservation_id: spendIdentifier(row.reservation_id, "attempt.reservation_id"),
    operation_kind: spendIdentifier(row.operation_kind, "attempt.operation_kind"),
    state,
    receipt_json: receiptJson,
    receipt_sha256: receiptSha,
    started_at: spendText(row.started_at, "attempt.started_at"),
  };
}

export function parseQuote(raw: string): OperationQuotedCost {
  const parsed = spendCanonicalStoredJson(raw, "spend admission quote");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    spendObservationFail("SPEND_OBSERVATION_READBACK_CORRUPT", "spend admission quote is not an object");
  }
  const record = parsed as Record<string, unknown>;
  const platform = spendMoney(record.platform_usd, "quote.platform_usd");
  const workersAi = spendMoney(record.workers_ai_usd, "quote.workers_ai_usd");
  const byok = spendMoney(record.byok_usd, "quote.byok_usd");
  const maxTotal = spendMoney(record.max_total_usd, "quote.max_total_usd");
  return Object.freeze({
    operation_kind: spendIdentifier(record.operation_kind, "quote.operation_kind"),
    platform_usd: platform,
    workers_ai_usd: workersAi,
    byok_usd: byok,
    max_total_usd: maxTotal,
    // Billable total only: BYOK is reported separately and never mixed into
    // billed totals, so it stays out of the quoted envelope too.
    quoted_total_usd: spendRoundUsd(platform + workersAi),
  });
}

interface ParsedReceipt {
  readonly route_fingerprint_ref: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly billed_usd: number;
}

export function parseReceipt(row: AttemptRow): ParsedReceipt | null {
  if (row.receipt_json === null) return null;
  const parsed = spendCanonicalStoredJson(row.receipt_json, "model attempt receipt");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    spendObservationFail("SPEND_OBSERVATION_READBACK_CORRUPT", "model receipt is not an object");
  }
  const record = parsed as Record<string, unknown>;
  return {
    route_fingerprint_ref: spendIdentifier(record.route_fingerprint_ref, "receipt.route_fingerprint_ref"),
    input_tokens: spendNonNegativeInteger(record.input_tokens, "receipt.input_tokens"),
    output_tokens: spendNonNegativeInteger(record.output_tokens, "receipt.output_tokens"),
    billed_usd: spendMoney(record.billed_usd, "receipt.billed_usd"),
  };
}

function classifyPricingFailure(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.includes("approved pricing snapshot is unavailable")) return "PRICING_SNAPSHOT_MISSING";
  if (message.includes("not currently effective")) return "PRICING_SNAPSHOT_NOT_CURRENT";
  if (message.includes("does not match the route fingerprint")) return "PRICING_SNAPSHOT_MISMATCH";
  return "REPRICING_FAILED";
}

export interface SettlementContext {
  readonly database: D1Database;
  readonly pricing?: ModelGatewayPricingPort;
  readonly pricingSnapshotRef: string;
  readonly costTargets: SpendObservationCostTargets;
  readonly nowMs: number;
}

async function reprice(
  context: SettlementContext,
  fingerprintRef: string,
  inputTokens: number,
  outputTokens: number,
): Promise<{ readonly repriced_usd: number | null; readonly reason: string | null }> {
  let fingerprint: Awaited<ReturnType<typeof readD1ModelGatewayFingerprint>>;
  try {
    fingerprint = await readD1ModelGatewayFingerprint(context.database, fingerprintRef);
  } catch {
    return { repriced_usd: null, reason: "READBACK_CORRUPT" };
  }
  if (fingerprint === null) {
    // The route fingerprint was never observed: repricing cannot be
    // assembled and is never fabricated.
    return { repriced_usd: null, reason: "FINGERPRINT_INCOMPLETE" };
  }
  const pricing = context.pricing ?? createD1ResearchModelPricingQuotePort(context.database, { now: () => context.nowMs });
  try {
    const quoted: unknown = await pricing.quote({
      fingerprint,
      pricing_snapshot_ref: context.pricingSnapshotRef,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    });
    // The port type is Promise<unknown>: never trust the shape, validate it.
    if (typeof quoted !== "object" || quoted === null || Array.isArray(quoted)) {
      return { repriced_usd: null, reason: "REPRICING_FAILED" };
    }
    const billed = (quoted as { readonly billed_usd?: unknown }).billed_usd;
    if (typeof billed !== "number" || !Number.isFinite(billed) || billed < 0) {
      return { repriced_usd: null, reason: "REPRICING_FAILED" };
    }
    return { repriced_usd: billed, reason: null };
  } catch (cause) {
    return { repriced_usd: null, reason: classifyPricingFailure(cause) };
  }
}

/**
 * Observes the settlement of one spend admission. The receipt digest is
 * verified against the stored canonical receipt bytes exactly as the
 * settlement writer bound them: sha256 over the full stored receipt_json
 * string, never over a re-canonicalized field subset.
 */
export async function observeOperationSettlement(
  admission: AdmissionRow,
  attempts: readonly AttemptRow[],
  context: SettlementContext,
): Promise<OperationSpendObservation> {
  const quoted = parseQuote(admission.quote_json);
  const mutableCounts = { total: attempts.length, started: 0, succeeded: 0, failed: 0, cancelled: 0 };
  for (const attempt of attempts) {
    if (attempt.state === "STARTED") mutableCounts.started += 1;
    else if (attempt.state === "SUCCEEDED") mutableCounts.succeeded += 1;
    else if (attempt.state === "FAILED") mutableCounts.failed += 1;
    else mutableCounts.cancelled += 1;
  }
  const counts: AttemptSettlementCounts = Object.freeze(mutableCounts);
  const reasons: string[] = [];
  let verdict: SpendObservationVerdict = "PASS";
  const failWith = (reason: string): void => {
    verdict = "FAIL";
    reasons.push(reason);
  };
  const blockWith = (reason: string): void => {
    if (verdict === "PASS") verdict = "BLOCKED";
    reasons.push(reason);
  };

  let settlement: SpendSettlement = "NO_ATTEMPT";
  let actualUsd: number | null = null;
  let repricedUsd: number | null = null;
  let repricing: RepricingStatus = { status: "NOT_APPLICABLE" };

  if (attempts.length === 0) {
    blockWith("NO_ATTEMPT");
  } else if (counts.started > 0) {
    settlement = "UNSETTLED";
    // A STARTED attempt has an unknown provider outcome: the operation
    // cannot pass a cost observation.
    failWith("UNSETTLED_ATTEMPT");
  } else {
    settlement = "SETTLED";
    let actual = 0;
    let repriced = 0;
    let repriceOk = counts.succeeded > 0;
    for (const attempt of attempts) {
      if (attempt.state !== "SUCCEEDED") continue;
      if (attempt.receipt_json === null || attempt.receipt_sha256 === null) {
        failWith("READBACK_CORRUPT");
        continue;
      }
      const receipt = parseReceipt(attempt);
      if (receipt === null) {
        failWith("READBACK_CORRUPT");
        continue;
      }
      const recomputed = await modelGatewaySha256(attempt.receipt_json);
      if (recomputed !== attempt.receipt_sha256) {
        failWith("READBACK_CORRUPT");
        continue;
      }
      actual = spendRoundUsd(actual + receipt.billed_usd);
      const repricedAttempt = await reprice(context, receipt.route_fingerprint_ref, receipt.input_tokens, receipt.output_tokens);
      if (repricedAttempt.repriced_usd === null) {
        repriceOk = false;
        if (repricedAttempt.reason === "READBACK_CORRUPT") failWith("READBACK_CORRUPT");
        else blockWith(repricedAttempt.reason ?? "REPRICING_FAILED");
      } else {
        repriced = spendRoundUsd(repriced + repricedAttempt.repriced_usd);
      }
    }
    actualUsd = actual;
    if (counts.succeeded === 0) {
      repricing = { status: "NOT_APPLICABLE", reason: "NO_SUCCEEDED_ATTEMPT" };
    } else if (repriceOk) {
      repricedUsd = repriced;
      repricing = { status: "AVAILABLE" };
    } else {
      const lastReason = reasons[reasons.length - 1];
      repricing = lastReason === undefined
        ? { status: "UNAVAILABLE" }
        : { status: "UNAVAILABLE", reason: lastReason };
    }
    if (actualUsd > quoted.max_total_usd) failWith("QUOTED_ACTUAL_BREACH");
    if (actualUsd > context.costTargets.max_usd_per_operation) failWith("PER_OPERATION_TARGET_EXCEEDED");
  }

  return Object.freeze({
    authorization_ref: admission.authorization_ref,
    operation_id: admission.operation_id,
    workflow_operation_id: admission.workflow_operation_id,
    stage_index: admission.stage_index,
    operation_kind: attempts[0]?.operation_kind ?? quoted.operation_kind,
    reservation_id: admission.reservation_id,
    principal_ref: admission.principal_ref,
    quoted,
    settlement,
    attempts: Object.freeze(counts),
    actual_usd: actualUsd,
    byok_usd: quoted.byok_usd,
    repriced_usd: repricedUsd,
    repricing: Object.freeze(repricing),
    verdict,
    reasons: Object.freeze(reasons),
  });
}
