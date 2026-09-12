import { describe, expect, it } from "vitest";
import {
  decodeResearchClaimAuditResult,
} from "@eliotr/cloudflare-research-stages";
import {
  createWorkflowCheckpointExecutor,
  WorkflowCheckpointStore,
  readWorkflowObject,
} from "@eliotr/cloudflare-workflows";
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import {
  AUDIT_VERIFIER_REF,
  auditCheckpointCount,
  auditStageLineage,
  readAuditStageInput,
  readAuditStageResult,
  researchClaimAuditStageFixture,
} from "./research-claim-audit-fixture.js";
import { principal } from "./research-evidence-freeze-fixture.js";

describe("AUDIT_CLAIMS W2 semantic audit over committed evidence", () => {
  it("persists a compact bound result and replays the terminal receipt without another audit call", async () => {
    const fixture = await researchClaimAuditStageFixture();
    const input = await readAuditStageInput(fixture);
    const evidence = input.evidence[0];
    const normalized = input.claims.claims[0];
    if (evidence === undefined || normalized === undefined) throw new Error("audit fixture has no normalized evidence claim");

    const first = await fixture.fixture.freeze.executor.execute(fixture.stage14, principal, fixture.auditHandler);
    const firstBytes = await readAuditStageResult(fixture, first);
    const result = decodeResearchClaimAuditResult(firstBytes);

    expect(firstBytes.byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(result.protocol).toBe("eliotr.research.audit-claims-result.v1");
    expect(result.stage).toBe("AUDIT_CLAIMS");
    expect(result.operation_id).toBe(fixture.stage14.operation_id);
    expect(result.investigation_ref).toEqual(fixture.stage14.investigation_ref);
    expect(result.audit_input_sha256).toBe(input.evidence_input_sha256);
    expect(result.synthesis.stage_attempt_ref).toBe(input.synthesis.stage_attempt_ref);
    expect(result.synthesis.stage_request_sha256).toBe(input.synthesis.stage_request_sha256);
    expect(result.synthesis.output_sha256).toBe(input.synthesis.output_sha256);
    expect(result.verification.stage_attempt_ref).toBe(fixture.verificationReceipt.attempt_ref);
    expect(result.verification.output_sha256).toBe(fixture.stage14.input_manifest.sha256);
    expect(result.verification.normalization_binding_sha256).toBe(input.verify.normalization.binding_sha256);
    expect(result.freeze_ref).toEqual(input.context.freeze.freeze_ref);
    expect(result.scope_snapshot_ref).toEqual(input.context.freeze.scope_snapshot_ref);
    expect(result.manifest_ref).toEqual(input.context.manifest.manifest_ref);
    expect(result.verifier.verifier_ref).toBe(AUDIT_VERIFIER_REF);
    expect(result.verifier.qualified).toBe(true);
    expect(result.verifier.deployment).toEqual(input.verifier.deployment);

    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]?.claim_ref).toEqual(normalized.claim_ref);
    expect(result.claims[0]?.claim_text_digest).toBe(normalized.text_digest);
    expect(result.claims[0]?.support_handle_refs).toEqual(normalized.support_handle_refs);
    expect(result.claims[0]?.counterevidence_handle_refs).toEqual(normalized.counterevidence_handle_refs);
    expect(result.claims[0]?.reference_verification).toBe("PASS");
    expect(result.claims[0]?.source_satisfies_requirement).toBe(false);
    expect(result.claims[0]?.supplied_excerpt_supports_requirement).toBe(true);
    expect(result.claims[0]?.disposition).toBe("UNSUPPORTED");
    expect(input.evidence[0]?.source_class).toBe("document");
    expect(input.normalization.required_source_class).toBe("official");

    const resultText = new TextDecoder().decode(firstBytes);
    expect(resultText).not.toContain(evidence.exact_excerpt);
    expect(resultText).not.toContain("Controlled verifier readback");
    expect(result.model_attempt.output.output_sha256).toBe(result.model_attempt.receipt.output_sha256);
    expect(result.model_attempt.output.readback_sha256).toBe(result.model_attempt.output.output_sha256);
    expect(result.model_attempt.stage_attempt_ref).toBe(result.stage_attempt_ref);
    expect(result.model_attempt.stage_request_sha256).toBe(result.stage_request_sha256);

    const promptBindings = fixture.promptBindings();
    expect(promptBindings).toHaveLength(1);
    expect(promptBindings[0]?.audit_input_sha256).toBe(input.evidence_input_sha256);
    expect(promptBindings[0]?.claims[0]?.claim_ref).toEqual(normalized.claim_ref);
    expect(promptBindings[0]?.claims[0]?.support_handle_refs).toEqual(normalized.support_handle_refs);
    expect(fixture.auditProviderCalls()).toBe(1);
    expect(fixture.fixture.provider_calls()).toBe(1);
    expect(await auditCheckpointCount(fixture)).toBe(1);

    const committed = await auditStageLineage(fixture);
    expect(committed.receipt).toEqual(first);
    expect(committed.receipt.output_manifest).toEqual(first.output_manifest);
    expect(committed.attempt_ref).toBe(first.attempt_ref);

    const replay = await fixture.fixture.freeze.executor.execute(fixture.stage14, principal, fixture.auditHandler);
    expect(replay).toEqual(first);
    expect(await readWorkflowObject(fixture.fixture.freeze.bucket, replay.output_manifest, true)).toEqual(firstBytes);
    expect(fixture.auditProviderCalls()).toBe(1);
    expect(fixture.fixture.provider_calls()).toBe(1);
    expect(await auditCheckpointCount(fixture)).toBe(1);
    const replayedCommitted = await new WorkflowCheckpointStore(fixture.fixture.freeze.db)
      .receipt(fixture.stage14, first.request_sha256);
    expect(replayedCommitted).toEqual(first);
  }, 60_000);

  it("recovers a durably settled AUDIT model result through the factory after the W2 ACK is lost", async () => {
    const fixture = await researchClaimAuditStageFixture();
    let paidResult: Uint8Array | undefined;
    const firstExecutor = createWorkflowCheckpointExecutor(
      fixture.fixture.freeze.db,
      fixture.fixture.freeze.bucket,
      fixture.fixture.freeze.ports,
    );
    await expect(firstExecutor.execute(fixture.stage14, principal, async (input) => {
      paidResult = await fixture.auditHandler(input);
      throw new Error("controlled W2 lost ACK after the governed AUDIT result");
    })).rejects.toMatchObject({ code: "WORKFLOW_EFFECT_UNCERTAIN" });
    expect(paidResult).toBeInstanceOf(Uint8Array);
    expect(fixture.auditProviderCalls()).toBe(1);
    expect(fixture.fixture.provider_calls()).toBe(1);

    const pending = await fixture.fixture.freeze.db.prepare(
      "SELECT state, output_json FROM research_workflow_attempt WHERE operation_id=?1 AND stage_index=?2",
    ).bind(fixture.fixture.freeze.operation_id, RESEARCH_WORKFLOW_STAGES.indexOf("AUDIT_CLAIMS"))
      .first<{ readonly state: string; readonly output_json: string | null }>();
    expect(pending).toEqual({ state: "STARTED", output_json: null });
    expect(await auditCheckpointCount(fixture)).toBe(0);

    const recovery = fixture.auditFactory.recoverStartedAttempt;
    if (recovery === undefined) throw new Error("v3 factory did not expose W2 recovery");
    const resumed = createWorkflowCheckpointExecutor(
      fixture.fixture.freeze.db,
      fixture.fixture.freeze.bucket,
      { ...fixture.fixture.freeze.ports, recoverStartedAttempt: recovery },
    );
    const recoveredReceipt = await resumed.execute(fixture.stage14, principal, async () => {
      throw new Error("W2 recovery must not invoke the paid stage handler");
    });
    const recoveredBytes = await readAuditStageResult(fixture, recoveredReceipt);
    expect(paidResult).toBeDefined();
    expect(recoveredBytes).toEqual(paidResult);
    expect(decodeResearchClaimAuditResult(recoveredBytes).claims[0]?.disposition).toBe("UNSUPPORTED");
    expect(fixture.auditProviderCalls()).toBe(1);
    expect(fixture.fixture.provider_calls()).toBe(1);
    expect(await auditCheckpointCount(fixture)).toBe(1);
    expect((await auditStageLineage(fixture)).receipt).toEqual(recoveredReceipt);

    const replay = await resumed.execute(fixture.stage14, principal, async () => {
      throw new Error("terminal replay must not invoke the paid stage handler");
    });
    expect(replay).toEqual(recoveredReceipt);
    expect(await readAuditStageResult(fixture, replay)).toEqual(recoveredBytes);
    expect(fixture.auditProviderCalls()).toBe(1);
    expect(fixture.fixture.provider_calls()).toBe(1);
    expect(await auditCheckpointCount(fixture)).toBe(1);

    const mismatched = await recovery({
      request: { ...fixture.stage14, handler_generation: "wrong-stage-handler" },
      principal_ref: principal.principal_ref,
      credential_generation: principal.credential_generation,
      deployment_generation: principal.deployment_generation,
      stage_index: RESEARCH_WORKFLOW_STAGES.indexOf("AUDIT_CLAIMS"),
      request_sha256: recoveredReceipt.request_sha256,
      attempt_ref: recoveredReceipt.attempt_ref,
      output_object_ref: recoveredReceipt.output_manifest.object_ref,
      expected_revision: fixture.stage14.investigation_ref.revision,
      budget_receipt_ref: recoveredReceipt.budget_receipt_ref,
      budget_expires_at_ms: Date.now() + 300_000,
    });
    expect(mismatched).toBeNull();
    expect(fixture.auditProviderCalls()).toBe(1);
  }, 60_000);
});
