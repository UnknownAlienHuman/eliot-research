import { describe, expect, it } from "vitest";
import {
  createD1InvestigationLedgerStore,
  createInvestigationLedgerService,
  type CreateLedgerInput,
  type LedgerD1Database,
} from "@eliotr/research";
import {
  createWorkflowCheckpointExecutor,
  deterministicWorkflowNativeStageBytes,
  deterministicWorkflowStageBytes,
  digest,
  readCommittedWorkflowStageCompletion,
  textDigest,
  WorkflowCheckpointStore,
  type StageRequest,
  type WorkflowNativeStageHandler,
  type WorkflowNativeStagePolicy,
} from "@eliotr/cloudflare-workflows";
import { faultDatabase, principal, workflowFixture } from "./research-workflow-fixture.js";

const NATIVE_POLICY: WorkflowNativeStagePolicy = {
  effect_class: "PURE_COMPUTE",
  effect_policy_generation: "eliotr.workflow-stage-effects.v1",
  retry_limit: 1,
  retry_delay_ms: 1_000,
};

function installedPolicy(value: WorkflowNativeStagePolicy | null): WorkflowNativeStagePolicy {
  if (value === null) throw new Error("expected the installed exploratory PURE tuple");
  expect(value).toEqual(NATIVE_POLICY);
  return value;
}

async function expectWorkflowError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

async function nativeRun(tag: string) {
  const base = await workflowFixture(`native-${tag}`, "exploratory");
  const now = new Date().toISOString();
  const policyGeneration = "research-policy-v1";
  const policyAuthorityRef = "workflow-policy-authority";
  const scopeSnapshotId = base.request.input_manifest.residency.scope_domain_id;
  const investigationId = `native-investigation-${tag}`;
  const operationId = `native-workflow-${tag}`;
  const objectRef = `workflow-native-input-${tag}`;
  const inputBytes = new TextEncoder().encode(JSON.stringify({
    investigation_id: investigationId,
    operation_id: operationId,
    query: "verify the native durable checkpoint",
    scope_snapshot_ref: { id: scopeSnapshotId, revision: 1 },
    evidence_grade: "E2",
    principal_ref: principal.principal_ref,
  }));
  const inputDigest = await digest(inputBytes);
  await base.db.prepare("UPDATE investigation_current_policy SET state = 'RETIRED' WHERE state = 'ACTIVE'").run();
  await base.db.prepare(`INSERT INTO investigation_current_policy
    (policy_generation, policy_authority_ref, state, created_at) VALUES (?1,?2,'ACTIVE',?3)`)
    .bind(policyGeneration, policyAuthorityRef, now).run();
  await base.bucket.put(objectRef, inputBytes, { sha256: inputDigest });

  const ledgerInput: CreateLedgerInput = {
    investigation_id: investigationId,
    goal: "verify the native durable checkpoint",
    scope_snapshot_id: scopeSnapshotId,
    scope_snapshot_revision: 1,
    evidence_grade: "E2",
    lane: "exploratory",
    lane_registrations: [],
    obligations: [],
    hypotheses: [],
    portfolio_ref: objectRef,
    debt_refs: [],
    principal_ref: principal.principal_ref,
    input_digest: inputDigest,
    policy_generation: policyGeneration,
    policy_authority_ref: policyAuthorityRef,
    deployment_generation: principal.deployment_generation,
    idempotency_key: `native-ledger-${tag}`,
    model_profile_ref: "native-test-profile-v1",
    event_id: `native-ledger-event-${tag}`,
    payload_handle_ref: objectRef,
    payload_digest: inputDigest,
    created_at: now,
  };
  const ledger = createInvestigationLedgerService(
    createD1InvestigationLedgerStore(base.db as unknown as LedgerD1Database),
    {
      current: async () => ({
        principal_ref: principal.principal_ref,
        scope_snapshot_id: scopeSnapshotId,
        scope_snapshot_revision: 1,
        policy_generation: policyGeneration,
        policy_authority_ref: policyAuthorityRef,
        deployment_generation: principal.deployment_generation,
        purge_revision: 0,
        scope_purge_revision: 0,
      }),
    },
    {
      has: async (ref) => (await base.bucket.head(ref)) !== null,
      digestFor: async (ref) => ref === objectRef ? inputDigest : null,
    },
  );
  await ledger.create(ledgerInput);

  const request: StageRequest = {
    protocol: "eliotr.workflow-stage.v1",
    operation_id: operationId,
    investigation_ref: { id: investigationId, revision: 1 },
    stage: "FREEZE_PROTOCOL_AND_SCOPE",
    idempotency_key: `native-stage-${tag}`,
    handler_generation: "research-handlers.exploratory.v1",
    input_manifest: {
      object_ref: objectRef,
      sha256: inputDigest,
      byte_length: inputBytes.byteLength,
      residency: {
        scope_domain_id: scopeSnapshotId,
        access_domain_id: principal.principal_ref,
        confidentiality_domain_id: "private",
        encryption_key_domain_id: "native-test-key-v1",
        retention_domain_id: "native-test-retention-v1",
        erasure_domain_id: "native-test-erasure-v1",
        content_digest: { algorithm: "sha256", digest: inputDigest },
      },
    },
  };
  const executor = createWorkflowCheckpointExecutor(base.db, base.bucket, base.ports);
  const freezeReceipt = await executor.execute(request, principal, async ({ request: stage, input_bytes, attempt_ref }) =>
    deterministicWorkflowStageBytes(stage.operation_id, stage.stage, input_bytes, attempt_ref));
  const orientRequest: StageRequest = {
    ...request,
    stage: "ORIENT",
    investigation_ref: freezeReceipt.investigation_ref,
    input_manifest: freezeReceipt.output_manifest,
  };
  return { ...base, ledger, executor, request, orientRequest, freezeReceipt };
}

describe("native Workflow D1 stage completion", () => {
  it("commits migration 0127 atomically, reconciles a lost ACK, and reads back after executor restart", async () => {
    const fixture = await nativeRun("lost-ack");
    let handlerCalls = 0;
    let lostAck = false;
    const faultingDb = faultDatabase(fixture.db, {
      afterBatch: async () => {
        if (!lostAck) {
          lostAck = true;
          throw new Error("simulated acknowledgement loss after native D1 commit");
        }
      },
    });
    const firstExecutor = createWorkflowCheckpointExecutor(faultingDb, fixture.bucket, fixture.ports);
    const policy = installedPolicy(await firstExecutor.nativeStagePolicy(fixture.orientRequest, principal));
    const handle: WorkflowNativeStageHandler = async ({ request, input_bytes }) => {
      handlerCalls += 1;
      return deterministicWorkflowNativeStageBytes(request.operation_id, request.stage, input_bytes);
    };

    const committed = await firstExecutor.executeNative(fixture.orientRequest, principal, handle, policy);
    expect(lostAck).toBe(true);
    expect(handlerCalls).toBe(1);
    expect(committed).toMatchObject({
      protocol: "eliotr.workflow-native-stage.v1",
      stage: "ORIENT",
      stage_index: 1,
      effect_class: "PURE_COMPUTE",
      effect_policy_generation: "eliotr.workflow-stage-effects.v1",
      engine_state: "CHECKPOINTED",
    });
    expect(committed).not.toHaveProperty("attempt_ref");
    expect(committed).not.toHaveProperty("budget_receipt_ref");

    const checkpoints = new WorkflowCheckpointStore(fixture.db);
    const canonical = await readCommittedWorkflowStageCompletion(
      checkpoints, fixture.orientRequest.operation_id, "ORIENT",
    );
    expect(canonical.kind).toBe("NATIVE");
    if (canonical.kind !== "NATIVE") throw new Error("native completion did not win canonical readback");
    expect(canonical.receipt).toEqual(committed);
    const native = await checkpoints.readCommittedNativeStage(fixture.orientRequest.operation_id, "ORIENT");
    expect(native?.request).toEqual(fixture.orientRequest);

    const nativeRow = await fixture.db.prepare(`SELECT stage_index, effect_class, handler_generation,
      authority_policy_generation FROM research_workflow_native_stage_completion WHERE operation_id = ?1`)
      .bind(fixture.orientRequest.operation_id)
      .first<{ stage_index: number; effect_class: string; handler_generation: string; authority_policy_generation: string }>();
    expect(nativeRow).toMatchObject({
      stage_index: 1,
      effect_class: "PURE_COMPUTE",
      handler_generation: "research-handlers.exploratory.v1",
      authority_policy_generation: "research-policy-v1",
    });
    const run = await fixture.db.prepare(`SELECT next_stage_index, current_revision FROM research_workflow_run
      WHERE operation_id = ?1`).bind(fixture.orientRequest.operation_id)
      .first<{ next_stage_index: number; current_revision: number }>();
    expect(run).toEqual({ next_stage_index: 2, current_revision: 3 });
    const event = await fixture.db.prepare(`SELECT kind, payload_handle_ref, payload_digest FROM investigation_ledger_event
      WHERE event_id = ?1`).bind(committed.receipt_ref)
      .first<{ kind: string; payload_handle_ref: string; payload_digest: string }>();
    expect(event).toEqual({
      kind: "CHECKPOINT",
      payload_handle_ref: committed.output_manifest.object_ref,
      payload_digest: committed.output_manifest.sha256,
    });
    const outbox = await fixture.db.prepare("SELECT topic, payload_ref, payload_sha256 FROM outbox WHERE outbox_id = ?1")
      .bind(`wnc-outbox:${committed.request_sha256}`)
      .first<{ topic: string; payload_ref: string; payload_sha256: string }>();
    expect(outbox).toEqual({
      topic: "research.workflow.native-stage.v1",
      payload_ref: committed.receipt_ref,
      payload_sha256: await textDigest(JSON.stringify(committed)),
    });
    const noNativeW2Attempt = await fixture.db.prepare(`SELECT state FROM research_workflow_attempt
      WHERE operation_id = ?1 AND stage_index = 1`).bind(fixture.orientRequest.operation_id)
      .first<{ state: string }>();
    expect(noNativeW2Attempt).toBeNull();

    const legacy = await readCommittedWorkflowStageCompletion(
      checkpoints, fixture.request.operation_id, "FREEZE_PROTOCOL_AND_SCOPE",
    );
    expect(legacy.kind).toBe("W2");
    if (legacy.kind !== "W2") throw new Error("the historical stage must remain W2-readable");
    expect(legacy.receipt.attempt_ref).toBeTruthy();

    const restartedExecutor = createWorkflowCheckpointExecutor(fixture.db, fixture.bucket, fixture.ports);
    const restartPolicy = installedPolicy(await restartedExecutor.nativeStagePolicy(fixture.orientRequest, principal));
    const replay = await restartedExecutor.executeNative(fixture.orientRequest, principal, handle, restartPolicy);
    expect(replay).toEqual(committed);
    expect(handlerCalls).toBe(1);
  });

  it("rejects a stale principal and a substituted input manifest before invoking the pure handler", async () => {
    const fixture = await nativeRun("fences");
    const policy = installedPolicy(await fixture.executor.nativeStagePolicy(fixture.orientRequest, principal));
    let handlerCalls = 0;
    const handler: WorkflowNativeStageHandler = async ({ request, input_bytes }) => {
      handlerCalls += 1;
      return deterministicWorkflowNativeStageBytes(request.operation_id, request.stage, input_bytes);
    };

    await expectWorkflowError(
      fixture.executor.executeNative(
        fixture.orientRequest,
        { ...principal, credential_generation: "stale-credential" },
        handler,
        policy,
      ),
      "WORKFLOW_AUTHORITY_STALE",
    );

    const substitutedDigest = "f".repeat(64);
    const substituted: StageRequest = {
      ...fixture.orientRequest,
      input_manifest: {
        ...fixture.orientRequest.input_manifest,
        object_ref: "substituted-native-input",
        sha256: substitutedDigest,
        residency: {
          ...fixture.orientRequest.input_manifest.residency,
          content_digest: { algorithm: "sha256", digest: substitutedDigest },
        },
      },
    };
    await expectWorkflowError(fixture.executor.nativeStagePolicy(substituted, principal), "WORKFLOW_STAGE_OUT_OF_ORDER");
    expect(handlerCalls).toBe(0);
  });

  it("rejects native execution after durable cancellation", async () => {
    const fixture = await nativeRun("cancelled");
    const policy = installedPolicy(await fixture.executor.nativeStagePolicy(fixture.orientRequest, principal));
    await fixture.executor.cancel(fixture.orientRequest.operation_id, principal);
    let handlerCalls = 0;
    await expectWorkflowError(
      fixture.executor.executeNative(fixture.orientRequest, principal, async ({ request, input_bytes }) => {
        handlerCalls += 1;
        return deterministicWorkflowNativeStageBytes(request.operation_id, request.stage, input_bytes);
      }, policy),
      "WORKFLOW_CANCELLED",
    );
    expect(handlerCalls).toBe(0);
  });

  it("rejects a ledger revision that drifted after the prior W2 checkpoint", async () => {
    const fixture = await nativeRun("ledger-drift");
    const policy = installedPolicy(await fixture.executor.nativeStagePolicy(fixture.orientRequest, principal));
    const head = await fixture.ledger.read(fixture.orientRequest.investigation_ref.id);
    await fixture.ledger.checkpoint(
      head.investigation_id,
      head.revision,
      head.checkpoint_head + 1,
      principal.principal_ref,
      "native-ledger-drift-event",
      fixture.request.input_manifest.object_ref,
      fixture.request.input_manifest.sha256,
    );
    let handlerCalls = 0;
    await expectWorkflowError(
      fixture.executor.executeNative(fixture.orientRequest, principal, async ({ request, input_bytes }) => {
        handlerCalls += 1;
        return deterministicWorkflowNativeStageBytes(request.operation_id, request.stage, input_bytes);
      }, policy),
      "WORKFLOW_AUTHORITY_STALE",
    );
    expect(handlerCalls).toBe(0);
  });

  it("does not bypass an existing W2 STARTED attempt for the same stage", async () => {
    const fixture = await nativeRun("w2-reservation");
    const policy = installedPolicy(await fixture.executor.nativeStagePolicy(fixture.orientRequest, principal));
    await expectWorkflowError(
      fixture.executor.execute(fixture.orientRequest, principal, async () => {
        throw new Error("leave the W2 reservation uncertain for reconciliation");
      }),
      "WORKFLOW_EFFECT_UNCERTAIN",
    );
    const attempt = await fixture.db.prepare(`SELECT state, attempt_ref FROM research_workflow_attempt
      WHERE operation_id = ?1 AND stage_index = 1`).bind(fixture.orientRequest.operation_id)
      .first<{ state: string; attempt_ref: string }>();
    expect(attempt?.state).toBe("STARTED");
    expect(attempt?.attempt_ref).toBeTruthy();

    let nativeHandlerCalls = 0;
    await expectWorkflowError(
      fixture.executor.executeNative(fixture.orientRequest, principal, async ({ request, input_bytes }) => {
        nativeHandlerCalls += 1;
        return deterministicWorkflowNativeStageBytes(request.operation_id, request.stage, input_bytes);
      }, policy),
      "WORKFLOW_AUTHORITY_STALE",
    );
    expect(nativeHandlerCalls).toBe(0);
  });
});
