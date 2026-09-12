import { env } from "cloudflare:workers";
import {
  canonicalEvidenceJson,
  createR2EvidenceContentPort,
  evidenceSha256,
  readBoundCitationResolutionReceipt,
  readEvidenceResolutionReceipt,
  readResolvedCitationEvidence,
} from "@eliotr/cloudflare-evidence";
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

async function citationBindingRow(
  fixture: Awaited<ReturnType<typeof researchClaimAuditStageFixture>>,
  operationId: string,
): Promise<{
  readonly operation_id: string;
  readonly stage_index: number;
  readonly attempt_ref: string;
  readonly request_sha256: string;
  readonly receipt_id: string;
  readonly receipt_revision: number;
  readonly receipt_sha256: string;
  readonly bound_at: string;
} | null> {
  return fixture.fixture.freeze.db.prepare(
    "SELECT operation_id,stage_index,attempt_ref,request_sha256,receipt_id,receipt_revision, " +
      "receipt_sha256,bound_at FROM research_workflow_citation_binding " +
      "WHERE operation_id=?1 AND stage_index=?2 LIMIT 1",
  ).bind(operationId, RESEARCH_WORKFLOW_STAGES.indexOf("RESOLVE_CITATIONS")).first<{
    readonly operation_id: string;
    readonly stage_index: number;
    readonly attempt_ref: string;
    readonly request_sha256: string;
    readonly receipt_id: string;
    readonly receipt_revision: number;
    readonly receipt_sha256: string;
    readonly bound_at: string;
  }>();
}

async function receiptCounts(
  fixture: Awaited<ReturnType<typeof researchClaimAuditStageFixture>>,
): Promise<{ readonly evidence: number; readonly citation: number }> {
  const row = await fixture.fixture.freeze.db.prepare(
    "SELECT (SELECT COUNT(*) FROM evidence_resolution_receipt) AS evidence, " +
      "(SELECT COUNT(*) FROM citation_resolution_receipt) AS citation",
  ).first<{ readonly evidence: number; readonly citation: number }>();
  if (row === null) throw new Error("receipt count readback is missing");
  return row;
}

async function evidenceReceiptRow(
  fixture: Awaited<ReturnType<typeof researchClaimAuditStageFixture>>,
  item: { readonly verification_receipt_ref: string; readonly handle_ref: { readonly id: string; readonly revision: number } },
): Promise<{ readonly receipt_json: string; readonly receipt_sha256: string } | null> {
  return fixture.fixture.freeze.db.prepare(
    "SELECT receipt_json,receipt_sha256 FROM evidence_resolution_receipt " +
      "WHERE handle_id=?1 AND handle_revision=?2 " +
      "AND (receipt_id || ':' || CAST(revision AS TEXT))=?3 LIMIT 1",
  ).bind(item.handle_ref.id, item.handle_ref.revision, item.verification_receipt_ref)
    .first<{ readonly receipt_json: string; readonly receipt_sha256: string }>();
}

interface EvidenceGuardRow {
  readonly handle_id: string;
  readonly handle_revision: number;
  readonly receipt_id: string;
  readonly receipt_revision: number;
  readonly identity_digest: string;
  readonly verified: number;
  readonly created_at: string;
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
    const binding = await citationBindingRow(fixture, stage15.operation_id);
    expect(binding).toEqual({
      operation_id: stage15.operation_id,
      stage_index: RESEARCH_WORKFLOW_STAGES.indexOf("RESOLVE_CITATIONS"),
      attempt_ref: first.attempt_ref,
      request_sha256: first.request_sha256,
      receipt_id: receipt.receipt_ref.id,
      receipt_revision: receipt.receipt_ref.revision,
      receipt_sha256: row.receipt_sha256,
      bound_at: expect.any(String),
    });
    if (binding === null) throw new Error("citation workflow binding row is missing");
    expect(binding.bound_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
    );

    const readbackReceiptCounts = await receiptCounts(fixture);
    const readbackProviderCalls = fixture.fixture.provider_calls();
    const readbackAuditProviderCalls = fixture.auditProviderCalls();
    const currentGrant = await fixture.fixture.freeze.navigation.current();
    const boundReadbackInput = {
      attempt_binding: {
        operation_id: stage15.operation_id,
        attempt_ref: first.attempt_ref,
        request_sha256: first.request_sha256,
      },
      access: fixture.fixture.freeze.navigation.access,
      scope_snapshot_ref: {
        id: fixture.fixture.freeze.navigation.scope.snapshot_id,
        revision: fixture.fixture.freeze.navigation.scope.revision,
      },
      authorization_receipt_ref: currentGrant.authorization_receipt_ref,
    } as const;
    const boundReadback = await readBoundCitationResolutionReceipt(
      fixture.fixture.freeze.db,
      boundReadbackInput,
    );
    expect(boundReadback).not.toBeNull();
    if (boundReadback === null) throw new Error("bound citation receipt readback is missing");
    expect(canonicalEvidenceJson(boundReadback)).toBe(row.receipt_json);
    expect(await evidenceSha256(boundReadback)).toBe(row.receipt_sha256);
    expect(boundReadback.receipt_ref).toEqual(receipt.receipt_ref);
    await expect(readBoundCitationResolutionReceipt(fixture.fixture.freeze.db, {
      ...boundReadbackInput,
      attempt_binding: {
        ...boundReadbackInput.attempt_binding,
        attempt_ref: `${first.attempt_ref}-wrong`,
      },
    })).rejects.toMatchObject({ code: "EVIDENCE_SETTLEMENT_UNCERTAIN", retryable: true });
    expect(await readBoundCitationResolutionReceipt(fixture.fixture.freeze.db, {
      ...boundReadbackInput,
      attempt_binding: {
        ...boundReadbackInput.attempt_binding,
        operation_id: `${stage15.operation_id}-missing`,
      },
    })).toBeNull();
    await expect(readBoundCitationResolutionReceipt(fixture.fixture.freeze.db, {
      ...boundReadbackInput,
      access: {
        ...boundReadbackInput.access,
        principal_ref: `${boundReadbackInput.access.principal_ref}-wrong`,
      },
    })).rejects.toMatchObject({ code: "EVIDENCE_SETTLEMENT_UNCERTAIN", retryable: true });
    await expect(readBoundCitationResolutionReceipt(fixture.fixture.freeze.db, {
      ...boundReadbackInput,
      scope_snapshot_ref: {
        ...boundReadbackInput.scope_snapshot_ref,
        revision: boundReadbackInput.scope_snapshot_ref.revision + 1,
      },
    })).rejects.toMatchObject({ code: "EVIDENCE_SETTLEMENT_UNCERTAIN", retryable: true });
    expect(await receiptCounts(fixture)).toEqual(readbackReceiptCounts);
    expect(fixture.fixture.provider_calls()).toBe(readbackProviderCalls);
    expect(fixture.auditProviderCalls()).toBe(readbackAuditProviderCalls);
    const firstItem = receipt.resolved[0];
    const secondItem = receipt.resolved[1];
    if (firstItem === undefined || secondItem === undefined) {
      throw new Error("citation receipt resolved members are incomplete");
    }
    expect(refKey(firstItem.handle_ref)).not.toBe(refKey(secondItem.handle_ref));
    const savedEvidenceReadbacks = new Map<
      string,
      NonNullable<Awaited<ReturnType<typeof readEvidenceResolutionReceipt>>>
    >();
    for (const item of [firstItem, secondItem]) {
      const readback = await readEvidenceResolutionReceipt(fixture.fixture.freeze.db, {
        verification_receipt_ref: item.verification_receipt_ref,
        expected_handle_ref: item.handle_ref,
      });
      expect(readback).not.toBeNull();
      if (readback === null) throw new Error("saved evidence resolution receipt is missing");
      const stored = await evidenceReceiptRow(fixture, item);
      expect(stored).not.toBeNull();
      if (stored === null) throw new Error("stored evidence resolution receipt row is missing");
      expect(canonicalEvidenceJson(readback)).toBe(stored.receipt_json);
      expect(await evidenceSha256(readback)).toBe(stored.receipt_sha256);
      expect(readback.handle_ref).toEqual(item.handle_ref);
      expect(readback.excerpt_sha256).toBe(item.excerpt_sha256);
      expect(refKey(readback.receipt_ref)).toBe(item.verification_receipt_ref);
      savedEvidenceReadbacks.set(refKey(item.handle_ref), readback);
    }
    expect(await readEvidenceResolutionReceipt(fixture.fixture.freeze.db, {
      verification_receipt_ref: firstItem.verification_receipt_ref,
      expected_handle_ref: secondItem.handle_ref,
    })).toBeNull();
    expect(await readEvidenceResolutionReceipt(fixture.fixture.freeze.db, {
      verification_receipt_ref: "missing-evidence-resolution-ref",
      expected_handle_ref: firstItem.handle_ref,
    })).toBeNull();
    expect(await receiptCounts(fixture)).toEqual(readbackReceiptCounts);
    expect(fixture.fixture.provider_calls()).toBe(readbackProviderCalls);
    expect(fixture.auditProviderCalls()).toBe(readbackAuditProviderCalls);

    const evidenceContent = createR2EvidenceContentPort({
      evidence_bucket: (env as unknown as { readonly EVIDENCE_BUCKET: R2Bucket }).EVIDENCE_BUCKET,
    });
    const materialized = await readResolvedCitationEvidence({
      database: fixture.fixture.freeze.db,
      content: evidenceContent,
      navigation: fixture.fixture.freeze.navigation,
      citation: boundReadback,
    });
    expect(materialized).toHaveLength(2);
    expect(sortedRefKeys(materialized.map((item) => item.handle.handle_ref))).toEqual(
      sortedRefKeys(auditInput.evidence.map((item) => item.handle.handle_ref)),
    );
    for (const actual of materialized) {
      const key = refKey(actual.handle.handle_ref);
      const admitted = auditInput.evidence.find((item) => refKey(item.handle.handle_ref) === key);
      const saved = savedEvidenceReadbacks.get(key);
      expect(admitted).toBeDefined();
      expect(saved).toBeDefined();
      if (admitted === undefined || saved === undefined) throw new Error("materialized evidence binding is missing");
      expect(actual.handle).toEqual(admitted.handle);
      expect(actual.exact_excerpt).toBe(admitted.exact_excerpt);
      expect(actual.verification_receipt_ref).toBe(refKey(saved.receipt_ref));
      expect(actual.resolved_at).toBe(saved.resolved_at);
    }
    const corruptedContent = {
      async materialize(
        source: Parameters<typeof evidenceContent.materialize>[0],
        anchor: Parameters<typeof evidenceContent.materialize>[1],
      ) {
        const value = await evidenceContent.materialize(source, anchor);
        return { ...value, exact_excerpt: `${value.exact_excerpt}\ncorrupted` };
      },
    };
    await expect(readResolvedCitationEvidence({
      database: fixture.fixture.freeze.db,
      content: corruptedContent,
      navigation: fixture.fixture.freeze.navigation,
      citation: boundReadback,
    })).rejects.toMatchObject({
      code: "EVIDENCE_OBJECT_INTEGRITY",
      invalidation_state: "BROKEN_INTEGRITY",
    });
    expect(await receiptCounts(fixture)).toEqual(readbackReceiptCounts);
    expect(fixture.fixture.provider_calls()).toBe(readbackProviderCalls);
    expect(fixture.auditProviderCalls()).toBe(readbackAuditProviderCalls);

    const firstGuard = await fixture.fixture.freeze.db.prepare(
      "SELECT g.handle_id,g.handle_revision,g.receipt_id,g.receipt_revision,g.identity_digest, " +
        "g.verified,g.created_at FROM evidence_resolution_guard g " +
        "JOIN evidence_resolution_receipt r ON r.receipt_id=g.receipt_id " +
        "AND r.revision=g.receipt_revision WHERE g.handle_id=?1 AND g.handle_revision=?2 " +
        "AND (r.receipt_id || ':' || CAST(r.revision AS TEXT))=?3 LIMIT 1",
    ).bind(
      firstItem.handle_ref.id,
      firstItem.handle_ref.revision,
      firstItem.verification_receipt_ref,
    ).first<EvidenceGuardRow>();
    expect(firstGuard).not.toBeNull();
    if (firstGuard === null) throw new Error("saved evidence resolution guard is missing");
    try {
      await fixture.fixture.freeze.db.prepare(
        "DELETE FROM evidence_resolution_guard WHERE handle_id=?1 AND handle_revision=?2 " +
          "AND receipt_id=?3 AND receipt_revision=?4",
      ).bind(
        firstGuard.handle_id,
        firstGuard.handle_revision,
        firstGuard.receipt_id,
        firstGuard.receipt_revision,
      ).run();
      await expect(readEvidenceResolutionReceipt(fixture.fixture.freeze.db, {
        verification_receipt_ref: firstItem.verification_receipt_ref,
        expected_handle_ref: firstItem.handle_ref,
      })).rejects.toMatchObject({ code: "EVIDENCE_INPUT_INVALID" });
    } finally {
      await fixture.fixture.freeze.db.prepare(
        "INSERT INTO evidence_resolution_guard " +
          "(handle_id,handle_revision,receipt_id,receipt_revision,identity_digest,verified,created_at) " +
          "VALUES (?1,?2,?3,?4,?5,?6,?7)",
      ).bind(
        firstGuard.handle_id,
        firstGuard.handle_revision,
        firstGuard.receipt_id,
        firstGuard.receipt_revision,
        firstGuard.identity_digest,
        firstGuard.verified,
        firstGuard.created_at,
      ).run();
    }
    const restoredGuard = await fixture.fixture.freeze.db.prepare(
      "SELECT handle_id,handle_revision,receipt_id,receipt_revision,identity_digest,verified,created_at " +
        "FROM evidence_resolution_guard WHERE handle_id=?1 AND handle_revision=?2 " +
        "AND receipt_id=?3 AND receipt_revision=?4 LIMIT 1",
    ).bind(
      firstGuard.handle_id,
      firstGuard.handle_revision,
      firstGuard.receipt_id,
      firstGuard.receipt_revision,
    ).first<EvidenceGuardRow>();
    expect(restoredGuard).toEqual(firstGuard);
    expect(await receiptCounts(fixture)).toEqual(readbackReceiptCounts);
    expect(fixture.fixture.provider_calls()).toBe(readbackProviderCalls);
    expect(fixture.auditProviderCalls()).toBe(readbackAuditProviderCalls);

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
    let currentReads = 0;
    const lateWithdrawalNavigation = {
      ...fixture.fixture.freeze.navigation,
      current: async (...args: Parameters<typeof fixture.fixture.freeze.navigation.current>) => {
        const grant = await fixture.fixture.freeze.navigation.current(...args);
        if (++currentReads === 3) {
          const sourceRevisionRef = auditInput.evidence[0]?.handle.source_revision_ref;
          if (sourceRevisionRef === undefined) throw new Error("audit fixture has no source revision");
          expect(grant).toEqual(currentGrant);
          const update = await fixture.fixture.freeze.db.prepare(
            "UPDATE source_admission_decision SET decision='QUARANTINED' WHERE source_revision_ref=?1 " +
              "AND decision='ADMITTED' RETURNING source_namespace_id,source_owner_generation,source_revision_ref,decision",
          ).bind(sourceRevisionRef).first<Record<string, string>>();
          expect(update).toEqual({ source_namespace_id: auditInput.evidence[0]?.handle.source_namespace_id,
            source_owner_generation: auditInput.evidence[0]?.handle.source_owner_generation,
            source_revision_ref: sourceRevisionRef, decision: "QUARANTINED" });
        }
        return grant;
      },
    };
    await expect(readResolvedCitationEvidence({
      database: fixture.fixture.freeze.db,
      content: evidenceContent,
      navigation: lateWithdrawalNavigation,
      citation: boundReadback,
    })).rejects.toMatchObject({ code: "NAVIGATION_ARTIFACT_INVALID" });
    expect(currentReads).toBe(3);
    expect(await receiptCounts(fixture)).toEqual(readbackReceiptCounts);
    expect([fixture.fixture.provider_calls(), fixture.auditProviderCalls()]).toEqual([
      readbackProviderCalls,
      readbackAuditProviderCalls,
    ]);
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
