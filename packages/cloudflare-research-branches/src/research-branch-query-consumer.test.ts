import { beforeEach, describe, expect, it, vi } from "vitest";
import { BranchQueryResultSchema, type BranchQueryPlan } from "@eliotr/contracts";
import { StageRequestSchema, type WorkflowPrincipal } from "@eliotr/cloudflare-workflows";
import { INSTALLED_INQUIRY_PROTOCOL_REFS, installedInquiryProtocolDefinition } from "./research-inquiry-protocol.js";
import { createResearchPlanningManifest } from "./research-planning-manifest.js";
import { createResearchBranchExecutionHandlers, BRANCH_QUERY_HANDLER_GENERATION } from "./research-branch-execution.js";
import type { ResearchBranchExecutionDependencies } from "./research-branch-execution-context.js";

const doubles = vi.hoisted(() => ({
  loadContext: vi.fn(),
  branchEvidence: vi.fn(),
  branchEvidenceFromResolved: vi.fn(),
}));

vi.mock("./research-branch-execution-context.js", () => ({
  loadContext: doubles.loadContext,
  branchEvidence: doubles.branchEvidence,
  branchEvidenceFromResolved: doubles.branchEvidenceFromResolved,
}));

const SHA = "a".repeat(64);
const OPERATION_ID = "run-query-result-consumer";
const INVESTIGATION_ID = "investigation-query-result-consumer";
const PRINCIPAL: WorkflowPrincipal = {
  principal_ref: "principal-query-result-consumer",
  credential_generation: "credential-query-result-consumer",
  deployment_generation: "deployment-query-result-consumer",
};
const SCOPE_REF = { id: "scope-query-result-consumer", revision: 1 } as const;

function stageRequest() {
  return StageRequestSchema.parse({
    protocol: "eliotr.workflow-stage.v1",
    operation_id: OPERATION_ID,
    investigation_ref: { id: INVESTIGATION_ID, revision: 1 },
    stage: "READ_AND_EXTRACT",
    idempotency_key: "query-result-consumer-attempt",
    handler_generation: BRANCH_QUERY_HANDLER_GENERATION,
    input_manifest: {
      object_ref: "query-result-consumer-input",
      sha256: SHA,
      byte_length: 1,
      residency: {
        scope_domain_id: "scope-domain-query-result-consumer",
        access_domain_id: "access-domain-query-result-consumer",
        confidentiality_domain_id: "confidentiality-query-result-consumer",
        encryption_key_domain_id: "key-domain-query-result-consumer",
        retention_domain_id: "retention-domain-query-result-consumer",
        erasure_domain_id: "erasure-domain-query-result-consumer",
        content_digest: { algorithm: "sha256", digest: SHA },
      },
    },
  });
}

describe("V9 query-result consumer identity verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    doubles.branchEvidenceFromResolved.mockReturnValue([]);
  });

  it("rejects a shape-valid executor digest before evidence or checkpoint construction", async () => {
    const protocolRef = INSTALLED_INQUIRY_PROTOCOL_REFS.architecture_decision;
    const planning = await createResearchPlanningManifest({
      investigation_id: INVESTIGATION_ID,
      operation_id: OPERATION_ID,
      question: "Which architecture should be selected?",
      scope_snapshot_ref: SCOPE_REF,
      scope_created_at: "2026-10-14T00:00:00.000Z",
      inquiry_protocol_ref: protocolRef,
      definition: installedInquiryProtocolDefinition(protocolRef),
      sources: [],
    });
    doubles.loadContext.mockResolvedValue({
      protocol: {
        scope_snapshot_ref: SCOPE_REF,
        profile_definition_ref: protocolRef,
        protocol_digest: SHA,
        observed_at: "2026-10-14T00:00:00.000Z",
      },
      planning,
    });

    const executeQueryPlan = vi.fn(async ({ plan }: { readonly plan: BranchQueryPlan }) =>
      BranchQueryResultSchema.parse({
        protocol: "eliotr.research.branch-query-result.v1",
        query_result_ref: { id: `eliotr.research.branch-query-result-${SHA}`, revision: 1 },
        identity_digest: SHA,
        query_plan_ref: plan.query_plan_ref,
        query_plan_digest: plan.identity_digest,
        role: plan.role,
        scope_snapshot_ref: plan.scope_snapshot_ref,
        scope_snapshot_digest: plan.scope_snapshot_digest,
        query_legs: plan.query_legs.map((leg) => ({
          status: "FAILED",
          query_id: leg.query_id,
          query_sha256: leg.query_sha256,
          retrieval_request_digest: SHA,
          scope_snapshot_ref: plan.scope_snapshot_ref,
          scope_snapshot_digest: plan.scope_snapshot_digest,
          failure_code: "RETRIEVAL_FAILED",
          resolved_handle_refs: [],
          omitted_candidates: [],
          stop_reason: "LEG_FAILED",
        })),
        resolved_evidence: [],
        omitted_candidate_refs: [],
        total_utf8_bytes: 0,
        stop_reason: "ALL_LEGS_FAILED",
        failure_disposition: "ALL_FAILED",
      }));
    const dependencies = {
      database: {},
      work_bucket: {},
      navigation: { scope: { digest: SHA } },
      ledger: { read: async () => null },
      read_stage_five: async () => { throw new Error("not used by READ_AND_EXTRACT"); },
      query_plan_budgets: {
        candidate_limit: 8,
        scan_limit: 16,
        evidence_limit: 2,
        max_evidence_bytes: 2_048,
        max_query_legs: 4,
      },
      execute_query_plan: executeQueryPlan,
    } as unknown as ResearchBranchExecutionDependencies;
    const handlers = createResearchBranchExecutionHandlers(dependencies);

    await expect(handlers.read_and_extract({
      request: stageRequest(),
      principal: PRINCIPAL,
      input_bytes: new Uint8Array(),
      attempt_ref: "read-extract-attempt",
      budget_receipt_ref: "read-extract-budget",
    })).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });

    expect(executeQueryPlan).toHaveBeenCalledTimes(1);
    expect(doubles.branchEvidenceFromResolved).not.toHaveBeenCalled();
  });
});
