import { describe, expect, it } from "vitest";
import {
  BranchQueryPlanSchema,
  MANAGED_RANKING_OUTCOME_PROTOCOL,
  MANAGED_RETRIEVAL_TRACE_PROTOCOL,
  ManagedRetrievalTraceSchema,
  type RetrievalLane,
  RetrievalTraceSchema,
  ScopeSnapshotSchema,
  type BranchQueryPlan,
  type ResolvedEvidence,
  type ScopeSnapshot,
} from "@eliotr/contracts";
import { evidenceSha256, evidenceSha256Bytes, type NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import type { HeldResearchScope } from "@eliotr/cloudflare-research";
import { StageRequestSchema, type StageRequest, type WorkflowPrincipal } from "@eliotr/cloudflare-workflows";
import {
  managedRetrievalInvocationIdsV1,
  managedRetrievalRefIdV1,
  retrievalRequestDigest,
  type RetrievalQueryAccess,
  type RetrievalQueryExecutionV1,
  type RetrievalRequestBudgets,
  type RetrievalResult,
} from "@eliotr/retrieval";
import type { ResearchRetrievalEnvironment } from "./research-retrieval-composition.js";
import {
  executeResearchBranchQueryPlanWithPorts,
  type ResearchBranchQueryExecutionAdapterDependencies,
  type ResearchBranchQueryExecutionPorts,
} from "./research-branch-query-execution.js";

const SHA = "a".repeat(64);
const PLAN_DOMAIN = "eliotr.research.branch-query-plan.v1";
const LEG_DOMAIN = "eliotr.research.branch-query-leg.v1";
const QUESTION_DOMAIN = "eliotr.research.branch-query-question.v1";

function scopeFixture(): ScopeSnapshot {
  return ScopeSnapshotSchema.parse({
    snapshot_id: "branch-query-scope-1",
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
}

async function planFixture(input: {
  readonly scope: ScopeSnapshot;
  readonly stop_rule?: BranchQueryPlan["stop_rule"];
  readonly leg_count?: number;
}): Promise<BranchQueryPlan> {
  const scope = input.scope;
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
  const queryLegs = await Promise.all(Array.from({ length: input.leg_count ?? 1 }, async (_, index) => {
    const query = `root question branch support evidence ${index + 1}`;
    const literal_probes: string[] = [];
    const query_sha256 = await evidenceSha256({ domain: LEG_DOMAIN, value: { query, literal_probes } });
    return {
      query_id: `branch-query-${query_sha256.slice(0, 40)}-${index}`,
      query_sha256,
      query,
      literal_probes,
    };
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
      candidate_limit: 12,
      scan_limit: 24,
      evidence_limit: 2,
      max_evidence_bytes: 4096,
      max_query_legs: input.leg_count ?? 1,
    },
    required: true,
    stop_rule: input.stop_rule ?? "FIRST_ADMISSIBLE_EVIDENCE",
    proposal_disposition: "NOT_PROPOSED" as const,
    plan_generation: "server.branch-query-planner.v1" as const,
  };
  const identity_digest = await evidenceSha256({ domain: PLAN_DOMAIN, value: material });
  return BranchQueryPlanSchema.parse({
    ...material,
    query_plan_ref: { id: `eliotr.research.branch-query-plan-${identity_digest}`, revision: 1 },
    identity_digest,
  });
}

function stageRequest(): StageRequest {
  const digest = "e".repeat(64);
  return StageRequestSchema.parse({
    protocol: "eliotr.workflow-stage.v1",
    operation_id: "branch-query-operation-1",
    investigation_ref: { id: "branch-query-investigation-1", revision: 1 },
    stage: "READ_AND_EXTRACT",
    idempotency_key: "branch-query-stage-key-1",
    handler_generation: "research-handlers.exploratory.v9",
    input_manifest: {
      object_ref: "branch-query-input-1",
      sha256: digest,
      byte_length: 0,
      residency: {
        scope_domain_id: "branch-query-scope-1",
        access_domain_id: "branch-query-owner-1",
        confidentiality_domain_id: "private-1",
        encryption_key_domain_id: "key-1",
        retention_domain_id: "retention-1",
        erasure_domain_id: "erasure-1",
        content_digest: { algorithm: "sha256", digest },
      },
    },
  });
}

async function resolvedEvidence(scope: ScopeSnapshot): Promise<ResolvedEvidence> {
  const excerpt = "Exact admitted excerpt.";
  const excerptValue = new TextEncoder().encode(excerpt);
  const excerptBytes = excerptValue.byteLength;
  const excerptDigest = await evidenceSha256Bytes(excerptValue);
  return {
    handle: {
      handle_ref: { id: "evidence-handle-1", revision: 1 },
      source_namespace_id: "namespace-1",
      source_owner_generation: "owner-generation-1",
      source_revision_ref: "source-revision-1",
      scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision },
      anchor: { kind: "normalized_byte_range", start: 0, end: excerptBytes },
      excerpt_sha256: excerptDigest,
      excerpt_byte_length: excerptBytes,
      object_residency_key_digest: "1".repeat(64),
      source_assurance_ceiling: "EXACT",
      materializer_assurance_ceiling: "EXACT",
      terminal_state: "LIVE",
      created_at: "2026-10-14T00:00:00.000Z",
    },
    exact_excerpt: excerpt,
    verification_receipt_ref: "verification-1",
    authorization_receipt_ref: "authorization-1",
    credential_generation: "credential-1",
    source_revision_content_sha256: "2".repeat(64),
    scope_snapshot_digest: scope.digest,
    instruction_taint: "DATA_ONLY",
    allowed_effects: "READ_ONLY",
    resolved_at: "2026-10-14T00:00:00.000Z",
  };
}

function navigation(scope: ScopeSnapshot, access: RetrievalQueryAccess): NavigationReadAuthority {
  return {
    scope,
    access,
    current: async () => ({
      authorization_receipt_ref: "authorization-1",
      policy_authority_ref: "policy-authority-1",
      allowed_use: ["RESEARCH"],
      disclosure_ceiling: "PRIVATE",
      expires_at: scope.expires_at,
    }),
    sources: async () => [],
    timestamp: () => scope.created_at,
  };
}

function heldScope(scope: ScopeSnapshot): HeldResearchScope {
  return {
    operation_id: "branch-query-operation-1",
    investigation_id: "branch-query-investigation-1",
    scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision },
    scope_snapshot: scope,
    policy_generation: "policy-generation-1",
    policy_authority_ref: "policy-authority-1",
    authorization_receipt_ref: "authorization-1",
    purge_revision: scope.purge_ledger_revision,
    deployment_generation: "deployment-generation-1",
  };
}

function managedOutcome(input: {
  readonly query: string;
  readonly withEvidence: boolean;
  readonly requestDigest: string;
}): Record<string, unknown> {
  return {
    protocol: MANAGED_RANKING_OUTCOME_PROTOCOL,
    provider: "cloudflare_ai_search",
    request_digest: input.requestDigest,
    scoped_invocation_id: "pending-invocation",
    provider_execution_identity: {
      available: false,
      provider_execution_id: null,
      reason: "BINDING_RESPONSE_HAS_NO_EXECUTION_ID",
    },
    output_digest: "4".repeat(64),
    provider_authority: {
      namespace: "research",
      instance_id: "managed-search-1",
      registry_revision: 1,
      registry_artifact_sha256: "5".repeat(64),
    },
    authority_generations: {
      policy_generation: null,
      execution_generation: null,
      index_generation: "index-generation-1",
      query_compiler_generation: null,
    },
    executed_query: input.query,
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
    processing_state: input.withEvidence ? "COMPLETE" : "NO_HIT",
    ordered_candidates: input.withEvidence ? [{
      provider_rank: 1,
      raw_score: 0.5,
      locator: {
        candidate_id: "provider-candidate-1",
        source_revision_ref: "source-revision-1",
        canonical_section_id: "section-1",
        index_generation: "index-generation-1",
        metadata: {
          provider_item_key: "item-1.md",
          provider_chunk_type: "text",
          content_sha256: "2".repeat(64),
          instruction_taint: "DATA_ONLY",
        },
      },
      scoring_details: null,
    }] : [],
  };
}

async function retrievalExecution(input: {
  readonly scope: ScopeSnapshot;
  readonly access: RetrievalQueryAccess;
  readonly retrievalInput: Parameters<ResearchBranchQueryExecutionPorts["retrieve"]>[1];
  readonly withEvidence?: boolean;
  readonly legacyTrace?: boolean;
  readonly corruptPackRef?: boolean;
  readonly driftBudgets?: boolean;
  readonly foreignOutcomeDigest?: string;
}): Promise<RetrievalQueryExecutionV1> {
  const { retrievalInput, scope, access } = input;
  const executionIds = await managedRetrievalInvocationIdsV1(
    access.principal_ref,
    access.client_class,
    retrievalInput.idempotency_key,
  );
  const traceRef = await managedRetrievalRefIdV1(executionIds.scoped_invocation_id, "trace");
  const packRef = await managedRetrievalRefIdV1(executionIds.scoped_invocation_id, "pack");
  const budgets = retrievalInput.budgets;
  if (budgets === undefined) throw new Error("adapter omitted explicit query budgets");
  const requestDigest = await retrievalRequestDigest({
    raw_query: retrievalInput.raw_query,
    product: retrievalInput.product,
    literals: retrievalInput.literals,
    requested_limit: retrievalInput.requested_limit,
    scope_digest: scope.digest,
    budgets,
  });
  const evidence = input.withEvidence === true ? await resolvedEvidence(scope) : undefined;
  const resultTraceBase = {
    trace_ref: { id: input.corruptPackRef === true ? "mrt1-" + "9".repeat(48) : traceRef, revision: 1 },
    raw_query: retrievalInput.raw_query,
    scope_snapshot: scope,
    query_product: retrievalInput.product,
    lanes_used: ["SEM"] as const,
    lanes_skipped: [],
    exact_probes: [...retrievalInput.literals],
    index_generations: ["index-generation-1"],
    context_expansion: 0,
    candidates_by_lane: {
      IDENT: 0,
      EXACT: 0,
      LEX: 0,
      SEM: 0,
      LITERAL: 0,
      SOURCECARD: 0,
      ATLAS: 0,
      ATOM: 0,
      ARGUMENT: 0,
      WIKI: 0,
      ARTIFACT: 0,
      STRUCTURE: 0,
      CODE: 0,
      WEB: 0,
      EXHAUSTIVE: 0,
      VERIFY: 0,
    } satisfies Record<RetrievalLane, number>,
    expansion_refs: [],
    represented_source_refs: [],
    omitted_sources: [],
    stale_or_degraded_channels: [],
    budget_receipt_ref: `budget-${executionIds.execution_id}`,
    evidence_pack_ref: packRef,
  };
  const trace = input.legacyTrace === true
    ? RetrievalTraceSchema.parse(resultTraceBase)
    : ManagedRetrievalTraceSchema.parse({
      ...resultTraceBase,
      protocol: MANAGED_RETRIEVAL_TRACE_PROTOCOL,
      managed_ranking_outcomes: [{
        ...managedOutcome({
          query: retrievalInput.raw_query,
          withEvidence: evidence !== undefined,
          requestDigest: input.foreignOutcomeDigest ?? requestDigest,
        }),
        scoped_invocation_id: executionIds.scoped_invocation_id,
      }],
    });
  const resolved = evidence === undefined ? [] : [evidence];
  const result: RetrievalResult = {
    evidence_pack: {
      pack_ref: { id: packRef, revision: 1 },
      scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision },
      resolved_evidence: resolved,
      omitted_candidates: [],
      trace_ref: { id: traceRef, revision: 1 },
      total_utf8_bytes: resolved.reduce((sum, item) => sum + new TextEncoder().encode(item.exact_excerpt).byteLength, 0),
    },
    trace,
    coverage_claim: resolved.length === 0 ? "NONE" : "SAMPLED",
  };
  const expectedBudgets: RetrievalRequestBudgets = input.driftBudgets === true
    ? { ...budgets, candidate_limit: budgets.candidate_limit + 1 }
    : { ...budgets };
  return {
    result,
    budget_settlement: {
      protocol: "eliotr.retrieval-budget-settlement.v1",
      receipt_ref: `budget-${executionIds.execution_id}`,
      execution_id: executionIds.execution_id,
      request_digest: requestDigest,
      result_digest: "6".repeat(64),
      trace_digest: "7".repeat(64),
      usage: {
        candidateUnitsUsed: 1,
        providerCandidatesReturned: 1,
        fusionOperationsUsed: 1,
        exactResolverScanUnitsUsed: resolved.length,
        evidenceItemsUsed: resolved.length,
        evidenceBytesUsed: result.evidence_pack.total_utf8_bytes,
      },
      request_budgets: expectedBudgets,
    },
  };
}

function testInput(scope: ScopeSnapshot, plan: BranchQueryPlan) {
  const request = stageRequest();
  const principal: WorkflowPrincipal = {
    principal_ref: "branch-query-owner-1",
    credential_generation: "credential-1",
    deployment_generation: "deployment-generation-1",
  };
  const access: RetrievalQueryAccess = {
    principal_ref: principal.principal_ref,
    credential_generation: principal.credential_generation,
    client_class: "owner_pwa",
  };
  const dependencies: ResearchBranchQueryExecutionAdapterDependencies = {
    env: {} as ResearchRetrievalEnvironment,
    access,
    navigation: navigation(scope, access),
    profile: { version: "scope-profile-1", max_sources: 8, max_results: plan.budgets.evidence_limit },
  };
  return { request, principal, plan, dependencies, access };
}

function portsFor(input: {
  readonly scope: ScopeSnapshot;
  readonly access: RetrievalQueryAccess;
  readonly retrieve: ResearchBranchQueryExecutionPorts["retrieve"];
}): ResearchBranchQueryExecutionPorts {
  return {
    load_held_scope: async () => heldScope(input.scope),
    retrieve: input.retrieve,
  };
}

describe("held-scope branch query execution adapter", () => {
  it("passes the exact plan budget tuple to one managed query and returns resolved evidence with its managed ranking", async () => {
    const scope = scopeFixture();
    const plan = await planFixture({ scope });
    const input = testInput(scope, plan);
    const observedBudgets: RetrievalRequestBudgets[] = [];
    const ports = portsFor({
      scope,
      access: input.access,
      retrieve: async (_env, retrievalInput) => {
        if (retrievalInput.budgets === undefined) throw new Error("budgets missing");
        observedBudgets.push(retrievalInput.budgets);
        return retrievalExecution({ scope, access: input.access, retrievalInput, withEvidence: true });
      },
    });

    const result = await executeResearchBranchQueryPlanWithPorts(input, input.dependencies, ports);

    expect(observedBudgets).toEqual([{
      candidate_limit: plan.budgets.candidate_limit,
      scan_limit: plan.budgets.scan_limit,
      evidence_limit: plan.budgets.evidence_limit,
      max_evidence_bytes: plan.budgets.max_evidence_bytes,
    }]);
    expect(result.query_legs).toHaveLength(1);
    const managedTrace = ManagedRetrievalTraceSchema.parse(result.query_legs[0]?.trace);
    expect(managedTrace.managed_ranking_outcomes).toHaveLength(1);
    expect(managedTrace.managed_ranking_outcomes[0]?.request_digest)
      .toBe(result.query_legs[0]?.retrieval_request_digest);
    expect(managedTrace.trace_ref.id).toMatch(/^mrt1-[a-f0-9]{48}$/u);
    expect(result.resolved_evidence).toHaveLength(1);
    expect(result.resolved_evidence[0]?.handle.handle_ref.id).toBe("evidence-handle-1");
    expect(result.stop_reason).toBe("FIRST_ADMISSIBLE_EVIDENCE");
  });

  it("rejects a managed outcome bound to a foreign request digest at the adapter boundary", async () => {
    const scope = scopeFixture();
    const plan = await planFixture({ scope });
    const input = testInput(scope, plan);
    const ports = portsFor({
      scope,
      access: input.access,
      retrieve: (_env, retrievalInput) => retrievalExecution({
        scope,
        access: input.access,
        retrievalInput,
        foreignOutcomeDigest: "8".repeat(64),
      }),
    });

    await expect(executeResearchBranchQueryPlanWithPorts(input, input.dependencies, ports))
      .rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
  });

  it("runs deterministic no-proposal legs to a no-hit result without inventing evidence", async () => {
    const scope = scopeFixture();
    const plan = await planFixture({ scope, stop_rule: "EXHAUST_QUERY_LEGS", leg_count: 2 });
    const input = testInput(scope, plan);
    let calls = 0;
    const ports = portsFor({
      scope,
      access: input.access,
      retrieve: async (_env, retrievalInput) => {
        calls += 1;
        return retrievalExecution({ scope, access: input.access, retrievalInput });
      },
    });

    const result = await executeResearchBranchQueryPlanWithPorts(input, input.dependencies, ports);

    expect(plan.proposal_disposition).toBe("NOT_PROPOSED");
    expect(calls).toBe(2);
    expect(result.query_legs).toHaveLength(2);
    expect(result.resolved_evidence).toEqual([]);
    expect(result.stop_reason).toBe("NO_HITS");
  });

  it("rejects a legal historical trace instead of using it as the V9 forward retrieval result", async () => {
    const scope = scopeFixture();
    const plan = await planFixture({ scope });
    const input = testInput(scope, plan);
    let calls = 0;
    const ports = portsFor({
      scope,
      access: input.access,
      retrieve: async (_env, retrievalInput) => {
        calls += 1;
        return retrievalExecution({ scope, access: input.access, retrievalInput, legacyTrace: true });
      },
    });

    await expect(executeResearchBranchQueryPlanWithPorts(input, input.dependencies, ports))
      .rejects.toMatchObject({ code: "WORKFLOW_CONFIGURATION_MISSING" });
    expect(calls).toBe(1);
  });

  it("rejects a foreign held scope before querying", async () => {
    const scope = scopeFixture();
    const plan = await planFixture({ scope });
    const input = testInput(scope, plan);
    const foreign = ScopeSnapshotSchema.parse({ ...scope, snapshot_id: "foreign-scope-1" });
    let calls = 0;
    const ports: ResearchBranchQueryExecutionPorts = {
      load_held_scope: async () => heldScope(foreign),
      retrieve: async () => {
        calls += 1;
        throw new Error("foreign scope reached retrieval");
      },
    };

    await expect(executeResearchBranchQueryPlanWithPorts(input, input.dependencies, ports))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(calls).toBe(0);
  });

  it("rejects corrupt managed trace-to-pack refs", async () => {
    const scope = scopeFixture();
    const plan = await planFixture({ scope });
    const input = testInput(scope, plan);
    const ports = portsFor({
      scope,
      access: input.access,
      retrieve: (_env, retrievalInput) => retrievalExecution({
        scope,
        access: input.access,
        retrievalInput,
        corruptPackRef: true,
      }),
    });

    await expect(executeResearchBranchQueryPlanWithPorts(input, input.dependencies, ports))
      .rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
  });

  it("rejects settled request-budget drift and caller plan mutation", async () => {
    const scope = scopeFixture();
    const plan = await planFixture({ scope });
    const mutablePlan = JSON.parse(JSON.stringify(plan));
    const input = testInput(scope, mutablePlan);
    const observedBudgets: RetrievalRequestBudgets[] = [];
    const ports = portsFor({
      scope,
      access: input.access,
      retrieve: async (_env, retrievalInput) => {
        if (retrievalInput.budgets === undefined) throw new Error("budgets missing");
        observedBudgets.push(retrievalInput.budgets);
        mutablePlan.budgets.candidate_limit = 1;
        return retrievalExecution({ scope, access: input.access, retrievalInput, driftBudgets: true });
      },
    });

    await expect(executeResearchBranchQueryPlanWithPorts(input, input.dependencies, ports))
      .rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
    expect(observedBudgets).toEqual([{
      candidate_limit: plan.budgets.candidate_limit,
      scan_limit: plan.budgets.scan_limit,
      evidence_limit: plan.budgets.evidence_limit,
      max_evidence_bytes: plan.budgets.max_evidence_bytes,
    }]);
  });

  it("reuses the settled managed retrieval idempotency key without redispatch on replay", async () => {
    const scope = scopeFixture();
    const plan = await planFixture({ scope });
    const input = testInput(scope, plan);
    const settled = new Map<string, RetrievalQueryExecutionV1>();
    let providerDispatches = 0;
    const ports = portsFor({
      scope,
      access: input.access,
      retrieve: async (_env, retrievalInput) => {
        const prior = settled.get(retrievalInput.idempotency_key);
        if (prior !== undefined) return prior;
        providerDispatches += 1;
        const execution = await retrievalExecution({ scope, access: input.access, retrievalInput, withEvidence: true });
        settled.set(retrievalInput.idempotency_key, execution);
        return execution;
      },
    });

    const first = await executeResearchBranchQueryPlanWithPorts(input, input.dependencies, ports);
    const replay = await executeResearchBranchQueryPlanWithPorts(input, input.dependencies, ports);

    expect(replay).toEqual(first);
    expect(settled.size).toBe(1);
    expect(providerDispatches).toBe(1);
  });
});
