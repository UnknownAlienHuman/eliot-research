import {
  OperationReceiptSchema,
  type OperationReceipt,
} from "@eliotr/contracts";
import {
  assertProjectionIdentifier,
  assertProjectionInteger,
  assertProjectionSha256,
  canonicalProjectionJson,
  projectionDigest,
  projectionFail,
  projectionReceiptRef,
  stableProjectionId,
} from "./canonical.js";
import type {
  ProjectionExecutionProfile,
  ProjectionSettlement,
  ProjectionSourceContext,
  ProjectionTerminalReceipt,
  ProjectionWorkReceipt,
} from "./types.js";

export function validateProjectionWorkReceipt(receipt: ProjectionWorkReceipt): void {
  assertProjectionIdentifier(receipt.manifest_ref, "work manifest_ref");
  assertProjectionSha256(receipt.manifest_sha256, "work manifest_sha256");
  assertProjectionSha256(receipt.item_set_digest, "work item_set_digest");
  assertProjectionInteger(receipt.item_count, "work item_count", 1, 1024);
  if (receipt.item_receipts.length !== receipt.item_count) {
    projectionFail(
      "PROJECTION_INPUT_INVALID",
      "work receipt item count differs from item receipts",
    );
  }
  const seen = new Set<string>();
  for (const item of receipt.item_receipts) {
    const key = assertProjectionIdentifier(item.item_key, "work item_key");
    if (seen.has(key)) {
      projectionFail("PROJECTION_INPUT_INVALID", "work receipt contains duplicate item keys");
    }
    seen.add(key);
    assertProjectionIdentifier(item.object_ref, "work object_ref");
    assertProjectionSha256(item.readback_sha256, "work item readback_sha256");
    assertProjectionInteger(item.size_bytes, "work item size_bytes", 1, 256 * 1024);
    assertProjectionIdentifier(item.etag, "work item etag");
  }
}

function validateSettlement(
  settlement: ProjectionSettlement,
  profile: ProjectionExecutionProfile,
): void {
  if (settlement.outcome === "SUCCEEDED" && (
    settlement.work === undefined ||
    settlement.d1_search === undefined ||
    settlement.managed?.state !== "READY"
  )) {
    projectionFail(
      "PROJECTION_INPUT_INVALID",
      "successful projection settlement requires Work, D1 Search, and managed-index receipts",
    );
  }
  if (settlement.work !== undefined) validateProjectionWorkReceipt(settlement.work);
  if (settlement.work !== undefined && settlement.d1_search !== undefined && (
    settlement.work.item_count !== settlement.d1_search.item_count ||
    settlement.work.item_set_digest !== settlement.d1_search.item_set_digest
  )) {
    projectionFail("PROJECTION_INPUT_INVALID", "projection Work and D1 Search receipts disagree");
  }
  if (settlement.managed !== undefined) {
    if (
      settlement.managed.instance_id !== profile.managed_instance_id ||
      settlement.managed.managed_generation !== profile.managed_generation ||
      (settlement.work !== undefined &&
        settlement.managed.item_count !== settlement.work.item_count)
    ) {
      projectionFail("PROJECTION_INPUT_INVALID", "managed receipt differs from profile or Work");
    }
  }
  if (settlement.outcome === "PARTIAL" && settlement.reason_codes.length === 0) {
    projectionFail("PROJECTION_INPUT_INVALID", "partial settlement requires a reason code");
  }
}

function settlementRefs(
  context: ProjectionSourceContext,
  generation: string,
  settlement: ProjectionSettlement,
): {
  readonly output_refs: readonly string[];
  readonly readback_refs: readonly string[];
} {
  const output = [context.job_id, `projection-generation:${generation}`];
  const readback: string[] = [];
  if (settlement.work !== undefined) {
    output.push(settlement.work.manifest_ref);
    readback.push(settlement.work.manifest_ref);
  }
  if (settlement.d1_search !== undefined) {
    output.push(settlement.d1_search.receipt_ref);
    readback.push(settlement.d1_search.receipt_ref);
  }
  if (settlement.managed?.state === "READY") {
    output.push(settlement.managed.receipt_ref);
    readback.push(settlement.managed.receipt_ref);
  }
  return { output_refs: output, readback_refs: readback };
}

interface ReadinessValue {
  readonly state: "ready" | "degraded";
  readonly generation: string | null;
  readonly receipt: string | null;
  readonly reasons: readonly string[];
}

function readinessState(
  settlement: ProjectionSettlement,
  channel: "exact_ready" | "lexical_ready" | "semantic_ready",
): ReadinessValue {
  if (channel === "semantic_ready") {
    if (settlement.managed?.state === "READY") {
      return {
        state: "ready",
        generation: settlement.managed.managed_generation,
        receipt: settlement.managed.receipt_ref,
        reasons: [],
      };
    }
    return {
      state: "degraded",
      generation: settlement.managed?.managed_generation ?? null,
      receipt: null,
      reasons: settlement.reason_codes,
    };
  }
  if (settlement.d1_search !== undefined) {
    return {
      state: "ready",
      generation: settlement.d1_search.projection_generation,
      receipt: settlement.d1_search.receipt_ref,
      reasons: [],
    };
  }
  return {
    state: "degraded",
    generation: null,
    receipt: null,
    reasons: settlement.reason_codes,
  };
}

export interface SettleProjectionInput {
  readonly database: D1Database;
  readonly context: ProjectionSourceContext;
  readonly projection_generation: string;
  readonly profile: ProjectionExecutionProfile;
  readonly settlement: ProjectionSettlement;
  readonly now: string;
  readonly read_terminal: () => Promise<ProjectionTerminalReceipt | null>;
}

export async function settleProjection(
  input: SettleProjectionInput,
): Promise<ProjectionTerminalReceipt> {
  const existing = await input.read_terminal();
  if (existing !== null) return existing;
  validateSettlement(input.settlement, input.profile);
  const reasonCodes = [...new Set(input.settlement.reason_codes)].sort();
  const refs = settlementRefs(
    input.context,
    input.projection_generation,
    input.settlement,
  );
  const receiptId = await stableProjectionId(
    "receipt-projection-terminal",
    input.context.intent_ref.id,
    String(input.context.intent_ref.revision),
    input.projection_generation,
    input.settlement.outcome,
    await projectionDigest({
      reason_codes: reasonCodes,
      output_refs: refs.output_refs,
      readback_refs: refs.readback_refs,
    }),
  );
  const receipt: OperationReceipt = OperationReceiptSchema.parse({
    receipt_ref: { id: receiptId, revision: 1 },
    intent_ref: input.context.intent_ref,
    attempt_id: input.context.acceptance_attempt_id,
    outcome: input.settlement.outcome,
    output_refs: refs.output_refs,
    readback_receipt_refs: refs.readback_refs,
    reconciliation_required: input.settlement.outcome === "PARTIAL",
    reason_codes: reasonCodes,
    created_at: input.now,
  });
  const terminalRef = projectionReceiptRef(receiptId);
  const terminalState = input.settlement.outcome === "SUCCEEDED" ? "COMPLETED" : "PARTIAL";
  const exact = readinessState(input.settlement, "exact_ready");
  const lexical = readinessState(input.settlement, "lexical_ready");
  const semantic = readinessState(input.settlement, "semantic_ready");
  const readiness = [
    ["exact_ready", exact],
    ["lexical_ready", lexical],
    ["semantic_ready", semantic],
  ] as const;

  await input.database.batch([
    input.database.prepare(
      "UPDATE projection_generation SET state=?3,d1_search_receipt_ref=?4," +
      "d1_search_readback_digest=?5,semantic_instance_id=?6,semantic_generation=?7," +
      "semantic_receipt_ref=?8,semantic_readback_digest=?9,reason_codes_json=?10," +
      "updated_at=?11 WHERE source_revision_ref=?1 AND projection_generation=?2 " +
      "AND state IN ('PREPARING','MATERIALIZED','D1_READY')",
    ).bind(
      input.context.source_revision.source_revision_ref,
      input.projection_generation,
      terminalState,
      input.settlement.d1_search?.receipt_ref ?? null,
      input.settlement.d1_search?.readback_digest ?? null,
      input.settlement.managed?.instance_id ?? null,
      input.settlement.managed?.managed_generation ?? null,
      input.settlement.managed?.state === "READY"
        ? input.settlement.managed.receipt_ref
        : null,
      input.settlement.managed?.state === "READY"
        ? input.settlement.managed.readback_digest
        : null,
      canonicalProjectionJson(reasonCodes),
      input.now,
    ),
    ...readiness.map(([channel, value]) => input.database.prepare(
      "INSERT INTO source_readiness(source_revision_ref,channel,state,generation," +
      "reason_codes_json,receipt_ref,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7) " +
      "ON CONFLICT(source_revision_ref,channel) DO UPDATE SET state=excluded.state," +
      "generation=excluded.generation,reason_codes_json=excluded.reason_codes_json," +
      "receipt_ref=excluded.receipt_ref,updated_at=excluded.updated_at",
    ).bind(
      input.context.source_revision.source_revision_ref,
      channel,
      value.state,
      value.generation,
      canonicalProjectionJson(value.reasons),
      value.receipt,
      input.now,
    )),
    input.database.prepare(
      "UPDATE operation_attempt SET state='SUCCEEDED',checkpoint_ref=?2,ended_at=?3 " +
      "WHERE attempt_id=?1 AND state IN ('STARTED','CHECKPOINTED','SUCCEEDED')",
    ).bind(
      input.context.acceptance_attempt_id,
      `projection-generation:${input.projection_generation}`,
      input.now,
    ),
    input.database.prepare(
      "INSERT INTO operation_receipt(receipt_id,revision,intent_id,intent_revision," +
      "attempt_id,outcome,output_refs_json,readback_receipt_refs_json," +
      "reconciliation_required,reason_codes_json,created_at) " +
      "VALUES (?1,1,?2,?3,?4,?5,?6,?7,?8,?9,?10) " +
      "ON CONFLICT(receipt_id,revision) DO NOTHING",
    ).bind(
      receiptId,
      input.context.intent_ref.id,
      input.context.intent_ref.revision,
      input.context.acceptance_attempt_id,
      input.settlement.outcome,
      canonicalProjectionJson(receipt.output_refs),
      canonicalProjectionJson(receipt.readback_receipt_refs),
      receipt.reconciliation_required ? 1 : 0,
      canonicalProjectionJson(receipt.reason_codes),
      input.now,
    ),
    input.database.prepare(
      "UPDATE job SET state=?2,current_stage=?3,terminal_receipt_ref=?4,updated_at=?5 " +
      "WHERE job_id=?1 AND state IN ('ACCEPTED','RUNNING','PARTIAL')",
    ).bind(
      input.context.job_id,
      terminalState,
      input.settlement.outcome === "SUCCEEDED"
        ? "PROJECTION_COMPLETE"
        : "PROJECTION_PARTIAL",
      terminalRef,
      input.now,
    ),
    input.database.prepare(
      "INSERT INTO projection_terminal_guard(source_revision_ref,projection_generation," +
      "job_id,terminal_receipt_id,terminal_receipt_revision,outcome,verified,created_at) " +
      "SELECT ?1,?2,?3,?4,1,?5,CASE WHEN " +
      "EXISTS (SELECT 1 FROM projection_generation g WHERE g.source_revision_ref=?1 " +
      "AND g.projection_generation=?2 AND g.job_id=?3 AND g.state=?6 " +
      "AND g.source_owner_generation=?7 AND g.content_sha256=?8 " +
      "AND g.object_residency_key_digest=?9 AND g.projector_profile=?10) " +
      "AND EXISTS (SELECT 1 FROM job j WHERE j.job_id=?3 AND j.state=?6 " +
      "AND j.terminal_receipt_ref=?11) " +
      "AND EXISTS (SELECT 1 FROM operation_receipt r WHERE r.receipt_id=?4 " +
      "AND r.revision=1 AND r.intent_id=?12 AND r.intent_revision=?13 " +
      "AND r.attempt_id=?14 AND r.outcome=?5 AND r.output_refs_json=?15 " +
      "AND r.readback_receipt_refs_json=?16 AND r.reason_codes_json=?17) " +
      "AND EXISTS (SELECT 1 FROM source_readiness s WHERE s.source_revision_ref=?1 " +
      "AND s.channel='exact_ready' AND s.state=?18 AND s.generation IS ?19 " +
      "AND s.receipt_ref IS ?20) AND EXISTS (SELECT 1 FROM source_readiness s " +
      "WHERE s.source_revision_ref=?1 AND s.channel='lexical_ready' AND s.state=?21 " +
      "AND s.generation IS ?22 AND s.receipt_ref IS ?23) " +
      "AND EXISTS (SELECT 1 FROM source_readiness s WHERE s.source_revision_ref=?1 " +
      "AND s.channel='semantic_ready' AND s.state=?24 AND s.generation IS ?25 " +
      "AND s.receipt_ref IS ?26) THEN 1 ELSE NULL END,?27",
    ).bind(
      input.context.source_revision.source_revision_ref,
      input.projection_generation,
      input.context.job_id,
      receiptId,
      input.settlement.outcome,
      terminalState,
      input.context.source_revision.source_owner_generation,
      input.context.source_revision.content_sha256,
      input.context.source_revision.object_residency_key_digest,
      input.profile.projector_profile,
      terminalRef,
      input.context.intent_ref.id,
      input.context.intent_ref.revision,
      input.context.acceptance_attempt_id,
      canonicalProjectionJson(receipt.output_refs),
      canonicalProjectionJson(receipt.readback_receipt_refs),
      canonicalProjectionJson(receipt.reason_codes),
      exact.state,
      exact.generation,
      exact.receipt,
      lexical.state,
      lexical.generation,
      lexical.receipt,
      semantic.state,
      semantic.generation,
      semantic.receipt,
      input.now,
    ),
  ]);

  const terminal = await input.read_terminal();
  if (
    terminal === null ||
    canonicalProjectionJson(terminal.receipt) !== canonicalProjectionJson(receipt)
  ) {
    projectionFail(
      "PROJECTION_SETTLEMENT_UNCERTAIN",
      "projection terminal settlement readback is incomplete",
      true,
    );
  }
  return terminal;
}
