import { canonicalEvidenceJson, evidenceSha256 } from "@eliotr/cloudflare-evidence";
import {
  createEvidenceFreezePostSynthesisContextReader,
} from "@eliotr/cloudflare-research";
import {
  decodeResearchClaimAuditResult,
  decodeResearchCitationsResult,
} from "@eliotr/cloudflare-research-stages";
import {
  readCommittedStageLineage,
  readWorkflowObject,
  parseRequest,
  textDigest,
  WorkflowCheckpointStore,
  type StageRequest,
} from "@eliotr/cloudflare-workflows";
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import {
  auditStageLineage,
  readAuditStageInput,
  readAuditStageResult,
  researchClaimAuditStageFixture,
} from "./research-claim-audit-fixture.js";
import { principal } from "./research-evidence-freeze-fixture.js";
import {
  createResearchStageHandlerFactory,
  SERVER_OWNED_FREEZE_HANDLER_GENERATION,
} from "../src/research-stage-handlers.js";
import { describe, expect, it } from "vitest";

function refKey(ref: { readonly id: string; readonly revision: number }): string {
  return `${ref.id}:${ref.revision}`;
}

function sortedRefKeys(refs: readonly { readonly id: string; readonly revision: number }[]): string[] {
  return refs.map(refKey).sort();
}

async function checkpointCount(
  fixture: Awaited<ReturnType<typeof researchClaimAuditStageFixture>>,
  stage: "RESOLVE_CITATIONS",
): Promise<number> {
  const row = await fixture.fixture.freeze.db.prepare(
    "SELECT COUNT(*) AS n FROM research_workflow_checkpoint WHERE operation_id=?1 AND stage_index=?2",
  ).bind(fixture.fixture.freeze.operation_id, RESEARCH_WORKFLOW_STAGES.indexOf(stage))
    .first<{ readonly n: number }>();
  return row?.n ?? 0;
}

async function citationReceiptRow(
  fixture: Awaited<ReturnType<typeof researchClaimAuditStageFixture>>,
  receipt: { readonly id: string; readonly revision: number },
): Promise<{
  readonly receipt_json: string;
  readonly receipt_sha256: string;
  readonly requested_count: number;
  readonly resolved_count: number;
  readonly all_material_citations_resolved: number;
  readonly verified: number;
} | null> {
  return fixture.fixture.freeze.db.prepare(
    "SELECT r.receipt_json, r.receipt_sha256, r.requested_count, r.resolved_count, " +
      "r.all_material_citations_resolved, g.verified " +
      "FROM citation_resolution_receipt r JOIN citation_resolution_guard g " +
      "ON g.receipt_id=r.receipt_id AND g.receipt_revision=r.revision " +
      "WHERE r.receipt_id=?1 AND r.revision=?2 LIMIT 1",
  ).bind(receipt.id, receipt.revision).first<{
    readonly receipt_json: string;
    readonly receipt_sha256: string;
    readonly requested_count: number;
    readonly resolved_count: number;
    readonly all_material_citations_resolved: number;
    readonly verified: number;
  }>();
}

describe("RESOLVE_CITATIONS W2 over committed AUDIT_CLAIMS", () => {
  it("resolves two real audited handles and replays the terminal receipt byte-for-byte", async () => {
    const fixture = await researchClaimAuditStageFixture({ include_counterevidence: true });
    const auditInput = await readAuditStageInput(fixture);
    const packedRefs = auditInput.context.stage_five.evidence_pack.resolved_evidence
      .map((item) => item.handle.handle_ref);
    const frozenRefs = auditInput.context.freeze.included_evidence.map((item) => item.handle_ref);
    const manifestRefs = auditInput.context.manifest.allowed_evidence_handle_refs;
    expect(packedRefs).toHaveLength(2);
    expect(sortedRefKeys(frozenRefs)).toEqual(sortedRefKeys(packedRefs));
    expect(sortedRefKeys(manifestRefs)).toEqual(sortedRefKeys(packedRefs));
    expect(auditInput.evidence).toHaveLength(2);
    expect(auditInput.evidence.every((item) => item.source_class === "document")).toBe(true);

    const auditReceipt = await fixture.fixture.freeze.executor.execute(
      fixture.stage14,
      principal,
      fixture.auditHandler,
    );
    const auditBytes = await readAuditStageResult(fixture, auditReceipt);
    const auditResult = decodeResearchClaimAuditResult(auditBytes);
    const auditClaim = auditResult.claims[0];
    if (auditClaim === undefined) throw new Error("audit fixture has no compact claim");
    expect(sortedRefKeys([
      ...auditClaim.support_handle_refs,
      ...auditClaim.counterevidence_handle_refs,
    ])).toEqual(sortedRefKeys(packedRefs));
    expect(auditClaim.support_handle_refs).toHaveLength(1);
    expect(auditClaim.counterevidence_handle_refs).toHaveLength(1);

    const stage15: StageRequest = {
      ...fixture.stage14,
      stage: "RESOLVE_CITATIONS",
      investigation_ref: auditReceipt.investigation_ref,
      input_manifest: auditReceipt.output_manifest,
    };
    const context = createEvidenceFreezePostSynthesisContextReader({
      database: fixture.fixture.freeze.db,
      work_bucket: fixture.fixture.freeze.bucket,
      manifest_store: fixture.fixture.freeze.freeze_store,
      read_stage_five: fixture.fixture.freeze.readers.read_stage_five,
    }, fixture.fixture.freeze.navigation, fixture.fixture.freeze.readers, "RESOLVE_CITATIONS");
    const stage15Handler = createResearchStageHandlerFactory({
      kind: "server-owned-exploratory",
      generation: SERVER_OWNED_FREEZE_HANDLER_GENERATION,
      navigation: fixture.fixture.freeze.navigation,
      ledger: fixture.fixture.freeze.ledger,
      resolve_citations: {
        database: fixture.fixture.freeze.db,
        navigation: fixture.fixture.freeze.navigation,
        evidence_resolver: fixture.fixture.freeze.resolver,
        context,
      },
    })("RESOLVE_CITATIONS");

    const first = await fixture.fixture.freeze.executor.execute(stage15, principal, stage15Handler);
    const firstBytes = await readWorkflowObject(fixture.fixture.freeze.bucket, first.output_manifest, true);
    const result = await decodeResearchCitationsResult(firstBytes);

    expect(first.stage).toBe("RESOLVE_CITATIONS");
    expect(result.protocol).toBe("eliotr.research.citations.v2");
    expect(result.operation_id).toBe(stage15.operation_id);
    expect(result.investigation_ref).toEqual(stage15.investigation_ref);
    expect(first.investigation_ref.revision).toBe(stage15.investigation_ref.revision + 1);
    expect(result.stage_attempt_ref).toBe(first.attempt_ref);
    expect(result.stage_request_sha256).toBe(first.request_sha256);
    expect(result.audit.protocol).toBe("eliotr.research.audit-claims-result.v1");
    expect(result.audit.stage_attempt_ref).toBe(auditReceipt.attempt_ref);
    expect(result.audit.stage_request_sha256).toBe(auditReceipt.request_sha256);
    expect(result.audit.output_sha256).toBe(stage15.input_manifest.sha256);
    expect(result.audit.synthesis).toEqual(auditResult.synthesis);
    expect(result.audit.verification).toEqual(auditResult.verification);
    expect(result.audit.audit_input_sha256).toBe(auditResult.audit_input_sha256);
    expect(result.audit.normalization_binding_sha256).toBe(auditResult.verification.normalization_binding_sha256);
    expect(result.freeze_ref).toEqual(auditResult.freeze_ref);
    expect(result.scope_snapshot_ref).toEqual(auditResult.scope_snapshot_ref);
    expect(result.manifest_ref).toEqual(auditResult.manifest_ref);
    expect(result.evidence_pack_ref).toEqual(auditInput.context.stage_five.evidence_pack.pack_ref);
    expect(result.claims).toEqual(auditResult.claims);

    const receipt = result.citation_resolution_receipt;
    expect(sortedRefKeys(receipt.requested_handle_refs)).toEqual(sortedRefKeys(packedRefs));
    expect(receipt.resolved).toHaveLength(2);
    expect(receipt.rejected).toHaveLength(0);
    expect(receipt.requested_count).toBe(2);
    expect(receipt.resolved_count).toBe(2);
    expect(receipt.all_material_citations_resolved).toBe(true);
    const row = await citationReceiptRow(fixture, receipt.receipt_ref);
    expect(row).not.toBeNull();
    if (row === null) throw new Error("citation resolver did not persist a receipt");
    expect(JSON.parse(row.receipt_json) as unknown).toEqual(receipt);
    expect(canonicalEvidenceJson(JSON.parse(row.receipt_json) as unknown)).toBe(row.receipt_json);
    expect(await evidenceSha256(JSON.parse(row.receipt_json) as unknown)).toBe(row.receipt_sha256);
    expect(row.requested_count).toBe(receipt.requested_count);
    expect(row.resolved_count).toBe(receipt.resolved_count);
    expect(row.all_material_citations_resolved).toBe(1);
    expect(row.verified).toBe(1);

    const resultText = new TextDecoder().decode(firstBytes);
    expect(resultText).not.toContain("Pinned support content");
    expect(resultText).not.toContain("Pinned counterevidence content");
    expect(fixture.fixture.provider_calls()).toBe(1);
    expect(fixture.auditProviderCalls()).toBe(1);
    expect(await checkpointCount(fixture, "RESOLVE_CITATIONS")).toBe(1);
    const committed = await readCommittedStageLineage(
      new WorkflowCheckpointStore(fixture.fixture.freeze.db),
      fixture.fixture.freeze.operation_id,
      "RESOLVE_CITATIONS",
    );
    expect(committed.request).toEqual(stage15);
    expect(committed.receipt).toEqual(first);
    expect((await auditStageLineage(fixture)).receipt).toEqual(auditReceipt);

    const replay = await fixture.fixture.freeze.executor.execute(stage15, principal, stage15Handler);
    expect(replay).toEqual(first);
    expect(await readWorkflowObject(fixture.fixture.freeze.bucket, replay.output_manifest, true)).toEqual(firstBytes);
    expect(fixture.fixture.provider_calls()).toBe(1);
    expect(fixture.auditProviderCalls()).toBe(1);
    expect(await checkpointCount(fixture, "RESOLVE_CITATIONS")).toBe(1);
    expect(await citationReceiptRow(fixture, receipt.receipt_ref)).toEqual(row);
  }, 60_000);

  it("rejects source authority drift after the final context read", async () => {
    const fixture = await researchClaimAuditStageFixture({ include_counterevidence: true });
    const auditInput = await readAuditStageInput(fixture);
    const sourceRevisionRef = auditInput.evidence[0]?.handle.source_revision_ref;
    if (sourceRevisionRef === undefined) throw new Error("audit fixture has no source revision");
    const auditReceipt = await fixture.fixture.freeze.executor.execute(
      fixture.stage14,
      principal,
      fixture.auditHandler,
    );
    const stage15: StageRequest = {
      ...fixture.stage14,
      stage: "RESOLVE_CITATIONS",
      investigation_ref: auditReceipt.investigation_ref,
      input_manifest: auditReceipt.output_manifest,
    };
    const baseContext = createEvidenceFreezePostSynthesisContextReader({
      database: fixture.fixture.freeze.db,
      work_bucket: fixture.fixture.freeze.bucket,
      manifest_store: fixture.fixture.freeze.freeze_store,
      read_stage_five: fixture.fixture.freeze.readers.read_stage_five,
    }, fixture.fixture.freeze.navigation, fixture.fixture.freeze.readers, "RESOLVE_CITATIONS");
    let contextReads = 0;
    const context = {
      async read(input: Parameters<typeof baseContext.read>[0]) {
        const value = await baseContext.read(input);
        contextReads += 1;
        if (contextReads === 2) {
          const grantBefore = await fixture.fixture.freeze.navigation.current();
          await fixture.fixture.freeze.db.prepare(
            "UPDATE source_admission_decision SET decision='QUARANTINED' " +
              "WHERE source_revision_ref=?1 AND decision='ADMITTED'",
          ).bind(sourceRevisionRef).run();
          const admission = await fixture.fixture.freeze.db.prepare(
            "SELECT decision FROM source_admission_decision WHERE source_revision_ref=?1 " +
              "ORDER BY created_at DESC LIMIT 1",
          ).bind(sourceRevisionRef).first<{ readonly decision: string }>();
          expect(admission?.decision).toBe("QUARANTINED");
          expect(await fixture.fixture.freeze.navigation.current()).toEqual(grantBefore);
        }
        return value;
      },
    };
    const stage15Handler = createResearchStageHandlerFactory({
      kind: "server-owned-exploratory",
      generation: SERVER_OWNED_FREEZE_HANDLER_GENERATION,
      navigation: fixture.fixture.freeze.navigation,
      ledger: fixture.fixture.freeze.ledger,
      resolve_citations: {
        database: fixture.fixture.freeze.db,
        navigation: fixture.fixture.freeze.navigation,
        evidence_resolver: fixture.fixture.freeze.resolver,
        context,
      },
    })("RESOLVE_CITATIONS");

    const normalizedStage15 = parseRequest(stage15);
    const stage15RequestSha256 = await textDigest(JSON.stringify(normalizedStage15));
    await expect(fixture.fixture.freeze.executor.execute(stage15, principal, stage15Handler))
      .rejects.toMatchObject({ code: "WORKFLOW_EFFECT_UNCERTAIN" });
    expect(contextReads).toBe(2);
    const pending = await fixture.fixture.freeze.db.prepare(
      "SELECT state, output_json, request_json, request_sha256 FROM research_workflow_attempt " +
        "WHERE operation_id=?1 AND stage_index=?2 AND request_sha256=?3 LIMIT 1",
    ).bind(
      fixture.fixture.freeze.operation_id,
      RESEARCH_WORKFLOW_STAGES.indexOf("RESOLVE_CITATIONS"),
      stage15RequestSha256,
    ).first<{
      readonly state: string;
      readonly output_json: string | null;
      readonly request_json: string;
      readonly request_sha256: string;
    }>();
    if (pending === null) throw new Error("Stage15 attempt readback is missing");
    expect(pending.state).toBe("STARTED");
    expect(pending.output_json).toBeNull();
    expect(pending.request_sha256).toBe(stage15RequestSha256);
    expect(JSON.parse(pending.request_json) as unknown).toEqual(normalizedStage15);
    expect(await checkpointCount(fixture, "RESOLVE_CITATIONS")).toBe(0);
    expect(fixture.fixture.provider_calls()).toBe(1);
    expect(fixture.auditProviderCalls()).toBe(1);
  }, 60_000);
});
