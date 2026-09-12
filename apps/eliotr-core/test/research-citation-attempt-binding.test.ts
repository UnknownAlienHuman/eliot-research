import { describe, expect, it } from "vitest";
import {
  canonicalEvidenceJson,
  createCloudflareEvidenceResolver,
  createD1EvidenceAuthorityPort,
  createR2EvidenceContentPort,
  evidenceSha256,
} from "@eliotr/cloudflare-evidence";
import {
  digest,
  parseRequest,
  textDigest,
  type createWorkflowCheckpointExecutor,
  type StageReceipt,
  type StageRequest,
} from "@eliotr/cloudflare-workflows";
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import type { CreateLedgerInput } from "@eliotr/research";
import {
  principal,
  runtime,
  workflowFixture,
} from "./research-workflow-fixture.js";

type BindingRow = {
  readonly operation_id: string;
  readonly stage_index: number;
  readonly attempt_ref: string;
  readonly request_sha256: string;
  readonly receipt_id: string;
  readonly receipt_revision: number;
  readonly receipt_sha256: string;
  readonly bound_at: string;
};

type AttemptRow = {
  readonly attempt_ref: string;
  readonly request_sha256: string;
  readonly state: string;
  readonly output_json: string | null;
};

type CitationReceiptRow = {
  readonly receipt_json: string;
  readonly receipt_sha256: string;
};

async function insertBinding(database: D1Database, row: BindingRow): Promise<void> {
  await database.prepare(
    "INSERT INTO research_workflow_citation_binding " +
      "(operation_id,stage_index,attempt_ref,request_sha256,receipt_id,receipt_revision,receipt_sha256,bound_at) " +
      "VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
  ).bind(
    row.operation_id,
    row.stage_index,
    row.attempt_ref,
    row.request_sha256,
    row.receipt_id,
    row.receipt_revision,
    row.receipt_sha256,
    row.bound_at,
  ).run();
}

async function readBinding(database: D1Database, operationId: string): Promise<BindingRow | null> {
  return database.prepare(
    "SELECT operation_id,stage_index,attempt_ref,request_sha256,receipt_id,receipt_revision,receipt_sha256,bound_at " +
      "FROM research_workflow_citation_binding WHERE operation_id=?1 AND stage_index=15",
  ).bind(operationId).first<BindingRow>();
}

async function expectD1Code(action: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(String(error)).toContain(code);
    return;
  }
  throw new Error(`expected D1 failure ${code}`);
}

async function expectD1Refusal(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(String(error)).toMatch(/WORKFLOW_CITATION_BINDING_CONFLICT|WORKFLOW_AUTHORITY_STALE/u);
    return;
  }
  throw new Error("expected bounded citation binding refusal");
}

async function leaveStarted(
  database: D1Database,
  executor: ReturnType<typeof createWorkflowCheckpointExecutor>,
  request: StageRequest,
): Promise<AttemptRow> {
  const normalized = parseRequest(request);
  const requestSha256 = await textDigest(JSON.stringify(normalized));
  await expect(executor.execute(request, principal, async () => {
    throw new Error("controlled citation binding provider outcome");
  })).rejects.toMatchObject({ code: "WORKFLOW_EFFECT_UNCERTAIN" });
  const attempt = await database.prepare(
    "SELECT attempt_ref,request_sha256,state,output_json FROM research_workflow_attempt " +
      "WHERE operation_id=?1 AND stage_index=?2 AND request_sha256=?3 LIMIT 1",
  ).bind(request.operation_id, 15, requestSha256).first<AttemptRow>();
  if (attempt === null) throw new Error("Stage15 STARTED attempt readback is missing");
  expect(attempt).toMatchObject({ request_sha256: requestSha256, state: "STARTED", output_json: null });
  return attempt;
}

async function walkControlledStages(
  executor: ReturnType<typeof createWorkflowCheckpointExecutor>,
  initial: StageRequest,
): Promise<StageReceipt> {
  let previous: StageReceipt | null = null;
  for (let index = 0; index <= 14; index += 1) {
    const stage = RESEARCH_WORKFLOW_STAGES[index];
    if (stage === undefined) throw new Error(`missing canonical stage ${index}`);
    const request: StageRequest = index === 0
      ? initial
      : (() => {
        if (previous === null) throw new Error(`missing stage ${index - 1} receipt`);
        return {
          ...initial,
          stage,
          investigation_ref: previous.investigation_ref,
          input_manifest: previous.output_manifest,
        };
      })();
    previous = await executor.execute(request, principal, async ({ request: current, input_bytes }) => (
      new TextEncoder().encode(JSON.stringify({
        operation_id: current.operation_id,
        stage: current.stage,
        input_sha256: await digest(input_bytes),
      }))
    ));
  }
  if (previous === null) throw new Error("controlled stage walk produced no receipt");
  return previous;
}

describe("ER-13 Stage15 citation-receipt binding migration", () => {
  it("binds one canonical all-rejected receipt to two valid STARTED operations and preserves conflicts", async () => {
    const workflow = await workflowFixture("citation-binding", "exploratory");
    const auditReceipt = await walkControlledStages(workflow.executor, workflow.request);
    const stage15: StageRequest = {
      ...workflow.request,
      stage: "RESOLVE_CITATIONS",
      investigation_ref: auditReceipt.investigation_ref,
      input_manifest: auditReceipt.output_manifest,
    };

    const resolver = createCloudflareEvidenceResolver({
      authority: createD1EvidenceAuthorityPort({
        core_database: workflow.db,
        search_database: runtime.SEARCH_DB,
      }),
      content: createR2EvidenceContentPort({ evidence_bucket: workflow.bucket }),
    });
    const scopeSnapshotRef = { id: workflow.request.input_manifest.residency.scope_domain_id, revision: 1 };
    const evidenceAccess = {
      principal_ref: principal.principal_ref,
      client_class: "owner_pwa" as const,
      credential_generation: principal.credential_generation,
    };
    const missingHandle = { id: "missing-valid-stage15-handle", revision: 1 };
    const citation = await resolver.resolveCitationSet({
      handle_refs: [missingHandle],
      scope_snapshot_ref: scopeSnapshotRef,
      access: evidenceAccess,
    });
    expect(citation.resolved_evidence).toHaveLength(0);
    expect(citation.receipt.requested_handle_refs).toEqual([missingHandle]);
    expect(citation.receipt.rejected).toEqual([{
      handle_ref: missingHandle,
      reason_code: "EVIDENCE_HANDLE_NOT_FOUND",
    }]);
    expect(citation.receipt.all_material_citations_resolved).toBe(false);

    const citationReceiptRow = await workflow.db.prepare(
      "SELECT receipt_json,receipt_sha256 FROM citation_resolution_receipt " +
        "WHERE receipt_id=?1 AND revision=?2 LIMIT 1",
    ).bind(citation.receipt.receipt_ref.id, citation.receipt.receipt_ref.revision).first<CitationReceiptRow>();
    if (citationReceiptRow === null) throw new Error("real resolver receipt readback is missing");
    expect(citationReceiptRow.receipt_json).toBe(canonicalEvidenceJson(citation.receipt));
    expect(await evidenceSha256(citation.receipt)).toBe(citationReceiptRow.receipt_sha256);

    const firstAttempt = await leaveStarted(workflow.db, workflow.executor, stage15);
    const firstBinding: BindingRow = {
      operation_id: stage15.operation_id,
      stage_index: 15,
      attempt_ref: firstAttempt.attempt_ref,
      request_sha256: firstAttempt.request_sha256,
      receipt_id: citation.receipt.receipt_ref.id,
      receipt_revision: citation.receipt.receipt_ref.revision,
      receipt_sha256: citationReceiptRow.receipt_sha256,
      bound_at: new Date().toISOString(),
    };

    const guard = await workflow.db.prepare(
      "SELECT verified,created_at FROM citation_resolution_guard WHERE receipt_id=?1 AND receipt_revision=?2",
    ).bind(firstBinding.receipt_id, firstBinding.receipt_revision).first<{
      readonly verified: number;
      readonly created_at: string;
    }>();
    expect(guard).toMatchObject({ verified: 1 });
    if (guard === null) throw new Error("real citation guard readback is missing");
    await workflow.db.prepare(
      "DELETE FROM citation_resolution_guard WHERE receipt_id=?1 AND receipt_revision=?2",
    ).bind(firstBinding.receipt_id, firstBinding.receipt_revision).run();
    await expectD1Code(() => insertBinding(workflow.db, firstBinding), "WORKFLOW_AUTHORITY_STALE");
    expect(await readBinding(workflow.db, firstBinding.operation_id)).toBeNull();
    await workflow.db.prepare(
      "INSERT INTO citation_resolution_guard(receipt_id,receipt_revision,verified,created_at) VALUES (?1,?2,1,?3)",
    ).bind(firstBinding.receipt_id, firstBinding.receipt_revision, guard.created_at).run();

    for (const mismatched of [
      { ...firstBinding, attempt_ref: "foreign-stage15-attempt" },
      { ...firstBinding, request_sha256: "f".repeat(64) },
      { ...firstBinding, receipt_sha256: "f".repeat(64) },
    ]) {
      await expectD1Code(() => insertBinding(workflow.db, mismatched), "WORKFLOW_AUTHORITY_STALE");
      expect(await readBinding(workflow.db, firstBinding.operation_id)).toBeNull();
    }

    await insertBinding(workflow.db, firstBinding);
    expect(await readBinding(workflow.db, firstBinding.operation_id)).toEqual(firstBinding);

    await expectD1Code(() => insertBinding(workflow.db, firstBinding), "WORKFLOW_CITATION_BINDING_CONFLICT");
    await expectD1Refusal(() => insertBinding(workflow.db, {
      ...firstBinding,
      receipt_sha256: "f".repeat(64),
    }));
    await expectD1Code(() => insertBinding(workflow.db, {
      ...firstBinding,
      stage_index: 14,
    }), "stage_index = 15");
    await expectD1Code(() => workflow.db.prepare(
      "UPDATE research_workflow_citation_binding SET receipt_id=?1 WHERE operation_id=?2 AND stage_index=15",
    ).bind("another-receipt", firstBinding.operation_id).run(), "WORKFLOW_CITATION_BINDING_IMMUTABLE");
    await expectD1Code(() => workflow.db.prepare(
      "DELETE FROM research_workflow_citation_binding WHERE operation_id=?1 AND stage_index=15",
    ).bind(firstBinding.operation_id).run(), "WORKFLOW_CITATION_BINDING_IMMUTABLE");
    expect(await readBinding(workflow.db, firstBinding.operation_id)).toEqual(firstBinding);

    const firstHead = await workflow.ledger.read(workflow.request.investigation_ref.id);
    const secondOperationId = `${workflow.request.operation_id}-binding-second`;
    const secondInvestigationId = `${workflow.request.investigation_ref.id}-binding-second`;
    const secondLedgerInput: CreateLedgerInput = {
      investigation_id: secondInvestigationId,
      goal: "citation binding second operation",
      scope_snapshot_id: firstHead.scope_snapshot_id,
      scope_snapshot_revision: firstHead.scope_snapshot_revision,
      evidence_grade: firstHead.evidence_grade,
      lane: firstHead.lane,
      lane_registrations: firstHead.lane_registrations,
      obligations: firstHead.obligations,
      hypotheses: firstHead.hypotheses,
      portfolio_ref: workflow.request.input_manifest.object_ref,
      debt_refs: firstHead.debt_refs,
      principal_ref: firstHead.principal_ref,
      input_digest: workflow.request.input_manifest.sha256,
      policy_generation: firstHead.policy_generation,
      policy_authority_ref: firstHead.policy_authority_ref,
      deployment_generation: firstHead.deployment_generation,
      idempotency_key: "citation-binding-second-ledger",
      model_profile_ref: firstHead.model_profile_ref,
      event_id: "citation-binding-second-ledger-created",
      payload_handle_ref: workflow.request.input_manifest.object_ref,
      payload_digest: workflow.request.input_manifest.sha256,
      created_at: new Date().toISOString(),
    };
    expect((await workflow.ledger.create(secondLedgerInput)).revision).toBe(1);
    const secondStageZero: StageRequest = {
      ...workflow.request,
      operation_id: secondOperationId,
      investigation_ref: { id: secondInvestigationId, revision: 1 },
      idempotency_key: "citation-binding-second-workflow",
    };
    const secondStage14 = await walkControlledStages(workflow.executor, secondStageZero);
    expect(secondStage14.stage).toBe("AUDIT_CLAIMS");
    const secondStage15: StageRequest = {
      ...secondStageZero,
      stage: "RESOLVE_CITATIONS",
      investigation_ref: secondStage14.investigation_ref,
      input_manifest: secondStage14.output_manifest,
    };
    const secondAttempt = await leaveStarted(workflow.db, workflow.executor, secondStage15);
    const secondBinding: BindingRow = {
      ...firstBinding,
      operation_id: secondOperationId,
      attempt_ref: secondAttempt.attempt_ref,
      request_sha256: secondAttempt.request_sha256,
    };
    await insertBinding(workflow.db, secondBinding);
    expect(await readBinding(workflow.db, secondOperationId)).toEqual(secondBinding);
    expect(secondBinding.operation_id).not.toBe(firstBinding.operation_id);
    expect(secondBinding.receipt_id).toBe(firstBinding.receipt_id);
    expect(secondBinding.receipt_revision).toBe(firstBinding.receipt_revision);
    expect(secondBinding.receipt_sha256).toBe(firstBinding.receipt_sha256);
    const bindings = await workflow.db.prepare(
      "SELECT operation_id,stage_index,attempt_ref,request_sha256,receipt_id,receipt_revision,receipt_sha256,bound_at " +
        "FROM research_workflow_citation_binding WHERE receipt_id=?1 AND receipt_revision=?2 ORDER BY operation_id",
    ).bind(firstBinding.receipt_id, firstBinding.receipt_revision).all<BindingRow>();
    expect(bindings.results).toHaveLength(2);
    expect(bindings.results.map((row) => row.operation_id)).toEqual([
      firstBinding.operation_id,
      secondBinding.operation_id,
    ].sort());
  }, 60_000);
});
