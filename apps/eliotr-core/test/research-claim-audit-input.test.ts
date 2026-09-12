import { describe, expect, it } from "vitest";
import type { NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import type { StageRequest } from "@eliotr/cloudflare-research";
import { createEvidenceFreezeVerificationContextReader } from "../../../packages/cloudflare-research/src/research-evidence-freeze-composition.js";
import {
  createResearchClaimAuditInputReaderFromFreeze,
  type ResearchClaimAuditPolicy,
  type ResearchClaimAuditVerifierAuthority,
  type ResearchClaimAuditVerifierSelection,
  type ResearchVerificationV2Config,
} from "@eliotr/cloudflare-research-stages";
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import { readWorkflowObject } from "@eliotr/cloudflare-workflows";
import { committedFreezeSynthesisFixture } from "./research-synthesis-fixture.js";
import { principal } from "./research-evidence-freeze-fixture.js";
import { createResearchStageHandlerFactory, SERVER_OWNED_FREEZE_HANDLER_GENERATION } from "../src/research-stage-handlers.js";

const VERIFIER_REF = "stage14-test-verifier";
const NORMALIZATION_CONFIG: ResearchVerificationV2Config = {
  section_ref: { id: "verification-section-v2", revision: 1 },
  required_precision: "exact-excerpt",
  required_source_class: "official",
};
const AUDIT_POLICY: ResearchClaimAuditPolicy = {
  required_dimensions: ["value_or_measurement_verification"],
  source_requirement_applicable: true,
  excerpt_requirement_applicable: true,
  coverage_limitations: [],
  unsupported_precision: [],
};

function verifierSelection(
  fixture: Awaited<ReturnType<typeof committedFreezeSynthesisFixture>>,
): ResearchClaimAuditVerifierSelection {
  const authority: ResearchClaimAuditVerifierAuthority = {
    allowed_verifier_refs: [VERIFIER_REF],
    verifier_ref: VERIFIER_REF,
    verifier_schema_generation: "stage14-verifier-schema-v1",
    deployment: fixture.freeze.profile_definition.deployment,
    deployment_generation: principal.deployment_generation,
    qualification_receipt_ref: "stage14-verifier-qualification",
    qualification_expires_at: fixture.freeze.scope.expires_at,
    qualified: true,
    current: true,
  };
  return { authority, read_current: async () => authority };
}

async function committedAuditInputFixture(
  allowedVerifierRefs: readonly string[],
) {
  const fixture = await committedFreezeSynthesisFixture({
    candidate_protocol: "v2",
    synthesis_prompt: "Produce eliotr.research.synthesis-claims-candidate.v2 from the frozen evidence.",
    allowed_verifier_refs: allowedVerifierRefs,
  });
  const synthesis = await fixture.freeze.executor.execute(fixture.stage_twelve, principal, fixture.handler.handler);
  const stage13: StageRequest = {
    ...fixture.stage_twelve,
    stage: "VERIFY",
    investigation_ref: synthesis.investigation_ref,
    input_manifest: synthesis.output_manifest,
  };
  const verification = createResearchStageHandlerFactory({
    kind: "server-owned-exploratory",
    generation: SERVER_OWNED_FREEZE_HANDLER_GENERATION,
    navigation: fixture.freeze.navigation,
    ledger: fixture.freeze.ledger,
    verification: {
      database: fixture.freeze.db,
      work_bucket: fixture.freeze.bucket,
      navigation: fixture.freeze.navigation,
      evidence_resolver: fixture.freeze.resolver,
      recheck_authority: async () => ({
        investigation_id: fixture.freeze.investigation_id,
        scope_snapshot_id: fixture.freeze.scope.snapshot_id,
        scope_snapshot_revision: fixture.freeze.scope.revision,
      }),
      context: createVerificationContext(fixture),
      v2_config: NORMALIZATION_CONFIG,
    },
  })("VERIFY");
  const verifyReceipt = await fixture.freeze.executor.execute(stage13, principal, verification);
  const stage14: StageRequest = {
    ...stage13,
    stage: "AUDIT_CLAIMS",
    investigation_ref: verifyReceipt.investigation_ref,
    input_manifest: verifyReceipt.output_manifest,
  };
  const inputBytes = await readWorkflowObject(fixture.freeze.bucket, stage14.input_manifest, true);
  const auditNavigation = fixture.freeze.navigation;
  const reader = createResearchClaimAuditInputReaderFromFreeze(
    {
      database: fixture.freeze.db,
      work_bucket: fixture.freeze.bucket,
      manifest_store: fixture.freeze.freeze_store,
      read_stage_five: fixture.freeze.readers.read_stage_five,
    },
    auditNavigation,
    fixture.freeze.readers,
    {
      database: fixture.freeze.db,
      work_bucket: fixture.freeze.bucket,
      evidence_resolver: fixture.freeze.resolver,
      recheck_authority: async () => ({
        investigation_id: fixture.freeze.investigation_id,
        scope_snapshot_id: fixture.freeze.scope.snapshot_id,
        scope_snapshot_revision: fixture.freeze.scope.revision,
      }),
      normalization: NORMALIZATION_CONFIG,
      verifier: verifierSelection(fixture),
      audit_policy: AUDIT_POLICY,
    },
  );
  return { fixture, stage14, inputBytes, reader };
}

function createVerificationContext(
  fixture: Awaited<ReturnType<typeof committedFreezeSynthesisFixture>>,
) {
  return createEvidenceFreezeVerificationContextReader({
    database: fixture.freeze.db,
    work_bucket: fixture.freeze.bucket,
    manifest_store: fixture.freeze.freeze_store,
    read_stage_five: fixture.freeze.readers.read_stage_five,
  }, fixture.freeze.navigation, fixture.freeze.readers);
}

async function checkpointCount(
  fixture: Awaited<ReturnType<typeof committedFreezeSynthesisFixture>>,
  stage: "AUDIT_CLAIMS",
): Promise<number> {
  const row = await fixture.freeze.db.prepare(
    "SELECT COUNT(*) AS n FROM research_workflow_checkpoint WHERE operation_id=?1 AND stage_index=?2",
  ).bind(fixture.freeze.operation_id, RESEARCH_WORKFLOW_STAGES.indexOf(stage)).first<{ readonly n: number }>();
  return row?.n ?? 0;
}

async function revokeScopeGrant(
  fixture: Awaited<ReturnType<typeof committedFreezeSynthesisFixture>>,
): Promise<void> {
  await fixture.freeze.db.prepare(
    "UPDATE scope_access_grant SET state='REVOKED' WHERE snapshot_id=?1 AND snapshot_revision=?2 AND principal_ref=?3",
  ).bind(fixture.freeze.scope.snapshot_id, fixture.freeze.scope.revision, principal.principal_ref).run();
}

describe("AUDIT_CLAIMS input over committed D1/R2 stages", () => {
  it("reads a real v2 VERIFY result and preserves source/readback lineage on replay", async () => {
    const prepared = await committedAuditInputFixture([VERIFIER_REF]);
    const first = await prepared.reader.read({
      request: prepared.stage14,
      principal,
      input_bytes: prepared.inputBytes,
    });
    const replay = await prepared.reader.read({
      request: prepared.stage14,
      principal,
      input_bytes: prepared.inputBytes,
    });
    const evidence = prepared.fixture.stage_five.evidence_pack.resolved_evidence[0];
    if (evidence === undefined) throw new Error("stage five fixture has no resolved evidence");
    expect(first.evidence_input_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.evidence_input_sha256).toBe(replay.evidence_input_sha256);
    expect(first.verify.protocol).toBe("eliotr.research.verification.v2");
    expect(first.verify.normalization.section_ref).toEqual(NORMALIZATION_CONFIG.section_ref);
    expect(first.verify.normalization.required_precision).toBe(NORMALIZATION_CONFIG.required_precision);
    expect(first.verify.normalization.required_source_class).toBe(NORMALIZATION_CONFIG.required_source_class);
    expect(first.claims.cited_handle_refs).toEqual([evidence.handle.handle_ref]);
    expect(first.claims.claims[0]?.support_handle_refs).toEqual([evidence.handle.handle_ref]);
    expect(first.claims.claims[0]?.counterevidence_handle_refs).toEqual([]);
    expect(first.evidence[0]?.handle.handle_ref).toEqual(evidence.handle.handle_ref);
    expect(first.evidence[0]?.source_class).toBe("document");
    expect(first.normalization.required_source_class).toBe("official");
    expect(first.verify.source_verification.resolved[0]?.source_revision_ref).toBe(evidence.handle.source_revision_ref);
    expect(first.synthesis.output_sha256).toBe(first.verify.synthesis.output_sha256);
    expect(first.audit_policy).toEqual(AUDIT_POLICY);
    expect(prepared.fixture.provider_calls()).toBe(1);
    expect(await checkpointCount(prepared.fixture, "AUDIT_CLAIMS")).toBe(0);
  }, 30_000);

  it("refuses a verifier disallowed by the committed manifest before another provider read", async () => {
    const prepared = await committedAuditInputFixture([]);
    await expect(prepared.reader.read({
      request: prepared.stage14,
      principal,
      input_bytes: prepared.inputBytes,
    })).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(prepared.fixture.provider_calls()).toBe(1);
    expect(await checkpointCount(prepared.fixture, "AUDIT_CLAIMS")).toBe(0);
  }, 30_000);

  it("refuses scope revocation observed after the final source readback", async () => {
    const prepared = await committedAuditInputFixture([VERIFIER_REF]);
    let sourceReads = 0;
    const baseNavigation = prepared.fixture.freeze.navigation;
    const navigation = {
      ...baseNavigation,
      async sources(refs: readonly string[], grant: Awaited<ReturnType<NavigationReadAuthority["current"]>>) {
        const result = await baseNavigation.sources(refs, grant);
        sourceReads += 1;
        if (sourceReads === 2) await revokeScopeGrant(prepared.fixture);
        return result;
      },
    } satisfies NavigationReadAuthority;
    const reader = createResearchClaimAuditInputReaderFromFreeze(
      {
        database: prepared.fixture.freeze.db,
        work_bucket: prepared.fixture.freeze.bucket,
        manifest_store: prepared.fixture.freeze.freeze_store,
        read_stage_five: prepared.fixture.freeze.readers.read_stage_five,
      },
      navigation,
      prepared.fixture.freeze.readers,
      {
        database: prepared.fixture.freeze.db,
        work_bucket: prepared.fixture.freeze.bucket,
        evidence_resolver: prepared.fixture.freeze.resolver,
        recheck_authority: async () => ({
          investigation_id: prepared.fixture.freeze.investigation_id,
          scope_snapshot_id: prepared.fixture.freeze.scope.snapshot_id,
          scope_snapshot_revision: prepared.fixture.freeze.scope.revision,
        }),
        normalization: NORMALIZATION_CONFIG,
        verifier: verifierSelection(prepared.fixture),
        audit_policy: AUDIT_POLICY,
      },
    );
    await expect(reader.read({
      request: prepared.stage14,
      principal,
      input_bytes: prepared.inputBytes,
    })).rejects.toMatchObject({ code: "EVIDENCE_AUTHORIZATION_DENIED" });
    expect(sourceReads).toBe(2);
    expect(prepared.fixture.provider_calls()).toBe(1);
    expect(await checkpointCount(prepared.fixture, "AUDIT_CLAIMS")).toBe(0);
  }, 30_000);
});
