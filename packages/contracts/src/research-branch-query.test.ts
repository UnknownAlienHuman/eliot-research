import { describe, expect, it } from "vitest";
import { RetrievalLaneSchema } from "./retrieval.js";
import { BranchQueryResultSchema } from "./research-branch-query.js";
import { ResolvedEvidenceSchema } from "./evidence.js";
import { EvidenceFreezeBranchFindingsProvenanceSchema, EvidenceFreezeBranchFindingsSchema } from "./research-branch-finding.js";

const SHA = "a".repeat(64);
const scopeRef = { id: "scope-1", revision: 1 };
const scopeDigest = SHA;
const scopeSnapshot = {
  snapshot_id: scopeRef.id,
  revision: scopeRef.revision,
  resolved_scope_expression: { kind: "GLOBAL_LIBRARY" as const },
  participant_generations: {},
  member_source_revision_refs: [],
  source_owner_generations: {},
  policy_authority_ref: "policy-1",
  disclosure_closure_digest: SHA,
  purge_ledger_revision: 0,
  digest: scopeDigest,
  created_at: "2026-01-01T00:00:00.000Z",
  expires_at: "2027-01-01T00:00:00.000Z",
};

function leg(queryId: string, status: "COMPLETED" | "FAILED") {
  return {
    status,
    query_id: queryId,
    query_sha256: SHA,
    retrieval_request_digest: SHA,
    scope_snapshot_ref: scopeRef,
    scope_snapshot_digest: scopeDigest,
    ...(status === "COMPLETED" ? {
      trace: {
        trace_ref: { id: `trace-${queryId}`, revision: 1 },
        raw_query: "bound branch query",
        scope_snapshot: scopeSnapshot,
        query_product: "RESEARCH" as const,
        lanes_used: ["LEX" as const],
        lanes_skipped: [],
        exact_probes: [],
        index_generations: [],
        context_expansion: 0,
        candidates_by_lane: Object.fromEntries(RetrievalLaneSchema.options.map((lane) => [lane, 0])),
        expansion_refs: [],
        represented_source_refs: [],
        omitted_sources: [],
        stale_or_degraded_channels: [],
        budget_receipt_ref: "budget-1",
      },
      stop_reason: "NO_HITS" as const,
    } : {
      failure_code: "RETRIEVAL_FAILED",
      stop_reason: "LEG_FAILED" as const,
    }),
    resolved_handle_refs: [],
    omitted_candidates: [],
  };
}

function result(input: {
  readonly query_legs: ReturnType<typeof leg>[];
  readonly failure_disposition: "PARTIAL" | "ALL_FAILED";
  readonly stop_reason: "PLAN_COMPLETED" | "BUDGET_EXHAUSTED";
}) {
  return BranchQueryResultSchema.safeParse({
    protocol: "eliotr.research.branch-query-result.v1",
    query_result_ref: { id: `eliotr.research.branch-query-result-${SHA}`, revision: 1 },
    identity_digest: SHA,
    query_plan_ref: { id: "query-plan-1", revision: 1 },
    query_plan_digest: SHA,
    role: "SUPPORT",
    scope_snapshot_ref: scopeRef,
    scope_snapshot_digest: scopeDigest,
    query_legs: input.query_legs,
    resolved_evidence: [],
    omitted_candidate_refs: [],
    total_utf8_bytes: 0,
    stop_reason: input.stop_reason,
    failure_disposition: input.failure_disposition,
  });
}

describe("BranchQueryResult failure disposition", () => {
  it("accepts partial leg failure with a completed-plan stop reason", () => {
    const parsed = result({
      query_legs: [leg("query-1", "COMPLETED"), leg("query-2", "FAILED")],
      failure_disposition: "PARTIAL",
      stop_reason: "PLAN_COMPLETED",
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("accepts all failed legs with a budget stop reason", () => {
    expect(result({
      query_legs: [leg("query-1", "FAILED"), leg("query-2", "FAILED")],
      failure_disposition: "ALL_FAILED",
      stop_reason: "BUDGET_EXHAUSTED",
    }).success).toBe(true);
  });
});

function evidence() {
  return ResolvedEvidenceSchema.parse({
    handle: {
      handle_ref: { id: "handle-shared", revision: 1 },
      source_namespace_id: "namespace-1", source_owner_generation: "owner-1", source_revision_ref: "source-1",
      scope_snapshot_ref: scopeRef, anchor: { kind: "normalized_byte_range", start: 0, end: 4 },
      excerpt_sha256: SHA, excerpt_byte_length: 4, object_residency_key_digest: SHA,
      source_assurance_ceiling: "EXACT", materializer_assurance_ceiling: "EXACT", terminal_state: "LIVE",
      created_at: "2026-01-01T00:00:00.000Z",
    },
    exact_excerpt: "text", verification_receipt_ref: "verification-1", authorization_receipt_ref: "authorization-1",
    credential_generation: "credential-1", source_revision_content_sha256: SHA, scope_snapshot_digest: SHA,
    instruction_taint: "DATA_ONLY", allowed_effects: "READ_ONLY", resolved_at: "2026-01-01T00:00:00.000Z",
  });
}

const queriedHandle = {
  handle_ref: { id: "handle-shared", revision: 1 }, excerpt_sha256: SHA, excerpt_byte_length: 4,
};

function frozenProvenance(supportQueriedHandle: boolean) {
  const roles = (["SUPPORT", "COUNTER"] as const).map((role) => {
    const question = { question_ref: { id: `question-${role}`, revision: 1 }, text: role, text_sha256: SHA };
    return {
      role, branch_ref: { id: `branch-${role}`, revision: 1 }, status: "CANDIDATE_READY",
      query_plan: {
        protocol: "eliotr.research.branch-query-plan.v1",
        query_plan_ref: { id: `eliotr.research.branch-query-plan-${SHA}`, revision: 1 }, identity_digest: SHA,
        branch_ref: { id: `branch-${role}`, revision: 1 }, role,
        planning_manifest_ref: { id: "planning-1", revision: 1 }, planning_manifest_digest: SHA,
        inquiry_protocol_ref: { id: "protocol-1", revision: 1 }, protocol_digest: SHA,
        scope_snapshot_ref: scopeRef, scope_snapshot_digest: SHA,
        root_question: { question_ref: { id: "question-root", revision: 1 }, text: "root", text_sha256: SHA },
        branch_question: question, question_refs: [{ id: "question-root", revision: 1 }, question.question_ref], hypothesis_refs: [],
        query_legs: [{ query_id: `query-${role}`, query_sha256: SHA, query: role, literal_probes: [] }],
        retrieval_product: "RESEARCH", budgets: {
          candidate_limit: 8, scan_limit: 8, evidence_limit: 2, max_evidence_bytes: 64, max_query_legs: 1,
        },
        required: true, stop_rule: "EXHAUST_QUERY_LEGS", proposal_disposition: "NOT_PROPOSED",
        plan_generation: "server.branch-query-planner.v1",
      },
      query_result_ref: { id: `eliotr.research.branch-query-result-${SHA}`, revision: 1 }, query_result_digest: SHA,
      failure_disposition: "NONE", stop_reason: "PLAN_COMPLETED", scope_snapshot_ref: scopeRef, scope_snapshot_digest: SHA,
      omitted_candidate_refs: [],
      retrieval_legs: [{
        query_id: `query-${role}`, query_sha256: SHA, retrieval_request_digest: SHA,
        scope_snapshot_ref: scopeRef, scope_snapshot_digest: SHA, status: "COMPLETED",
        trace_ref: { id: `trace-${role}`, revision: 1 }, trace_sha256: SHA, stop_reason: "LEG_COMPLETED",
        resolved_handle_refs: role === "SUPPORT" && !supportQueriedHandle ? [] : [queriedHandle], omitted_candidates: [],
      }],
      finding_refs: role === "SUPPORT" ? [{ id: `eliotr.research.branch-finding-${SHA}`, revision: 1 }] : [],
    };
  });
  const summary = {
    protocol: "eliotr.research.branch-reconciliation.v2",
    checkpoint_ref: { id: `eliotr.research.branch-reconciliation-v2-${SHA}`, revision: 1 }, identity_digest: SHA,
    operation_id: "operation-1", investigation_ref: { id: "investigation-1", revision: 1 }, principal_ref: "principal-1",
    scope_snapshot_ref: scopeRef, inquiry_protocol_ref: { id: "protocol-1", revision: 1 }, protocol_digest: SHA,
    planning_manifest_ref: { id: "planning-1", revision: 1 }, planning_manifest_digest: SHA,
    branch_analysis_ref: { id: "analysis-1", revision: 1 }, required_roles: ["SUPPORT", "COUNTER"], unmet_required_roles: [],
    unresolved_contradiction_refs: [], research_debts: [], counter_search_status: "COMPLETE",
    omissions: roles.map(({ role }) => ({ role, omitted_candidate_refs: [] })), created_at: "2026-01-01T00:00:00.000Z",
  };
  return {
    protocol: "eliotr.research.evidence-freeze-branch-findings.v1",
    reconciliation_ref: summary.checkpoint_ref, reconciliation_digest: SHA, reconciliation_summary: summary, roles,
    findings: [{
      protocol: "eliotr.research.branch-finding.v1", finding_ref: { id: `eliotr.research.branch-finding-${SHA}`, revision: 1 },
      identity_digest: SHA, role: "SUPPORT", question_ref: { id: "question-SUPPORT", revision: 1 }, question_sha256: SHA,
      kind: "SUPPORT", state: "CANDIDATE", statement: "supported claim", conditions: [], scope: "scope-1",
      evidence_handle_refs: [queriedHandle.handle_ref], unknowns: [], limitations: [],
    }],
  };
}

describe("branch query evidence provenance", () => {
  it("rejects unqueried evidence and incorrect leg byte lengths", () => {
    const baseline = result({ query_legs: [leg("query-1", "COMPLETED"), leg("query-2", "FAILED")],
      failure_disposition: "PARTIAL", stop_reason: "PLAN_COMPLETED" });
    expect(baseline.success).toBe(true);
    if (!baseline.success) throw baseline.error;
    const orphan = { ...baseline.data, resolved_evidence: [evidence()], total_utf8_bytes: 4 };
    expect(BranchQueryResultSchema.safeParse(orphan).success).toBe(false);
    const completed = { ...leg("query-1", "COMPLETED"), stop_reason: "LEG_COMPLETED", resolved_handle_refs: [queriedHandle] };
    const valid = { ...orphan, query_legs: [completed, leg("query-2", "FAILED")] };
    expect(BranchQueryResultSchema.safeParse(valid).success).toBe(true);
    expect(BranchQueryResultSchema.safeParse({ ...valid, query_legs: [
      { ...completed, resolved_handle_refs: [{ ...queriedHandle, excerpt_byte_length: 3 }] }, leg("query-2", "FAILED"),
    ] }).success).toBe(false);
  });

  it("requires finding evidence to come from its own role query", () => {
    const valid = EvidenceFreezeBranchFindingsProvenanceSchema.safeParse(frozenProvenance(true));
    expect(valid.success, JSON.stringify(valid.error?.issues)).toBe(true);
    expect(EvidenceFreezeBranchFindingsProvenanceSchema.safeParse(frozenProvenance(false)).success).toBe(false);
  });

  it("rejects conflicting same-handle digests across sibling query legs", () => {
    const parsed = EvidenceFreezeBranchFindingsSchema.parse({ ...frozenProvenance(true), resolved_evidence: [evidence()], identity_digest: SHA });
    const support = parsed.roles[0];
    if (support === undefined) throw new Error("fixture SUPPORT role missing");
    const handle = support.retrieval_legs[0]?.resolved_handle_refs[0];
    if (handle === undefined) throw new Error("fixture SUPPORT query handle missing");
    handle.excerpt_sha256 = "b".repeat(64);
    expect(EvidenceFreezeBranchFindingsSchema.safeParse(parsed).success).toBe(false);
  });
});
