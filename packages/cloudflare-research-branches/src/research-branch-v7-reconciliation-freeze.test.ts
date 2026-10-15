import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProjectClientGrantSchema,
  ResearchBranchAnalysisCheckpointSchema,
  ResearchBranchEvidenceItemSchema,
  ResearchBranchReconciliationCheckpointSchema,
  ResearchReadExtractCheckpointSchema,
} from "@eliotr/contracts";
import { ExternalAgentTaskStore, StageRequestSchema, textDigest } from "@eliotr/cloudflare-workflows";
import type * as CloudflareWorkflows from "@eliotr/cloudflare-workflows";
import { INSTALLED_INQUIRY_PROTOCOL_REFS, installedInquiryProtocolDefinition } from "./research-inquiry-protocol.js";
import { createResearchPlanningManifest } from "./research-planning-manifest.js";
import { canonicalBytes, withIdentity } from "./research-branch-execution-shared.js";
import { buildRoleResult } from "./research-branch-execution-results.js";
import { createResearchBranchExecutionHandlers } from "./research-branch-execution.js";
import type { ResearchBranchExecutionDependencies } from "./research-branch-execution-context.js";
import type { ResearchBranchReconciliationLineage } from "./research-branch-execution.js";
import type { ResearchBranchRoleModelExecutor } from "./research-branch-role-model.js";
import type { ProtocolScopeCheckpoint } from "./research-protocol-freeze.js";
import type { EvidenceFreezeStageFiveLineage } from "./research-evidence-freeze-preparation.js";
import { buildEvidenceFreezeLineage } from "./research-evidence-freeze-branch-lineage.js";
import { createResearchExternalBranchAnalysisHandlers } from "./research-external-branch-analysis.js";

const doubles = vi.hoisted(() => ({
  loadContext: vi.fn(),
  readCommittedStageLineage: vi.fn(),
  readWorkflowObject: vi.fn(),
}));

vi.mock("./research-branch-execution-context.js", () => ({
  loadContext: doubles.loadContext,
  branchEvidence: vi.fn(),
  branchEvidenceFromResolved: vi.fn(),
}));

vi.mock("@eliotr/cloudflare-workflows", async (importOriginal) => {
  const actual = await importOriginal<typeof CloudflareWorkflows>();
  return {
    ...actual,
    readCommittedStageLineage: doubles.readCommittedStageLineage,
    readCommittedWorkflowStageLineage: doubles.readCommittedStageLineage,
    readWorkflowObject: doubles.readWorkflowObject,
  };
});

const ACTIVE_BRANCH_GENERATION = "research-handlers.exploratory.v7";
const OPERATION_ID = "run-v7-counter-relation-freeze";
const INVESTIGATION_REF = { id: "investigation-v7-counter-relation-freeze", revision: 2 } as const;
const PRINCIPAL = {
  principal_ref: "principal-v7-counter-relation-freeze",
  credential_generation: "credential-v7-counter-relation-freeze",
  deployment_generation: "deployment-v7-counter-relation-freeze",
};
const SCOPE = { id: "scope-v7-counter-relation-freeze", revision: 1 } as const;
const SHA256 = "a".repeat(64);
const HANDLE_REF = { id: "evidence-handle-v7-counter-relation-freeze", revision: 1 } as const;
const PENDING_RELATION_LIMITATION =
  "Relation assessment is pending; counter evidence alone does not establish a contradiction.";

function stageRequest(stage: "ANALYZE_BRANCHES" | "COUNTER_SEARCH") {
  return StageRequestSchema.parse({
    protocol: "eliotr.workflow-stage.v1",
    operation_id: OPERATION_ID,
    investigation_ref: INVESTIGATION_REF,
    stage,
    idempotency_key: `stage-v7-counter-relation-freeze:${stage}`,
    handler_generation: ACTIVE_BRANCH_GENERATION,
    input_manifest: {
      object_ref: "input-v7-counter-relation-freeze",
      sha256: SHA256,
      byte_length: 1,
      residency: {
        scope_domain_id: "scope-domain-v7-counter-relation-freeze",
        access_domain_id: "access-domain-v7-counter-relation-freeze",
        confidentiality_domain_id: "confidentiality-v7-counter-relation-freeze",
        encryption_key_domain_id: "key-domain-v7-counter-relation-freeze",
        retention_domain_id: "retention-v7-counter-relation-freeze",
        erasure_domain_id: "erasure-v7-counter-relation-freeze",
        content_digest: { algorithm: "sha256", digest: SHA256 },
      },
    },
  });
}

describe("active V7 counter reconciliation through freeze lineage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retains COUNTER evidence and the relation-pending limitation without promoting a contradiction ref", async () => {
    const protocolRef = INSTALLED_INQUIRY_PROTOCOL_REFS.architecture_decision;
    const planning = await createResearchPlanningManifest({
      investigation_id: INVESTIGATION_REF.id,
      operation_id: OPERATION_ID,
      question: "Which architecture should be selected?",
      scope_snapshot_ref: SCOPE,
      scope_created_at: "2026-09-18T00:00:00.000Z",
      inquiry_protocol_ref: protocolRef,
      definition: installedInquiryProtocolDefinition(protocolRef),
      sources: [{
        source_revision_ref: "revision-v7-counter-relation-freeze",
        source_id: "source-v7-counter-relation-freeze",
        source_class: "counter-evidence",
        source_namespace_id: "namespace-v7-counter-relation-freeze",
        source_owner_generation: "owner-generation-v7-counter-relation-freeze",
        origin_uri: "https://example.com/counter-evidence",
      }],
    });
    const source = planning.source_portfolio.members[0];
    if (source === undefined) throw new Error("planning manifest did not retain its source member");
    const evidence = ResearchBranchEvidenceItemSchema.parse({
      handle_ref: HANDLE_REF,
      source_revision_ref: source.source_revision_ref,
      source_id: source.source_id,
      source_class: source.source_class,
      source_namespace_id: source.source_namespace_id,
      source_owner_generation: source.source_owner_generation,
      source_family_ref: source.source_family_ref,
      independence: source.independence,
      excerpt_sha256: SHA256,
      excerpt_byte_length: 1,
      verification_receipt_ref: "verification-v7-counter-relation-freeze",
      authorization_receipt_ref: "authorization-v7-counter-relation-freeze",
    });
    const read = ResearchReadExtractCheckpointSchema.parse(await withIdentity(
      "eliotr.research.read-extract.v1",
      "eliotr.research.read-extract-",
      {
        protocol: "eliotr.research.read-extract.v1",
        operation_id: OPERATION_ID,
        investigation_ref: INVESTIGATION_REF,
        principal_ref: PRINCIPAL.principal_ref,
        scope_snapshot_ref: SCOPE,
        inquiry_protocol_ref: protocolRef,
        protocol_digest: SHA256,
        planning_manifest_ref: planning.manifest_ref,
        planning_manifest_digest: planning.identity_digest,
        retrieval_request_digest: SHA256,
        evidence: [evidence],
        omitted_candidate_refs: [],
        created_at: "2026-09-18T00:00:00.000Z",
      },
    ));
    const readBytes = canonicalBytes(read);
    doubles.loadContext.mockResolvedValue({
      protocol: { scope_snapshot_ref: SCOPE },
      planning,
    });
    doubles.readCommittedStageLineage.mockResolvedValue({
      receipt: { output_manifest: { object_ref: "committed-read-extract" } },
    });
    doubles.readWorkflowObject.mockResolvedValue(readBytes);

    const selectedRoles: string[] = [];
    const roleModel: ResearchBranchRoleModelExecutor = {
      executeRole: async ({ role }) => {
        selectedRoles.push(role);
        return new TextEncoder().encode(JSON.stringify({
          protocol: "eliotr.research.branch-role-output.v1",
          role,
          status: "CANDIDATE_READY",
          evidence_handle_refs: [HANDLE_REF],
          unknowns: [],
          limitations: [],
        }));
      },
    };
    const dependencies = {
      database: {},
      work_bucket: {},
      navigation: {},
      ledger: { read: async () => null },
      read_stage_five: async () => { throw new Error("context loader should be mocked"); },
      role_model: roleModel,
    } as unknown as ResearchBranchExecutionDependencies;
    const handlers = createResearchBranchExecutionHandlers(dependencies);
    const analysisBytes = await handlers.analyze_branches({
      request: stageRequest("ANALYZE_BRANCHES"),
      principal: PRINCIPAL,
      input_bytes: readBytes,
      attempt_ref: "analysis-v7-attempt",
      budget_receipt_ref: "analysis-v7-budget",
    });
    const reconciliationBytes = await handlers.counter_search({
      request: stageRequest("COUNTER_SEARCH"),
      principal: PRINCIPAL,
      input_bytes: analysisBytes,
      attempt_ref: "counter-v7-attempt",
      budget_receipt_ref: "counter-v7-budget",
    });
    const reconciliation = ResearchBranchReconciliationCheckpointSchema.parse(
      JSON.parse(new TextDecoder().decode(reconciliationBytes)),
    );
    const counter = reconciliation.branch_results.find((result) => result.role === "COUNTER");

    expect(selectedRoles).toContain("COUNTER");
    expect(counter?.evidence_handle_refs).toEqual([HANDLE_REF]);
    expect(counter?.authoritative_disposition).toBe("UNASSESSED");
    expect(counter?.limitations).toContain(PENDING_RELATION_LIMITATION);
    expect(reconciliation.unresolved_contradiction_refs).toEqual([]);

    const reconciliationLineage = {
      checkpoint: reconciliation,
      read_extract_attempt_ref: "read-v7-attempt",
      read_extract_request_sha256: SHA256,
      branch_analysis_attempt_ref: "analysis-v7-attempt",
      branch_analysis_request_sha256: SHA256,
      stage_attempt_ref: "counter-v7-attempt",
      stage_request_sha256: SHA256,
    } as ResearchBranchReconciliationLineage;
    const stageZero = {
      operation_id: OPERATION_ID,
      attempt_ref: "protocol-v7-attempt",
      investigation_ref: INVESTIGATION_REF,
      principal_ref: PRINCIPAL.principal_ref,
      scope_snapshot_ref: SCOPE,
      profile_definition_ref: protocolRef,
      protocol_digest: SHA256,
      planning_manifest_ref: planning.manifest_ref,
      planning_manifest_digest: planning.identity_digest,
      denominator_digest: SHA256,
      coverage_denominator: { required_question_branches: planning.required_branch_roles },
    } as unknown as ProtocolScopeCheckpoint;
    const stageFive = {
      operation_id: OPERATION_ID,
      stage_attempt_ref: "stage-five-v7-attempt",
      stage_request_sha256: SHA256,
    } as unknown as EvidenceFreezeStageFiveLineage;
    const freezeLineage = await buildEvidenceFreezeLineage({
      operation_id: OPERATION_ID,
      stage_zero: stageZero,
      stage_five: stageFive,
      model_profile_binding_ref: { id: "model-binding-v7-counter-relation-freeze", revision: 1 },
      branch_reconciliation: reconciliationLineage,
    });
    const frozenCheckpoint = ResearchBranchReconciliationCheckpointSchema.parse(
      JSON.parse(new TextDecoder().decode(reconciliationBytes)),
    );

    expect(freezeLineage.branch?.unresolved_contradiction_refs).toEqual([]);
    expect(freezeLineage.branch?.checkpoint_ref).toEqual(frozenCheckpoint.checkpoint_ref);
    expect(freezeLineage.branch?.identity_digest).toBe(frozenCheckpoint.identity_digest);
    expect(freezeLineage.identity.branch_reconciliation).toMatchObject({
      checkpoint_ref: frozenCheckpoint.checkpoint_ref,
      identity_digest: frozenCheckpoint.identity_digest,
      unresolved_contradiction_refs: [],
    });
    expect(frozenCheckpoint.branch_results.find((result) => result.role === "COUNTER")?.limitations)
      .toContain(PENDING_RELATION_LIMITATION);
  });

  it("rejects a frozen V1 checkpoint that mints a contradiction ref without a source-bound relation assessment", async () => {
    // Causal negative: a checkpoint whose COUNTER handles were already hashed
    // into unresolved_contradiction_refs has no evaluated relation behind them.
    // Freeze lineage must fail closed instead of certifying that promotion.
    const protocolRef = INSTALLED_INQUIRY_PROTOCOL_REFS.architecture_decision;
    const planning = await createResearchPlanningManifest({
      investigation_id: INVESTIGATION_REF.id,
      operation_id: OPERATION_ID,
      question: "Which architecture should be selected?",
      scope_snapshot_ref: SCOPE,
      scope_created_at: "2026-09-18T00:00:00.000Z",
      inquiry_protocol_ref: protocolRef,
      definition: installedInquiryProtocolDefinition(protocolRef),
      sources: [{
        source_revision_ref: "revision-v7-counter-relation-freeze",
        source_id: "source-v7-counter-relation-freeze",
        source_class: "counter-evidence",
        source_namespace_id: "namespace-v7-counter-relation-freeze",
        source_owner_generation: "owner-generation-v7-counter-relation-freeze",
        origin_uri: "https://example.com/counter-evidence",
      }],
    });
    const source = planning.source_portfolio.members[0];
    if (source === undefined) throw new Error("planning manifest did not retain its source member");
    const evidence = ResearchBranchEvidenceItemSchema.parse({
      handle_ref: HANDLE_REF,
      source_revision_ref: source.source_revision_ref,
      source_id: source.source_id,
      source_class: source.source_class,
      source_namespace_id: source.source_namespace_id,
      source_owner_generation: source.source_owner_generation,
      source_family_ref: source.source_family_ref,
      independence: source.independence,
      excerpt_sha256: SHA256,
      excerpt_byte_length: 1,
      verification_receipt_ref: "verification-v7-counter-relation-freeze",
      authorization_receipt_ref: "authorization-v7-counter-relation-freeze",
    });
    const read = ResearchReadExtractCheckpointSchema.parse(await withIdentity(
      "eliotr.research.read-extract.v1",
      "eliotr.research.read-extract-",
      {
        protocol: "eliotr.research.read-extract.v1",
        operation_id: OPERATION_ID,
        investigation_ref: INVESTIGATION_REF,
        principal_ref: PRINCIPAL.principal_ref,
        scope_snapshot_ref: SCOPE,
        inquiry_protocol_ref: protocolRef,
        protocol_digest: SHA256,
        planning_manifest_ref: planning.manifest_ref,
        planning_manifest_digest: planning.identity_digest,
        retrieval_request_digest: SHA256,
        evidence: [evidence],
        omitted_candidate_refs: [],
        created_at: "2026-09-18T00:00:00.000Z",
      },
    ));
    // A genuine COUNTER result built by the real role-result builder, so its
    // identity digest, observation refs and limitations are authentic. The only
    // defect under test is the inherited V1 contradiction derivation.
    const counterResult = await buildRoleResult(planning, "COUNTER", [evidence]);
    // The unassessed COUNTER is paired with a contradiction ref, as the old
    // published V1 derivation produced. No relation assessment exists.
    const fabricated = await withIdentity(
      "eliotr.research.branch-reconciliation.v1",
      "eliotr.research.branch-reconciliation-",
      {
        protocol: "eliotr.research.branch-reconciliation.v1",
        operation_id: OPERATION_ID,
        investigation_ref: INVESTIGATION_REF,
        principal_ref: PRINCIPAL.principal_ref,
        scope_snapshot_ref: SCOPE,
        inquiry_protocol_ref: protocolRef,
        protocol_digest: SHA256,
        planning_manifest_ref: planning.manifest_ref,
        planning_manifest_digest: planning.identity_digest,
        branch_analysis_ref: read.checkpoint_ref,
        required_roles: ["COUNTER"],
        branch_results: [counterResult],
        unmet_required_roles: [],
        unresolved_contradiction_refs: ["eliotr.research.contradiction-v7-negative"],
        research_debts: [],
        counter_search_status: "COMPLETE",
        created_at: "2026-09-18T00:00:00.000Z",
      },
    );
    const reconciliationLineage = {
      checkpoint: fabricated,
      read_extract_attempt_ref: "read-v7-attempt",
      read_extract_request_sha256: SHA256,
      branch_analysis_attempt_ref: "analysis-v7-attempt",
      branch_analysis_request_sha256: SHA256,
      stage_attempt_ref: "counter-v7-attempt",
      stage_request_sha256: SHA256,
    } as ResearchBranchReconciliationLineage;
    const stageZero = {
      operation_id: OPERATION_ID,
      attempt_ref: "protocol-v7-attempt",
      investigation_ref: INVESTIGATION_REF,
      principal_ref: PRINCIPAL.principal_ref,
      scope_snapshot_ref: SCOPE,
      profile_definition_ref: protocolRef,
      protocol_digest: SHA256,
      planning_manifest_ref: planning.manifest_ref,
      planning_manifest_digest: planning.identity_digest,
      denominator_digest: SHA256,
      coverage_denominator: { required_question_branches: ["COUNTER"] },
    } as unknown as ProtocolScopeCheckpoint;
    const stageFive = {
      operation_id: OPERATION_ID,
      stage_attempt_ref: "stage-five-v7-attempt",
      stage_request_sha256: SHA256,
    } as unknown as EvidenceFreezeStageFiveLineage;
    const modelProfileBindingRef = { id: "model-binding-v7-counter-relation-freeze", revision: 1 };

    await expect(buildEvidenceFreezeLineage({
      operation_id: OPERATION_ID,
      stage_zero: stageZero,
      stage_five: stageFive,
      model_profile_binding_ref: modelProfileBindingRef,
      branch_reconciliation: reconciliationLineage,
    })).rejects.toThrow(/branch reconciliation lineage is inconsistent/u);

    expect(fabricated.unresolved_contradiction_refs).toEqual(["eliotr.research.contradiction-v7-negative"]);
  });
});

describe("native external branch checkpoint identity", () => {
  it("keeps the frozen READ_AND_EXTRACT revision when the stage-8 request has advanced", async () => {
    const externalPrincipal = { ...PRINCIPAL, principal_ref: "principal-v8-external.access" };
    const protocolRef = INSTALLED_INQUIRY_PROTOCOL_REFS.lookup;
    const planning = await createResearchPlanningManifest({
      investigation_id: INVESTIGATION_REF.id,
      operation_id: OPERATION_ID,
      question: "What does the admitted corpus contain?",
      scope_snapshot_ref: SCOPE,
      scope_created_at: "2026-09-18T00:00:00.000Z",
      inquiry_protocol_ref: protocolRef,
      definition: installedInquiryProtocolDefinition(protocolRef),
      sources: [{
        source_revision_ref: "revision-v8-external-branch",
        source_id: "source-v8-external-branch",
        source_class: "document",
        source_namespace_id: "namespace-v8-external-branch",
        source_owner_generation: "owner-generation-v8-external-branch",
        origin_uri: "https://example.com/readme",
      }],
    });
    expect(planning.required_branch_roles).toEqual([]);
    const read = await withIdentity("eliotr.research.read-extract.v1", "eliotr.research.read-extract-", {
      protocol: "eliotr.research.read-extract.v1",
      operation_id: OPERATION_ID,
      investigation_ref: { ...INVESTIGATION_REF, revision: 8 },
      principal_ref: externalPrincipal.principal_ref,
      scope_snapshot_ref: SCOPE,
      inquiry_protocol_ref: protocolRef,
      protocol_digest: SHA256,
      planning_manifest_ref: planning.manifest_ref,
      planning_manifest_digest: planning.identity_digest,
      retrieval_request_digest: SHA256,
      evidence: [],
      omitted_candidate_refs: [],
      created_at: "2026-09-18T00:00:00.000Z",
    });
    const readBytes = canonicalBytes(read);
    const request = StageRequestSchema.parse({
      ...stageRequest("ANALYZE_BRANCHES"),
      investigation_ref: { ...INVESTIGATION_REF, revision: 9 },
      handler_generation: "research-handlers.exploratory.external-wait.v1",
    });
    const requestSha = await textDigest(JSON.stringify(request));
    const submittedAt = "2026-09-18T00:00:01.000Z";
    const recorded = {
      protocol: "eliotr.external-agent-result.v1",
      task_id: `external-task:${requestSha}`,
      operation_id: OPERATION_ID,
      stage_index: 8,
      stage: "ANALYZE_BRANCHES",
      attempt_ref: "external-attempt-v8",
      request_sha256: requestSha,
      lease_id: "lease-v8",
      idempotency_key: "result-v8",
      disposition: "PARTIAL",
      output: {
        protocol: "eliotr.external-branch-analysis.v1",
        task_kind: "RESEARCH_BRANCH_ANALYSIS",
        task_id: `external-task:${requestSha}`,
        operation_id: OPERATION_ID,
        stage_index: 8,
        stage: "ANALYZE_BRANCHES",
        attempt_ref: "external-attempt-v8",
        request_sha256: requestSha,
        roles: [],
        candidate_findings: [],
        execution_observation: {
          contour: "OTHER",
          computer_scope: "UNKNOWN",
          interfaces_used: [],
          observed_at: submittedAt,
        },
      },
      evidence_refs: [],
      diagnostics: [],
      usage: { accounting: "UNKNOWN" },
      submitted_at: submittedAt,
    } as const;
    const w1Head = { revision: 9, principal_ref: PRINCIPAL.principal_ref };
    doubles.loadContext.mockResolvedValue({
      protocol: { scope_snapshot_ref: SCOPE, profile_definition_ref: protocolRef, protocol_digest: SHA256 },
      planning,
      stage_five: { retrieval_request_digest: SHA256, evidence_pack: { resolved_evidence: [] } },
      w1: w1Head,
    });
    doubles.readWorkflowObject.mockResolvedValue(readBytes);
    vi.spyOn(ExternalAgentTaskStore.prototype, "readRecordedResult").mockResolvedValue(recorded);
    const grant = ProjectClientGrantSchema.parse({
      protocol: "eliotr.project-client-grant.v1",
      grant_id: "grant-v8-external",
      project_id: "project-v8-external",
      grantor_principal_ref: "owner-v8.access",
      revision: 1,
      state: "ACTIVE",
      grantee: {
        issuer: "https://example.cloudflareaccess.com",
        authentication_method: "service_token",
        subject: externalPrincipal.principal_ref,
      },
      allowed_operations: ["run", "recover", "evidence"],
      ingest_namespace_ids: [],
      expires_at: "2027-01-01T00:00:00.000Z",
      created_at: submittedAt,
      updated_at: submittedAt,
    });
    const handlers = createResearchExternalBranchAnalysisHandlers({
      database: {},
      work_bucket: {},
      navigation: { access: externalPrincipal, current: async () => ({ stable: true }) },
      ledger: { read: async () => ({ head: w1Head }) },
      read_stage_five: async () => { throw new Error("context is mocked"); },
      resolver: { resolveHandle: vi.fn() },
      grant,
      require_route_binding: async () => undefined,
      now: () => Date.parse(submittedAt),
    } as never);

    const output = await handlers.handler({
      request,
      principal: externalPrincipal,
      input_bytes: readBytes,
      attempt_ref: "external-attempt-v8",
      budget_receipt_ref: "budget-v8",
    });
    const analysis = ResearchBranchAnalysisCheckpointSchema.parse(JSON.parse(new TextDecoder().decode(output)));
    expect(request.investigation_ref.revision).toBe(9);
    expect(analysis.investigation_ref).toEqual(read.investigation_ref);
    expect(analysis.required_roles).toEqual([]);
    expect(analysis.branch_results).toEqual([]);
  });
});
