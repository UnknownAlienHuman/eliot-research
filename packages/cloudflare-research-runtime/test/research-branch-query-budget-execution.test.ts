import { describe, expect, it } from "vitest";
import {
  BranchQueryPlanSchema,
  MANAGED_RANKING_OUTCOME_PROTOCOL,
  MANAGED_RETRIEVAL_TRACE_PROTOCOL,
  ManagedRetrievalTraceSchema,
  ScopeSnapshotSchema,
} from "@eliotr/contracts";
import { evidenceSha256, type NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import type { HeldResearchScope } from "@eliotr/cloudflare-research";
import { StageRequestSchema, type WorkflowPrincipal } from "@eliotr/cloudflare-workflows";
import {
  managedRetrievalInvocationIdsV1,
  managedRetrievalRefIdV1,
  retrievalRequestDigest,
  type RetrievalQueryAccess,
  type RetrievalQueryExecutionV1,
} from "@eliotr/retrieval";
import type { ResearchRetrievalEnvironment } from "../src/research-retrieval-composition.js";
import {
  executeResearchBranchQueryPlanWithPorts,
  type ResearchBranchQueryExecutionAdapterDependencies,
  type ResearchBranchQueryExecutionPorts,
} from "../src/research-branch-query-execution.js";

const SHA = "a".repeat(64);
const PLAN_DOMAIN = "eliotr.research.branch-query-plan.v1";
const LEG_DOMAIN = "eliotr.research.branch-query-leg.v1";
const QUESTION_DOMAIN = "eliotr.research.branch-query-question.v1";

async function runFixture() {
  const scope = ScopeSnapshotSchema.parse({
    snapshot_id: "branch-budget-scope",
    revision: 1,
    resolved_scope_expression: { kind: "PROJECT", project_id: "project-1" },
    participant_generations: {},
    member_source_revision_refs: ["source-revision-1"],
    source_owner_generations: { "source-revision-1": "owner-generation-1" },
    policy_authority_ref: "policy-authority-1",
    disclosure_closure_digest: SHA,
    purge_ledger_revision: 0,
    digest: "b".repeat(64),
    created_at: "2026-10-14T00:00:00.000Z",
    expires_at: "2026-10-15T00:00:00.000Z",
  });
  const rootRef = { id: "question-root", revision: 1 };
  const branchRef = { id: "question-support", revision: 1 };
  const rootText = "What is the root question?";
  const branchText = "What supports the claim?";
  const rootQuestion = {
    question_ref: rootRef,
    text: rootText,
    text_sha256: await evidenceSha256({ domain: QUESTION_DOMAIN, value: { question_ref: rootRef, text: rootText } }),
  };
  const branchQuestion = {
    question_ref: branchRef,
    text: branchText,
    text_sha256: await evidenceSha256({ domain: QUESTION_DOMAIN, value: { question_ref: branchRef, text: branchText } }),
  };
  const planningManifestRef = { id: "planning-manifest-1", revision: 1 };
  const queryLegs = await Promise.all([1, 2].map(async (index) => {
    const query = `support query ${index}`;
    const literal_probes: string[] = [];
    const query_sha256 = await evidenceSha256({ domain: LEG_DOMAIN, value: { query, literal_probes } });
    return { query_id: `branch-query-${query_sha256.slice(0, 40)}-${index - 1}`, query_sha256, query, literal_probes };
  }));
  const branchIdentity = await evidenceSha256({
    domain: "eliotr.research.branch-query-branch.v1",
    value: { role: "SUPPORT", planning_manifest_ref: planningManifestRef, branch_question_ref: branchRef },
  });
  const material = {
    protocol: "eliotr.research.branch-query-plan.v1" as const,
    branch_ref: { id: `eliotr.research.branch-query-${branchIdentity}`, revision: 1 },
    role: "SUPPORT" as const,
    planning_manifest_ref: planningManifestRef,
    planning_manifest_digest: "c".repeat(64),
    inquiry_protocol_ref: { id: "inquiry-protocol-1", revision: 1 },
    protocol_digest: "d".repeat(64),
    scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision },
    scope_snapshot_digest: scope.digest,
    root_question: rootQuestion,
    branch_question: branchQuestion,
    question_refs: [rootRef, branchRef],
    hypothesis_refs: [],
    query_legs: queryLegs,
    retrieval_product: "RESEARCH" as const,
    budgets: {
      candidate_limit: 4,
      scan_limit: 8,
      evidence_limit: 2,
      max_evidence_bytes: 128,
      max_query_legs: 2,
    },
    required: true,
    stop_rule: "EXHAUST_QUERY_LEGS" as const,
    proposal_disposition: "NOT_PROPOSED" as const,
    plan_generation: "server.branch-query-planner.v1" as const,
  };
  const planDigest = await evidenceSha256({ domain: PLAN_DOMAIN, value: material });
  const plan = BranchQueryPlanSchema.parse({
    ...material,
    query_plan_ref: { id: `eliotr.research.branch-query-plan-${planDigest}`, revision: 1 },
    identity_digest: planDigest,
  });
  const principal: WorkflowPrincipal = {
    principal_ref: "branch-budget-owner",
    credential_generation: "credential-1",
    deployment_generation: "deployment-1",
  };
  const access: RetrievalQueryAccess = {
    principal_ref: principal.principal_ref,
    credential_generation: principal.credential_generation,
    client_class: "owner_pwa",
  };
  const request = StageRequestSchema.parse({
    protocol: "eliotr.workflow-stage.v1",
    operation_id: "branch-budget-operation",
    investigation_ref: { id: "branch-budget-investigation", revision: 1 },
    stage: "READ_AND_EXTRACT",
    idempotency_key: "branch-budget-idempotency",
    handler_generation: "research-handlers.exploratory.v9",
    input_manifest: {
      object_ref: "branch-budget-input",
      sha256: SHA,
      byte_length: 1,
      residency: {
        scope_domain_id: "branch-budget-scope",
        access_domain_id: "branch-budget-owner",
        confidentiality_domain_id: "confidentiality-1",
        encryption_key_domain_id: "key-1",
        retention_domain_id: "retention-1",
        erasure_domain_id: "erasure-1",
        content_digest: { algorithm: "sha256", digest: SHA },
      },
    },
  });
  const held: HeldResearchScope = {
    operation_id: request.operation_id,
    investigation_id: request.investigation_ref.id,
    scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision },
    scope_snapshot: scope,
    policy_generation: "policy-generation-1",
    policy_authority_ref: "policy-authority-1",
    authorization_receipt_ref: "authorization-1",
    purge_revision: 0,
    deployment_generation: principal.deployment_generation,
  };
  const navigation: NavigationReadAuthority = {
    scope,
    access,
    current: async () => scope,
    sources: async () => [],
    timestamp: () => "2026-10-14T00:00:00.000Z",
  };
  const dependencies: ResearchBranchQueryExecutionAdapterDependencies = {
    env: {} as ResearchRetrievalEnvironment,
    access,
    navigation,
    profile: { version: "scope-profile-1", max_sources: 8, max_results: 2 },
  };
  const observed: string[] = [];
  const ports: ResearchBranchQueryExecutionPorts = {
    load_held_scope: async () => held,
    retrieve: async (_env, retrievalInput) => {
      observed.push(retrievalInput.raw_query);
      const budgets = retrievalInput.budgets;
      if (budgets === undefined) throw new Error("missing request budgets");
      const ids = await managedRetrievalInvocationIdsV1(access.principal_ref, access.client_class, retrievalInput.idempotency_key);
      const traceRef = await managedRetrievalRefIdV1(ids.scoped_invocation_id, "trace");
      const packRef = await managedRetrievalRefIdV1(ids.scoped_invocation_id, "pack");
      const requestDigest = await retrievalRequestDigest({
        raw_query: retrievalInput.raw_query,
        product: retrievalInput.product,
        literals: retrievalInput.literals,
        requested_limit: retrievalInput.requested_limit,
        scope_digest: scope.digest,
        budgets,
      });
      const trace = ManagedRetrievalTraceSchema.parse({
        trace_ref: { id: traceRef, revision: 1 },
        raw_query: retrievalInput.raw_query,
        scope_snapshot: scope,
        query_product: retrievalInput.product,
        lanes_used: ["SEM"],
        lanes_skipped: [],
        exact_probes: [...retrievalInput.literals],
        index_generations: ["index-generation-1"],
        context_expansion: 0,
        candidates_by_lane: Object.fromEntries([
          "IDENT", "EXACT", "LEX", "SEM", "LITERAL", "SOURCECARD", "ATLAS", "ATOM", "ARGUMENT", "WIKI",
          "ARTIFACT", "STRUCTURE", "CODE", "WEB", "EXHAUSTIVE", "VERIFY",
        ].map((lane) => [lane, 0])),
        expansion_refs: [],
        represented_source_refs: [],
        omitted_sources: [],
        stale_or_degraded_channels: [],
        budget_receipt_ref: `budget-${ids.execution_id}`,
        evidence_pack_ref: packRef,
        protocol: MANAGED_RETRIEVAL_TRACE_PROTOCOL,
        managed_ranking_outcomes: [{
          protocol: MANAGED_RANKING_OUTCOME_PROTOCOL,
          provider: "cloudflare_ai_search",
          request_digest: requestDigest,
          scoped_invocation_id: ids.scoped_invocation_id,
          provider_execution_identity: {
            available: false,
            provider_execution_id: null,
            reason: "BINDING_RESPONSE_HAS_NO_EXECUTION_ID",
          },
          output_digest: SHA,
          provider_authority: {
            namespace: "research",
            instance_id: "managed-search-1",
            registry_revision: 1,
            registry_artifact_sha256: SHA,
          },
          authority_generations: {
            policy_generation: null,
            execution_generation: null,
            index_generation: "index-generation-1",
            query_compiler_generation: null,
          },
          executed_query: retrievalInput.raw_query,
          contributing_signals: [{ signal: "VECTOR", basis: "EXECUTED_QUERY" }],
          list_semantics: "ONE_PHYSICAL_MANAGED_LIST",
          scope_absence_proven: false,
          rerank_requested: false,
          rerank_attempted: false,
          rerank_succeeded: false,
          rerank_provider: null,
          rerank_model: null,
          fallback_used: false,
          failure_class: null,
          processing_state: "NO_HIT",
          ordered_candidates: [],
        }],
      });
      const result = {
        evidence_pack: {
          pack_ref: { id: packRef, revision: 1 },
          scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision },
          resolved_evidence: [],
          omitted_candidates: [],
          trace_ref: { id: traceRef, revision: 1 },
          total_utf8_bytes: 0,
        },
        trace,
        coverage_claim: "NONE" as const,
      };
      const settlement: NonNullable<RetrievalQueryExecutionV1["budget_settlement"]> = {
        protocol: "eliotr.retrieval-budget-settlement.v1",
        receipt_ref: `budget-${ids.execution_id}`,
        execution_id: ids.execution_id,
        request_digest: requestDigest,
        result_digest: SHA,
        trace_digest: SHA,
        usage: {
          candidateUnitsUsed: budgets.candidate_limit,
          providerCandidatesReturned: budgets.candidate_limit,
          fusionOperationsUsed: budgets.candidate_limit,
          exactResolverScanUnitsUsed: 0,
          evidenceItemsUsed: 0,
          evidenceBytesUsed: 0,
        },
        request_budgets: { ...budgets },
      };
      return { result, budget_settlement: settlement };
    },
  };
  return { scope, plan, request, principal, dependencies, ports, observed };
}

describe("held-scope branch query aggregate budget stop", () => {
  it("settles one exhausted leg and binds the skipped suffix before finalizing identity", async () => {
    const fixture = await runFixture();
    const result = await executeResearchBranchQueryPlanWithPorts({
      request: fixture.request,
      principal: fixture.principal,
      plan: fixture.plan,
    }, fixture.dependencies, fixture.ports);
    const receipt = result.budget_exhaustion;
    const first = fixture.plan.query_legs[0];
    const second = fixture.plan.query_legs[1];
    if (receipt === undefined || first === undefined || second === undefined) throw new Error("budget receipt missing");
    const { query_result_ref: resultRef, identity_digest: identityDigest, ...material } = result;

    expect(fixture.observed).toHaveLength(1);
    expect(result.stop_reason).toBe("BUDGET_EXHAUSTED");
    expect(receipt.exhausted_dimension).toBe("CANDIDATE_UNITS");
    expect(receipt.executed_query_refs).toEqual([{ query_id: first.query_id, query_sha256: first.query_sha256 }]);
    expect(receipt.unexecuted_query_refs).toEqual([{ query_id: second.query_id, query_sha256: second.query_sha256 }]);
    expect(await evidenceSha256({ domain: "eliotr.research.branch-query-result.v1", value: material })).toBe(identityDigest);
    expect(resultRef.id).toBe(`eliotr.research.branch-query-result-${identityDigest}`);
  });
});
