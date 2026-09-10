import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import {
  COMMAND_SQL, buildAppendCommand, decodeLedgerHead,
  type LedgerEvent, type LedgerHead, type LedgerHeadRow,
} from "@eliotr/research";
import {
  decodeReceipt, encodeReceipt, fail, parseRequest, textDigest, WorkflowCheckpointError,
  type StageReceipt, type StageRequest, type WorkflowBudgetGrant, type WorkflowObject, type WorkflowPrincipal,
} from "./types.js";

interface RunRow {
  operation_id: string; investigation_id: string; initial_revision: number; current_revision: number;
  principal_ref: string; credential_generation: string; deployment_generation: string;
  scope_snapshot_id: string; scope_snapshot_revision: number;
  idempotency_key: string; handler_generation: string; initial_manifest_json: string;
  next_stage_index: number; state: "ACTIVE" | "CANCELLED" | "ENGINE_COMPLETED";
  cancellation_receipt_ref: string | null; ledger_revision?: number;
}
export interface AttemptRow {
  operation_id: string; stage_index: number; request_json: string; request_sha256: string;
  attempt_ref: string; expected_revision: number; budget_receipt_ref: string; budget_expires_at_ms: number;
  state: "STARTED" | "OUTPUT_RECORDED" | "COMMITTED"; output_json: string | null;
}
export interface WorkflowRunStatus {
  readonly operation_id: string;
  readonly investigation_id: string;
  readonly initial_revision: number;
  readonly current_revision: number;
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly deployment_generation: string;
  readonly scope_snapshot_id: string;
  readonly scope_snapshot_revision: number;
  readonly next_stage_index: number;
  readonly state: RunRow["state"];
  readonly cancellation_receipt_ref: string | null;
  readonly current_attempt: Readonly<Pick<AttemptRow, "stage_index" | "attempt_ref" | "request_sha256" | "state">> | null;
  readonly final_receipt: StageReceipt | null;
}
export interface CommittedStageRequest {
  readonly request: StageRequest;
  readonly request_sha256: string;
  readonly attempt_ref: string;
}
interface StoredCommittedStageRequestRow {
  readonly operation_id: string;
  readonly stage_index: number;
  readonly request_json: string;
  readonly request_sha256: string;
  readonly attempt_ref: string;
  readonly state: string;
}
interface StoredCurrentRunRow {
  readonly operation_id: string;
  readonly state: RunRow["state"];
  readonly current_revision: number;
  readonly next_stage_index: number;
  readonly ledger_revision: number;
}
function mapFailure(error: unknown): never {
  if (error instanceof WorkflowCheckpointError) throw error;
  const message = error instanceof Error ? error.message : "";
  if (message.includes("WORKFLOW_STAGE_OUT_OF_ORDER")) fail("WORKFLOW_STAGE_OUT_OF_ORDER");
  if (/WORKFLOW_AUTHORITY_STALE|LEDGER_/.test(message)) fail("WORKFLOW_AUTHORITY_STALE");
  if (/WORKFLOW_CONFLICT|constraint|UNIQUE|CHECK/.test(message)) fail("WORKFLOW_CONFLICT");
  return fail("WORKFLOW_EFFECT_UNCERTAIN");
}
export function workflowStageIndex(request: StageRequest): number {
  return RESEARCH_WORKFLOW_STAGES.indexOf(request.stage);
}
export class WorkflowCheckpointStore {
  constructor(private readonly db: D1Database) {}

  async head(id: string): Promise<LedgerHead> {
    const row = await this.db.prepare("SELECT * FROM investigation_ledger_head WHERE investigation_id = ?1").bind(id).first<LedgerHeadRow>();
    if (row === null) fail("WORKFLOW_AUTHORITY_STALE");
    return decodeLedgerHead(row);
  }
  private async run(operation: string): Promise<RunRow | null> {
    return this.db.prepare("SELECT * FROM research_workflow_run WHERE operation_id = ?1").bind(operation).first<RunRow>();
  }
  private samePrincipal(run: RunRow, principal: WorkflowPrincipal): void {
    if (run.principal_ref !== principal.principal_ref || run.credential_generation !== principal.credential_generation ||
        run.deployment_generation !== principal.deployment_generation) fail("WORKFLOW_AUTHORITY_STALE");
  }
  /**
   * Read the owner-bound durable run state. This deliberately does not call
   * current(), because cancelled and engine-completed runs remain readable.
   */
  async readRunStatus(operationId: string, principal: WorkflowPrincipal): Promise<WorkflowRunStatus | null> {
    let run: RunRow | null;
    try {
      run = await this.db.prepare(
        "SELECT operation_id, investigation_id, initial_revision, current_revision, principal_ref, " +
        "credential_generation, deployment_generation, scope_snapshot_id, scope_snapshot_revision, " +
        "next_stage_index, state, cancellation_receipt_ref, handler_generation, idempotency_key, " +
        "policy_generation, policy_authority_ref, authorization_receipt_ref, purge_revision, initial_manifest_json " +
        "FROM research_workflow_run WHERE operation_id = ?1 AND principal_ref = ?2 LIMIT 1",
      ).bind(operationId, principal.principal_ref).first<RunRow>();
    } catch {
      fail("WORKFLOW_EFFECT_UNCERTAIN");
    }
    if (run === null) return null;
    const requiredStrings: readonly unknown[] = [run.operation_id, run.investigation_id, run.principal_ref,
      run.credential_generation, run.deployment_generation, run.scope_snapshot_id];
    if (requiredStrings.some((value) => typeof value !== "string" || value.length < 1 || value.length > 256) ||
        (run.state !== "ACTIVE" && run.state !== "CANCELLED" && run.state !== "ENGINE_COMPLETED") ||
        run.operation_id !== operationId || !Number.isSafeInteger(run.initial_revision) || run.initial_revision < 1 ||
        !Number.isSafeInteger(run.current_revision) || run.current_revision < run.initial_revision ||
        !Number.isSafeInteger(run.next_stage_index) || run.next_stage_index < 0 || run.next_stage_index > RESEARCH_WORKFLOW_STAGES.length ||
        !Number.isSafeInteger(run.scope_snapshot_revision) || run.scope_snapshot_revision < 1 ||
        run.current_revision !== run.initial_revision + run.next_stage_index ||
        (run.state === "CANCELLED") !== (run.cancellation_receipt_ref !== null) ||
        (run.state !== "CANCELLED" && run.cancellation_receipt_ref !== null) ||
        (run.cancellation_receipt_ref !== null && run.cancellation_receipt_ref !== `workflow-cancelled:${operationId}`)) {
      fail("WORKFLOW_OUTPUT_CORRUPT");
    }
    if (run.state === "ACTIVE" && run.next_stage_index === RESEARCH_WORKFLOW_STAGES.length) {
      fail("WORKFLOW_OUTPUT_CORRUPT");
    }
    if (run.credential_generation === principal.credential_generation &&
        run.deployment_generation === principal.deployment_generation) {
      let current: StoredCurrentRunRow | null;
      try {
        current = await this.db.prepare(
          "SELECT operation_id, state, current_revision, next_stage_index, ledger_revision " +
          "FROM research_workflow_current WHERE operation_id = ?1 LIMIT 1",
        ).bind(operationId).first<StoredCurrentRunRow>();
      } catch {
        fail("WORKFLOW_EFFECT_UNCERTAIN");
      }
      if (current === null) fail("WORKFLOW_AUTHORITY_STALE");
      if (current.operation_id !== operationId || current.state !== run.state ||
          current.current_revision !== run.current_revision || current.next_stage_index !== run.next_stage_index ||
          current.ledger_revision !== run.current_revision) fail("WORKFLOW_OUTPUT_CORRUPT");
    }
    let currentAttempt: AttemptRow | null = null;
    if (run.next_stage_index < RESEARCH_WORKFLOW_STAGES.length) {
      try {
        currentAttempt = await this.db.prepare(
          "SELECT operation_id, stage_index, request_json, request_sha256, attempt_ref, expected_revision, " +
          "budget_receipt_ref, budget_expires_at_ms, state, output_json, created_at " +
          "FROM research_workflow_attempt WHERE operation_id = ?1 AND stage_index = ?2 LIMIT 1",
        ).bind(operationId, run.next_stage_index).first<AttemptRow>();
      } catch {
        fail("WORKFLOW_EFFECT_UNCERTAIN");
      }
      if (currentAttempt !== null && (currentAttempt.operation_id !== operationId ||
          currentAttempt.stage_index !== run.next_stage_index || currentAttempt.expected_revision !== run.current_revision ||
          typeof currentAttempt.attempt_ref !== "string" || currentAttempt.attempt_ref.length < 1 ||
          typeof currentAttempt.request_sha256 !== "string" || currentAttempt.request_sha256.length !== 64 ||
          (currentAttempt.state !== "STARTED" && currentAttempt.state !== "OUTPUT_RECORDED") ||
          (currentAttempt.state === "STARTED") !== (currentAttempt.output_json === null) ||
          (currentAttempt.state !== "STARTED" && currentAttempt.output_json === null))) {
        fail("WORKFLOW_OUTPUT_CORRUPT");
      }
    }
    if (run.state === "ENGINE_COMPLETED") {
      if (run.next_stage_index !== RESEARCH_WORKFLOW_STAGES.length) fail("WORKFLOW_OUTPUT_CORRUPT");
      let committed: CommittedStageRequest | null;
      try {
        committed = await this.readCommittedStageRequest(operationId, "MATERIALIZE");
      } catch (error) {
        // The committed-stage helper predates this status reader and reports
        // its own D1 read failure as authority-stale. At this boundary that
        // is an unavailable read, while a missing row remains corruption.
        if (error instanceof WorkflowCheckpointError && error.code === "WORKFLOW_AUTHORITY_STALE") {
          fail("WORKFLOW_EFFECT_UNCERTAIN");
        }
        throw error;
      }
      if (committed === null) fail("WORKFLOW_OUTPUT_CORRUPT");
      let finalReceipt: StageReceipt | null;
      try { finalReceipt = await this.receipt(committed.request, committed.request_sha256); }
      catch (error) {
        if (error instanceof WorkflowCheckpointError) throw error;
        fail("WORKFLOW_EFFECT_UNCERTAIN");
      }
      if (finalReceipt === null || finalReceipt.engine_state !== "ENGINE_COMPLETED" ||
          finalReceipt.stage !== "MATERIALIZE" || finalReceipt.investigation_ref.revision !== run.current_revision ||
          finalReceipt.investigation_ref.id !== run.investigation_id) {
        fail("WORKFLOW_OUTPUT_CORRUPT");
      }
      return Object.freeze({
        operation_id: run.operation_id, investigation_id: run.investigation_id, initial_revision: run.initial_revision,
        current_revision: run.current_revision, principal_ref: run.principal_ref,
        credential_generation: run.credential_generation, deployment_generation: run.deployment_generation,
        scope_snapshot_id: run.scope_snapshot_id, scope_snapshot_revision: run.scope_snapshot_revision,
        next_stage_index: run.next_stage_index, state: run.state,
        cancellation_receipt_ref: run.cancellation_receipt_ref, current_attempt: null, final_receipt: finalReceipt,
      });
    }
    return Object.freeze({
      operation_id: run.operation_id, investigation_id: run.investigation_id, initial_revision: run.initial_revision,
      current_revision: run.current_revision, principal_ref: run.principal_ref,
      credential_generation: run.credential_generation, deployment_generation: run.deployment_generation,
      scope_snapshot_id: run.scope_snapshot_id, scope_snapshot_revision: run.scope_snapshot_revision,
      next_stage_index: run.next_stage_index, state: run.state,
      cancellation_receipt_ref: run.cancellation_receipt_ref,
      current_attempt: currentAttempt === null ? null : Object.freeze({
        stage_index: currentAttempt.stage_index, attempt_ref: currentAttempt.attempt_ref,
        request_sha256: currentAttempt.request_sha256, state: currentAttempt.state,
      }), final_receipt: null,
    });
  }
  /** Read one committed stage request with its immutable attempt binding and no effects. */
  async readCommittedStageRequest(
    operationId: string,
    stage: StageRequest["stage"],
  ): Promise<CommittedStageRequest | null> {
    const stageIndex = RESEARCH_WORKFLOW_STAGES.indexOf(stage);
    if (stageIndex < 0) fail("WORKFLOW_INPUT_INVALID");
    let row: StoredCommittedStageRequestRow | null;
    try {
      row = await this.db.prepare(
        "SELECT operation_id, stage_index, request_json, request_sha256, attempt_ref, state " +
        "FROM research_workflow_attempt WHERE operation_id = ?1 AND stage_index = ?2 LIMIT 1",
      ).bind(operationId, stageIndex).first<StoredCommittedStageRequestRow>();
    } catch {
      fail("WORKFLOW_AUTHORITY_STALE");
    }
    if (row === null || row.state !== "COMMITTED") return null;
    let request: StageRequest;
    try { request = parseRequest(JSON.parse(row.request_json)); }
    catch { fail("WORKFLOW_OUTPUT_CORRUPT"); }
    if (row.operation_id !== operationId || row.stage_index !== stageIndex ||
        request.operation_id !== operationId || request.stage !== stage ||
        workflowStageIndex(request) !== stageIndex || JSON.stringify(request) !== row.request_json ||
        row.request_sha256 !== await textDigest(row.request_json) ||
        typeof row.attempt_ref !== "string" || row.attempt_ref.length < 1 || row.attempt_ref.length > 256) {
      fail("WORKFLOW_OUTPUT_CORRUPT");
    }
    return Object.freeze({ request, request_sha256: row.request_sha256, attempt_ref: row.attempt_ref });
  }
  async current(request: StageRequest, principal: WorkflowPrincipal): Promise<void> {
    const run = await this.run(request.operation_id);
    if (run === null) fail("WORKFLOW_AUTHORITY_STALE");
    this.samePrincipal(run, principal);
    if (run.state === "CANCELLED") fail("WORKFLOW_CANCELLED");
    const current = await this.db.prepare("SELECT * FROM research_workflow_current WHERE operation_id = ?1")
      .bind(request.operation_id).first<RunRow>();
    if (current === null || current.ledger_revision !== current.current_revision) fail("WORKFLOW_AUTHORITY_STALE");
    if (current.state === "CANCELLED") fail("WORKFLOW_CANCELLED");
  }
  async ensureRun(request: StageRequest, principal: WorkflowPrincipal): Promise<void> {
    let run = await this.run(request.operation_id);
    if (run === null) {
      if (workflowStageIndex(request) !== 0) fail("WORKFLOW_STAGE_OUT_OF_ORDER");
      const head = await this.head(request.investigation_ref.id);
      if (head.principal_ref !== principal.principal_ref || head.deployment_generation !== principal.deployment_generation ||
          head.revision !== request.investigation_ref.revision) fail("WORKFLOW_AUTHORITY_STALE");
      const grant = await this.db.prepare(`SELECT authorization_receipt_ref FROM scope_access_grant
        WHERE snapshot_id = ?1 AND snapshot_revision = ?2 AND principal_ref = ?3
        AND credential_generation = ?4 AND policy_authority_ref = ?5 AND state = 'ACTIVE'
        AND julianday(expires_at) > julianday('now') AND json_type(allowed_use_json) = 'array'
        AND EXISTS (SELECT 1 FROM json_each(allowed_use_json) u WHERE u.type = 'text' AND u.value = 'research')
        ORDER BY authorization_receipt_ref LIMIT 1`)
        .bind(head.scope_snapshot_id, head.scope_snapshot_revision, principal.principal_ref,
          principal.credential_generation, head.policy_authority_ref).first<{ authorization_receipt_ref: string }>();
      if (grant === null) fail("WORKFLOW_AUTHORITY_STALE");
      const purge = await this.db.prepare("SELECT COALESCE(MAX(ledger_revision),0) AS n FROM purge_ledger").first<{ n: number }>();
      try {
        await this.db.prepare(`INSERT INTO research_workflow_run
          (operation_id, investigation_id, initial_revision, current_revision, principal_ref, credential_generation,
           deployment_generation, policy_generation, policy_authority_ref, authorization_receipt_ref,
           scope_snapshot_id, scope_snapshot_revision, purge_revision, idempotency_key, handler_generation,
           initial_manifest_json, created_at)
          VALUES (?1,?2,?3,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
          ON CONFLICT(operation_id) DO NOTHING`)
          .bind(request.operation_id, head.investigation_id, head.revision, principal.principal_ref,
            principal.credential_generation, principal.deployment_generation, head.policy_generation,
            head.policy_authority_ref, grant.authorization_receipt_ref, head.scope_snapshot_id,
            head.scope_snapshot_revision, purge?.n ?? -1, request.idempotency_key, request.handler_generation,
            JSON.stringify(request.input_manifest), new Date().toISOString()).run();
      } catch (error) {
        run = await this.run(request.operation_id);
        if (run === null) mapFailure(error);
      }
      run = await this.run(request.operation_id);
    }
    if (run === null) fail("WORKFLOW_EFFECT_UNCERTAIN");
    this.samePrincipal(run, principal);
    if (run.investigation_id !== request.investigation_ref.id || run.idempotency_key !== request.idempotency_key ||
        run.handler_generation !== request.handler_generation || (workflowStageIndex(request) === 0 &&
          (run.initial_revision !== request.investigation_ref.revision || run.initial_manifest_json !== JSON.stringify(request.input_manifest)))) {
      fail("WORKFLOW_CONFLICT");
    }
    await this.current(request, principal);
  }
  async attempt(request: StageRequest, requestDigest: string): Promise<AttemptRow | null> {
    const row = await this.db.prepare("SELECT * FROM research_workflow_attempt WHERE operation_id = ?1 AND stage_index = ?2")
      .bind(request.operation_id, workflowStageIndex(request)).first<AttemptRow>();
    if (row !== null && (row.request_sha256 !== requestDigest || row.request_json !== JSON.stringify(request))) fail("WORKFLOW_CONFLICT");
    return row;
  }
  async reserve(request: StageRequest, requestDigest: string, attemptRef: string, budget: WorkflowBudgetGrant): Promise<AttemptRow> {
    try {
      await this.db.prepare(`INSERT INTO research_workflow_attempt
        (operation_id, stage_index, request_json, request_sha256, attempt_ref, expected_revision,
         budget_receipt_ref, budget_expires_at_ms, state, created_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'STARTED',?9)`)
        .bind(request.operation_id, workflowStageIndex(request), JSON.stringify(request), requestDigest,
          attemptRef, request.investigation_ref.revision, budget.receipt_ref, budget.expires_at_ms, new Date().toISOString()).run();
    } catch (error) {
      const row = await this.attempt(request, requestDigest);
      if (row !== null) return row;
      mapFailure(error);
    }
    const row = await this.attempt(request, requestDigest);
    if (row === null) fail("WORKFLOW_EFFECT_UNCERTAIN");
    return row;
  }
  async recordOutput(request: StageRequest, attempt: AttemptRow, output: WorkflowObject): Promise<void> {
    const text = JSON.stringify(output);
    try {
      await this.db.prepare(`UPDATE research_workflow_attempt SET state = 'OUTPUT_RECORDED', output_json = ?1
        WHERE operation_id = ?2 AND stage_index = ?3 AND attempt_ref = ?4 AND state = 'STARTED'`)
        .bind(text, request.operation_id, attempt.stage_index, attempt.attempt_ref).run();
    } catch (error) {
      const row = await this.attempt(request, attempt.request_sha256);
      if (row?.output_json !== text) mapFailure(error);
    }
    const row = await this.attempt(request, attempt.request_sha256);
    if (row?.output_json !== text) fail("WORKFLOW_EFFECT_UNCERTAIN");
  }
  async receipt(request: StageRequest, requestDigest: string): Promise<StageReceipt | null> {
    const row = await this.db.prepare(`SELECT c.receipt_json, c.receipt_sha256, a.attempt_ref, a.output_json
      FROM research_workflow_checkpoint c JOIN research_workflow_attempt a
        ON a.operation_id = c.operation_id AND a.stage_index = c.stage_index AND a.state = 'COMMITTED'
      JOIN investigation_ledger_event e ON e.event_id = c.ledger_event_id
        AND e.payload_handle_ref = json_extract(a.output_json, '$.object_ref')
        AND e.payload_digest = json_extract(a.output_json, '$.sha256')
      JOIN outbox o ON o.outbox_id = 'wcp-outbox:' || c.request_sha256
        AND o.payload_sha256 = c.receipt_sha256 AND o.payload_ref = 'wcp:' || c.request_sha256
      WHERE c.operation_id = ?1 AND c.stage_index = ?2 AND c.request_sha256 = ?3`)
      .bind(request.operation_id, workflowStageIndex(request), requestDigest)
      .first<{ receipt_json: string; receipt_sha256: string; attempt_ref: string; output_json: string }>();
    if (row === null) return null;
    if (await textDigest(row.receipt_json) !== row.receipt_sha256) fail("WORKFLOW_OUTPUT_CORRUPT");
    const receipt = decodeReceipt(row.receipt_json);
    if (receipt.request_sha256 !== requestDigest || receipt.attempt_ref !== row.attempt_ref ||
        receipt.operation_id !== request.operation_id || receipt.stage !== request.stage ||
        receipt.investigation_ref.id !== request.investigation_ref.id ||
        receipt.investigation_ref.revision !== request.investigation_ref.revision + 1 ||
        JSON.stringify(receipt.output_manifest) !== row.output_json) fail("WORKFLOW_OUTPUT_CORRUPT");
    return receipt;
  }
  async commit(request: StageRequest, attempt: AttemptRow, output: WorkflowObject): Promise<StageReceipt> {
    const existing = await this.receipt(request, attempt.request_sha256);
    if (existing !== null) return existing;
    const head = await this.head(request.investigation_ref.id);
    if (head.revision !== attempt.expected_revision) fail("WORKFLOW_AUTHORITY_STALE");
    const now = new Date().toISOString();
    const receipt: StageReceipt = {
      protocol: "eliotr.workflow-checkpoint.v1", operation_id: request.operation_id, stage: request.stage,
      request_sha256: attempt.request_sha256, receipt_ref: `wcp:${attempt.request_sha256}`,
      attempt_ref: attempt.attempt_ref, investigation_ref: { id: head.investigation_id, revision: head.revision + 1 },
      input_manifest_ref: request.input_manifest.object_ref, output_manifest: output,
      budget_receipt_ref: attempt.budget_receipt_ref, cancellation_checked_at: now,
      engine_state: request.stage === "MATERIALIZE" ? "ENGINE_COMPLETED" : "CHECKPOINTED",
    };
    const text = encodeReceipt(receipt);
    const next: LedgerHead = { ...head, revision: head.revision + 1, checkpoint_head: head.checkpoint_head + 1,
      event_head: head.event_head + 1, updated_at: now };
    const event: LedgerEvent = {
      investigation_id: head.investigation_id, sequence: next.event_head, event_id: receipt.receipt_ref,
      kind: "CHECKPOINT", payload_handle_ref: output.object_ref, payload_digest: output.sha256,
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
    try {
      await this.db.batch([
        this.db.prepare(COMMAND_SQL.insertCommand).bind(...command.params),
        this.db.prepare(`INSERT INTO research_workflow_checkpoint
          (operation_id, stage_index, request_sha256, receipt_json, receipt_sha256, ledger_event_id, created_at)
          VALUES (?1,?2,?3,?4,?5,?6,?7)`).bind(request.operation_id, attempt.stage_index, attempt.request_sha256,
            text, await textDigest(text), event.event_id, now),
      ]);
    } catch (error) {
      const reconciled = await this.receipt(request, attempt.request_sha256);
      if (reconciled !== null) return reconciled;
      mapFailure(error);
    }
    const readback = await this.receipt(request, attempt.request_sha256);
    if (readback === null) fail("WORKFLOW_EFFECT_UNCERTAIN");
    return readback;
  }
  async cancel(operationId: string, principal: WorkflowPrincipal): Promise<string> {
    const run = await this.run(operationId);
    if (run === null) fail("WORKFLOW_CONFLICT");
    this.samePrincipal(run, principal);
    if (run.state === "ENGINE_COMPLETED") fail("WORKFLOW_CONFLICT");
    const ref = `workflow-cancelled:${operationId}`;
    try {
      await this.db.prepare(`UPDATE research_workflow_run SET state = 'CANCELLED', cancellation_receipt_ref = ?1
        WHERE operation_id = ?2 AND principal_ref = ?3 AND credential_generation = ?4 AND state = 'ACTIVE'`)
        .bind(ref, operationId, principal.principal_ref, principal.credential_generation).run();
    } catch (error) {
      if ((await this.run(operationId))?.cancellation_receipt_ref !== ref) mapFailure(error);
    }
    if ((await this.run(operationId))?.cancellation_receipt_ref !== ref) fail("WORKFLOW_CONFLICT");
    return ref;
  }
}
