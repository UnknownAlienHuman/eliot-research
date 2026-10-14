import {
  BranchQueryPlanSchema,
  BranchQueryResultSchema,
  MANAGED_RETRIEVAL_TRACE_PROTOCOL,
  ManagedRetrievalTraceSchema,
  ResolvedEvidenceSchema,
  RetrievalTraceSchema,
  ScopeSnapshotSchema,
  branchQueryResultMatchesPlan,
  type BranchQueryPlan,
  type BranchQueryResult,
  type ResolvedEvidence,
  type VersionedRef,
} from "@eliotr/contracts";
import { canonicalEvidenceJson, evidenceSha256, evidenceSha256Bytes, type NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import {
  fail,
  StageRequestSchema,
  type StageRequest,
  type WorkflowPrincipal,
} from "@eliotr/cloudflare-workflows";
import {
  managedRetrievalInvocationIdsV1,
  managedRetrievalRefIdV1,
  retrievalRequestDigest,
  type RetrievalQueryAccess,
  type RetrievalQueryExecutionV1,
  type RetrievalRequestBudgets,
  type ScopeProfileBinding,
} from "@eliotr/retrieval";
import type { HeldResearchScope } from "@eliotr/cloudflare-research";
import {
  loadHeldResearchScope,
  retrieveWithHeldScopeWithBudgetSettlement,
  type HeldScopeRetrievalInput,
  type ResearchRetrievalEnvironment,
} from "./research-retrieval-composition.js";

const BRANCH_QUERY_RETRIEVAL_DEADLINE_MS = 30_000;
const RESULT_DOMAIN = "eliotr.research.branch-query-result.v1";
const PLAN_DOMAIN = "eliotr.research.branch-query-plan.v1";
const LEG_DOMAIN = "eliotr.research.branch-query-leg.v1";
const QUESTION_DOMAIN = "eliotr.research.branch-query-question.v1";
const BRANCH_QUERY_HANDLER_GENERATION = "research-handlers.exploratory.v9";

export interface ResearchBranchQueryExecutionAdapterDependencies {
  readonly env: ResearchRetrievalEnvironment;
  readonly access: RetrievalQueryAccess;
  readonly navigation: NavigationReadAuthority;
  readonly profile: ScopeProfileBinding;
}

/** Ports preserve the production adapter seam for deterministic boundary tests. */
export interface ResearchBranchQueryExecutionPorts {
  readonly load_held_scope: (input: {
    readonly env: Pick<ResearchRetrievalEnvironment, "CORE_DB" | "SEARCH_DB">;
    readonly access: RetrievalQueryAccess;
    readonly operation_id: string;
    readonly deployment_generation: string;
  }) => Promise<HeldResearchScope>;
  readonly retrieve: (
    env: ResearchRetrievalEnvironment,
    input: HeldScopeRetrievalInput,
  ) => Promise<RetrievalQueryExecutionV1>;
}

export interface ResearchBranchQueryExecutionInput {
  readonly request: StageRequest;
  readonly principal: WorkflowPrincipal;
  readonly plan: BranchQueryPlan;
}

function freezeTree(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeTree(child);
  Object.freeze(value);
}

function parseAndFreeze<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  let parsed: T;
  try { parsed = schema.parse(value); }
  catch { fail("WORKFLOW_OUTPUT_CORRUPT"); }
  freezeTree(parsed);
  return parsed;
}

function requireRef(value: VersionedRef): VersionedRef {
  if (typeof value.id !== "string" || value.id.length === 0 || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    fail("WORKFLOW_OUTPUT_CORRUPT");
  }
  return Object.freeze({ id: value.id, revision: value.revision });
}

function snapshotHeldScope(value: HeldResearchScope): HeldResearchScope {
  const scopeSnapshot = parseAndFreeze(ScopeSnapshotSchema, value.scope_snapshot);
  const scopeSnapshotRef = requireRef(value.scope_snapshot_ref);
  if (typeof value.operation_id !== "string" || typeof value.investigation_id !== "string" ||
      typeof value.policy_generation !== "string" || typeof value.policy_authority_ref !== "string" ||
      typeof value.authorization_receipt_ref !== "string" || typeof value.deployment_generation !== "string" ||
      !Number.isSafeInteger(value.purge_revision) || value.purge_revision < 0 ||
      scopeSnapshot.snapshot_id !== scopeSnapshotRef.id || scopeSnapshot.revision !== scopeSnapshotRef.revision) {
    fail("WORKFLOW_OUTPUT_CORRUPT");
  }
  const snapshot: HeldResearchScope = {
    operation_id: value.operation_id,
    investigation_id: value.investigation_id,
    scope_snapshot_ref: scopeSnapshotRef,
    scope_snapshot: scopeSnapshot,
    policy_generation: value.policy_generation,
    policy_authority_ref: value.policy_authority_ref,
    authorization_receipt_ref: value.authorization_receipt_ref,
    purge_revision: value.purge_revision,
    deployment_generation: value.deployment_generation,
  };
  freezeTree(snapshot);
  return snapshot;
}

function snapshotPrincipal(value: WorkflowPrincipal): WorkflowPrincipal {
  if (typeof value.principal_ref !== "string" || value.principal_ref.length === 0 ||
      typeof value.credential_generation !== "string" || value.credential_generation.length === 0 ||
      typeof value.deployment_generation !== "string" || value.deployment_generation.length === 0) {
    fail("WORKFLOW_AUTHORITY_STALE");
  }
  return Object.freeze({
    principal_ref: value.principal_ref,
    credential_generation: value.credential_generation,
    deployment_generation: value.deployment_generation,
    ...(value.signal === undefined ? {} : { signal: value.signal }),
  });
}

function snapshotProfile(value: ScopeProfileBinding): ScopeProfileBinding {
  if (typeof value.version !== "string" || value.version.length < 1 || value.version.length > 128 ||
      !Number.isSafeInteger(value.max_sources) || value.max_sources < 1 ||
      !Number.isSafeInteger(value.max_results) || value.max_results < 1) {
    fail("WORKFLOW_CONFIGURATION_MISSING");
  }
  return Object.freeze({
    version: value.version,
    max_sources: value.max_sources,
    max_results: value.max_results,
  });
}

function snapshotNavigation(value: NavigationReadAuthority): NavigationReadAuthority {
  const scope = parseAndFreeze(ScopeSnapshotSchema, value.scope);
  const access = Object.freeze({ ...value.access });
  return Object.freeze({
    scope,
    access,
    current: (requested?: typeof scope) => value.current(requested),
    sources: (
      refs: Parameters<NavigationReadAuthority["sources"]>[0],
      grant: Parameters<NavigationReadAuthority["sources"]>[1],
    ) => value.sources(refs, grant),
    timestamp: () => value.timestamp(),
  });
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function heldScopeIdentity(value: HeldResearchScope): string {
  return canonicalEvidenceJson(value);
}

function checkHeldScopeBinding(input: {
  readonly held: HeldResearchScope;
  readonly request: StageRequest;
  readonly principal: WorkflowPrincipal;
  readonly plan: BranchQueryPlan;
  readonly dependencies: ResearchBranchQueryExecutionAdapterDependencies;
}): void {
  const { held, request, principal, plan, dependencies } = input;
  if (held.operation_id !== request.operation_id ||
      held.investigation_id !== request.investigation_ref.id ||
      held.deployment_generation !== principal.deployment_generation ||
      !sameRef(held.scope_snapshot_ref, plan.scope_snapshot_ref) ||
      held.scope_snapshot.digest !== plan.scope_snapshot_digest ||
      !sameRef(held.scope_snapshot_ref, {
        id: dependencies.navigation.scope.snapshot_id,
        revision: dependencies.navigation.scope.revision,
      }) ||
      held.scope_snapshot.digest !== dependencies.navigation.scope.digest ||
      held.policy_authority_ref !== held.scope_snapshot.policy_authority_ref ||
      request.input_manifest.residency.scope_domain_id !== held.scope_snapshot_ref.id ||
      request.input_manifest.residency.access_domain_id !== principal.principal_ref ||
      dependencies.navigation.access.principal_ref !== principal.principal_ref ||
      dependencies.navigation.access.credential_generation !== principal.credential_generation ||
      dependencies.navigation.access.client_class !== dependencies.access.client_class) {
    fail("WORKFLOW_AUTHORITY_STALE");
  }
}

async function readCurrentHeldScope(input: {
  readonly dependencies: ResearchBranchQueryExecutionAdapterDependencies;
  readonly ports: ResearchBranchQueryExecutionPorts;
  readonly request: StageRequest;
  readonly principal: WorkflowPrincipal;
  readonly plan: BranchQueryPlan;
}): Promise<{ readonly held: HeldResearchScope; readonly navigation_identity: string }> {
  const navigationBefore = canonicalEvidenceJson(await input.dependencies.navigation.current());
  const held = snapshotHeldScope(await input.ports.load_held_scope({
    env: input.dependencies.env,
    access: input.dependencies.access,
    operation_id: input.request.operation_id,
    deployment_generation: input.principal.deployment_generation,
  }));
  const navigationAfter = canonicalEvidenceJson(await input.dependencies.navigation.current());
  if (navigationBefore !== navigationAfter) fail("WORKFLOW_AUTHORITY_STALE");
  checkHeldScopeBinding({ ...input, held });
  return { held, navigation_identity: navigationAfter };
}

async function assertPlanIdentity(plan: BranchQueryPlan): Promise<void> {
  const {
    query_plan_ref: queryPlanRef,
    identity_digest: identityDigest,
    ...material
  } = plan;
  if (await evidenceSha256({ domain: PLAN_DOMAIN, value: material }) !== identityDigest ||
      queryPlanRef.id !== `eliotr.research.branch-query-plan-${identityDigest}` ||
      queryPlanRef.revision !== 1) {
    fail("WORKFLOW_OUTPUT_CORRUPT");
  }
  for (let index = 0; index < plan.query_legs.length; index += 1) {
    const leg = plan.query_legs[index];
    if (leg === undefined) fail("WORKFLOW_OUTPUT_CORRUPT");
    const queryDigest = await evidenceSha256({
      domain: LEG_DOMAIN,
      value: { query: leg.query, literal_probes: [...leg.literal_probes] },
    });
    if (leg.query_sha256 !== queryDigest || leg.query_id !== `branch-query-${queryDigest.slice(0, 40)}-${index}`) {
      fail("WORKFLOW_OUTPUT_CORRUPT");
    }
  }
  for (const question of [plan.root_question, plan.branch_question]) {
    const questionDigest = await evidenceSha256({
      domain: QUESTION_DOMAIN,
      value: { question_ref: question.question_ref, text: question.text },
    });
    if (question.text_sha256 !== questionDigest) fail("WORKFLOW_OUTPUT_CORRUPT");
  }
}

function requireManagedTrace(value: unknown) {
  const managed = ManagedRetrievalTraceSchema.safeParse(value);
  if (!managed.success) {
    if (RetrievalTraceSchema.safeParse(value).success) fail("WORKFLOW_CONFIGURATION_MISSING");
    fail("WORKFLOW_OUTPUT_CORRUPT");
  }
  if (managed.data.managed_ranking_outcomes.length !== 1) fail("WORKFLOW_OUTPUT_CORRUPT");
  return managed.data;
}

function evidenceIdentity(value: ResolvedEvidence): string {
  return canonicalEvidenceJson({
    handle: value.handle,
    exact_excerpt: value.exact_excerpt,
    credential_generation: value.credential_generation,
    source_revision_content_sha256: value.source_revision_content_sha256,
    scope_snapshot_digest: value.scope_snapshot_digest,
    instruction_taint: value.instruction_taint,
    allowed_effects: value.allowed_effects,
  });
}

function legStopReason(value: {
  readonly evidence: readonly ResolvedEvidence[];
  readonly omissions: readonly { readonly reason_code: string }[];
}): "LEG_COMPLETED" | "NO_HITS" | "CANDIDATE_BUDGET" | "SCAN_BUDGET" | "EVIDENCE_BUDGET" {
  if (value.omissions.some((item) => item.reason_code === "CANDIDATE_LIMIT" || item.reason_code === "FUSION_CANDIDATE_LIMIT")) {
    return "CANDIDATE_BUDGET";
  }
  if (value.omissions.some((item) => item.reason_code === "DIVERSITY_SCAN_LIMIT" || item.reason_code === "EXACT_RESOLUTION_SCAN_LIMIT")) {
    return "SCAN_BUDGET";
  }
  if (value.omissions.some((item) => item.reason_code === "EVIDENCE_LIMIT" || item.reason_code === "EVIDENCE_UTF8_LIMIT")) {
    return "EVIDENCE_BUDGET";
  }
  return value.evidence.length === 0 ? "NO_HITS" : "LEG_COMPLETED";
}

function bytesUsed(value: readonly ResolvedEvidence[]): number {
  return value.reduce((sum, item) => sum + new TextEncoder().encode(item.exact_excerpt).byteLength, 0);
}

function requestBudgets(value: BranchQueryPlan["budgets"]): RetrievalRequestBudgets {
  return Object.freeze({
    candidate_limit: value.candidate_limit,
    scan_limit: value.scan_limit,
    evidence_limit: value.evidence_limit,
    max_evidence_bytes: value.max_evidence_bytes,
  });
}

function assertSettlement(input: {
  readonly execution: RetrievalQueryExecutionV1;
  readonly expectedBudgets: RetrievalRequestBudgets;
  readonly expectedDigest: string;
}): NonNullable<RetrievalQueryExecutionV1["budget_settlement"]> {
  const receipt = input.execution.budget_settlement;
  if (receipt === undefined || receipt.request_digest !== input.expectedDigest ||
      canonicalEvidenceJson(receipt.request_budgets) !== canonicalEvidenceJson(input.expectedBudgets) ||
      !Number.isSafeInteger(receipt.usage.candidateUnitsUsed) || receipt.usage.candidateUnitsUsed < 0 ||
      receipt.usage.candidateUnitsUsed > input.expectedBudgets.candidate_limit ||
      !Number.isSafeInteger(receipt.usage.exactResolverScanUnitsUsed) || receipt.usage.exactResolverScanUnitsUsed < 0 ||
      receipt.usage.exactResolverScanUnitsUsed > input.expectedBudgets.scan_limit ||
      !Number.isSafeInteger(receipt.usage.evidenceItemsUsed) || receipt.usage.evidenceItemsUsed < 0 ||
      receipt.usage.evidenceItemsUsed > input.expectedBudgets.evidence_limit ||
      !Number.isSafeInteger(receipt.usage.evidenceBytesUsed) || receipt.usage.evidenceBytesUsed < 0) {
    fail("WORKFLOW_OUTPUT_CORRUPT");
  }
  return receipt;
}

function decrementBudgets(
  available: RetrievalRequestBudgets,
  used: NonNullable<RetrievalQueryExecutionV1["budget_settlement"]>["usage"],
): RetrievalRequestBudgets {
  return Object.freeze({
    candidate_limit: Math.max(0, available.candidate_limit - used.candidateUnitsUsed),
    scan_limit: Math.max(0, available.scan_limit - used.exactResolverScanUnitsUsed),
    evidence_limit: Math.max(0, available.evidence_limit - used.evidenceItemsUsed),
    max_evidence_bytes: Math.max(0, available.max_evidence_bytes - used.evidenceBytesUsed),
  });
}

function hasRemainingBudget(value: RetrievalRequestBudgets): boolean {
  return value.candidate_limit > 0 && value.scan_limit > 0 && value.evidence_limit > 0 && value.max_evidence_bytes > 0;
}

function cancellationRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function sameEvidence(left: ResolvedEvidence, right: ResolvedEvidence): boolean {
  return evidenceIdentity(left) === evidenceIdentity(right);
}

function refKey(value: VersionedRef): string {
  return `${value.id}:${value.revision}`;
}

function addEvidence(
  byHandle: Map<string, ResolvedEvidence>,
  values: readonly ResolvedEvidence[],
): void {
  for (const raw of values) {
    const evidence = ResolvedEvidenceSchema.parse(raw);
    const key = refKey(evidence.handle.handle_ref);
    const previous = byHandle.get(key);
    if (previous !== undefined && !sameEvidence(previous, evidence)) fail("WORKFLOW_OUTPUT_CORRUPT");
    if (previous === undefined) byHandle.set(key, evidence);
  }
}

async function retrievalIdempotencyKey(input: {
  readonly request: StageRequest;
  readonly plan: BranchQueryPlan;
  readonly queryId: string;
}): Promise<string> {
  const digest = await evidenceSha256({
    domain: "eliotr.research.branch-query-retrieval-idempotency.v1",
    value: {
      operation_id: input.request.operation_id,
      investigation_ref: input.request.investigation_ref,
      request_idempotency_key: input.request.idempotency_key,
      query_plan_ref: input.plan.query_plan_ref,
      query_plan_digest: input.plan.identity_digest,
      query_id: input.queryId,
    },
  });
  return `branch-query-v1:${digest}`;
}

export async function executeResearchBranchQueryPlanWithPorts(
  input: ResearchBranchQueryExecutionInput,
  dependencies: ResearchBranchQueryExecutionAdapterDependencies,
  ports: ResearchBranchQueryExecutionPorts,
): Promise<BranchQueryResult> {
  // Strict parses make private snapshots before the first await; retries cannot
  // observe caller mutation of the request, plan, access tuple, or profile.
  const request = parseAndFreeze(StageRequestSchema, input.request);
  const plan = parseAndFreeze(BranchQueryPlanSchema, input.plan);
  const principal = snapshotPrincipal(input.principal);
  const access = Object.freeze({ ...dependencies.access });
  const profile = snapshotProfile(dependencies.profile);
  const navigation = snapshotNavigation(dependencies.navigation);
  const env = Object.freeze({ ...dependencies.env });
  const frozenPorts: ResearchBranchQueryExecutionPorts = Object.freeze({
    load_held_scope: ports.load_held_scope,
    retrieve: ports.retrieve,
  });
  const frozenDependencies: ResearchBranchQueryExecutionAdapterDependencies = Object.freeze({
    env,
    access,
    navigation,
    profile,
  });

  if (request.stage !== "READ_AND_EXTRACT" ||
      request.handler_generation !== BRANCH_QUERY_HANDLER_GENERATION ||
      access.principal_ref !== principal.principal_ref ||
      access.credential_generation !== principal.credential_generation ||
      frozenDependencies.navigation.access.principal_ref !== principal.principal_ref ||
      frozenDependencies.navigation.access.credential_generation !== principal.credential_generation ||
      plan.proposal_disposition !== "NOT_PROPOSED" ||
      plan.budgets.evidence_limit > profile.max_results) {
    fail("WORKFLOW_CONFIGURATION_MISSING");
  }
  if (cancellationRequested(principal.signal)) fail("WORKFLOW_CANCELLED");

  await assertPlanIdentity(plan);
  const initialAuthority = await readCurrentHeldScope({
    dependencies: frozenDependencies,
    ports: frozenPorts,
    request,
    principal,
    plan,
  });

  const deadlineMs = Date.now() + BRANCH_QUERY_RETRIEVAL_DEADLINE_MS;
  const signal = principal.signal ?? new AbortController().signal;
  let remaining = requestBudgets(plan.budgets);
  let budgetExhausted = false;
  let firstEvidenceStop = false;
  const queryLegs: BranchQueryResult["query_legs"] = [];
  const evidenceByHandle = new Map<string, ResolvedEvidence>();

  for (const leg of plan.query_legs) {
    if (cancellationRequested(principal.signal)) fail("WORKFLOW_CANCELLED");
    if (!hasRemainingBudget(remaining)) {
      budgetExhausted = true;
      break;
    }
    const before = await readCurrentHeldScope({
      dependencies: frozenDependencies,
      ports: frozenPorts,
      request,
      principal,
      plan,
    });
    if (heldScopeIdentity(before.held) !== heldScopeIdentity(initialAuthority.held) ||
        before.navigation_identity !== initialAuthority.navigation_identity) fail("WORKFLOW_AUTHORITY_STALE");

    const legBudgets = Object.freeze({ ...remaining });
    const requestedLimit = legBudgets.evidence_limit;
    const literals = Object.freeze([...leg.literal_probes]);
    const idempotencyKey = await retrievalIdempotencyKey({ request, plan, queryId: leg.query_id });
    const invocation = await managedRetrievalInvocationIdsV1(
      principal.principal_ref,
      access.client_class,
      idempotencyKey,
    );
    const retrievalInput: HeldScopeRetrievalInput = Object.freeze({
      access,
      scope_snapshot: before.held.scope_snapshot,
      raw_query: leg.query,
      product: plan.retrieval_product,
      literals,
      requested_limit: requestedLimit,
      deadline_ms: deadlineMs,
      idempotency_key: idempotencyKey,
      signal,
      profile,
      budgets: legBudgets,
    });
    const expectedDigest = await retrievalRequestDigest({
      raw_query: retrievalInput.raw_query,
      product: retrievalInput.product,
      literals: retrievalInput.literals,
      requested_limit: retrievalInput.requested_limit,
      scope_digest: before.held.scope_snapshot.digest,
      budgets: legBudgets,
    });

    const execution = await frozenPorts.retrieve(frozenDependencies.env, retrievalInput);
    const after = await readCurrentHeldScope({
      dependencies: frozenDependencies,
      ports: frozenPorts,
      request,
      principal,
      plan,
    });
    if (heldScopeIdentity(after.held) !== heldScopeIdentity(initialAuthority.held) ||
        after.navigation_identity !== initialAuthority.navigation_identity) fail("WORKFLOW_AUTHORITY_STALE");
    if (cancellationRequested(principal.signal)) fail("WORKFLOW_CANCELLED");

    const settlement = assertSettlement({ execution, expectedBudgets: legBudgets, expectedDigest });
    const managedTrace = requireManagedTrace(execution.result.trace);
    const pack = execution.result.evidence_pack;
    const packScopeRef = requireRef(pack.scope_snapshot_ref);
    const traceRef = requireRef(managedTrace.trace_ref);
    const expectedTraceRef = await managedRetrievalRefIdV1(invocation.scoped_invocation_id, "trace");
    const expectedPackRef = await managedRetrievalRefIdV1(invocation.scoped_invocation_id, "pack");
    const outcome = managedTrace.managed_ranking_outcomes[0];
    if (managedTrace.managed_ranking_outcomes.length !== 1 ||
        outcome === undefined ||
        managedTrace.protocol !== MANAGED_RETRIEVAL_TRACE_PROTOCOL ||
        outcome.scoped_invocation_id !== invocation.scoped_invocation_id ||
        settlement.execution_id !== invocation.execution_id ||
        settlement.receipt_ref !== `budget-${invocation.execution_id}` ||
        traceRef.id !== expectedTraceRef ||
        pack.pack_ref.id !== expectedPackRef ||
        managedTrace.raw_query !== leg.query || managedTrace.query_product !== plan.retrieval_product ||
        managedTrace.scope_snapshot.digest !== before.held.scope_snapshot.digest ||
        !sameRef(packScopeRef, before.held.scope_snapshot_ref) ||
        !sameRef(traceRef, pack.trace_ref) ||
        managedTrace.evidence_pack_ref !== pack.pack_ref.id ||
        canonicalEvidenceJson(managedTrace.scope_snapshot) !== canonicalEvidenceJson(before.held.scope_snapshot)) {
      fail("WORKFLOW_OUTPUT_CORRUPT");
    }
    if (pack.resolved_evidence.length > legBudgets.evidence_limit ||
        pack.total_utf8_bytes > legBudgets.max_evidence_bytes ||
        bytesUsed(pack.resolved_evidence) !== pack.total_utf8_bytes) fail("WORKFLOW_OUTPUT_CORRUPT");

    const legEvidence = pack.resolved_evidence.map((item) => ResolvedEvidenceSchema.parse(item));
    for (const item of legEvidence) {
      const excerptBytes = new TextEncoder().encode(item.exact_excerpt);
      if (item.scope_snapshot_digest !== before.held.scope_snapshot.digest ||
          !sameRef(item.handle.scope_snapshot_ref, before.held.scope_snapshot_ref) ||
          excerptBytes.byteLength !== item.handle.excerpt_byte_length ||
          await evidenceSha256Bytes(excerptBytes) !== item.handle.excerpt_sha256) {
        fail("WORKFLOW_OUTPUT_CORRUPT");
      }
    }
    const handleRefs = legEvidence.map((item) => ({
      handle_ref: requireRef(item.handle.handle_ref),
      excerpt_sha256: item.handle.excerpt_sha256,
      excerpt_byte_length: item.handle.excerpt_byte_length,
    }));
    if (new Set(handleRefs.map((item) => refKey(item.handle_ref))).size !== handleRefs.length) {
      fail("WORKFLOW_OUTPUT_CORRUPT");
    }
    const omissions = pack.omitted_candidates.map((item) => ({
      candidate_id: item.candidate_id,
      reason_code: item.reason_code,
    }));
    const legStop = legStopReason({ evidence: legEvidence, omissions });
    queryLegs.push({
      status: "COMPLETED",
      query_id: leg.query_id,
      query_sha256: leg.query_sha256,
      retrieval_request_digest: expectedDigest,
      scope_snapshot_ref: before.held.scope_snapshot_ref,
      scope_snapshot_digest: before.held.scope_snapshot.digest,
      trace: managedTrace,
      resolved_handle_refs: handleRefs,
      omitted_candidates: omissions,
      stop_reason: legStop,
    });
    addEvidence(evidenceByHandle, legEvidence);
    remaining = decrementBudgets(legBudgets, settlement.usage);

    if (plan.stop_rule === "FIRST_ADMISSIBLE_EVIDENCE" && legEvidence.length > 0) {
      firstEvidenceStop = true;
      break;
    }
    if (!hasRemainingBudget(remaining) && queryLegs.length < plan.query_legs.length) {
      budgetExhausted = true;
      break;
    }
  }

  if (queryLegs.length === 0) fail("WORKFLOW_OUTPUT_CORRUPT");
  const resolvedEvidence = [...evidenceByHandle.values()];
  const totalBytes = bytesUsed(resolvedEvidence);
  if (resolvedEvidence.length > plan.budgets.evidence_limit || totalBytes > plan.budgets.max_evidence_bytes) {
    fail("WORKFLOW_OUTPUT_CORRUPT");
  }
  const omittedCandidateRefs = [...new Set(queryLegs.flatMap((leg) => leg.omitted_candidates.map((item) => item.candidate_id)))].sort();
  const stopReason: BranchQueryResult["stop_reason"] = firstEvidenceStop
    ? "FIRST_ADMISSIBLE_EVIDENCE"
    : budgetExhausted
      ? "BUDGET_EXHAUSTED"
      : resolvedEvidence.length === 0
        ? "NO_HITS"
        : "PLAN_COMPLETED";
  const material = {
    protocol: "eliotr.research.branch-query-result.v1" as const,
    query_plan_ref: plan.query_plan_ref,
    query_plan_digest: plan.identity_digest,
    role: plan.role,
    scope_snapshot_ref: plan.scope_snapshot_ref,
    scope_snapshot_digest: plan.scope_snapshot_digest,
    query_legs: queryLegs,
    resolved_evidence: resolvedEvidence,
    omitted_candidate_refs: omittedCandidateRefs,
    total_utf8_bytes: totalBytes,
    stop_reason: stopReason,
    failure_disposition: "NONE" as const,
  };
  const identityDigest = await evidenceSha256({ domain: RESULT_DOMAIN, value: material });
  const result = BranchQueryResultSchema.safeParse({
    ...material,
    query_result_ref: { id: `eliotr.research.branch-query-result-${identityDigest}`, revision: 1 },
    identity_digest: identityDigest,
  });
  if (!result.success || !branchQueryResultMatchesPlan(plan, result.data)) fail("WORKFLOW_OUTPUT_CORRUPT");
  return result.data;
}

export function createResearchBranchQueryExecutionAdapter(
  dependencies: ResearchBranchQueryExecutionAdapterDependencies,
): (input: ResearchBranchQueryExecutionInput) => Promise<BranchQueryResult> {
  const access = Object.freeze({ ...dependencies.access });
  const profile = snapshotProfile(dependencies.profile);
  const capturedDependencies: ResearchBranchQueryExecutionAdapterDependencies = Object.freeze({
    env: dependencies.env,
    access,
    navigation: dependencies.navigation,
    profile,
  });
  const ports: ResearchBranchQueryExecutionPorts = {
    load_held_scope: ({ env, access: queryAccess, operation_id, deployment_generation }) =>
      loadHeldResearchScope(env, queryAccess, operation_id, deployment_generation),
    retrieve: retrieveWithHeldScopeWithBudgetSettlement,
  };
  return (input) => executeResearchBranchQueryPlanWithPorts(input, capturedDependencies, ports);
}
