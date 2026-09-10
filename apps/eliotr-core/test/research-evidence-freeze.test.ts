import { describe, expect, it } from "vitest";
import type { NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import type { InvestigationLedgerStore } from "@eliotr/research";
import type { StageRequest, WorkflowPrincipal } from "@eliotr/cloudflare-research";
import { freezeFixture, principal } from "./research-evidence-freeze-fixture.js";
import { committedFreezeSynthesisFixture } from "./research-synthesis-fixture.js";
import { createResearchStageHandlerFactory, SERVER_OWNED_FREEZE_HANDLER_GENERATION } from "../src/research-stage-handlers.js";


describe("FREEZE_EVIDENCE over committed exploratory W2 stages", () => {
  it("refuses the explicit freeze generation when its composition is absent", async () => {
    const handlers = createResearchStageHandlerFactory({
      kind: "server-owned-exploratory",
      generation: SERVER_OWNED_FREEZE_HANDLER_GENERATION,
      navigation: {} as NavigationReadAuthority,
      ledger: {} as InvestigationLedgerStore,
    });
    const handler = handlers("RECONCILE");
    await expect(handler({ request: {} as StageRequest, principal: {} as WorkflowPrincipal,
      input_bytes: new Uint8Array(), attempt_ref: "missing-freeze", budget_receipt_ref: "missing-budget" }))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
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
    const replay = await f.freeze.executor.execute(f.stage_twelve, principal, f.handler.handler);
    expect(replay.receipt_ref).toBe(first.receipt_ref);
    expect(f.provider_calls()).toBe(1);
  }, 30_000);
});
