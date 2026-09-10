import { describe, expect, it } from "vitest";
import type { NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import type { InvestigationLedgerStore } from "@eliotr/research";
import type { StageRequest, WorkflowPrincipal } from "@eliotr/cloudflare-research";
import { freezeFixture, principal } from "./research-evidence-freeze-fixture.js";
import { committedFreezeSynthesisFixture } from "./research-synthesis-fixture.js";
import { createResearchStageHandlerFactory, SERVER_OWNED_FREEZE_HANDLER_GENERATION } from "../src/research-stage-handlers.js";
import { createEvidenceFreezeVerificationContextReader } from "../../../packages/cloudflare-research/src/research-evidence-freeze-composition.js";
import { createResearchVerificationStageHandler } from "../../../packages/cloudflare-research/src/research-verification-stage-handler.js";
import { decodeResearchVerificationResult } from "../../../packages/cloudflare-research/src/research-verification-result.js";
import { readWorkflowObject } from "@eliotr/cloudflare-workflows";


describe("FREEZE_EVIDENCE over committed exploratory W2 stages", () => {
  it("refuses the explicit freeze generation when its composition is absent", async () => {
    const handlers = createResearchStageHandlerFactory({
      kind: "server-owned-exploratory",
      generation: SERVER_OWNED_FREEZE_HANDLER_GENERATION,
      navigation: {} as NavigationReadAuthority,
      ledger: {} as InvestigationLedgerStore,
    });
    for (const stage of ["RECONCILE", "SYNTHESIZE", "MATERIALIZE"] as const) {
      const handler = handlers(stage);
      await expect(handler({ request: {} as StageRequest, principal: {} as WorkflowPrincipal,
        input_bytes: new Uint8Array(), attempt_ref: "missing-freeze", budget_receipt_ref: "missing-budget" }))
        .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    }
  });

  it("persists stage 10/11 from real stage 0/5 readbacks and replays without new effects", async () => {
    const f = await freezeFixture();
    const stage10: StageRequest = { ...f.stage_zero, stage: "RECONCILE", investigation_ref: f.pre_reconcile.investigation_ref,
      input_manifest: f.pre_reconcile.output_manifest };
    const reconcile = await f.executor.execute(stage10, principal, f.composition.reconcile);
    const stage11: StageRequest = { ...stage10, stage: "FREEZE_EVIDENCE", investigation_ref: reconcile.investigation_ref, input_manifest: reconcile.output_manifest };
    const frozen = await f.executor.execute(stage11, principal, f.composition.freeze);
    expect(frozen.stage).toBe("FREEZE_EVIDENCE");
    const replay = await f.executor.execute(stage11, principal, f.composition.freeze);
    expect(replay.receipt_ref).toBe(frozen.receipt_ref);
    expect(await f.db.prepare("SELECT COUNT(*) AS n FROM research_reference_manifest WHERE state='COMMITTED'").first<{ n: number }>()
      .then((row) => row?.n)).toBe(1);
  }, 30_000);

  it("refuses the committed freeze after its scope grant is revoked", async () => {
    const f = await freezeFixture();
    const stage10: StageRequest = { ...f.stage_zero, stage: "RECONCILE", investigation_ref: f.pre_reconcile.investigation_ref, input_manifest: f.pre_reconcile.output_manifest };
    const reconcile = await f.executor.execute(stage10, principal, f.composition.reconcile);
    const stage11: StageRequest = { ...stage10, stage: "FREEZE_EVIDENCE", investigation_ref: reconcile.investigation_ref, input_manifest: reconcile.output_manifest };
    const before = await f.db.prepare("SELECT COUNT(*) AS n FROM research_reference_manifest WHERE state='COMMITTED'").first<{ n: number }>();
    await f.db.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE snapshot_id=?1 AND snapshot_revision=?2 AND principal_ref=?3")
      .bind(f.scope.snapshot_id, f.scope.revision, principal.principal_ref).run();
    await expect(f.executor.execute(stage11, principal, f.composition.freeze))
      .rejects.toMatchObject({ code: "EVIDENCE_AUTHORIZATION_DENIED" });
    const after = await f.db.prepare("SELECT COUNT(*) AS n FROM research_reference_manifest WHERE state='COMMITTED'").first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
    expect(await f.db.prepare("SELECT COUNT(*) AS n FROM research_workflow_checkpoint WHERE operation_id=?1 AND stage_index=11")
      .bind(f.operation_id).first<{ n: number }>()).toEqual({ n: 0 });
  }, 30_000);

  it("consumes the committed freeze through the model stage and replays its durable result", async () => {
    const f = await committedFreezeSynthesisFixture();
    const first = await f.freeze.executor.execute(f.stage_twelve, principal, f.handler.handler);
    expect(first.stage).toBe("SYNTHESIZE");
    expect(f.provider_calls()).toBe(1);
    const evidence = f.stage_five.evidence_pack.resolved_evidence[0];
    if (evidence === undefined) throw new Error("stage five fixture has no resolved evidence");
    expect(f.request_bodies()).toHaveLength(1);
    const request = JSON.parse(f.request_bodies()[0] ?? "") as {
      readonly messages?: readonly { readonly role?: unknown; readonly content?: unknown }[];
    };
    const userMessage = request.messages?.find((message) => message.role === "user");
    if (userMessage === undefined || typeof userMessage.content !== "string") {
      throw new Error("gateway request has no user message");
    }
    const compiled = JSON.parse(userMessage.content) as {
      readonly evidence?: readonly { readonly evidence_handle_ref?: unknown; readonly quoted_content?: unknown }[];
      readonly prompt?: unknown;
    };
    expect(compiled.prompt).toContain("eliotr.research.synthesis-section-candidate.v1");
    expect(compiled.evidence).toHaveLength(1);
    expect(compiled.evidence?.[0]?.evidence_handle_ref).toEqual(evidence.handle.handle_ref);
    expect(compiled.evidence?.[0]?.quoted_content).toBe(evidence.exact_excerpt);
    const replay = await f.freeze.executor.execute(f.stage_twelve, principal, f.handler.handler);
    expect(replay.receipt_ref).toBe(first.receipt_ref);
    expect(f.provider_calls()).toBe(1);
  }, 30_000);

  it("verifies committed synthesis citations against current source authority", async () => {
    const f = await committedFreezeSynthesisFixture();
    const synthesis = await f.freeze.executor.execute(f.stage_twelve, principal, f.handler.handler);
    const stage13: StageRequest = { ...f.stage_twelve, stage: "VERIFY", investigation_ref: synthesis.investigation_ref,
      input_manifest: synthesis.output_manifest };
    const context = createEvidenceFreezeVerificationContextReader({
      database: f.freeze.db, work_bucket: f.freeze.bucket, manifest_store: f.freeze.freeze_store,
      read_stage_five: f.freeze.readers.read_stage_five,
    }, f.freeze.navigation, f.freeze.readers);
    const handler = createResearchVerificationStageHandler({
      database: f.freeze.db, work_bucket: f.freeze.bucket, navigation: f.freeze.navigation,
      evidence_resolver: f.freeze.resolver,
      recheck_authority: async () => ({ investigation_id: f.freeze.investigation_id,
        scope_snapshot_id: f.freeze.scope.snapshot_id, scope_snapshot_revision: f.freeze.scope.revision }),
      context,
    });
    const receipt = await f.freeze.executor.execute(stage13, principal, handler);
    const result = decodeResearchVerificationResult(await readWorkflowObject(f.freeze.bucket, receipt.output_manifest, true));
    const evidence = f.stage_five.evidence_pack.resolved_evidence[0];
    if (evidence === undefined) throw new Error("stage five fixture has no resolved evidence");
    expect(result.semantic_verification).toBe("NOT_EXECUTED");
    expect(result.source_verification.requested_handle_refs).toEqual([evidence.handle.handle_ref]);
    expect(result.source_verification.resolved[0]?.excerpt_sha256).toBe(evidence.handle.excerpt_sha256);
    expect(result.source_verification.resolved[0]?.authorization_receipt_ref).toBe((await f.freeze.navigation.current()).authorization_receipt_ref);
  }, 30_000);

  it("refuses VERIFY when the committed scope grant is revoked", async () => {
    const f = await committedFreezeSynthesisFixture();
    const synthesis = await f.freeze.executor.execute(f.stage_twelve, principal, f.handler.handler);
    const stage13: StageRequest = { ...f.stage_twelve, stage: "VERIFY", investigation_ref: synthesis.investigation_ref,
      input_manifest: synthesis.output_manifest };
    await f.freeze.db.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE snapshot_id=?1 AND snapshot_revision=?2 AND principal_ref=?3")
      .bind(f.freeze.scope.snapshot_id, f.freeze.scope.revision, principal.principal_ref).run();
    const context = createEvidenceFreezeVerificationContextReader({
      database: f.freeze.db, work_bucket: f.freeze.bucket, manifest_store: f.freeze.freeze_store,
      read_stage_five: f.freeze.readers.read_stage_five,
    }, f.freeze.navigation, f.freeze.readers);
    const handler = createResearchVerificationStageHandler({
      database: f.freeze.db, work_bucket: f.freeze.bucket, navigation: f.freeze.navigation,
      evidence_resolver: f.freeze.resolver,
      recheck_authority: async () => ({ investigation_id: f.freeze.investigation_id,
        scope_snapshot_id: f.freeze.scope.snapshot_id, scope_snapshot_revision: f.freeze.scope.revision }),
      context,
    });
    const inputBytes = await readWorkflowObject(f.freeze.bucket, stage13.input_manifest, true);
    await expect(handler({ request: stage13, principal, input_bytes: inputBytes,
      attempt_ref: "verification-revoked-attempt", budget_receipt_ref: "verification-revoked-budget" }))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
  }, 30_000);
});
