import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import {
  COMMAND_SQL,
  buildAppendCommand,
  type LedgerEvent,
  type LedgerHead,
} from "@eliotr/research";
import {
  fail,
  parseRequest,
  textDigest,
  WorkflowNativeStageReceiptSchema,
  WorkflowObjectSchema,
  type StageRequest,
  type WorkflowNativeStagePolicy,
  type WorkflowNativeStageReceipt,
  type WorkflowObject,
  type WorkflowPrincipal,
} from "./types.js";

export interface CommittedNativeStage {
  readonly request: StageRequest;
  readonly request_sha256: string;
  readonly receipt: WorkflowNativeStageReceipt;
}

export interface WorkflowNativeStageRun {
  readonly investigation_id: string;
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly deployment_generation: string;
  readonly policy_generation: string;
  readonly policy_authority_ref: string;
  readonly authorization_receipt_ref: string;
  readonly scope_snapshot_id: string;
  readonly scope_snapshot_revision: number;
  readonly purge_revision: number;
  readonly stage_effect_policy_generation: string | null;
}

export interface WorkflowNativeStagePersistenceOwner {
  readonly read_run: (operation_id: string) => Promise<WorkflowNativeStageRun | null>;
  readonly same_principal: (run: WorkflowNativeStageRun, principal: WorkflowPrincipal) => void;
  readonly current: (request: StageRequest, principal: WorkflowPrincipal) => Promise<void>;
  readonly assert_ready: (
    request: StageRequest,
    principal: WorkflowPrincipal,
    policy: WorkflowNativeStagePolicy,
  ) => Promise<boolean>;
  readonly head: (investigation_id: string) => Promise<LedgerHead>;
  readonly map_failure: (error: unknown) => never;
}

interface StoredNativeStageCompletionRow {
  readonly operation_id: string;
  readonly stage_index: number;
  readonly request_json: string;
  readonly request_sha256: string;
  readonly handler_generation: string;
  readonly effect_policy_generation: string;
  readonly effect_class: string;
  readonly authority_policy_generation: string;
  readonly policy_authority_ref: string;
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly deployment_generation: string;
  readonly scope_snapshot_id: string;
  readonly scope_snapshot_revision: number;
  readonly authorization_receipt_ref: string;
  readonly purge_revision: number;
  readonly expected_revision: number;
  readonly input_manifest_json: string;
  readonly output_manifest_json: string;
  readonly receipt_json: string;
  readonly receipt_sha256: string;
  readonly ledger_event_id: string;
  readonly event_id: string | null;
  readonly event_sequence: number | null;
  readonly event_kind: string | null;
  readonly event_payload_handle_ref: string | null;
  readonly event_payload_digest: string | null;
  readonly event_actor_ref: string | null;
  readonly event_verifier_ref: string | null;
  readonly intent_id: string | null;
  readonly intent_revision: number | null;
  readonly intent_operation_kind: string | null;
  readonly intent_principal_ref: string | null;
  readonly intent_idempotency_key: string | null;
  readonly intent_payload_ref: string | null;
  readonly intent_policy_decision_ref: string | null;
  readonly intent_budget_reservation_ref: string | null;
  readonly intent_cancellation_ref: string | null;
  readonly outbox_id: string | null;
  readonly outbox_topic: string | null;
  readonly outbox_payload_ref: string | null;
  readonly outbox_payload_sha256: string | null;
  readonly run_investigation_id: string | null;
  readonly run_stage_effect_policy_generation: string | null;
  readonly run_principal_ref: string | null;
  readonly run_credential_generation: string | null;
  readonly run_deployment_generation: string | null;
  readonly run_policy_generation: string | null;
  readonly run_policy_authority_ref: string | null;
  readonly run_scope_snapshot_id: string | null;
  readonly run_scope_snapshot_revision: number | null;
  readonly run_authorization_receipt_ref: string | null;
  readonly run_purge_revision: number | null;
  readonly run_handler_generation: string | null;
  readonly attempt_operation_id: string | null;
}

/** Private native persistence capability; W2 reservation/receipt readers stay owned by WorkflowCheckpointStore. */
export class WorkflowNativeStageCompletionPersistence {
  constructor(
    private readonly db: D1Database,
    private readonly owner: WorkflowNativeStagePersistenceOwner,
  ) {}

  async readCommittedNativeStage(
    operationId: string,
    stage: StageRequest["stage"],
  ): Promise<CommittedNativeStage | null> {
    const stageIndex = RESEARCH_WORKFLOW_STAGES.indexOf(stage);
    if (stageIndex < 1 || stageIndex > 4) return null;
    let row: StoredNativeStageCompletionRow | null;
    try {
      row = await this.db.prepare(`SELECT n.operation_id, n.stage_index, n.request_json, n.request_sha256,
          n.handler_generation, n.effect_policy_generation, n.effect_class, n.authority_policy_generation,
          n.policy_authority_ref, n.principal_ref, n.credential_generation, n.deployment_generation,
          n.scope_snapshot_id, n.scope_snapshot_revision, n.authorization_receipt_ref, n.purge_revision,
          n.expected_revision, n.input_manifest_json, n.output_manifest_json, n.receipt_json, n.receipt_sha256,
          n.ledger_event_id, e.event_id AS event_id, e.sequence AS event_sequence, e.kind AS event_kind,
          e.payload_handle_ref AS event_payload_handle_ref, e.payload_digest AS event_payload_digest,
          e.actor_ref AS event_actor_ref, e.verifier_ref AS event_verifier_ref,
          i.intent_id AS intent_id, i.revision AS intent_revision, i.operation_kind AS intent_operation_kind,
          i.principal_ref AS intent_principal_ref, i.idempotency_key AS intent_idempotency_key,
          i.payload_ref AS intent_payload_ref, i.policy_decision_ref AS intent_policy_decision_ref,
          i.budget_reservation_ref AS intent_budget_reservation_ref, i.cancellation_ref AS intent_cancellation_ref,
          o.outbox_id AS outbox_id, o.topic AS outbox_topic, o.payload_ref AS outbox_payload_ref,
          o.payload_sha256 AS outbox_payload_sha256, r.investigation_id AS run_investigation_id,
          r.stage_effect_policy_generation AS run_stage_effect_policy_generation,
          r.principal_ref AS run_principal_ref, r.credential_generation AS run_credential_generation,
          r.deployment_generation AS run_deployment_generation, r.policy_generation AS run_policy_generation,
          r.policy_authority_ref AS run_policy_authority_ref, r.scope_snapshot_id AS run_scope_snapshot_id,
          r.scope_snapshot_revision AS run_scope_snapshot_revision,
          r.authorization_receipt_ref AS run_authorization_receipt_ref, r.purge_revision AS run_purge_revision,
          r.handler_generation AS run_handler_generation, a.operation_id AS attempt_operation_id
        FROM research_workflow_native_stage_completion n
        LEFT JOIN investigation_ledger_event e ON e.event_id = n.ledger_event_id
        LEFT JOIN operation_intent i ON i.intent_id = 'wni:' || n.request_sha256 AND i.revision = 1
        LEFT JOIN outbox o ON o.outbox_id = 'wnc-outbox:' || n.request_sha256
        LEFT JOIN research_workflow_run r ON r.operation_id = n.operation_id
        LEFT JOIN research_workflow_attempt a ON a.operation_id = n.operation_id AND a.stage_index = n.stage_index
        WHERE n.operation_id = ?1 AND n.stage_index = ?2 LIMIT 1`)
        .bind(operationId, stageIndex).first<StoredNativeStageCompletionRow>();
    } catch {
      fail("WORKFLOW_STORAGE_UNAVAILABLE");
    }
    if (row === null) return null;

    let request: StageRequest;
    let receipt: WorkflowNativeStageReceipt;
    let output: WorkflowObject;
    try {
      request = parseRequest(JSON.parse(row.request_json));
      receipt = WorkflowNativeStageReceiptSchema.parse(JSON.parse(row.receipt_json));
      output = WorkflowObjectSchema.parse(JSON.parse(row.output_manifest_json));
    } catch {
      fail("WORKFLOW_OUTPUT_CORRUPT");
    }
    const requestJson = JSON.stringify(request);
    const requestSha = row.request_sha256;
    const authority = receipt.authority;
    if (row.operation_id !== operationId || row.stage_index !== stageIndex || request.operation_id !== operationId ||
        request.stage !== stage || RESEARCH_WORKFLOW_STAGES.indexOf(request.stage) !== stageIndex || requestJson !== row.request_json ||
        requestSha !== await textDigest(requestJson) || row.input_manifest_json !== JSON.stringify(request.input_manifest) ||
        JSON.stringify(output) !== row.output_manifest_json || receipt.request_sha256 !== requestSha ||
        receipt.receipt_ref !== `wnc:${requestSha}` || row.ledger_event_id !== receipt.receipt_ref ||
        receipt.operation_id !== operationId || receipt.stage !== stage || receipt.stage_index !== stageIndex ||
        receipt.handler_generation !== request.handler_generation || receipt.handler_generation !== row.handler_generation ||
        receipt.effect_policy_generation !== row.effect_policy_generation || receipt.effect_class !== row.effect_class ||
        receipt.expected_revision !== request.investigation_ref.revision || row.expected_revision !== receipt.expected_revision ||
        receipt.investigation_ref.id !== request.investigation_ref.id ||
        receipt.investigation_ref.revision !== receipt.expected_revision + 1 ||
        receipt.input_manifest_ref !== request.input_manifest.object_ref ||
        JSON.stringify(receipt.output_manifest) !== row.output_manifest_json || receipt.engine_state !== "CHECKPOINTED" ||
        row.run_investigation_id !== request.investigation_ref.id ||
        row.run_stage_effect_policy_generation !== receipt.effect_policy_generation ||
        row.run_handler_generation !== request.handler_generation ||
        authority.principal_ref !== row.principal_ref || authority.principal_ref !== row.run_principal_ref ||
        authority.credential_generation !== row.credential_generation || authority.credential_generation !== row.run_credential_generation ||
        authority.deployment_generation !== row.deployment_generation || authority.deployment_generation !== row.run_deployment_generation ||
        authority.policy_generation !== row.authority_policy_generation || authority.policy_generation !== row.run_policy_generation ||
        authority.policy_authority_ref !== row.policy_authority_ref || authority.policy_authority_ref !== row.run_policy_authority_ref ||
        authority.scope_snapshot_id !== row.scope_snapshot_id || authority.scope_snapshot_id !== row.run_scope_snapshot_id ||
        authority.scope_snapshot_revision !== row.scope_snapshot_revision || authority.scope_snapshot_revision !== row.run_scope_snapshot_revision ||
        authority.authorization_receipt_ref !== row.authorization_receipt_ref ||
        authority.authorization_receipt_ref !== row.run_authorization_receipt_ref ||
        authority.purge_revision !== row.purge_revision || authority.purge_revision !== row.run_purge_revision ||
        row.event_id !== receipt.receipt_ref || typeof row.event_sequence !== "number" ||
        !Number.isSafeInteger(row.event_sequence) || row.event_sequence < 1 ||
        row.event_kind !== "CHECKPOINT" || row.event_payload_handle_ref !== output.object_ref ||
        row.event_payload_digest !== output.sha256 || row.event_actor_ref !== authority.principal_ref || row.event_verifier_ref !== null ||
        row.intent_id !== `wni:${requestSha}` || row.intent_revision !== 1 ||
        row.intent_operation_kind !== "research.workflow.native-stage.intent.v1" ||
        row.intent_principal_ref !== authority.principal_ref || row.intent_idempotency_key !== requestSha ||
        row.intent_payload_ref !== output.object_ref || row.intent_policy_decision_ref !== authority.authorization_receipt_ref ||
        row.intent_budget_reservation_ref !== null || row.intent_cancellation_ref !== `workflow:${operationId}` ||
        row.outbox_id !== `wnc-outbox:${requestSha}` || row.outbox_topic !== "research.workflow.native-stage.v1" ||
        row.outbox_payload_ref !== receipt.receipt_ref || row.outbox_payload_sha256 !== await textDigest(row.receipt_json) ||
        row.attempt_operation_id !== null || await textDigest(row.receipt_json) !== row.receipt_sha256 ||
        JSON.stringify(receipt) !== row.receipt_json) {
      fail("WORKFLOW_OUTPUT_CORRUPT");
    }
    return Object.freeze({ request, request_sha256: requestSha, receipt });
  }

  async ensureNativeStageIntent(input: {
    readonly request: StageRequest;
    readonly principal: WorkflowPrincipal;
    readonly output: WorkflowObject;
    readonly request_sha256: string;
  }): Promise<void> {
    await this.owner.current(input.request, input.principal);
    const run = await this.owner.read_run(input.request.operation_id);
    if (run === null) fail("WORKFLOW_AUTHORITY_STALE");
    this.owner.same_principal(run, input.principal);
    const intentId = `wni:${input.request_sha256}`;
    const intent = {
      intent_id: intentId, revision: 1, operation_kind: "research.workflow.native-stage.intent.v1",
      principal_ref: run.principal_ref, idempotency_key: input.request_sha256,
      payload_ref: input.output.object_ref, policy_decision_ref: run.authorization_receipt_ref,
      budget_reservation_ref: null, cancellation_ref: `workflow:${input.request.operation_id}`,
    } as const;
    try {
      await this.db.prepare(`INSERT INTO operation_intent
        (intent_id, revision, operation_kind, principal_ref, idempotency_key, payload_ref,
         policy_decision_ref, budget_reservation_ref, cancellation_ref, created_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT DO NOTHING`)
        .bind(intent.intent_id, intent.revision, intent.operation_kind, intent.principal_ref,
          intent.idempotency_key, intent.payload_ref, intent.policy_decision_ref,
          intent.budget_reservation_ref, intent.cancellation_ref, new Date().toISOString()).run();
    } catch (error) {
      const row = await this.db.prepare(`SELECT intent_id, revision, operation_kind, principal_ref, idempotency_key,
          payload_ref, policy_decision_ref, budget_reservation_ref, cancellation_ref
        FROM operation_intent WHERE intent_id = ?1 AND revision = 1 LIMIT 1`)
        .bind(intentId).first<Record<keyof typeof intent, unknown>>().catch(() => null);
      if (row === null) this.owner.map_failure(error);
      this.assertIntent(row, intent);
      return;
    }
    const row = await this.db.prepare(`SELECT intent_id, revision, operation_kind, principal_ref, idempotency_key,
        payload_ref, policy_decision_ref, budget_reservation_ref, cancellation_ref
      FROM operation_intent WHERE intent_id = ?1 AND revision = 1 LIMIT 1`)
      .bind(intentId).first<Record<keyof typeof intent, unknown>>().catch(() => null);
    if (row === null) fail("WORKFLOW_STORAGE_UNAVAILABLE");
    this.assertIntent(row, intent);
  }

  private assertIntent(row: Record<string, unknown>, intent: {
    readonly intent_id: string;
    readonly revision: 1;
    readonly operation_kind: "research.workflow.native-stage.intent.v1";
    readonly principal_ref: string;
    readonly idempotency_key: string;
    readonly payload_ref: string;
    readonly policy_decision_ref: string;
    readonly budget_reservation_ref: null;
    readonly cancellation_ref: string;
  }): void {
    if (row.intent_id !== intent.intent_id || row.revision !== intent.revision ||
        row.operation_kind !== intent.operation_kind || row.principal_ref !== intent.principal_ref ||
        row.idempotency_key !== intent.idempotency_key || row.payload_ref !== intent.payload_ref ||
        row.policy_decision_ref !== intent.policy_decision_ref || row.budget_reservation_ref !== null ||
        row.cancellation_ref !== intent.cancellation_ref) fail("WORKFLOW_CONFLICT");
  }

  async commitNativeStage(input: {
    readonly request: StageRequest;
    readonly principal: WorkflowPrincipal;
    readonly policy: WorkflowNativeStagePolicy;
    readonly output: WorkflowObject;
  }): Promise<WorkflowNativeStageReceipt> {
    const request = parseRequest(input.request);
    const requestJson = JSON.stringify(request);
    const requestSha = await textDigest(requestJson);
    const existing = await this.readCommittedNativeStage(request.operation_id, request.stage);
    if (existing !== null) {
      if (existing.request_sha256 !== requestSha || JSON.stringify(existing.request) !== requestJson ||
          JSON.stringify(existing.receipt.output_manifest) !== JSON.stringify(input.output)) fail("WORKFLOW_CONFLICT");
      return existing.receipt;
    }
    if (!(await this.owner.assert_ready(request, input.principal, input.policy))) fail("WORKFLOW_CONFLICT");
    await this.owner.current(request, input.principal);
    const run = await this.owner.read_run(request.operation_id);
    const head = await this.owner.head(request.investigation_ref.id);
    if (run === null || head.revision !== request.investigation_ref.revision ||
        run.stage_effect_policy_generation !== input.policy.effect_policy_generation) fail("WORKFLOW_AUTHORITY_STALE");
    this.owner.same_principal(run, input.principal);
    const now = new Date().toISOString();
    const authority = {
      principal_ref: run.principal_ref, credential_generation: run.credential_generation,
      deployment_generation: run.deployment_generation, policy_generation: run.policy_generation,
      policy_authority_ref: run.policy_authority_ref, scope_snapshot_id: run.scope_snapshot_id,
      scope_snapshot_revision: run.scope_snapshot_revision, authorization_receipt_ref: run.authorization_receipt_ref,
      purge_revision: run.purge_revision,
    };
    const stageIndex = RESEARCH_WORKFLOW_STAGES.indexOf(request.stage);
    const receipt = WorkflowNativeStageReceiptSchema.parse({
      protocol: "eliotr.workflow-native-stage.v1", operation_id: request.operation_id, stage: request.stage,
      stage_index: stageIndex, request_sha256: requestSha, receipt_ref: `wnc:${requestSha}`,
      handler_generation: request.handler_generation, effect_policy_generation: input.policy.effect_policy_generation,
      effect_class: input.policy.effect_class, authority, expected_revision: request.investigation_ref.revision,
      investigation_ref: { id: head.investigation_id, revision: head.revision + 1 },
      input_manifest_ref: request.input_manifest.object_ref, output_manifest: input.output, engine_state: "CHECKPOINTED",
    });
    const receiptJson = JSON.stringify(receipt);
    if (new TextEncoder().encode(receiptJson).byteLength > 65_536) fail("WORKFLOW_INPUT_INVALID");
    const receiptSha = await textDigest(receiptJson);
    const next: LedgerHead = {
      ...head, revision: head.revision + 1, checkpoint_head: head.checkpoint_head + 1,
      event_head: head.event_head + 1, updated_at: now,
    };
    const event: LedgerEvent = {
      investigation_id: head.investigation_id, sequence: next.event_head, event_id: receipt.receipt_ref,
      kind: "CHECKPOINT", payload_handle_ref: input.output.object_ref, payload_digest: input.output.sha256,
      actor_ref: head.principal_ref, verifier_ref: null, created_at: now,
    };
    const epoch = await this.db.prepare(COMMAND_SQL.selectEpoch).first<{ generation: number }>();
    const purge = await this.db.prepare(`SELECT s.purge_ledger_revision AS scope_revision,
        COALESCE((SELECT MAX(ledger_revision) FROM purge_ledger),0) AS global_revision
      FROM scope_snapshot s WHERE s.snapshot_id = ?1 AND s.revision = ?2`)
      .bind(head.scope_snapshot_id, head.scope_snapshot_revision).first<{ scope_revision: number; global_revision: number }>();
    if (epoch === null || purge === null) fail("WORKFLOW_AUTHORITY_STALE");
    const command = buildAppendCommand(next, head.revision, event, {
      principal_ref: head.principal_ref, scope_snapshot_id: head.scope_snapshot_id,
      scope_snapshot_revision: head.scope_snapshot_revision, policy_generation: head.policy_generation,
      policy_authority_ref: head.policy_authority_ref, deployment_generation: head.deployment_generation,
      purge_revision: purge.global_revision, scope_purge_revision: purge.scope_revision,
    }, epoch.generation, now);
    await this.owner.current(request, input.principal);
    try {
      await this.db.batch([
        this.db.prepare(COMMAND_SQL.insertCommand).bind(...command.params),
        this.db.prepare(`INSERT INTO research_workflow_native_stage_completion
          (operation_id, stage_index, stage, request_json, request_sha256, handler_generation,
           effect_policy_generation, effect_class, authority_policy_generation, policy_authority_ref,
           principal_ref, credential_generation, deployment_generation, scope_snapshot_id,
           scope_snapshot_revision, authorization_receipt_ref, purge_revision, expected_revision,
           input_manifest_json, output_manifest_json, receipt_json, receipt_sha256, ledger_event_id, created_at)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)`)
          .bind(request.operation_id, stageIndex, request.stage, requestJson, requestSha, request.handler_generation,
            input.policy.effect_policy_generation, input.policy.effect_class, authority.policy_generation,
            authority.policy_authority_ref, authority.principal_ref, authority.credential_generation,
            authority.deployment_generation, authority.scope_snapshot_id, authority.scope_snapshot_revision,
            authority.authorization_receipt_ref, authority.purge_revision, request.investigation_ref.revision,
            JSON.stringify(request.input_manifest), JSON.stringify(input.output), receiptJson, receiptSha,
            receipt.receipt_ref, now),
      ]);
    } catch (error) {
      const reconciled = await this.readCommittedNativeStage(request.operation_id, request.stage);
      if (reconciled !== null) {
        if (reconciled.request_sha256 === requestSha && JSON.stringify(reconciled.receipt.output_manifest) === JSON.stringify(input.output)) {
          return reconciled.receipt;
        }
        fail("WORKFLOW_CONFLICT");
      }
      this.owner.map_failure(error);
    }
    const readback = await this.readCommittedNativeStage(request.operation_id, request.stage);
    if (readback === null || readback.request_sha256 !== requestSha ||
        JSON.stringify(readback.receipt.output_manifest) !== JSON.stringify(input.output)) fail("WORKFLOW_EFFECT_UNCERTAIN");
    return readback.receipt;
  }
}
