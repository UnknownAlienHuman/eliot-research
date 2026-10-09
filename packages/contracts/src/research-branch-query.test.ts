import { describe, expect, it } from "vitest";
import { RetrievalLaneSchema } from "./retrieval.js";
import { BranchQueryPlanSchema, BranchQueryResultSchema, BranchQueryLegResultSchema, branchQueryResultMatchesPlan } from "./research-branch-query.js";
import { ResearchBranchResultV2Schema, ResearchReadExtractCheckpointV2Schema,
  ResearchBranchAnalysisCheckpointV2Schema, ResearchBranchReconciliationCheckpointV2Schema } from "./research-branch.js";
import { ResolvedEvidenceSchema } from "./evidence.js";
import { EvidenceFreezeBranchFindingsProvenanceSchema, EvidenceFreezeBranchFindingsSchema, ResearchEvidenceFreezeV3Schema } from "./research-branch-finding.js";

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

describe("branch plan and scope pairing", () => {
  it("rejects a foreign paired plan and incomplete completed query legs", () => {
    const plan = BranchQueryPlanSchema.parse(frozenProvenance(true).roles[0]?.query_plan);
    const queryResult = BranchQueryResultSchema.parse({
      protocol: "eliotr.research.branch-query-result.v1",
      query_result_ref: { id: `eliotr.research.branch-query-result-${SHA}`, revision: 1 }, identity_digest: SHA,
      query_plan_ref: plan.query_plan_ref, query_plan_digest: plan.identity_digest, role: plan.role,
      scope_snapshot_ref: scopeRef, scope_snapshot_digest: SHA, query_legs: [leg("query-SUPPORT", "COMPLETED")],
      resolved_evidence: [], omitted_candidate_refs: [], total_utf8_bytes: 0, stop_reason: "NO_HITS", failure_disposition: "NONE",
    });
    const read = {
      protocol: "eliotr.research.read-extract.v2",
      checkpoint_ref: { id: `eliotr.research.read-extract-v2-${SHA}`, revision: 1 }, identity_digest: SHA,
      operation_id: "operation-1", investigation_ref: { id: "investigation-1", revision: 1 }, principal_ref: "principal-1",
      scope_snapshot_ref: scopeRef, inquiry_protocol_ref: plan.inquiry_protocol_ref, protocol_digest: SHA,
      planning_manifest_ref: plan.planning_manifest_ref, planning_manifest_digest: SHA,
      role_queries: [{ query_plan: plan, query_result: queryResult }], evidence: [], omitted_candidate_refs: [],
      created_at: "2026-01-01T00:00:00.000Z",
    };
    expect(ResearchReadExtractCheckpointV2Schema.safeParse(read).success).toBe(true);
    expect(ResearchReadExtractCheckpointV2Schema.safeParse({ ...read, role_queries: [{ query_plan: plan,
      query_result: { ...queryResult, query_plan_ref: { id: "foreign-plan", revision: 1 } },
    }] }).success).toBe(false);
    const branch = {
      protocol: "eliotr.research.branch-result.v2", branch_ref: plan.branch_ref,
      result_ref: { id: `eliotr.research.branch-result-v2-${SHA}`, revision: 1 }, identity_digest: SHA, role: plan.role,
      status: "BLOCKED", question_ids: plan.question_refs.map((ref) => ref.id), hypothesis_ids: [], evidence_handle_refs: [], observation_refs: [],
      unknowns: [], limitations: [], failed_probe_refs: ["probe-1"], authoritative_disposition: "UNASSESSED",
      query_plan: plan, query_result: queryResult, findings: [],
    };
    expect(ResearchBranchResultV2Schema.safeParse(branch).success).toBe(true);
    expect(ResearchBranchResultV2Schema.safeParse({ ...branch,
      query_result: { ...queryResult, query_legs: [leg("foreign-leg", "COMPLETED")] },
    }).success).toBe(false);
    const provenance = EvidenceFreezeBranchFindingsProvenanceSchema.parse(frozenProvenance(true));
    const support = provenance.roles[0];
    if (support === undefined) throw new Error("fixture SUPPORT role missing");
    support.query_plan.budgets.max_query_legs = 2;
    support.query_plan.query_legs.push({ query_id: "query-second", query_sha256: SHA, query: "second query", literal_probes: [] });
    expect(EvidenceFreezeBranchFindingsProvenanceSchema.safeParse(provenance).success).toBe(false);
  });

  it("rejects evidence and reconciliation scopes outside the committed freeze scope", () => {
    const findings = EvidenceFreezeBranchFindingsSchema.parse({
      ...frozenProvenance(true), resolved_evidence: [evidence()], identity_digest: SHA,
    });
    const foreign = { id: "scope-foreign", revision: 1 };
    const frozen = {
      protocol: "eliotr.research.evidence-freeze.v3", identity_digest: SHA, branch_findings: findings,
      freeze: {
        freeze_ref: { id: "freeze-1", revision: 1 }, scope_snapshot_ref: scopeRef,
        coverage_denominator_ref: { id: "denominator-1", revision: 1 }, contract_protocol_digest: SHA, lane_digest: SHA,
        included_evidence: [{ handle_ref: queriedHandle.handle_ref, digest: SHA }], excluded_evidence: [],
        unresolved_contradiction_refs: [], open_research_debt_refs: [], provider_model_prompt_tool_generations: {},
        frozen_at: "2026-01-01T00:00:00.000Z",
      },
    };
    expect(ResearchEvidenceFreezeV3Schema.safeParse(frozen).success).toBe(true);
    for (const digests of [["b".repeat(64), SHA], [SHA, "b".repeat(64)], [SHA, SHA]]) {
      expect(ResearchEvidenceFreezeV3Schema.safeParse({ ...frozen,
        freeze: { ...frozen.freeze, included_evidence: digests.map((digest) => ({
          handle_ref: queriedHandle.handle_ref, digest,
        })) },
      }).success).toBe(false);
    }
    expect(ResearchEvidenceFreezeV3Schema.safeParse({ ...frozen,
      freeze: { ...frozen.freeze, scope_snapshot_ref: foreign },
    }).success).toBe(false);
    const provenance = EvidenceFreezeBranchFindingsProvenanceSchema.parse(frozenProvenance(true));
    for (const role of provenance.roles) {
      role.scope_snapshot_ref = foreign;
      role.query_plan.scope_snapshot_ref = foreign;
      for (const query of role.retrieval_legs) query.scope_snapshot_ref = foreign;
    }
    expect(EvidenceFreezeBranchFindingsProvenanceSchema.safeParse(provenance).success).toBe(false);
    const resolved = evidence();
    resolved.handle.scope_snapshot_ref = foreign;
    const baseline = result({ query_legs: [leg("query-1", "COMPLETED"), leg("query-2", "FAILED")],
      failure_disposition: "PARTIAL", stop_reason: "PLAN_COMPLETED" });
    if (!baseline.success) throw baseline.error;
    expect(BranchQueryResultSchema.safeParse({ ...baseline.data, resolved_evidence: [resolved], total_utf8_bytes: 4,
      query_legs: [{ ...leg("query-1", "COMPLETED"), stop_reason: "LEG_COMPLETED", resolved_handle_refs: [queriedHandle] }, leg("query-2", "FAILED")],
    }).success).toBe(false);
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
      finding_refs: [{ id: `eliotr.research.branch-finding-${role === "SUPPORT" ? SHA : "b".repeat(64)}`, revision: 1 }],
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
    }, {
      protocol: "eliotr.research.branch-finding.v1", finding_ref: { id: `eliotr.research.branch-finding-${"b".repeat(64)}`, revision: 1 },
      identity_digest: "b".repeat(64), role: "COUNTER", question_ref: { id: "question-COUNTER", revision: 1 }, question_sha256: SHA,
      kind: "COUNTEREVIDENCE", state: "CANDIDATE", statement: "opposing finding", conditions: [], scope: "scope-1",
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

function parentCheckpointFixture() {
  const plan = BranchQueryPlanSchema.parse(frozenProvenance(true).roles[0]?.query_plan);
  const query = BranchQueryResultSchema.parse({
    protocol: "eliotr.research.branch-query-result.v1", identity_digest: SHA,
    query_result_ref: { id: `eliotr.research.branch-query-result-${SHA}`, revision: 1 },
    query_plan_ref: plan.query_plan_ref, query_plan_digest: plan.identity_digest, role: plan.role,
    scope_snapshot_ref: scopeRef, scope_snapshot_digest: SHA, query_legs: [leg("query-SUPPORT", "COMPLETED")],
    resolved_evidence: [], omitted_candidate_refs: [], total_utf8_bytes: 0, stop_reason: "NO_HITS", failure_disposition: "NONE",
  });
  const branch = ResearchBranchResultV2Schema.parse({
    protocol: "eliotr.research.branch-result.v2", identity_digest: SHA,
    result_ref: { id: `eliotr.research.branch-result-v2-${SHA}`, revision: 1 }, branch_ref: plan.branch_ref,
    role: plan.role, status: "BLOCKED", question_ids: plan.question_refs.map((ref) => ref.id), hypothesis_ids: [], evidence_handle_refs: [], observation_refs: [],
    unknowns: [], limitations: [], failed_probe_refs: ["probe-1"], authoritative_disposition: "UNASSESSED",
    query_plan: plan, query_result: query, findings: [],
  });
  const header = {
    identity_digest: SHA, operation_id: "operation-1", investigation_ref: { id: "investigation-1", revision: 1 },
    principal_ref: "principal-1", scope_snapshot_ref: scopeRef, inquiry_protocol_ref: plan.inquiry_protocol_ref,
    protocol_digest: SHA, planning_manifest_ref: plan.planning_manifest_ref, planning_manifest_digest: SHA,
    required_roles: [plan.role], branch_results: [branch], created_at: "2026-01-01T00:00:00.000Z",
  };
  const analysis = ResearchBranchAnalysisCheckpointV2Schema.parse({
    ...header, protocol: "eliotr.research.branch-analysis.v2",
    checkpoint_ref: { id: `eliotr.research.branch-analysis-v2-${SHA}`, revision: 1 }, read_extract_ref: { id: "read-1", revision: 1 },
  });
  const reconciliation = ResearchBranchReconciliationCheckpointV2Schema.parse({
    ...header, protocol: "eliotr.research.branch-reconciliation.v2",
    checkpoint_ref: { id: `eliotr.research.branch-reconciliation-v2-${SHA}`, revision: 1 },
    branch_analysis_ref: analysis.checkpoint_ref, unmet_required_roles: [plan.role],
    unresolved_contradiction_refs: [], research_debts: [{
      debt_ref: { id: "debt-SUPPORT", revision: 1 }, kind: "epistemic", blocked_refs: [plan.role], basis_and_evidence_refs: [],
      owner: "research-workflow", blocking_effect: "Required support is blocked.", next_probe: "Resolve exact support evidence.",
      review_condition: "A current support finding is available.", status: "OPEN",
    }], counter_search_status: "NOT_REQUIRED",
  });
  return { plan, query, analysis, reconciliation };
}

describe("branch parent and outcome integrity", () => {
  it("stops on the first evidence leg and enforces plan evidence budgets", () => {
    const { plan, query } = parentCheckpointFixture();
    const fullPlan = BranchQueryPlanSchema.parse({ ...plan, stop_rule: "FIRST_ADMISSIBLE_EVIDENCE",
      budgets: { ...plan.budgets, max_query_legs: 2 },
      query_legs: [...plan.query_legs, { query_id: "query-second", query_sha256: SHA, query: "second", literal_probes: [] }],
    });
    const firstEvidence = { ...leg("query-SUPPORT", "COMPLETED"), stop_reason: "LEG_COMPLETED", resolved_handle_refs: [queriedHandle] };
    const stopped = BranchQueryResultSchema.parse({ ...query, query_legs: [firstEvidence],
      resolved_evidence: [evidence()], total_utf8_bytes: 4, stop_reason: "FIRST_ADMISSIBLE_EVIDENCE",
    });
    expect(branchQueryResultMatchesPlan(fullPlan, stopped)).toBe(true);
    expect(branchQueryResultMatchesPlan(fullPlan, { ...stopped,
      query_legs: [...stopped.query_legs, BranchQueryLegResultSchema.parse(leg("query-second", "COMPLETED"))],
    })).toBe(false);
    expect(BranchQueryResultSchema.safeParse({ ...stopped,
      query_legs: [...stopped.query_legs, leg("query-second", "COMPLETED")],
    }).success).toBe(false);
    expect(branchQueryResultMatchesPlan({ ...fullPlan, budgets: { ...fullPlan.budgets, max_evidence_bytes: 3 } }, stopped)).toBe(false);
    const twoHandles = BranchQueryResultSchema.parse({ ...stopped,
      query_legs: [{ ...firstEvidence, resolved_handle_refs: [queriedHandle,
        { ...queriedHandle, handle_ref: { id: "handle-second", revision: 1 } }] }],
      resolved_evidence: [evidence(), { ...evidence(), handle: { ...evidence().handle, handle_ref: { id: "handle-second", revision: 1 } } }],
      total_utf8_bytes: 8,
    });
    expect(branchQueryResultMatchesPlan({ ...fullPlan, budgets: { ...fullPlan.budgets, evidence_limit: 1 } }, twoHandles)).toBe(false);
  });

  it("rejects findings outside the branch-selected handles even when retrieval resolved them", () => {
    const { plan, query, analysis } = parentCheckpointFixture();
    const finding = frozenProvenance(true).findings[0];
    const branch = analysis.branch_results[0];
    if (finding === undefined || branch === undefined) throw new Error("fixture branch or finding missing");
    const queryWithEvidence = { ...query,
      query_legs: [{ ...leg("query-SUPPORT", "COMPLETED"), stop_reason: "LEG_COMPLETED", resolved_handle_refs: [queriedHandle] }],
      resolved_evidence: [evidence()], total_utf8_bytes: 4, stop_reason: "PLAN_COMPLETED",
    };
    const ready = { ...branch, status: "CANDIDATE_READY", question_ids: plan.question_refs.map((ref) => ref.id),
      evidence_handle_refs: [queriedHandle.handle_ref], findings: [finding], query_result: queryWithEvidence,
    };
    expect(ResearchBranchResultV2Schema.safeParse(ready).success).toBe(true);
    expect(ResearchBranchResultV2Schema.safeParse({ ...ready, evidence_handle_refs: [] }).success).toBe(false);
    expect(ResearchBranchResultV2Schema.safeParse({ ...ready, status: "BLOCKED", findings: [] }).success).toBe(false);
  });

  it("rejects delimiter collisions in question identity and frozen omission sets", () => {
    const { plan, analysis } = parentCheckpointFixture();
    const branch = analysis.branch_results[0];
    if (branch === undefined) throw new Error("fixture branch missing");
    const changedPlan = { ...plan,
      root_question: { ...plan.root_question, question_ref: { id: "a\nb", revision: 1 } },
      branch_question: { ...plan.branch_question, question_ref: { id: "c", revision: 1 } },
      question_refs: [{ id: "a\nb", revision: 1 }, { id: "c", revision: 1 }],
    };
    const changedBranch = { ...branch, query_plan: changedPlan, question_ids: ["a\nb", "c"] };
    expect(ResearchBranchResultV2Schema.safeParse(changedBranch).success).toBe(true);
    expect(ResearchBranchResultV2Schema.safeParse({ ...changedBranch, question_ids: ["a", "b\nc"] }).success).toBe(false);
    const frozen = EvidenceFreezeBranchFindingsProvenanceSchema.parse(frozenProvenance(true));
    const support = frozen.roles[0];
    const supportLeg = support?.retrieval_legs[0];
    const supportOmissions = frozen.reconciliation_summary.omissions[0];
    if (support === undefined || supportLeg === undefined || supportOmissions === undefined) throw new Error("fixture provenance missing");
    supportLeg.omitted_candidates = ["a\nb", "c"].map((candidate_id) => ({ candidate_id, reason_code: "SCAN_LIMIT" }));
    support.omitted_candidate_refs = ["a\nb", "c"];
    supportOmissions.omitted_candidate_refs = ["a\nb", "c"];
    expect(EvidenceFreezeBranchFindingsProvenanceSchema.safeParse(frozen).success).toBe(true);
    support.omitted_candidate_refs = ["a", "b\nc"];
    supportOmissions.omitted_candidate_refs = ["a", "b\nc"];
    expect(EvidenceFreezeBranchFindingsProvenanceSchema.safeParse(frozen).success).toBe(false);
  });

  it("binds exact query omissions, required plan membership and blocked debts", () => {
    const { query, analysis, reconciliation } = parentCheckpointFixture();
    const omitted = { candidate_id: "omitted-1", reason_code: "SCAN_LIMIT" };
    const withOmission = { ...query, query_legs: [{ ...query.query_legs[0], omitted_candidates: [omitted] }], omitted_candidate_refs: [omitted.candidate_id] };
    expect(BranchQueryResultSchema.safeParse(withOmission).success).toBe(true);
    expect(BranchQueryResultSchema.safeParse({ ...withOmission, omitted_candidate_refs: [] }).success).toBe(false);
    expect(BranchQueryResultSchema.safeParse({ ...withOmission,
      query_legs: [{ ...query.query_legs[0], omitted_candidates: [omitted, omitted] }],
    }).success).toBe(false);
    const branch = analysis.branch_results[0];
    if (branch === undefined) throw new Error("fixture branch missing");
    expect(ResearchBranchAnalysisCheckpointV2Schema.safeParse({ ...analysis,
      branch_results: [{ ...branch, query_plan: { ...branch.query_plan, required: false } }],
    }).success).toBe(false);
    expect(ResearchBranchReconciliationCheckpointV2Schema.safeParse({ ...reconciliation, research_debts: [] }).success).toBe(false);
    const debt = reconciliation.research_debts[0];
    if (debt === undefined) throw new Error("fixture debt missing");
    for (const changed of [{ blocked_refs: ["COUNTER"] }, { basis_and_evidence_refs: ["foreign:1"] }, { status: "WAIVED" }]) {
      expect(ResearchBranchReconciliationCheckpointV2Schema.safeParse({ ...reconciliation,
        research_debts: [{ ...debt, ...changed }],
      }).success).toBe(false);
    }
    expect(ResearchBranchResultV2Schema.safeParse({ ...branch, question_ids: [] }).success).toBe(false);
    expect(ResearchBranchResultV2Schema.safeParse({ ...branch, hypothesis_ids: ["foreign"] }).success).toBe(false);
  });

  it("retains substantive frozen findings and derives counter status from its role", () => {
    const frozen = EvidenceFreezeBranchFindingsProvenanceSchema.parse(frozenProvenance(true));
    expect(EvidenceFreezeBranchFindingsProvenanceSchema.safeParse({ ...frozen,
      reconciliation_summary: { ...frozen.reconciliation_summary, counter_search_status: "PARTIAL" },
    }).success).toBe(false);
    const counter = frozen.roles.find((role) => role.role === "COUNTER");
    if (counter === undefined) throw new Error("fixture counter missing");
    expect(EvidenceFreezeBranchFindingsProvenanceSchema.safeParse({ ...frozen,
      roles: frozen.roles.map((role) => role.role === "COUNTER" ? { ...role, finding_refs: [] } : role),
      findings: frozen.findings.filter((finding) => finding.role !== "COUNTER"),
    }).success).toBe(false);
    expect(EvidenceFreezeBranchFindingsProvenanceSchema.safeParse({ ...frozen,
      roles: frozen.roles.map((role) => ({ ...role, query_plan: { ...role.query_plan, required: false } })),
    }).success).toBe(false);
    expect(EvidenceFreezeBranchFindingsProvenanceSchema.safeParse({ ...frozen,
      roles: frozen.roles.map((role) => role.role === "COUNTER" ? { ...role, omitted_candidate_refs: ["foreign"] } : role),
      reconciliation_summary: { ...frozen.reconciliation_summary,
        omissions: frozen.reconciliation_summary.omissions.map((role) => role.role === "COUNTER" ? { ...role, omitted_candidate_refs: ["foreign"] } : role),
      },
    }).success).toBe(false);
  });

  it("rejects nested plans from a foreign parent scope, planning manifest or protocol", () => {
    const { analysis, reconciliation } = parentCheckpointFixture();
    for (const changed of [
      { scope_snapshot_ref: { id: "foreign-scope", revision: 1 } },
      { planning_manifest_ref: { id: "planning-1", revision: 2 } },
      { planning_manifest_digest: "b".repeat(64) },
      { inquiry_protocol_ref: { id: "foreign-protocol", revision: 1 } },
      { protocol_digest: "b".repeat(64) },
    ]) {
      expect(ResearchBranchAnalysisCheckpointV2Schema.safeParse({ ...analysis, ...changed }).success).toBe(false);
      expect(ResearchBranchReconciliationCheckpointV2Schema.safeParse({ ...reconciliation, ...changed }).success).toBe(false);
    }
  });

  it("requires every required role to be retained at its owning checkpoint", () => {
    const { analysis, reconciliation } = parentCheckpointFixture();
    expect(ResearchBranchAnalysisCheckpointV2Schema.safeParse({ ...analysis, required_roles: ["SUPPORT", "COUNTER"] }).success).toBe(true);
    expect(ResearchBranchAnalysisCheckpointV2Schema.safeParse({ ...analysis, branch_results: [] }).success).toBe(false);
    expect(ResearchBranchReconciliationCheckpointV2Schema.safeParse({ ...reconciliation,
      required_roles: ["SUPPORT", "COUNTER"], counter_search_status: "PARTIAL",
    }).success).toBe(false);
  });

  it("rejects stop reasons contradicting completed, failed or frozen evidence outcomes", () => {
    const { query } = parentCheckpointFixture();
    expect(BranchQueryLegResultSchema.safeParse({ ...query.query_legs[0], stop_reason: "LEG_FAILED" }).success).toBe(false);
    expect(BranchQueryLegResultSchema.safeParse({ ...query.query_legs[0], stop_reason: "CANCELLED" }).success).toBe(false);
    expect(BranchQueryResultSchema.safeParse({ ...query, stop_reason: "ALL_LEGS_FAILED" }).success).toBe(false);
    const frozen = EvidenceFreezeBranchFindingsProvenanceSchema.parse(frozenProvenance(true));
    const support = frozen.roles[0];
    if (support === undefined) throw new Error("fixture SUPPORT role missing");
    support.stop_reason = "NO_HITS";
    expect(EvidenceFreezeBranchFindingsProvenanceSchema.safeParse(frozen).success).toBe(false);
  });

  it("binds retained read/extract byte length to the exact query evidence", () => {
    const { plan, query } = parentCheckpointFixture();
    const resolved = evidence();
    const queryWithEvidence = BranchQueryResultSchema.parse({ ...query,
      query_legs: [{ ...leg("query-SUPPORT", "COMPLETED"), stop_reason: "LEG_COMPLETED", resolved_handle_refs: [queriedHandle] }],
      resolved_evidence: [resolved], total_utf8_bytes: 4, stop_reason: "PLAN_COMPLETED",
    });
    const read = ResearchReadExtractCheckpointV2Schema.parse({
      protocol: "eliotr.research.read-extract.v2", identity_digest: SHA,
      checkpoint_ref: { id: `eliotr.research.read-extract-v2-${SHA}`, revision: 1 }, operation_id: "operation-1",
      investigation_ref: { id: "investigation-1", revision: 1 }, principal_ref: "principal-1", scope_snapshot_ref: scopeRef,
      inquiry_protocol_ref: plan.inquiry_protocol_ref, protocol_digest: SHA,
      planning_manifest_ref: plan.planning_manifest_ref, planning_manifest_digest: SHA,
      role_queries: [{ query_plan: plan, query_result: queryWithEvidence }], omitted_candidate_refs: [],
      evidence: [{ handle_ref: queriedHandle.handle_ref, source_revision_ref: "source-1", source_id: "source-1",
        source_class: "source", source_namespace_id: "namespace-1", source_owner_generation: "owner-1",
        source_family_ref: "family-1", independence: "UNKNOWN", excerpt_sha256: SHA, excerpt_byte_length: 4,
        verification_receipt_ref: "verification-1", authorization_receipt_ref: "authorization-1" }],
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const retained = read.evidence[0];
    if (retained === undefined) throw new Error("fixture evidence missing");
    retained.excerpt_byte_length = 3;
    expect(ResearchReadExtractCheckpointV2Schema.safeParse(read).success).toBe(false);
    expect(ResearchReadExtractCheckpointV2Schema.safeParse({ ...read, evidence: [{ ...retained, excerpt_byte_length: 4 }],
      inquiry_protocol_ref: { id: "foreign-protocol", revision: 1 },
    }).success).toBe(false);
  });
});
