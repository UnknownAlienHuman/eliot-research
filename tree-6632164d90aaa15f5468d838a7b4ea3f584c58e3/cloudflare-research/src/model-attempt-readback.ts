import { OperationReceiptSchema, type OperationReceipt } from "@eliotr/contracts";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import type { AttemptRow } from "./model-attempt-store.js";
import { ModelAttemptError, type ModelAttemptReadback, type ModelAttemptSettlementInput } from "./model-attempt-types.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u;

function fail(message: string): never {
  throw new ModelAttemptError("MODEL_ATTEMPT_READBACK_CORRUPT", message);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail(`${label} is invalid`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${label} is invalid`);
  return value as number;
}

function parseStringArrayValue(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !IDENTIFIER.test(item))) fail(`${label} is invalid`);
  return [...value] as string[];
}

function parseStringArray(value: unknown, label: string): string[] {
  if (typeof value !== "string") fail(`${label} is missing`);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { fail(`${label} is not JSON`); }
  return parseStringArrayValue(parsed, label);
}

export function parseWorkflowBudgetReceipt(value: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { fail("model request is not JSON"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) fail("model request is not an object");
  return text((parsed as Record<string, unknown>).workflow_budget_receipt_ref, "workflow budget receipt");
}

function parseOperationReceipt(value: unknown): OperationReceipt | null {
  if (value === null) return null;
  if (typeof value !== "string") fail("operation receipt is invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { fail("operation receipt is not JSON"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) fail("operation receipt is not an object");
  const receipt = parsed as Record<string, unknown>;
  return OperationReceiptSchema.parse({
    ...receipt,
    output_refs: parseStringArrayValue(receipt.output_refs, "operation receipt output_refs"),
    readback_receipt_refs: parseStringArrayValue(receipt.readback_receipt_refs, "operation receipt readback_receipt_refs"),
    reason_codes: parseStringArrayValue(receipt.reason_codes, "operation receipt reason_codes"),
  });
}

export function operationReceiptJson(row: AttemptRow): string | null {
  if (row.operation_receipt_id === null) return null;
  if (typeof row.operation_output_refs_json !== "string" || typeof row.operation_readback_receipt_refs_json !== "string" || typeof row.operation_reasons_json !== "string") fail("operation receipt projection is malformed");
  const revision = nonNegativeInteger(row.operation_receipt_revision, "operation receipt revision");
  if (revision < 1 || (row.operation_reconciliation_required !== 0 && row.operation_reconciliation_required !== 1)) fail("operation receipt metadata is malformed");
  let output_refs: unknown;
  let readback_receipt_refs: unknown;
  let reason_codes: unknown;
  try {
    output_refs = JSON.parse(row.operation_output_refs_json);
    readback_receipt_refs = JSON.parse(row.operation_readback_receipt_refs_json);
    reason_codes = JSON.parse(row.operation_reasons_json);
  } catch { fail("operation receipt arrays are malformed"); }
  return canonicalJson({
    receipt_ref: { id: row.operation_receipt_id, revision },
    intent_ref: { id: row.intent_id, revision: row.intent_revision },
    attempt_id: row.attempt_id,
    outcome: row.operation_receipt_outcome,
    output_refs: parseStringArrayValue(output_refs, "operation receipt output_refs"),
    readback_receipt_refs: parseStringArrayValue(readback_receipt_refs, "operation receipt readback_receipt_refs"),
    reconciliation_required: row.operation_reconciliation_required === 1,
    reason_codes: parseStringArrayValue(reason_codes, "operation receipt reason_codes"),
    created_at: row.operation_receipt_created_at ?? row.ended_at ?? row.started_at,
  });
}

export function assertTerminalReplay(input: ModelAttemptSettlementInput, current: ModelAttemptReadback): void {
  if (input.state !== current.persisted_state) throw new ModelAttemptError("MODEL_ATTEMPT_CONFLICT", "terminal model attempt cannot be overwritten");
  if (input.state === "SUCCEEDED") {
    if (current.receipt === null || current.output === null || canonicalJson(current.receipt) !== canonicalJson(input.receipt) || canonicalJson(current.output) !== canonicalJson(input.output)) throw new ModelAttemptError("MODEL_ATTEMPT_CONFLICT", "terminal model result differs from persisted result");
    return;
  }
  const errorCode = text(input.error_code, "error_code");
  const reasons = [...(input.reason_codes ?? []), errorCode];
  reasons.forEach((reason) => text(reason, "reason_code"));
  if (current.error_code !== errorCode || canonicalJson(current.reason_codes) !== canonicalJson(reasons)) throw new ModelAttemptError("MODEL_ATTEMPT_CONFLICT", "terminal model failure differs from persisted failure");
}

export { parseStringArray, parseOperationReceipt };
