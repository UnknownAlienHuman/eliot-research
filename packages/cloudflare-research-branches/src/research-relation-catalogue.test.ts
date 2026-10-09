import { describe, expect, it, vi } from "vitest";
import {
  BranchQueryPlanSchema,
  BranchQueryResultSchema,
  RetrievalLaneSchema,
  ResolvedEvidenceSchema,
  type BranchQueryPlan,
  type BranchQueryResult,
} from "@eliotr/contracts";
import { createResearchRelationAliasCatalogue } from "./research-relation-catalogue.js";

const SHA = "a".repeat(64);
const SCOPE_REF = { id: "scope-1", revision: 1 } as const;
const SCOPE = {
  snapshot_id: SCOPE_REF.id,
  revision: SCOPE_REF.revision,
  digest: SHA,
  resolved_scope_expression: { kind: "GLOBAL_LIBRARY" },
  participant_generations: {},
  member_source_revision_refs: [],
  source_owner_generations: {},
  policy_authority_ref: "policy-1",
  disclosure_closure_digest: SHA,
  purge_ledger_revision: 0,
  created_at: "2026-01-01T00:00:00.000Z",
  expires_at: "2027-01-01T00:00:00.000Z",
};

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function resolvedEvidence(id: string, sourceRevision: string, exactExcerpt: string) {
  const excerptBytes = new TextEncoder().encode(exactExcerpt);
  return ResolvedEvidenceSchema.parse({
    handle: {
      handle_ref: { id, revision: 1 },
      source_namespace_id: "namespace-1",
      source_owner_generation: "owner-generation-1",
      source_revision_ref: sourceRevision,
      scope_snapshot_ref: SCOPE_REF,
      anchor: { kind: "normalized_byte_range", start: 0, end: excerptBytes.byteLength },
      excerpt_sha256: await sha256(exactExcerpt),
      excerpt_byte_length: excerptBytes.byteLength,
      object_residency_key_digest: SHA,
      source_assurance_ceiling: "EXACT",
      materializer_assurance_ceiling: "EXACT",
      terminal_state: "LIVE",
      created_at: "2026-01-01T00:00:00.000Z",
    },
    exact_excerpt: exactExcerpt,
    verification_receipt_ref: `verification-${id}`,
    authorization_receipt_ref: "authorization-1",
    credential_generation: "credential-1",
    source_revision_content_sha256: SHA,
    scope_snapshot_digest: SHA,
    instruction_taint: "DATA_ONLY",
    allowed_effects: "READ_ONLY",
    resolved_at: "2026-01-01T00:00:00.000Z",
  });
}

async function planAndResult(
  firstExcerpt = "  Exact fact from source A.  ",
): Promise<{ plan: BranchQueryPlan; result: BranchQueryResult }> {
  const rootQuestion = {
    question_ref: { id: "question-root", revision: 1 },
    text: "What happened?",
    text_sha256: SHA,
  };
  const branchQuestion = {
    question_ref: { id: "question-counter", revision: 1 },
    text: "Which evidence challenges the hypothesis?",
    text_sha256: SHA,
  };
  const planDigest = "b".repeat(64);
  const plan = BranchQueryPlanSchema.parse({
    protocol: "eliotr.research.branch-query-plan.v1",
    query_plan_ref: { id: `eliotr.research.branch-query-plan-${planDigest}`, revision: 1 },
    identity_digest: planDigest,
    branch_ref: { id: "branch-1", revision: 1 },
    role: "COUNTER",
    planning_manifest_ref: { id: "planning-1", revision: 1 },
    planning_manifest_digest: SHA,
    inquiry_protocol_ref: { id: "protocol-1", revision: 1 },
    protocol_digest: SHA,
    scope_snapshot_ref: SCOPE_REF,
    scope_snapshot_digest: SHA,
    root_question: rootQuestion,
    branch_question: branchQuestion,
    question_refs: [rootQuestion.question_ref, branchQuestion.question_ref],
    hypothesis_refs: ["hypothesis-1"],
    query_legs: [{
      query_id: "query-1",
      query_sha256: SHA,
      query: "counter evidence query",
      literal_probes: [],
    }],
    retrieval_product: "RESEARCH",
    budgets: {
      candidate_limit: 2,
      scan_limit: 4,
      evidence_limit: 2,
      max_evidence_bytes: 256,
      max_query_legs: 1,
    },
    required: true,
    stop_rule: "EXHAUST_QUERY_LEGS",
    proposal_disposition: "NOT_PROPOSED",
    plan_generation: "server.branch-query-planner.v1",
  });
  const plannedLeg = plan.query_legs[0];
  if (plannedLeg === undefined) throw new Error("query plan fixture has no leg");
  const excerpts = [
    await resolvedEvidence("handle-a", "source-revision-a", firstExcerpt),
    await resolvedEvidence("handle-b", "source-revision-b", "  Exact fact from source B.  "),
  ];
  const resultDigest = "c".repeat(64);
  const traceRef = { id: "trace-1", revision: 1 };
  const result = BranchQueryResultSchema.parse({
    protocol: "eliotr.research.branch-query-result.v1",
    query_result_ref: { id: `eliotr.research.branch-query-result-${resultDigest}`, revision: 1 },
    identity_digest: resultDigest,
    query_plan_ref: plan.query_plan_ref,
    query_plan_digest: plan.identity_digest,
    role: plan.role,
    scope_snapshot_ref: plan.scope_snapshot_ref,
    scope_snapshot_digest: plan.scope_snapshot_digest,
    query_legs: [{
      status: "COMPLETED",
      query_id: plannedLeg.query_id,
      query_sha256: plannedLeg.query_sha256,
      retrieval_request_digest: SHA,
      scope_snapshot_ref: SCOPE_REF,
      scope_snapshot_digest: SHA,
      trace: {
        trace_ref: traceRef,
        raw_query: plannedLeg.query,
        scope_snapshot: SCOPE,
        query_product: "RESEARCH",
        lanes_used: ["LEX"],
        lanes_skipped: [],
        exact_probes: [],
        index_generations: [],
        context_expansion: 0,
        candidates_by_lane: Object.fromEntries(RetrievalLaneSchema.options.map((lane) => [
          lane,
          lane === "LEX" ? excerpts.length : 0,
        ])),
        expansion_refs: [],
        represented_source_refs: [],
        omitted_sources: [],
        stale_or_degraded_channels: [],
        budget_receipt_ref: "budget-1",
      },
      resolved_handle_refs: excerpts.map((evidence) => ({
        handle_ref: evidence.handle.handle_ref,
        excerpt_sha256: evidence.handle.excerpt_sha256,
        excerpt_byte_length: evidence.handle.excerpt_byte_length,
      })),
      omitted_candidates: [],
      stop_reason: "LEG_COMPLETED",
    }],
    resolved_evidence: excerpts,
    omitted_candidate_refs: [],
    total_utf8_bytes: excerpts.reduce((total, evidence) => total + evidence.handle.excerpt_byte_length, 0),
    stop_reason: "PLAN_COMPLETED",
    failure_disposition: "NONE",
  });
  return { plan, result };
}

describe("createResearchRelationAliasCatalogue", () => {
  it("rejects a lone-surrogate excerpt before query validation encodes its replacement-byte collision", async () => {
    const { plan, result } = await planAndResult("\uD800");
    const malformed = result.resolved_evidence[0];
    if (malformed === undefined) throw new Error("malformed evidence fixture is missing");
    expect(malformed.exact_excerpt.isWellFormed()).toBe(false);
    expect(malformed.handle.excerpt_sha256).toBe(await sha256("\uFFFD"));
    expect(malformed.handle.excerpt_byte_length).toBe(new TextEncoder().encode("\uFFFD").byteLength);

    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      await expect(createResearchRelationAliasCatalogue({
        plan,
        query_result: result,
        target: {
          kind: "QUESTION",
          question_ref: plan.branch_question.question_ref,
          question_sha256: plan.branch_question.text_sha256,
        },
      })).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
      expect(encode).not.toHaveBeenCalled();
    } finally {
      encode.mockRestore();
    }
  });

  it("preserves exact source bytes and rejects forged aliases or model-supplied revisions", async () => {
    const { plan, result } = await planAndResult();
    const catalogue = await createResearchRelationAliasCatalogue({
      plan,
      query_result: result,
      target: {
        kind: "QUESTION",
        question_ref: plan.branch_question.question_ref,
        question_sha256: plan.branch_question.text_sha256,
      },
    });

    expect(catalogue.model_input.facts).toEqual([
      { alias: "F0", fact_text: "  Exact fact from source A.  " },
      { alias: "F1", fact_text: "  Exact fact from source B.  " },
    ]);
    const selected = catalogue.parseModelOutput(new TextEncoder().encode(JSON.stringify({
      protocol: "eliotr.research.relation-alias-output.v1",
      relations: [{ left_alias: "F0", relation_kind: "CONTRADICTS", right_alias: "F1" }],
    })));
    expect(selected).toHaveLength(1);
    expect(selected[0]?.left.resolved_evidence.exact_excerpt).toBe("  Exact fact from source A.  ");
    expect(selected[0]?.left.resolved_evidence.handle.handle_ref).toEqual({ id: "handle-a", revision: 1 });
    expect(selected[0]?.authority_verification).toEqual({
      source_references_verified: false,
      target_authority_verified: false,
    });

    const forgedAlias = new TextEncoder().encode(JSON.stringify({
      protocol: "eliotr.research.relation-alias-output.v1",
      relations: [{ left_alias: "F2", relation_kind: "CONTRADICTS", right_alias: "F1" }],
    }));
    expect(() => catalogue.parseModelOutput(forgedAlias)).toThrow();

    const substitutedRevision = new TextEncoder().encode(JSON.stringify({
      protocol: "eliotr.research.relation-alias-output.v1",
      relations: [{
        left_alias: "F0",
        relation_kind: "CONTRADICTS",
        right_alias: "F1",
        left_handle_ref: { id: "handle-a", revision: 2 },
      }],
    }));
    expect(() => catalogue.parseModelOutput(substitutedRevision)).toThrow();
  });
});
