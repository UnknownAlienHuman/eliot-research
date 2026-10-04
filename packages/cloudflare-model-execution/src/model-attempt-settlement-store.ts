import {
  OperationAttemptSchema,
  VersionedRefSchema,
  type OperationReceipt,
} from "@eliotr/contracts";
import type { ModelCallReceipt } from "@eliotr/research";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import { z } from "zod";
import {
  ModelAttemptError,
  type ModelAttemptReadback,
  type ModelAttemptStore,
  type ModelOutputBinding,
} from "./model-attempt-types.js";
import {
  IDENTIFIER,
  boundedJson,
  canonicalStoredJson,
  digest,
  fail,
  nonNegativeInteger,
  operationIntent,
  parseAuthority,
  parseModelReceipt,
  sha,
  text,
  type AttemptRow,
} from "./model-attempt-store-common.js";
import {
  assertTerminalReplay,
  operationReceiptJson,
  parseOperationReceipt,
  parseStringArray,
  parseWorkflowBudgetReceipt,
} from "./model-attempt-readback.js";
export function createModelAttemptSettlementStore(
  database: D1Database,
  now: () => string,
): Pick<ModelAttemptStore, "settleAttempt" | "readByAttempt" | "readByIdempotency" | "reconcileAttempt"> {
  async function readbackFromRow(row: AttemptRow): Promise<ModelAttemptReadback> {
    const attempt = OperationAttemptSchema.parse({
      attempt_id: row.attempt_id,
      intent_ref: { id: row.intent_id, revision: row.intent_revision },
      attempt_number: row.attempt_number,
      state: row.operation_attempt_state,
      ...(row.checkpoint_ref === null ? {} : { checkpoint_ref: row.checkpoint_ref }),
      ...(row.operation_attempt_error_code === null ? {} : { error_code: row.operation_attempt_error_code }),
      started_at: row.started_at,
      ...(row.ended_at === null ? {} : { ended_at: row.ended_at }),
    });
    const state = row.attempt_state as string;
    if (!["STARTED", "SUCCEEDED", "FAILED", "CANCELLED"].includes(state)) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "stored model attempt state is invalid");
    const requestJson = canonicalStoredJson(row.attempt_request_json, "model attempt request");
    const budgetRequestJson = canonicalStoredJson(row.request_json, "budget reservation request");
    if (requestJson !== budgetRequestJson || row.request_sha256 !== row.attempt_request_sha256) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model request binding is inconsistent");
    const workflowBudgetReceipt = parseWorkflowBudgetReceipt(requestJson);
    const budgetAuthorityJson = canonicalStoredJson(row.authority_json, "budget reservation authority");
    const attemptAuthorityJson = canonicalStoredJson(row.attempt_authority_json, "model attempt authority");
    if (budgetAuthorityJson !== attemptAuthorityJson) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model authority binding is inconsistent");
    const authority = parseAuthority(attemptAuthorityJson);
    if (row.workflow_budget_receipt_ref !== workflowBudgetReceipt || row.workflow_principal_ref !== authority.principal_ref ||
        row.workflow_credential_generation !== authority.credential_generation || row.workflow_deployment_generation !== authority.deployment_generation) {
      fail("MODEL_ATTEMPT_READBACK_CORRUPT", "workflow budget grant binding is inconsistent");
    }
    if (text(row.attempt_stage_attempt_ref, "stage_attempt_ref") !== text(row.stage_attempt_ref, "stage_attempt_ref") || sha(row.attempt_stage_request_sha256, "stage_request_sha256") !== sha(row.stage_request_sha256, "stage_request_sha256")) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "workflow stage binding is inconsistent");
    let artifactCowBinding: ModelAttemptReadback["artifact_cow_binding"];
    if (row.workflow_binding_kind === "ARTIFACT_SECTION_REVISE") {
      let parsedRequest: unknown;
      try { parsedRequest = JSON.parse(requestJson) as unknown; }
      catch (cause) { fail("MODEL_ATTEMPT_READBACK_CORRUPT", "COW model request is malformed", false, cause); }
      const rawBinding = parsedRequest !== null && typeof parsedRequest === "object" && !Array.isArray(parsedRequest)
        ? (parsedRequest as Record<string, unknown>).artifact_cow_binding : undefined;
      const binding = z.object({
        protocol: z.literal("eliotr.artifact.section.revise.v1"),
        call_slot: z.enum(["SYNTHESIZE", "INDEPENDENT_VERIFY"]),
        operation_id: z.string().regex(IDENTIFIER),
        attempt_ref: z.string().regex(IDENTIFIER),
        scope_snapshot_ref: VersionedRefSchema,
        policy_authority_ref: z.string().regex(IDENTIFIER),
        authorization_receipt_ref: z.string().regex(IDENTIFIER),
        purge_revision: z.number().int().nonnegative(),
      }).strict().safeParse(rawBinding);
      if (!binding.success || binding.data.operation_id !== row.cow_operation_id || binding.data.attempt_ref !== row.stage_attempt_ref ||
          row.model_workflow_binding_kind !== "ARTIFACT_SECTION_REVISE" || row.model_cow_operation_id !== row.cow_operation_id ||
          binding.data.scope_snapshot_ref.id !== authority.scope_snapshot_ref.id || binding.data.scope_snapshot_ref.revision !== authority.scope_snapshot_ref.revision ||
          binding.data.purge_revision < 0 || row.cow_call_slot !== binding.data.call_slot) {
        fail("MODEL_ATTEMPT_READBACK_CORRUPT", "COW model request does not match its persisted W2 locator");
      }
      artifactCowBinding = Object.freeze(binding.data);
    } else if (row.workflow_binding_kind !== "RESEARCH_STAGE" || row.cow_operation_id !== null) {
      fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model attempt has an unsupported W2 binding kind");
    }
    const receipt = parseModelReceipt(row.receipt_json);
    if ((receipt === null) !== (row.receipt_sha256 === null)) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model receipt and digest binding disagree");
    if (receipt !== null) {
      const receiptDigest = await digest(canonicalJson(receipt));
      if (receiptDigest !== row.receipt_sha256) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model receipt digest does not match persisted binding");
    }
    const operation_receipt = parseOperationReceipt(operationReceiptJson(row));
    if (state !== "STARTED" && operation_receipt === null) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "terminal model operation receipt is missing");
    if ((state === "SUCCEEDED") !== (receipt !== null && operation_receipt !== null)) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "terminal model receipt is incomplete");
    if (state !== "SUCCEEDED" && receipt !== null) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "non-success model attempt has a receipt");
    if (operation_receipt !== null && (operation_receipt.attempt_id !== row.attempt_id || operation_receipt.intent_ref.id !== row.intent_id || operation_receipt.intent_ref.revision !== row.intent_revision || operation_receipt.outcome !== (state === "SUCCEEDED" ? "SUCCEEDED" : state))) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "operation receipt identity or outcome is inconsistent");
    const output = row.output_object_ref === null ? null : {
      output_object_ref: text(row.output_object_ref, "output_object_ref"),
      output_sha256: sha(row.output_sha256, "output_sha256"),
      output_size_bytes: nonNegativeInteger(row.output_size_bytes, "output_size_bytes"),
      readback_sha256: sha(row.readback_sha256, "readback_sha256"),
    } satisfies ModelOutputBinding;
    if ((state === "SUCCEEDED") !== (output !== null)) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model output binding is incomplete");
    if (operation_receipt !== null) {
      const expectedOutputRefs = output === null ? [] : [output.output_object_ref];
      const expectedReadbackRefs = receipt === null ? [] : [receipt.receipt_ref];
      if (canonicalJson(operation_receipt.output_refs) !== canonicalJson(expectedOutputRefs) || canonicalJson(operation_receipt.readback_receipt_refs) !== canonicalJson(expectedReadbackRefs) || canonicalJson(operation_receipt.reason_codes) !== canonicalJson(parseStringArray(row.reason_codes_json, "reason_codes"))) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "operation receipt output or reason bindings are inconsistent");
    }
    if (row.operation_attempt_state !== state) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model and operation attempt states disagree");
    const readState = state === "STARTED" ? "UNKNOWN" : state as "SUCCEEDED" | "FAILED" | "CANCELLED";
    return Object.freeze({
      attempt_id: attempt.attempt_id,
      intent: operationIntent(row),
      attempt,
      state: readState,
      persisted_state: attempt.state,
      request_sha256: sha(row.request_sha256, "request_sha256"),
      stage_attempt_ref: text(row.stage_attempt_ref, "stage_attempt_ref"),
      stage_request_sha256: sha(row.stage_request_sha256, "stage_request_sha256"),
      authority,
      receipt,
      operation_receipt,
      output,
      workflow_budget_receipt_ref: workflowBudgetReceipt,
      ...(artifactCowBinding === undefined ? {} : { artifact_cow_binding: artifactCowBinding }),
      ...(row.error_code === null ? {} : { error_code: text(row.error_code, "error_code") }),
      reason_codes: Object.freeze(parseStringArray(row.reason_codes_json, "reason_codes")),
    });
  }

  function attemptSelect(): string {
    return "SELECT m.attempt_id, m.intent_id, m.intent_revision, m.reservation_id, m.attempt_number, m.principal_ref, m.operation_kind, m.idempotency_key, m.request_sha256 AS attempt_request_sha256, m.request_json AS attempt_request_json, m.authority_json AS attempt_authority_json, m.route_ref, m.prompt_generation, m.schema_generation, m.credential_generation AS attempt_credential_generation, m.deployment_generation AS attempt_deployment_generation, m.stage_attempt_ref AS attempt_stage_attempt_ref, m.stage_request_sha256 AS attempt_stage_request_sha256, m.workflow_binding_kind AS model_workflow_binding_kind, m.cow_operation_id AS model_cow_operation_id, csa.call_slot AS cow_call_slot, m.state AS attempt_state, m.receipt_json, m.receipt_sha256, m.output_object_ref, m.output_sha256, m.output_size_bytes, m.readback_sha256, m.error_code, m.reason_codes_json, m.started_at, m.ended_at, " +
      "a.state AS operation_attempt_state, a.checkpoint_ref, a.error_code AS operation_attempt_error_code, " +
      "i.revision, i.operation_kind, i.principal_ref, i.idempotency_key, i.payload_ref, i.policy_decision_ref, i.budget_reservation_ref, i.cancellation_ref, i.created_at AS intent_created_at, " +
      "o.receipt_id AS operation_receipt_id, o.revision AS operation_receipt_revision, o.outcome AS operation_receipt_outcome, o.reconciliation_required AS operation_reconciliation_required, o.output_refs_json AS operation_output_refs_json, o.readback_receipt_refs_json AS operation_readback_receipt_refs_json, o.reason_codes_json AS operation_reasons_json, o.created_at AS operation_receipt_created_at, " +
      "b.project_id, b.platform_usd, b.workers_ai_usd, b.byok_usd, b.max_total_usd, b.workflow_steps, b.state AS state, b.state AS budget_state, b.expires_at, b.created_at AS created_at, b.created_at AS budget_created_at, b.expected_sources, b.expected_sections, b.confidence, b.quote_ref, b.quote_json, b.authority_json, b.stage_attempt_ref, b.stage_request_sha256, b.request_sha256, b.request_json, b.workflow_binding_kind, b.cow_operation_id, COALESCE(w.budget_receipt_ref,ca.budget_receipt_ref) AS workflow_budget_receipt_ref, COALESCE(r.principal_ref,cr.principal_ref) AS workflow_principal_ref, COALESCE(r.credential_generation,cr.credential_generation) AS workflow_credential_generation, COALESCE(r.deployment_generation,cr.deployment_generation) AS workflow_deployment_generation " +
      "FROM research_model_attempt m JOIN operation_attempt a ON a.attempt_id = m.attempt_id " +
      "JOIN operation_intent i ON i.intent_id = m.intent_id AND i.revision = m.intent_revision " +
      "JOIN budget_reservation b ON b.reservation_id = m.reservation_id " +
      "LEFT JOIN research_workflow_attempt w ON b.workflow_binding_kind='RESEARCH_STAGE' AND w.attempt_ref = b.stage_attempt_ref AND w.request_sha256 = b.stage_request_sha256 " +
      "LEFT JOIN research_workflow_run r ON b.workflow_binding_kind='RESEARCH_STAGE' AND r.operation_id = w.operation_id " +
      "LEFT JOIN artifact_section_revise_attempt ca ON b.workflow_binding_kind='ARTIFACT_SECTION_REVISE' AND ca.operation_id=b.cow_operation_id AND ca.attempt_ref=b.stage_attempt_ref AND ca.request_sha256=b.stage_request_sha256 " +
      "LEFT JOIN artifact_section_revise_run cr ON b.workflow_binding_kind='ARTIFACT_SECTION_REVISE' AND cr.operation_id=ca.operation_id " +
      "LEFT JOIN artifact_section_revise_spend_admission csa ON b.workflow_binding_kind='ARTIFACT_SECTION_REVISE' AND csa.workflow_operation_id=b.cow_operation_id AND csa.stage_attempt_ref=b.stage_attempt_ref AND csa.stage_request_sha256=b.stage_request_sha256 AND csa.reservation_id=b.reservation_id AND csa.intent_id=m.intent_id AND csa.intent_revision=m.intent_revision " +
      "LEFT JOIN operation_receipt o ON o.attempt_id = m.attempt_id AND o.intent_id = m.intent_id AND o.intent_revision = m.intent_revision ";
  }
  const settlement: Pick<ModelAttemptStore, "settleAttempt" | "readByAttempt" | "readByIdempotency" | "reconcileAttempt"> = {
    async settleAttempt(input): Promise<ModelAttemptReadback> {
      const current = await settlement.readByAttempt(input.attempt_id);
      if (current === null) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model attempt does not exist");
      if (current.state !== "UNKNOWN") {
        assertTerminalReplay(input, current);
        return current;
      }
      const endedAt = now();
      const state = input.state;
      let receipt: ModelCallReceipt | null = null;
      let output: ModelOutputBinding | null = null;
      let errorCode: string | null = null;
      let reasons: readonly string[] = [];
      if (state === "SUCCEEDED") {
        receipt = input.receipt;
        output = input.output;
        if (receipt.output_object_ref !== output.output_object_ref || receipt.output_sha256 !== output.output_sha256 || output.readback_sha256 !== output.output_sha256) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model receipt and exact output readback do not match");
        sha(receipt.output_sha256, "receipt.output_sha256");
        nonNegativeInteger(output.output_size_bytes, "output.output_size_bytes");
      } else {
        errorCode = text(input.error_code, "error_code");
        reasons = Object.freeze([...(input.reason_codes ?? []), errorCode]);
        reasons.forEach((reason) => text(reason, "reason_code"));
      }
      const receiptJson = receipt === null ? null : boundedJson(receipt, "model receipt");
      const receiptSha = receiptJson === null ? null : await digest(receiptJson);
      const operationReceipt: OperationReceipt = {
        receipt_ref: { id: `model-receipt-${current.request_sha256.slice(0, 48)}`, revision: 1 },
        intent_ref: current.intent.intent_ref,
        attempt_id: current.attempt_id,
        outcome: state === "SUCCEEDED" ? "SUCCEEDED" : state,
        output_refs: output === null ? [] : [output.output_object_ref],
        readback_receipt_refs: receipt === null ? [] : [receipt.receipt_ref],
        reconciliation_required: false,
        reason_codes: [...reasons],
        created_at: endedAt,
      };
      boundedJson(operationReceipt, "operation receipt");
      try {
        const results = await database.batch([
          database.prepare("UPDATE research_model_attempt SET state=?1,receipt_json=?2,receipt_sha256=?3,output_object_ref=?4,output_sha256=?5,output_size_bytes=?6,readback_sha256=?7,error_code=?8,reason_codes_json=?9,ended_at=?10 WHERE attempt_id=?11 AND state='STARTED'").bind(state, receiptJson, receiptSha, output?.output_object_ref ?? null, output?.output_sha256 ?? null, output?.output_size_bytes ?? null, output?.readback_sha256 ?? null, errorCode, canonicalJson(reasons), endedAt, input.attempt_id),
          database.prepare("UPDATE operation_attempt SET state=?1,error_code=?2,ended_at=?3 WHERE attempt_id=?4 AND state='STARTED'").bind(state, errorCode, endedAt, input.attempt_id),
          database.prepare("INSERT INTO operation_receipt(receipt_id,revision,intent_id,intent_revision,attempt_id,outcome,output_refs_json,readback_receipt_refs_json,reconciliation_required,reason_codes_json,created_at) VALUES (?1,1,?2,?3,?4,?5,?6,?7,0,?8,?9)").bind(operationReceipt.receipt_ref.id, current.intent.intent_ref.id, current.intent.intent_ref.revision, current.attempt_id, operationReceipt.outcome, JSON.stringify(operationReceipt.output_refs), JSON.stringify(operationReceipt.readback_receipt_refs), JSON.stringify(operationReceipt.reason_codes), endedAt),
          database.prepare("UPDATE budget_reservation SET state='SETTLED' WHERE reservation_id=?1 AND state IN ('RESERVED','EXPIRED')").bind(current.intent.budget_reservation_ref),
        ]);
        if (results.length !== 4 || results[0]?.meta?.changes !== 1 || results[1]?.meta?.changes !== 1 || results[2]?.meta?.changes !== 1 || results[3]?.meta?.changes !== 1) fail("MODEL_ATTEMPT_SETTLEMENT_UNCERTAIN", "model settlement batch did not commit its exact rows", true);
      } catch (error) {
        const raced = await settlement.readByAttempt(input.attempt_id);
        if (raced !== null && raced.state !== "UNKNOWN") {
          assertTerminalReplay(input, raced);
          return raced;
        }
        if (error instanceof ModelAttemptError) throw error;
        fail("MODEL_ATTEMPT_SETTLEMENT_UNCERTAIN", "model settlement outcome is uncertain", true, error);
      }
      const readback = await settlement.readByAttempt(input.attempt_id);
      if (readback === null || readback.state === "UNKNOWN") fail("MODEL_ATTEMPT_SETTLEMENT_UNCERTAIN", "model settlement readback is missing", true);
      return readback;
    },

    async readByAttempt(attempt_id): Promise<ModelAttemptReadback | null> {
      text(attempt_id, "attempt_id");
      const row = await database.prepare(attemptSelect() + "WHERE m.attempt_id = ?1 LIMIT 1").bind(attempt_id).first<AttemptRow>();
      if (row === null) return null;
      return readbackFromRow(row);
    },

    async readByIdempotency(input): Promise<ModelAttemptReadback | null> {
      text(input.principal_ref, "principal_ref");
      const row = await database.prepare(attemptSelect() + "WHERE m.principal_ref = ?1 AND m.operation_kind = ?2 AND m.idempotency_key = ?3 ORDER BY m.attempt_number DESC LIMIT 1").bind(input.principal_ref, input.operation_kind, input.idempotency_key).first<AttemptRow>();
      if (row === null) return null;
      return readbackFromRow(row);
    },

    async reconcileAttempt(attempt_id): Promise<ModelAttemptReadback | null> {
      return settlement.readByAttempt(attempt_id);
    }
  };
  return settlement;
}
