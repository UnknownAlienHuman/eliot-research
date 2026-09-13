import {
  canonicalEvidenceJson,
  stableEvidenceId,
  type EvidenceSourceAuthority,
  type NavigationReadAuthority,
} from "@eliotr/cloudflare-evidence";
import {
  type CoverageReceipt,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  createEvidenceFreezePostSynthesisContextReader,
  CORPUS_EXPLORATORY_LOOKUP_DEFINITIONS,
  readCommittedProtocolScopeCheckpoint,
  type EvidenceFreezeCommittedReaders,
  type EvidenceFreezeSynthesisContext,
  type EvidenceFreezeSynthesisReaderEnvironment,
  type EvidenceFreezeVerificationContextReader,
} from "@eliotr/cloudflare-research";
import type { InvestigationLedgerStore } from "@eliotr/research";
import {
  digest,
  fail,
  parseRequest,
  readCommittedStageLineage,
  snapshotPrincipal,
  WorkflowCheckpointError,
  WorkflowCheckpointStore,
  type StageRequest,
  type WorkflowPrincipal,
  type WorkflowStageHandler,
} from "@eliotr/cloudflare-workflows";
import {
  decodeResearchCitationsResult,
  type ResearchCitationsResult,
} from "./research-citations-result.js";
import {
  encodeResearchCoverageResult,
  type ResearchCoverageResultInput,
} from "./research-coverage-result.js";

const STAGE = "CALCULATE_COVERAGE" as const;
const PREDECESSOR_STAGE = "RESOLVE_CITATIONS" as const;

export interface ResearchCoverageStageDependencies {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly ledger: Pick<InvestigationLedgerStore, "read">;
  readonly navigation: NavigationReadAuthority;
  /** The post-synthesis reader must be created for CALCULATE_COVERAGE. */
  readonly context: EvidenceFreezeVerificationContextReader;
}

interface PreparedInvocation {
  readonly request: StageRequest;
  readonly principal: WorkflowPrincipal;
  readonly attempt_ref: string;
  readonly navigation_access: NavigationReadAuthority["access"];
}

interface CoverageAuthorities {
  readonly context: EvidenceFreezeSynthesisContext;
  readonly protocol: Awaited<ReturnType<typeof readCommittedProtocolScopeCheckpoint>>;
  readonly grant: Awaited<ReturnType<NavigationReadAuthority["current"]>>;
  readonly sources: readonly EvidenceSourceAuthority[];
  readonly source_fingerprint: string;
  readonly grant_fingerprint: string;
}

function failAuthority(): never {
  return fail("WORKFLOW_AUTHORITY_STALE");
}

function failCorrupt(): never {
  return fail("WORKFLOW_OUTPUT_CORRUPT");
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function refKey(value: VersionedRef): string {
  return `${value.id}:${value.revision}`;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  if (new Set(leftSorted).size !== leftSorted.length || new Set(rightSorted).size !== rightSorted.length) return false;
  return leftSorted.every((value, index) => value === rightSorted[index]);
}

function stableSources(value: readonly EvidenceSourceAuthority[]): string {
  return canonicalEvidenceJson([...value].sort((left, right) => (
    left.source_revision_ref < right.source_revision_ref ? -1 : left.source_revision_ref > right.source_revision_ref ? 1 : 0
  )).map((source) => ({
    source_revision_ref: source.source_revision_ref,
    source_owner_generation: source.source_owner_generation,
    source_class: source.source_class,
    content_sha256: source.content_sha256,
    object_residency_key_digest: source.object_residency_key_digest,
    normalized_artifact_ref: source.normalized_artifact_ref,
    purge_state: source.purge_state,
    admission_receipt_ref: source.admission_receipt_ref,
    allowed_use: source.allowed_use,
    disclosure_ceiling: source.disclosure_ceiling,
    ...(source.admission_expires_at === undefined ? {} : { admission_expires_at: source.admission_expires_at }),
  })));
}

function stableContext(value: EvidenceFreezeSynthesisContext): string {
  return canonicalEvidenceJson({
    operation_id: value.operation_id,
    investigation_id: value.investigation_id,
    current_revision: value.current_revision,
    principal_ref: value.principal_ref,
    credential_generation: value.credential_generation,
    deployment_generation: value.deployment_generation,
    authorization_receipt_ref: value.authorization_receipt_ref,
    freeze: value.freeze,
    manifest: value.manifest,
    stage_five: value.stage_five,
    w1_head: value.w1_head,
  });
}

function stableProtocol(value: Awaited<ReturnType<typeof readCommittedProtocolScopeCheckpoint>>): string {
  return canonicalEvidenceJson(value);
}

function snapshotAccess(value: NavigationReadAuthority["access"]): NavigationReadAuthority["access"] {
  return Object.freeze({
    principal_ref: value.principal_ref,
    client_class: value.client_class,
    credential_generation: value.credential_generation,
  });
}

function prepareInvocation(
  dependencies: ResearchCoverageStageDependencies,
  rawRequest: unknown,
  rawPrincipal: WorkflowPrincipal,
  rawAttemptRef: unknown,
): PreparedInvocation {
  const request = parseRequest(rawRequest);
  const principal = snapshotPrincipal(rawPrincipal);
  if (request.stage !== STAGE || typeof rawAttemptRef !== "string" || rawAttemptRef.length < 1 || rawAttemptRef.length > 256) {
    fail("WORKFLOW_INPUT_INVALID");
  }
  const access = snapshotAccess(dependencies.navigation.access);
  if (access.principal_ref !== principal.principal_ref ||
      access.credential_generation !== principal.credential_generation) return failAuthority();
  return Object.freeze({ request, principal, attempt_ref: rawAttemptRef, navigation_access: access });
}

function requirePredecessor(
  request: StageRequest,
  citations: ResearchCitationsResult,
  predecessor: Awaited<ReturnType<typeof readCommittedStageLineage>>,
): void {
  if (predecessor.request.stage !== PREDECESSOR_STAGE ||
      predecessor.request.operation_id !== request.operation_id ||
      predecessor.request.handler_generation !== request.handler_generation ||
      predecessor.request.investigation_ref.id !== request.investigation_ref.id ||
      predecessor.receipt.engine_state !== "CHECKPOINTED" ||
      predecessor.receipt.input_manifest_ref !== predecessor.request.input_manifest.object_ref ||
      predecessor.receipt.investigation_ref.id !== request.investigation_ref.id ||
      predecessor.receipt.investigation_ref.revision !== request.investigation_ref.revision ||
      canonicalEvidenceJson(predecessor.receipt.output_manifest) !== canonicalEvidenceJson(request.input_manifest) ||
      predecessor.request.investigation_ref.revision + 1 !== request.investigation_ref.revision ||
      citations.protocol !== "eliotr.research.citations.v2" ||
      citations.operation_id !== request.operation_id ||
      citations.investigation_ref.id !== predecessor.request.investigation_ref.id ||
      citations.investigation_ref.revision !== predecessor.request.investigation_ref.revision ||
      citations.stage !== PREDECESSOR_STAGE ||
      citations.stage_attempt_ref !== predecessor.attempt_ref ||
      citations.stage_request_sha256 !== predecessor.request_sha256) return failCorrupt();
}

function requireContextBinding(
  request: StageRequest,
  principal: WorkflowPrincipal,
  citations: ResearchCitationsResult,
  context: EvidenceFreezeSynthesisContext,
): void {
  if (context.operation_id !== request.operation_id ||
      context.investigation_id !== request.investigation_ref.id ||
      context.current_revision !== request.investigation_ref.revision ||
      context.principal_ref !== principal.principal_ref ||
      context.credential_generation !== principal.credential_generation ||
      context.deployment_generation !== principal.deployment_generation ||
      !sameRef(context.freeze.freeze_ref, citations.freeze_ref) ||
      !sameRef(context.freeze.scope_snapshot_ref, citations.scope_snapshot_ref) ||
      !sameRef(context.manifest.manifest_ref, citations.manifest_ref) ||
      !sameRef(context.manifest.scope_snapshot_ref, context.freeze.scope_snapshot_ref) ||
      !sameRef(context.stage_five.scope_snapshot_ref, context.freeze.scope_snapshot_ref) ||
      context.stage_five.operation_id !== request.operation_id ||
      context.stage_five.investigation_ref.id !== request.investigation_ref.id ||
      context.stage_five.principal_ref !== principal.principal_ref ||
      context.w1_head.investigation_id !== request.investigation_ref.id ||
      context.w1_head.revision !== request.investigation_ref.revision ||
      context.w1_head.principal_ref !== principal.principal_ref ||
      context.w1_head.deployment_generation !== principal.deployment_generation) return failAuthority();
}

function requireDenominatorBinding(
  context: EvidenceFreezeSynthesisContext,
  protocol: Awaited<ReturnType<typeof readCommittedProtocolScopeCheckpoint>>,
  navigation: NavigationReadAuthority,
): readonly string[] {
  const denominator = protocol.coverage_denominator;
  const expectedScope = { id: navigation.scope.snapshot_id, revision: navigation.scope.revision };
  if (!sameRef(denominator.frozen_scope_snapshot_ref, expectedScope) ||
      !sameRef(context.freeze.scope_snapshot_ref, expectedScope) ||
      !sameRef(context.freeze.coverage_denominator_ref, denominator.denominator_ref) ||
      !sameRef(context.stage_five.scope_snapshot_ref, expectedScope) ||
      !sameStringSet(denominator.eligible_source_revision_refs, navigation.scope.member_source_revision_refs) ||
      denominator.required_source_classes.length !== 0 ||
      denominator.required_question_branches.length !== 0 ||
      Object.keys(denominator.acquisition_method_generations).length !== 0 ||
      denominator.excluded_sources.length !== 0 ||
      denominator.completeness_test_ref !== CORPUS_EXPLORATORY_LOOKUP_DEFINITIONS.completeness_test_ref) return failAuthority();
  return Object.freeze([...denominator.eligible_source_revision_refs].sort());
}

function requireSourceAuthorities(
  sources: readonly EvidenceSourceAuthority[],
  refs: readonly string[],
  grant: Awaited<ReturnType<NavigationReadAuthority["current"]>>,
): void {
  if (sources.length !== refs.length || !sameStringSet(sources.map((source) => source.source_revision_ref), refs) ||
      !grant.allowed_use.includes("research")) return failAuthority();
  for (const source of sources) {
    if (source.purge_state !== "LIVE" || !source.allowed_use.includes("research") ||
        source.disclosure_ceiling !== grant.disclosure_ceiling) return failAuthority();
  }
}

function requirePackBinding(
  context: EvidenceFreezeSynthesisContext,
  eligibleRefs: readonly string[],
  sources: readonly EvidenceSourceAuthority[],
): readonly string[] {
  const eligible = new Set(eligibleRefs);
  const sourceByRevision = new Map(sources.map((source) => [source.source_revision_ref, source]));
  const packed = context.stage_five.evidence_pack.resolved_evidence;
  const handles = new Set<string>();
  const represented = new Set<string>();
  for (const item of packed) {
    const handle = item.handle;
    const handleKey = refKey(handle.handle_ref);
    const source = sourceByRevision.get(handle.source_revision_ref);
    if (handles.has(handleKey) || handle.terminal_state !== "LIVE" ||
        handle.scope_snapshot_ref.id !== context.freeze.scope_snapshot_ref.id ||
        handle.scope_snapshot_ref.revision !== context.freeze.scope_snapshot_ref.revision ||
        !eligible.has(handle.source_revision_ref) || source === undefined ||
        item.source_revision_content_sha256 !== source.content_sha256 ||
        handle.source_owner_generation !== source.source_owner_generation ||
        handle.object_residency_key_digest !== source.object_residency_key_digest) return failAuthority();
    handles.add(handleKey);
    represented.add(handle.source_revision_ref);
  }
  const manifest = new Set(context.manifest.allowed_evidence_handle_refs.map(refKey));
  const frozen = new Map(context.freeze.included_evidence.map((item) => [refKey(item.handle_ref), item.digest]));
  for (const item of packed) {
    const key = refKey(item.handle.handle_ref);
    if (!manifest.has(key) || frozen.get(key) !== item.handle.excerpt_sha256) return failCorrupt();
  }
  return Object.freeze([...represented].sort());
}

function requireCitationsBinding(
  citations: ResearchCitationsResult,
  context: EvidenceFreezeSynthesisContext,
  represented: readonly string[],
): readonly string[] {
  if (!sameRef(citations.freeze_ref, context.freeze.freeze_ref) ||
      !sameRef(citations.scope_snapshot_ref, context.freeze.scope_snapshot_ref) ||
      !sameRef(citations.manifest_ref, context.manifest.manifest_ref) ||
      !sameRef(citations.evidence_pack_ref, context.stage_five.evidence_pack.pack_ref)) return failCorrupt();
  const packedByHandle = new Map(context.stage_five.evidence_pack.resolved_evidence.map((item) => [refKey(item.handle.handle_ref), item]));
  const cited = new Set<string>();
  const resolved = citations.citation_resolution_receipt.resolved;
  for (const item of resolved) {
    const packed = packedByHandle.get(refKey(item.handle_ref));
    if (packed === undefined || packed.handle.source_revision_ref.length === 0) return failCorrupt();
    cited.add(packed.handle.source_revision_ref);
  }
  if (![...cited].every((sourceRef) => represented.includes(sourceRef))) return failCorrupt();
  return Object.freeze([...cited].sort());
}

async function readAuthorities(
  dependencies: ResearchCoverageStageDependencies,
  invocation: PreparedInvocation,
  context: EvidenceFreezeSynthesisContext,
  protocol: Awaited<ReturnType<typeof readCommittedProtocolScopeCheckpoint>>,
  eligibleRefs: readonly string[],
): Promise<CoverageAuthorities> {
  let grant: Awaited<ReturnType<NavigationReadAuthority["current"]>>;
  let sources: readonly EvidenceSourceAuthority[];
  try {
    grant = await dependencies.navigation.current();
    sources = await dependencies.navigation.sources(eligibleRefs, grant);
  } catch (error) {
    if (error instanceof WorkflowCheckpointError) throw error;
    return failAuthority();
  }
  requireSourceAuthorities(sources, eligibleRefs, grant);
  return {
    context,
    protocol,
    grant,
    sources,
    source_fingerprint: stableSources(sources),
    grant_fingerprint: canonicalEvidenceJson(grant),
  };
}

async function readProtocol(
  dependencies: ResearchCoverageStageDependencies,
  invocation: PreparedInvocation,
): Promise<Awaited<ReturnType<typeof readCommittedProtocolScopeCheckpoint>>> {
  try {
    return await readCommittedProtocolScopeCheckpoint({
      database: dependencies.database,
      bucket: dependencies.work_bucket,
      navigation: dependencies.navigation,
      ledger: dependencies.ledger,
      request: invocation.request,
      principal: invocation.principal,
    });
  } catch (error) {
    if (error instanceof WorkflowCheckpointError) throw error;
    return failAuthority();
  }
}

function buildCoverageReceipt(
  context: EvidenceFreezeSynthesisContext,
  protocol: Awaited<ReturnType<typeof readCommittedProtocolScopeCheckpoint>>,
  requestedScopeExpression: unknown,
  represented: readonly string[],
  cited: readonly string[],
  receiptRef: VersionedRef,
): CoverageReceipt {
  const denominator = protocol.coverage_denominator;
  const eligible = [...denominator.eligible_source_revision_refs].sort();
  const omitted = eligible
    .filter((sourceRef) => !represented.includes(sourceRef))
    .map((sourceRef) => ({ source_ref: sourceRef, reason: "NOT_REPRESENTED_IN_EVIDENCE_PACK" }));
  /* The persisted exploratory membership observation does not prove absence. */
  const denominatorKind = "unknown" as const;
  return {
    receipt_ref: receiptRef,
    requested_scope_expression: requestedScopeExpression,
    frozen_scope_snapshot_ref: context.freeze.scope_snapshot_ref,
    coverage_denominator_ref: denominator.denominator_ref,
    denominator_kind: denominatorKind,
    eligible_source_refs: eligible,
    represented_source_refs: [...represented].sort(),
    cited_source_refs: [...cited].sort(),
    omitted_sources: omitted,
    unknown_coverage_reason: "EXPLORATORY_MEMBERSHIP_OBSERVATION_DOES_NOT_PROVE_COMPLETE_SCOPE",
    source_families_and_independence_profile_ref: protocol.protocol_profile.independence_policy_ref,
    lanes_used: [context.stage_ten_input.lane_material.lane, ...context.stage_ten_input.lane_material.lane_registrations],
    stale_or_skipped_lanes: [],
    failed_acquisition_refs: denominator.excluded_sources.map((item) => item.source_ref),
    provider_degradation_refs: [],
    parser_degradation_refs: [],
    redacted_dependency_refs: [],
    counter_search_status: protocol.protocol_profile.counter_search_required ? "NOT_RUN" : "NOT_REQUIRED",
    budget_limitations: [],
    terminal_disposition: "INCOMPLETE_COVERAGE",
  };
}

async function executeCoverage(
  dependencies: ResearchCoverageStageDependencies,
  invocation: PreparedInvocation,
  inputBytes: Uint8Array,
): Promise<Uint8Array> {
  const copiedInput = new Uint8Array(inputBytes);
  const requestSha256 = await digest(new TextEncoder().encode(JSON.stringify(invocation.request)));
  if (invocation.request.input_manifest.byte_length !== copiedInput.byteLength ||
      invocation.request.input_manifest.sha256 !== await digest(copiedInput)) return failCorrupt();
  const checkpoints = new WorkflowCheckpointStore(dependencies.database);
  const predecessor = await readCommittedStageLineage(checkpoints, invocation.request.operation_id, PREDECESSOR_STAGE);
  let citations: ResearchCitationsResult;
  try { citations = await decodeResearchCitationsResult(copiedInput); }
  catch (error) {
    if (error instanceof WorkflowCheckpointError) throw error;
    return failCorrupt();
  }
  requirePredecessor(invocation.request, citations, predecessor);
  let contextBefore: EvidenceFreezeSynthesisContext;
  try {
    contextBefore = await dependencies.context.read({ request: invocation.request, principal: invocation.principal, input_bytes: copiedInput });
  } catch (error) {
    if (error instanceof WorkflowCheckpointError) throw error;
    return failAuthority();
  }
  requireContextBinding(invocation.request, invocation.principal, citations, contextBefore);
  const protocolCheckpointBefore = await readProtocol(dependencies, invocation);
  const eligibleRefs = requireDenominatorBinding(contextBefore, protocolCheckpointBefore, dependencies.navigation);
  const protocolBefore = await readAuthorities(dependencies, invocation, contextBefore, protocolCheckpointBefore, eligibleRefs);
  const represented = requirePackBinding(contextBefore, protocolBefore.protocol.coverage_denominator.eligible_source_revision_refs, protocolBefore.sources);
  const cited = requireCitationsBinding(citations, contextBefore, represented);
  const receiptRef = { id: await stableEvidenceId("coverage-receipt", invocation.request.operation_id, invocation.attempt_ref, requestSha256), revision: 1 };
  const coverageReceipt = buildCoverageReceipt(contextBefore, protocolBefore.protocol,
    dependencies.navigation.scope.resolved_scope_expression, represented, cited, receiptRef);
  let output: Uint8Array;
  try {
    output = await encodeResearchCoverageResult({
      citations,
      operation_id: invocation.request.operation_id,
      investigation_ref: invocation.request.investigation_ref,
      stage_attempt_ref: invocation.attempt_ref,
      stage_request_sha256: requestSha256,
      stage_fifteen_output_sha256: invocation.request.input_manifest.sha256,
      coverage_receipt: coverageReceipt,
    } satisfies ResearchCoverageResultInput);
  } catch (error) {
    if (error instanceof WorkflowCheckpointError) return failCorrupt();
    return failCorrupt();
  }
  let contextAfter: EvidenceFreezeSynthesisContext;
  try {
    contextAfter = await dependencies.context.read({ request: invocation.request, principal: invocation.principal, input_bytes: copiedInput });
  } catch (error) {
    if (error instanceof WorkflowCheckpointError) throw error;
    return failAuthority();
  }
  requireContextBinding(invocation.request, invocation.principal, citations, contextAfter);
  const predecessorAfter = await readCommittedStageLineage(checkpoints, invocation.request.operation_id, PREDECESSOR_STAGE);
  const protocolAfter = await readProtocol(dependencies, invocation);
  let finalGrant: Awaited<ReturnType<NavigationReadAuthority["current"]>>;
  let finalSources: readonly EvidenceSourceAuthority[];
  let terminalGrant: Awaited<ReturnType<NavigationReadAuthority["current"]>>;
  try {
    finalGrant = await dependencies.navigation.current();
    finalSources = await dependencies.navigation.sources(protocolAfter.coverage_denominator.eligible_source_revision_refs, finalGrant);
    requireSourceAuthorities(finalSources, protocolAfter.coverage_denominator.eligible_source_revision_refs, finalGrant);
    terminalGrant = await dependencies.navigation.current();
  } catch (error) {
    if (error instanceof WorkflowCheckpointError) throw error;
    return failAuthority();
  }
  if (stableContext(contextAfter) !== stableContext(contextBefore) ||
      canonicalEvidenceJson(predecessorAfter) !== canonicalEvidenceJson(predecessor) ||
      stableProtocol(protocolAfter) !== stableProtocol(protocolBefore.protocol) ||
      canonicalEvidenceJson(finalGrant) !== protocolBefore.grant_fingerprint ||
      stableSources(finalSources) !== protocolBefore.source_fingerprint ||
      canonicalEvidenceJson(terminalGrant) !== protocolBefore.grant_fingerprint) return failAuthority();
  return output;
}

export function createResearchCoverageStageHandler(
  dependencies: ResearchCoverageStageDependencies,
): WorkflowStageHandler {
  if (dependencies === null || typeof dependencies !== "object" ||
      typeof dependencies.database?.prepare !== "function" ||
      typeof dependencies.work_bucket?.get !== "function" ||
      typeof dependencies.navigation?.current !== "function" ||
      typeof dependencies.navigation?.sources !== "function" ||
      typeof dependencies.ledger?.read !== "function" ||
      typeof dependencies.context?.read !== "function") {
    fail("WORKFLOW_INPUT_INVALID");
  }
  const frozen = Object.freeze({ ...dependencies });
  return async ({ request, principal, input_bytes, attempt_ref }) => {
    const invocation = prepareInvocation(frozen, request, principal, attempt_ref);
    if (!(input_bytes instanceof Uint8Array)) return fail("WORKFLOW_INPUT_INVALID");
    return executeCoverage(frozen, invocation, input_bytes);
  };
}

export function createResearchCoverageStageHandlerFromFreeze(
  environment: EvidenceFreezeSynthesisReaderEnvironment,
  navigation: NavigationReadAuthority,
  readers: EvidenceFreezeCommittedReaders,
  dependencies: Omit<ResearchCoverageStageDependencies, "context" | "navigation" | "database" | "work_bucket"> & {
    readonly ledger: Pick<InvestigationLedgerStore, "read">;
  },
): WorkflowStageHandler {
  return createResearchCoverageStageHandler({
    ...dependencies,
    database: environment.database,
    work_bucket: environment.work_bucket,
    navigation,
    context: createEvidenceFreezePostSynthesisContextReader(environment, navigation, readers, STAGE),
  });
}
